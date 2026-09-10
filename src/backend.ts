import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryService } from './service.js';
import { ManagedLocalModels } from './models/index.js';
import { sanitizeText } from './host/adapter.js';
import type { ServerBackend } from './host/contracts.js';
import { digest, MemoryError, type Scope } from './domain.js';

export async function createBackend(dataDirectory: string): Promise<ServerBackend> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  const manifestPath = [new URL('../../models/manifest.json', import.meta.url), new URL('../models/manifest.json', import.meta.url)].map(url => fileURLToPath(url)).find(path => existsSync(path));
  const models = new ManagedLocalModels({ directory: join(dataDirectory, 'models'), manifestPath,
    onStatus: state => { process.stderr.write(JSON.stringify({ component: 'models', phase: state.phase, resource: state.resource, downloadedBytes: state.downloadedBytes, totalBytes: state.totalBytes, code: state.error?.code }) + '\n'); } });
  const service = await MemoryService.open(dataDirectory, { models });
  // Neither protocol handshake nor a host hook waits for model download or generation.
  void models.prepare().then(() => service.processPending()).catch(() => {});
  const worker = setInterval(() => { void service.processPending().catch(() => {}); }, 30_000);
  worker.unref();
  let closing = false;
  const backend: ServerBackend = {
    async retryModels() { await models.retry(); void service.processPending().catch(() => {}); return models.status(); },
    bind: identity => service.bind(identity),
    async handleHook(context, event, intent) {
      const scope = context as Scope;
      if (intent) {
        if (intent.action === 'correct' && sanitizeText(intent.text).filtered) throw new MemoryError('INVALID_INPUT', 'Correction contains a recognized secret; remove it before submitting');
        const credential = await service.issueIntent(scope, intent);
        return { additionalContext: `The user issued an explicit banana-memory maintenance command. Call manage with only this one-use intentToken: ${credential.intentToken}. It binds the workspace, action and version; do not invent or expand parameters. Deletion preview must be shown to the user before a separate confirm-delete command.`, intentToken: credential.intentToken };
      }
      if (event.kind === 'SessionEnd') return {};
      // Recognize only explicit tool-reported runtime versions; arbitrary prompts cannot update environment authority.
      if (event.role === 'tool' && !event.filtered && !event.truncated && event.toolName === 'Bash') {
        try {
          const output = JSON.parse(event.text) as { input?: { command?: string }; result?: unknown };
          const command = output.input?.command?.trim();
          const match = /^(node|npm|pnpm|python3?) --version$/.exec(command ?? '');
          const result = typeof output.result === 'string' ? output.result : JSON.stringify(output.result);
          const version = /(?:^|[\s":])v?(\d+\.\d+\.\d+)(?:[\s",}]|$)/.exec(result);
          if (match && version) await service.updateEnvironment(scope, { [match[1]!]: version[1]! });
        } catch { /* Non-version tool output remains ordinary evidence. */ }
      }
      const received = await service.record(scope, event);
      if (event.kind === 'UserPromptSubmit' && received.id && /验证通过|结果符合预期|验证失败|反例|verified success|verified outcome|verified failure|counterexample/i.test(event.text)) {
        await service.feedback(scope, { taskId: event.taskId, text: event.text, sourceIds: [received.id] });
      }
      if (event.kind === 'Stop') void service.processPending().catch(() => {});
      else if (Number((await service.inspect(scope)).queue) >= 20) void service.processPending().catch(() => {});
      if (event.kind === 'UserPromptSubmit' || event.kind === 'SessionStart') {
        const bundle = await service.recall(scope, event.kind === 'UserPromptSubmit' ? event.text : '');
        const delivered = await service.deliver(scope, bundle);
        return { additionalContext: delivered.text, received, degradation: delivered.degradation };
      }
      return { received };
    },
    async call(context, tool, args) {
      const scope = context as Scope;
      switch (tool) {
        case 'inspect': return service.inspect(scope, typeof args.target === 'string' ? args.target : undefined);
        case 'recall': return service.deliver(scope, await service.recall(scope, String(args.query ?? ''), args.mode === 'history' ? 'history' : 'current'));
        case 'record': {
          const clean = sanitizeText(String(args.text ?? ''));
          const taskId = typeof args.taskId === 'string' ? args.taskId : undefined;
          const sourceIds = Array.isArray(args.sourceIds) ? args.sourceIds.filter((id): id is string => typeof id === 'string').sort() : undefined;
          const id = typeof args.idempotencyKey === 'string' ? args.idempotencyKey : digest(JSON.stringify({ session: scope.sessionId, task: taskId, text: clean.text, sources: sourceIds }));
          const received = await service.record(scope, { id, text: clean.text, taskId, sourceIds, role: 'assistant', filtered: clean.filtered, filterReasons: clean.reasons });
          if (Number((await service.inspect(scope)).queue) >= 20) void service.processPending().catch(() => {});
          return received;
        }
        case 'feedback': return service.feedback(scope, { taskId: String(args.taskId ?? scope.sessionId), bundleId: typeof args.bundleId === 'string' ? args.bundleId : undefined, text: sanitizeText(String(args.text ?? '')).text, sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds.filter((id): id is string => typeof id === 'string') : undefined });
        case 'manage': return service.manage(scope, String(args.intentToken ?? ''));
      }
    },
    async close() {
      if (closing) return; closing = true; clearInterval(worker);
      // Abort inference first so no long model job can hold the kernel past its exit budget.
      await models.shutdown();
      await service.close();
    }
  };
  return backend;
}
