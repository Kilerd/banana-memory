import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { HostIdentity } from './contracts.js';

export function dataDirectory(): string { return resolve(process.env.BANANA_MEMORY_HOME || join(homedir(), '.banana-memory')); }
export function runtimeDirectory(dataDir: string): string {
  let canonical = resolve(dataDir);
  try { canonical = realpathSync(canonical); } catch { /* The first launcher creates a missing data directory. */ }
  return join('/tmp', `banana-memory-${process.getuid?.() ?? 'user'}`, createHash('sha256').update(canonical).digest('hex').slice(0, 20));
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (process.getuid && metadata.uid !== process.getuid())) throw new Error('unsafe_runtime_directory');
  await chmod(path, 0o700);
}
export function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class KernelClient {
  private counter = 0;
  private buffer = '';
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 2_000_000) { socket.destroy(new Error('ipc_message_limit')); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        try {
          const reply = JSON.parse(line) as { id: number; result?: unknown; error?: string };
          const request = this.pending.get(reply.id);
          if (!request) continue;
          clearTimeout(request.timer); this.pending.delete(reply.id);
          if (reply.error) request.reject(new Error(reply.error)); else request.resolve(reply.result);
        } catch { socket.destroy(new Error('invalid_ipc_response')); }
      }
    });
    const fail = () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('kernel_disconnected')); }
      this.pending.clear();
    };
    socket.on('error', fail); socket.on('close', fail);
  }

  static async connect(dataDir: string, identity: HostIdentity, ownerPid: number, timeoutMs = 8000): Promise<KernelClient> {
    const socketPath = join(runtimeDirectory(dataDir), 'kernel.sock');
    const secret = await readFile(join(runtimeDirectory(dataDir), 'auth'), 'utf8');
    const socket = await new Promise<Socket>((resolve, reject) => {
      const connection = createConnection(socketPath);
      const timer = setTimeout(() => { connection.destroy(); reject(new Error('kernel_timeout')); }, timeoutMs);
      connection.once('connect', () => { clearTimeout(timer); resolve(connection); });
      connection.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const client = new KernelClient(socket);
    try { await client.request('hello', { secret, identity, ownerPid }, timeoutMs); return client; }
    catch (error) { client.close(); throw error; }
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<unknown> {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('kernel_timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  close(): void { this.socket.destroy(); }
}

export async function ensureKernel(dataDir: string, cliPath: string, identity: HostIdentity, ownerPid: number, timeoutMs = 8000): Promise<KernelClient> {
  const started = Date.now();
  try { return await KernelClient.connect(dataDir, identity, ownerPid, Math.min(500, timeoutMs)); } catch { /* bootstrap below */ }
  // Every contender starts a tiny launcher; the exclusive kernel lock admits only one writer.
  const launch = () => {
    const child = spawn(process.execPath, [cliPath, 'kernel'], { detached: true, stdio: 'ignore', env: { ...process.env, BANANA_MEMORY_HOME: dataDir } });
    child.on('error', () => {}); child.unref();
  };
  launch();
  let lastLaunch = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 40));
    try { return await KernelClient.connect(dataDir, identity, ownerPid, Math.max(20, timeoutMs - (Date.now() - started))); } catch { /* kernel startup */ }
    if (Date.now() - lastLaunch > 1100) { launch(); lastLaunch = Date.now(); }
  }
  throw new Error('kernel_timeout');
}

export function connectionSession(): string { return `mcp:${process.ppid}:${randomUUID()}`; }
