import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../src/service.js';
import type { LocalModels, SummaryMember } from '../src/models/types.js';
import { ModelError } from '../src/models/types.js';

function models(before?: () => Promise<void>): LocalModels & { calls: number } {
  const result = {
    calls: 0,
    status: () => ({ phase: 'ready' as const, modelVersion: 'summary-test', generationLoaded: true, embeddingLoaded: true }),
    prepare: async () => {}, shutdown: async () => {},
    embed: async () => [1, ...Array(1023).fill(0)],
    extract: async (events: Parameters<LocalModels['extract']>[0]) => events.map(event => ({ type: 'fact' as const, scope: 'project' as const, text: event.text, sourceIds: [event.id], conditions: [], confidence: 1, evidence: [{ sourceId: event.id, quote: event.text }] })),
    summarize: async (members: SummaryMember[]) => {
      result.calls++; await before?.();
      return { text: 'CORE_CACHE 的项目约束由多条原始记录共同描述，仍需核验。', evidence: members.map(member => ({ memberId: member.id, quote: member.text })) };
    },
  };
  return result;
}

test('candidate facts produce a sourced summary across sessions, without promotion or repeated generation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-summary-'));
  const local = models();
  let service = await MemoryService.open(directory, { models: local });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = await service.bind({ workspace: '/project', sessionId: 'a', origin: 'mcp', includeCandidates: true });
  const other = await service.bind({ workspace: '/unrelated', sessionId: 'a', origin: 'mcp', includeCandidates: true });
  for (let i = 0; i < 3; i++) await service.record(scope, { id: 'source-' + i, text: `CORE_CACHE 项目事实 ${['甲', '乙', '丙'][i]}。`, taskId: 'task-' + i });
  await service.record(other, { id: 'unrelated', text: 'CORE_CACHE 属于另一个项目。' });
  await service.processPending();
  let dashboard = await service.dashboard() as any;
  const summary = dashboard.memories.find((row: any) => row.type === 'summary');
  assert.ok(summary);
  assert.equal(summary.state, 'candidate'); assert.equal(summary.scope, 'project');
  assert.equal(summary.sources.length, 3); assert.equal(summary.lineage.memberIds.length, 3);
  assert.equal(dashboard.totals.active, 0); assert.equal(local.calls, 1);
  const next = await service.bind({ workspace: '/project', sessionId: 'b', origin: 'mcp', includeCandidates: true });
  assert.ok((await service.recall(next, 'CORE_CACHE')).memories.some(memory => memory.id === summary.id));
  assert.equal((await service.feedback(next, { taskId: 'task-0', sourceIds: [summary.sources[0].id], text: '验证通过：CORE_CACHE' })).verified, false);
  await service.processPending(); assert.equal(local.calls, 1);
  await service.close(); service = await MemoryService.open(directory, { models: local });
  await service.processPending(); assert.equal(local.calls, 1, 'completed summaries survive restart');
  const host = await service.bind({ workspace: '/project', sessionId: 'host', origin: 'hook' });
  const source = summary.sources[0];
  const preview = await service.manage(host, (await service.issueIntent(host, { action: 'delete-preview', target: source.id, expectedVersion: 1 })).intentToken);
  assert.ok(preview.affectedMemories.some((row: any) => row.id === summary.id));
  await service.manage(host, (await service.issueIntent(host, { action: 'delete', previewId: preview.previewId })).intentToken);
  await service.processPending();
  dashboard = await service.dashboard() as any;
  assert.equal(dashboard.memories.some((row: any) => row.id === summary.id), false);
});

test('source deletion during synthesis discards the late summary', async t => {
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const directory = await mkdtemp(join(tmpdir(), 'banana-summary-race-'));
  const service = await MemoryService.open(directory, { models: models(async () => { started(); await barrier; }) });
  let work: Promise<void> | undefined;
  t.after(async () => { release(); await work; await service.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = await service.bind({ workspace: '/project', sessionId: 'a', origin: 'hook' });
  const events = [];
  for (let i = 0; i < 3; i++) events.push(await service.record(scope, { id: 'source-' + i, text: `CORE_CACHE 项目事实 ${['甲', '乙', '丙'][i]}。`, role: 'user' }));
  work = service.processPending(); await entered;
  const preview = await service.manage(scope, (await service.issueIntent(scope, { action: 'delete-preview', target: events[0]!.id, expectedVersion: 1 })).intentToken);
  await service.manage(scope, (await service.issueIntent(scope, { action: 'delete', previewId: preview.previewId })).intentToken);
  release(); await work;
  assert.equal((await service.dashboard() as any).totals.summaries, 0);
});

test('correction invalidates derived summaries immediately and fabricated evidence cannot publish', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-summary-correction-'));
  const local = models();
  const service = await MemoryService.open(directory, { models: local });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = await service.bind({ workspace: '/project', sessionId: 'a', origin: 'hook', includeCandidates: true });
  for (let i = 0; i < 3; i++) await service.record(scope, { id: 'source-' + i, text: `CORE_CACHE 项目事实 ${['甲', '乙', '丙'][i]}。`, role: 'user' });
  await service.processPending();
  const dashboard = await service.dashboard() as any;
  const summary = dashboard.memories.find((row: any) => row.type === 'summary');
  const member = dashboard.memories.find((row: any) => row.id === summary.lineage.memberIds[0]);
  await service.manage(scope, (await service.issueIntent(scope, { action: 'correct', target: member.id, expectedVersion: member.version, text: 'CORE_CACHE 已修改，不再使用此前配置。' })).intentToken);
  assert.equal((await service.inspect(scope, summary.id)).data.state, 'review');
  assert.equal((await service.recall(scope, 'CORE_CACHE')).memories.some(row => row.id === summary.id), false);
  local.summarize = async members => ({ text: '伪造总结', evidence: members.map(member => ({ memberId: member.id, quote: '原文中不存在的证据' })) });
  await service.processPending();
  assert.equal((await service.dashboard() as any).memories.some((row: any) => row.text === '伪造总结'), false);
  assert.ok((await service.inspect(scope)).summaryJobs.some((job: any) => job.state === 'failed'));
});

test('split observations and derived echoes do not count as independent corroboration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-summary-echo-'));
  const local = models();
  local.extract = async events => events.flatMap(event => event.text.split('|').map(text => ({ type: 'fact', scope: 'project', text, sourceIds: [event.id], conditions: [], confidence: 1, evidence: [{ sourceId: event.id, quote: text }] })));
  const service = await MemoryService.open(directory, { models: local });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = await service.bind({ workspace: '/project', sessionId: 'a', origin: 'mcp', includeCandidates: true });
  const original = await service.record(scope, { id: 'original', text: 'CORE_CACHE 甲|CORE_CACHE 乙|CORE_CACHE 丙' });
  await service.record(scope, { id: 'echo', text: 'CORE_CACHE 丁|CORE_CACHE 戊', sourceIds: [original.id] });
  await service.processPending();
  assert.equal((await service.dashboard() as any).totals.memories, 5);
  assert.equal(local.calls, 0);
});

test('foreground interruption queues synthesis again without exhausting its failure budget', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-summary-yield-'));
  const local = models();
  local.summarize = async () => { throw new ModelError('MODEL_PREPARING', 'Foreground retrieval has priority'); };
  const service = await MemoryService.open(directory, { models: local });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = await service.bind({ workspace: '/project', sessionId: 'a', origin: 'mcp' });
  for (const text of ['CORE_CACHE 甲', 'CORE_CACHE 乙', 'CORE_CACHE 丙']) await service.record(scope, { id: text, text });
  await service.processPending();
  const jobs = (await service.inspect(scope)).summaryJobs;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'queued'); assert.equal(jobs[0].attempts, 0); assert.equal(jobs[0].error, undefined);
});
