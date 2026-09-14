#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataDirectory } from './host/ipc.js';

const cliPath = fileURLToPath(import.meta.url);
const command = process.argv[2];

function printHttpConnection(instance: { url: string; token: string }, alreadyRunning: boolean): void {
  const status = alreadyRunning ? 'Banana Memory is already running.' : 'Banana Memory is running in the foreground.';
  const stop = alreadyRunning ? '' : '\nPress Ctrl+C to stop.\n';
  const ui = instance.url.replace(/\/mcp$/, '/') + `#token=${instance.token}`;
  const dataUrl = pathToFileURL(dataDirectory()).href.replaceAll("'", '%27');
  const headers = `npx -y banana-memory@latest codex-headers '${dataUrl}'`;
  process.stdout.write(`${status}\nUI:  ${ui}\nMCP: ${instance.url}\nData: ${dataDirectory()}\n\nAdd it to Codex once in ~/.codex/config.toml:\n[mcp_servers.banana-memory]\nurl = "${instance.url}"\nhttp_headers_helper = "${headers}"\n\nAdd it to Claude Code once:\nclaude mcp add --transport http --scope user --header "Authorization: Bearer ${instance.token}" -- banana-memory ${instance.url}\n${stop}`);
}

try {
  if (command === 'hook') {
    const { runHook } = await import('./host/hook.js');
    await runHook(dataDirectory(), cliPath, process.argv[3]);
  } else if (command === 'mcp') {
    const { runMcp } = await import('./host/mcp.js');
    await runMcp(dataDirectory(), cliPath);
  } else if (command === 'codex-headers') {
    const { codexHttpHeaders } = await import('./host/http.js');
    if (process.argv.length > 4) throw new Error('invalid_codex_headers_option');
    const directory = process.argv[3] ? fileURLToPath(process.argv[3]) : dataDirectory();
    process.stdout.write(JSON.stringify(await codexHttpHeaders(directory, process.cwd())) + '\n');
  } else if (command === 'migrate-projects') {
    const plan = process.argv[3];
    if (!plan || process.argv.length > 5 || process.argv[4] && process.argv[4] !== '--apply') throw new Error('invalid_migration_option');
    const { migrateProjects } = await import('./migration.js');
    process.stdout.write(JSON.stringify(await migrateProjects(dataDirectory(), plan, process.argv[4] === '--apply')) + '\n');
  } else if (command === 'start' || command === 'serve') {
    const flags = process.argv.slice(3);
    const portIndex = flags.indexOf('--port');
    const port = portIndex >= 0 ? Number(flags[portIndex + 1]) : undefined;
    if (portIndex >= 0 && (!flags[portIndex + 1] || !Number.isSafeInteger(port))) throw new Error('invalid_http_port');
    if (flags.some((flag, index) => flag !== '--port' && index !== portIndex + 1)) throw new Error('invalid_http_option');
    const [{ createBackend }, { startHttpServer, probeRunningHttpServer }] = await Promise.all([import('./backend.js'), import('./host/http.js')]);
    try {
      const instance = await startHttpServer({ dataDir: dataDirectory(), createBackend, port });
      printHttpConnection(instance, false);
      const close = () => { void instance.close().finally(() => { process.exitCode = 0; }); };
      process.once('SIGTERM', close); process.once('SIGINT', close);
      await instance.done;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'server_already_running') throw error;
      const running = await probeRunningHttpServer({ dataDir: dataDirectory(), port });
      if (!running) throw error;
      printHttpConnection(running, true);
    }
  } else if (command === 'kernel') {
    const { startKernel } = await import('./host/kernel.js');
    const instance = await startKernel({ dataDir: dataDirectory(), createBackend: async dataDir => {
      const { createBackend } = await import('./backend.js');
      return createBackend(dataDir);
    } });
    if (instance) {
      const close = () => { void instance.close().finally(() => process.exit(0)); };
      process.once('SIGTERM', close); process.once('SIGINT', close);
      await instance.done;
      process.exit(0);
    }
  } else if (command === 'models-retry') {
    const { ensureKernel, connectionSession } = await import('./host/ipc.js');
    const { resolveWorkspace } = await import('./host/adapter.js');
    const workspace = await resolveWorkspace(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    const client = await ensureKernel(dataDirectory(), cliPath, { ...workspace, sessionId: connectionSession(), origin: 'mcp' }, process.ppid);
    const stop = () => { client.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      process.stderr.write('banana-memory: retrying local model preparation; keep this command open until it finishes\n');
      const result = await client.request('models-retry', {}, 30 * 60_000);
      process.stdout.write(JSON.stringify(result) + '\n');
    } finally { client.close(); }
  } else {
    process.stderr.write('Usage: banana-memory <start [--port PORT]|serve [--port PORT]|codex-headers [DATA_DIR_FILE_URL]|migrate-projects PLAN.json [--apply]|mcp|kernel|hook EVENT|models-retry>\n');
    process.exitCode = 1;
  }
} catch (error) {
  const { safeErrorCode } = await import('./host/errors.js');
  process.stderr.write(`banana-memory: ${safeErrorCode(error, 'startup_failed')}\n`);
  process.exitCode = command === 'hook' ? 0 : 1;
}
