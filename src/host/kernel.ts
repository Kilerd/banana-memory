import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, open, unlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { normalizeHook, parseExplicitIntent, resolveWorkspace } from './adapter.js';
import { isAlive, privateDirectory, runtimeDirectory } from './ipc.js';
import type { BackendFactory, HostIdentity, MemoryTool, ServerBackend } from './contracts.js';
import lockfile from 'proper-lockfile';
import { safeErrorCode } from './errors.js';

const TOOLS: MemoryTool[] = ['recall', 'record', 'feedback', 'inspect', 'manage'];
export interface KernelOptions { dataDir: string; createBackend: BackendFactory; idleGraceMs?: number; drainMs?: number }

export async function startKernel(options: KernelOptions): Promise<{ pid: number; close: () => Promise<void>; done: Promise<void> } | null> {
  await privateDirectory(options.dataDir);
  const runtime = runtimeDirectory(options.dataDir);
  await privateDirectory(dirname(runtime)); await privateDirectory(runtime); await privateDirectory(options.dataDir);
  const lockPath = join(runtime, 'kernel.lock');
  let release: (() => Promise<void>);
  try {
    release = await lockfile.lock(options.dataDir, {
      lockfilePath: lockPath, realpath: false, retries: 0, stale: 5000, update: 1000,
      // A process that loses its write lease must never publish additional database writes.
      onCompromised: () => { process.stderr.write('banana-memory: kernel_lock_lost\n'); process.exit(1); },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return null;
    throw error;
  }
  const secret = randomBytes(32).toString('hex');
  const authPath = join(runtime, 'auth');
  const auth = await open(authPath, 'w', 0o600); await auth.writeFile(secret); await auth.close(); await chmod(authPath, 0o600);
  const socketPath = join(runtime, 'kernel.sock');
  await unlink(socketPath).catch(() => {});
  const sockets = new Set<Socket>();
  const sessions = new Map<number, { sessionId: string; taskId?: string; workspace: string | null }>();
  const connections = new Map<Socket, { identity: HostIdentity; ownerPid: number }>();
  let backend: ServerBackend | undefined;
  let backendFailed = false;
  let launchBackend!: () => void;
  const backendPromise = new Promise<ServerBackend>((resolve, reject) => {
    launchBackend = () => { void Promise.resolve().then(() => options.createBackend(options.dataDir)).then(value => { backend = value; resolve(value); }, reject); };
  });
  backendPromise.catch(() => { backendFailed = true; });
  let stopped = false;
  let idleSince = Date.now();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let active = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); connections.delete(socket); });
    let buffer = '';
    let queue = Promise.resolve();
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_000_000) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        queue = queue.then(async () => {
          active++;
          let id: unknown;
          try {
            const request = JSON.parse(line) as { id: unknown; method: string; params: Record<string, unknown> };
            id = request.id;
            const result = await dispatch(socket, request.method, request.params);
            if (!socket.destroyed) socket.write(JSON.stringify({ id, result }) + '\n');
          } catch (error) {
            // Error categories only: database/model exception messages can contain user text.
            const code = safeErrorCode(error);
            if (!socket.destroyed) socket.write(JSON.stringify({ id, error: code }) + '\n');
          } finally { active--; }
        });
      }
    });
  });

  async function dispatch(socket: Socket, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (stopped) throw new Error('kernel_draining');
    if (method === 'hello') {
      if (connections.has(socket)) throw new Error('already_bound');
      const supplied = typeof params.secret === 'string' ? Buffer.from(params.secret) : Buffer.alloc(0);
      if (supplied.length !== secret.length || !timingSafeEqual(supplied, Buffer.from(secret))) throw new Error('unauthorized');
      const value = params.identity as HostIdentity;
      if (!value || !['hook', 'mcp'].includes(value.origin) || typeof value.sessionId !== 'string') throw new Error('invalid_identity');
      const workspace = await resolveWorkspace(value.workspace);
      const identity = { ...value, ...workspace };
      const ownerPid = Number(params.ownerPid);
      if (!isAlive(ownerPid)) throw new Error('host_session_unavailable');
      connections.set(socket, { identity, ownerPid });
      return { pid: process.pid, state: backend ? 'initialized' : 'initializing' };
    }
    const connection = connections.get(socket);
    if (!connection) throw new Error('unauthorized');
    if (method === 'ping') return { pid: process.pid, sessions: sessions.size, state: backend ? 'initialized' : 'initializing' };
    if (method === 'models-retry') {
      if (connection.identity.origin !== 'mcp') throw new Error('unauthorized');
      const service = await backendPromise;
      if (!service.retryModels) throw new Error('processing_failed');
      return service.retryModels();
    }
    if (method === 'hook') {
      if (connection.identity.origin !== 'hook') throw new Error('unauthorized');
      const payload = params.payload as Record<string, unknown>;
      if (!payload || payload.session_id !== connection.identity.sessionId) throw new Error('invalid_host_event');
      const previous = sessions.get(connection.ownerPid);
      const event = await normalizeHook(payload, connection.identity.workspace, previous?.sessionId === payload.session_id ? previous.taskId : undefined);
      if (event.kind === 'SessionEnd') sessions.delete(connection.ownerPid);
      else sessions.set(connection.ownerPid, { sessionId: event.sessionId, taskId: event.taskId, workspace: connection.identity.workspace });
      const service = await backendPromise;
      const context = await service.bind(connection.identity);
      return service.handleHook(context, event, parseExplicitIntent(payload));
    }
    if (method !== 'tool' || connection.identity.origin !== 'mcp' || !TOOLS.includes(params.tool as MemoryTool)) throw new Error('unauthorized');
    const session = sessions.get(connection.ownerPid);
    const identity = session && session.workspace === connection.identity.workspace ? { ...connection.identity, sessionId: session.sessionId } : connection.identity;
    const args = params.args && typeof params.args === 'object' && !Array.isArray(params.args) ? params.args as Record<string, unknown> : {};
    if (['projectId', 'project_id', 'workspace', 'user_confirmed', 'sessionId', 'session_id', 'origin'].some(key => key in args)) throw new Error('unauthorized');
    if (params.tool === 'inspect' && !backend) return { state: backendFailed ? 'processing_failed' : 'initializing' };
    const service = await backendPromise;
    const context = await service.bind(identity);
    return service.call(context, params.tool as MemoryTool, args);
  }

  let shutdown: Promise<void> | undefined;
  function close(): Promise<void> {
    if (shutdown) return shutdown;
    stopped = true; clearInterval(sweep);
    shutdown = (async () => {
      const deadline = Date.now() + Math.min(options.drainMs ?? 55_000, 60_000 - (options.idleGraceMs ?? 5000));
      const bound = new Promise<void>(resolve => { const timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); timer.unref(); });
      await Promise.race([(async () => {
        while (active > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        const service = await backendPromise.catch(() => undefined);
        await service?.close();
      })(), bound]);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.all([unlink(socketPath), unlink(authPath)].map(promise => promise.catch(() => {})));
      await release();
      finish();
    })();
    return shutdown;
  }
  const sweep = setInterval(() => {
    for (const [pid] of sessions) if (!isAlive(pid)) sessions.delete(pid);
    const hasMcp = [...connections.values()].some(connection => connection.identity.origin === 'mcp' && isAlive(connection.ownerPid));
    if (sessions.size || hasMcp) idleSince = Date.now();
    else if (Date.now() - idleSince >= (options.idleGraceMs ?? 5000)) void close();
  }, Math.min(1000, options.idleGraceMs ?? 5000));
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()); }); }
  catch (error) { clearInterval(sweep); await release(); await backend?.close(); throw error; }
  await chmod(socketPath, 0o600);
  launchBackend();
  return { pid: process.pid, close, done };
}
