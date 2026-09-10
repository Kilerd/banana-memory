import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MemoryService } from '../src/service.js';
import { ManagedLocalModels, type LocalModels } from '../src/models/index.js';
import type { Scope } from '../src/domain.js';

const modelDirectory = path.resolve(process.env.BANANA_MODEL_DIR ?? '.runtime/models');
const reportPath = path.resolve('docs/local-pipeline-evaluation.json');
await mkdir('.runtime', { recursive: true });
const directory = await mkdtemp(path.resolve('.runtime/local-pipeline-'));
const started = performance.now();
const originalFetch = globalThis.fetch;
let externalRequests = 0;
const loopbackRequests: Record<string, number> = {};
const modelCalls = { extract: 0, documentEmbedding: 0, queryEmbedding: 0 };
const steps: Array<{ name: string; passed: boolean; elapsedMs: number; detail?: unknown }> = [];
// Deny every non-loopback fetch before preparation starts. Cached preparation
// must succeed under this guard; no remote call is replaced with a fixture.
globalThis.fetch = async (...args) => {
  const value = args[0];
  const url = new URL(value instanceof Request ? value.url : String(value));
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') { externalRequests++; throw new Error('OFFLINE_NON_LOOPBACK_REQUEST'); }
  loopbackRequests[url.pathname] = (loopbackRequests[url.pathname] ?? 0) + 1;
  return originalFetch(...args);
};
function realModels(): { managed: ManagedLocalModels; observed: LocalModels } {
  const managed = new ManagedLocalModels({ directory: modelDirectory, manifestPath: path.resolve('models/manifest.json') });
  return { managed, observed: {
    status: () => managed.status(), prepare: () => managed.prepare(), shutdown: () => managed.shutdown(),
    extract: async events => { modelCalls.extract++; return managed.extract(events); },
    embed: async (text, purpose) => { modelCalls[purpose === 'document' ? 'documentEmbedding' : 'queryEmbedding']++; return managed.embed(text, purpose); },
  } };
}
let active = realModels();
let service: MemoryService | undefined;
async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { const result = await work(); steps.push({ name, passed: true, elapsedMs: performance.now() - start, detail: result }); console.error(`PASS ${name}`); return result; }
  catch (error) { steps.push({ name, passed: false, elapsedMs: performance.now() - start, detail: error instanceof Error ? error.message : String(error) }); throw error; }
}
async function command(scope: Scope, intent: Parameters<MemoryService['issueIntent']>[1]): Promise<Record<string, any>> {
  const { intentToken } = await service!.issueIntent(scope, intent);
  return service!.manage(scope, intentToken);
}
let failure: string | undefined;
try {
  await step('cached model preparation with all non-loopback fetches denied', async () => { await active.managed.prepare(); assert.equal(active.managed.status().phase, 'ready'); assert.equal(externalRequests, 0); return { phase: active.managed.status().phase }; });
  service = await MemoryService.open(directory, { models: active.observed });
  let scope = await service.bind({ workspace: path.resolve('.runtime/pipeline-project'), sessionId: 'pipeline-session-1', origin: 'hook' });
  const chinese = { id: 'pipeline-zh', taskId: 'pipeline-task-zh', role: 'user' as const, text: '这个项目使用 pnpm 9，不使用 npm；legacy 子目录仍然使用 yarn 1。' };
  const english = { id: 'pipeline-en', taskId: 'pipeline-task-en', role: 'user' as const, text: 'Payment writes are not automatically retried. A retry requires the original idempotency key.' };
  const ids = await step('record persists two original events and deduplicates ten retries', async () => {
    const zh = await service!.record(scope, chinese); const en = await service!.record(scope, english);
    assert.equal(zh.status, 'received'); assert.equal(en.status, 'received');
    for (let i = 0; i < 10; i++) assert.equal((await service!.record(scope, chinese)).status, 'duplicate');
    const status = await service!.inspect(scope); assert.equal(status.events, 2); assert.equal(status.queue, 2);
    return { chinese: zh.id, english: en.id };
  });
  await step('worker uses real extraction and document embeddings', async () => {
    await service!.processPending(20);
    const status = await service!.inspect(scope);
    assert.equal(status.queue, 0); assert.equal(status.memories, 2); assert.equal(modelCalls.extract, 2); assert.equal(modelCalls.documentEmbedding, 2);
    return { memories: status.memories, queue: status.queue, modelCalls: { ...modelCalls } };
  });
  const held = await step('recall preserves the Chinese negation and legacy exception', async () => {
    const bundle = await service!.recall(scope, 'pnpm 9 legacy yarn 1 不使用 npm');
    const memory = bundle.memories.find(m => m.sources.includes(ids.chinese)); assert.ok(memory);
    for (const token of ['pnpm 9', '不使用 npm', 'legacy', 'yarn 1']) assert.ok(memory.text.includes(token));
    const inspected = await service!.inspect(scope, memory.id); assert.equal(inspected.vector.length, 1024);
    assert.equal(bundle.degradation, undefined); return bundle;
  });
  const target = held.memories.find(m => m.sources.includes(ids.chinese))!;
  await step('cross-language recall uses the real query embedding and preserves English restrictions', async () => {
    const bundle = await service!.recall(scope, '支付请求失败后能否直接重试，怎样避免重复扣款？');
    const memory = bundle.memories.find(m => m.sources.includes(ids.english)); assert.ok(memory);
    assert.ok(memory.text.includes('not automatically retried')); assert.ok(memory.text.includes('original idempotency key'));
    const inspected = await service!.inspect(scope, memory.id); assert.equal(inspected.vector.length, 1024);
    assert.equal(bundle.degradation, undefined); assert.equal((await service!.deliver(scope, bundle)).delivered, true);
    return { memoryId: memory.id, dimensions: inspected.vector.length, degradation: bundle.degradation ?? null };
  });
  await step('an older repeated fact can remain queued when correction arrives', async () => {
    const received = await service!.record(scope, { ...chinese, id: 'pipeline-zh-late', taskId: 'pipeline-task-late' });
    assert.equal(received.status, 'received');
    assert.equal((await service!.inspect(scope)).queue, 1);
    return { id: received.id, queue: 1 };
  });
  const corrected = await step('explicit correction immediately supersedes old text before vector regeneration', async () => {
    const result = await command(scope, { action: 'correct', target: target.id, expectedVersion: target.version, text: '这个项目现在使用 pnpm 10，不使用 npm；legacy 子目录仍然使用 yarn 1。' });
    assert.equal(result.status, 'corrected');
    const bundle = await service!.recall(scope, 'pnpm 10 legacy yarn 1');
    assert.ok(bundle.memories.some(m => m.id === target.id && m.text.includes('pnpm 10')));
    assert.equal(bundle.text.includes('pnpm 9'), false);
    const inspected = await service!.inspect(scope, target.id); assert.equal(inspected.vector, undefined);
    return { id: target.id, version: result.version, oldTextAbsent: true, correctedVectorPending: true };
  });
  await step('processing an older queued source cannot overwrite the explicit correction', async () => {
    await service!.processPending(20);
    const bundle = await service!.recall(scope, 'pnpm 10 pnpm 9 legacy');
    assert.ok(bundle.memories.some(m => m.id === target.id && m.text.includes('pnpm 10')), JSON.stringify({ reason: 'Explicit correction overwritten by older queued source', memories: bundle.memories }));
    assert.equal(bundle.text.includes('pnpm 9'), false);
    const inspected = await service!.inspect(scope, target.id);
    assert.equal(inspected.vector?.length, 1024, 'Corrected memory must receive a real document embedding in the background');
    return { oldTextAbsent: true, correctedVectorDimensions: inspected.vector.length, queue: (await service!.inspect(scope)).queue };
  });
  await step('held pre-correction context cannot be delivered', async () => {
    const delivered = await service!.deliver(scope, held); assert.equal(delivered.delivered, false); assert.equal(delivered.text, ''); assert.deepEqual(delivered.memories, []); assert.equal(delivered.degradation, 'CONTROL_CHANGED');
    return { delivered: false, degradation: delivered.degradation };
  });
  await step('preview and confirmed deletion remove original and corrected source history', async () => {
    const preview = await command(scope, { action: 'delete-preview', target: target.id, expectedVersion: corrected.version });
    assert.ok(preview.sources.includes(ids.chinese)); assert.equal(preview.sources.length, 2);
    const result = await command(scope, { action: 'delete', previewId: preview.previewId });
    assert.equal(result.status, 'deleted'); assert.equal(result.cleanup.complete, true);
    assert.equal((await service!.recall(scope, 'pnpm yarn', 'history')).memories.some(m => m.id === target.id), false);
    await assert.rejects(service!.inspect(scope, target.id), { code: 'UNAUTHORIZED' });
    await assert.rejects(service!.record(scope, chinese), { code: 'SOURCE_DELETED' });
    return { sourceCount: result.sources.length, cleanup: result.cleanup, replayBlocked: true };
  });
  await step('restart reuses the same model cache offline and cannot resurrect deleted memory', async () => {
    await active.managed.shutdown(); await service!.close(); service = undefined;
    active = realModels(); await active.managed.prepare();
    service = await MemoryService.open(directory, { models: active.observed });
    scope = await service.bind({ workspace: path.resolve('.runtime/pipeline-project'), sessionId: 'pipeline-session-2', origin: 'hook' });
    await service.processPending(20);
    for (const mode of ['current', 'history'] as const) {
      const bundle = await service.recall(scope, 'pnpm 9 pnpm 10 yarn legacy', mode);
      assert.equal(bundle.memories.some(m => m.id === target.id || m.text.includes('pnpm')), false);
    }
    await assert.rejects(service.record(scope, chinese), { code: 'SOURCE_DELETED' });
    const surviving = await service.recall(scope, 'Payment writes idempotency key'); assert.ok(surviving.memories.some(m => m.sources.includes(ids.english)));
    assert.equal(externalRequests, 0);
    return { oldResults: 0, survivingUnrelatedMemory: true, externalRequests };
  });
} catch (error) { failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await active.managed.shutdown(); await service?.close(); globalThis.fetch = originalFetch;
  const manifest = JSON.parse(await readFile('models/manifest.json', 'utf8'));
  const report = { recordedAt: new Date().toISOString(), passed: !failure, failure, modelDirectory, modelVersion: manifest.version, node: process.version, durationMs: performance.now() - started, externalRequests, loopbackRequests, modelCalls, steps, limitations: ['Real local model + real LanceDB + MemoryService boundary; not a live Claude Code hook/client test.', 'Offline mode rejects all non-loopback JavaScript fetch URLs before they are requested; it is not an operating-system network capture.', 'Two synthetic source events are a smoke test, not the release quality or scale benchmark.'] };
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ reportPath, passed: report.passed, externalRequests, modelCalls, steps: steps.length, failure }));
}
