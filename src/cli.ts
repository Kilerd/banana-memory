#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dataDirectory } from './host/ipc.js';

const cliPath = fileURLToPath(import.meta.url);
const command = process.argv[2];
try {
  if (command === 'hook') {
    const { runHook } = await import('./host/hook.js');
    await runHook(dataDirectory(), cliPath, process.argv[3]);
  } else if (command === 'mcp') {
    const { runMcp } = await import('./host/mcp.js');
    await runMcp(dataDirectory(), cliPath);
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
    process.stderr.write('Usage: banana-memory <mcp|kernel|hook EVENT|models-retry>\n');
    process.exitCode = 1;
  }
} catch (error) {
  const { safeErrorCode } = await import('./host/errors.js');
  process.stderr.write(`banana-memory: ${safeErrorCode(error, 'startup_failed')}\n`);
  process.exitCode = command === 'hook' ? 0 : 1;
}
