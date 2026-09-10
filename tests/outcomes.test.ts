import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyOutcome } from '../src/domain.js';
import { MemoryService } from '../src/service.js';
import type { LocalModels } from '../src/models/types.js';

test('outcome declarations reject questions and negated completion while preserving negative conditions', () => {
  for (const text of [
    '尚未验证通过：重建索引', 'we have not verified success: rebuild the index',
    '验证通过了吗？', 'verified success: did that really work?',
    '引用：验证通过：重建索引', '> verified success: rebuild the index',
    '验证通过：尚未验证成功，只启动了命令', 'verified success: we have not verified success',
    '验证通过：', '验证通过：是否真正生效', 'verified success: did all tests pass', 'verified success: not successful', '验证通过：完成\n实际上未验证',
  ]) assert.equal(classifyOutcome(text), 'unverified', text);
  for (const text of [
    '验证通过：node=22 时恢复缓存；离线时除外，不得删除生产数据。',
    '结果符合预期：支付写入不得自动重试。',
    'verified success: Never retry payment writes without the original idempotency key.',
    'verified outcome: all expected checks passed.',
  ]) assert.equal(classifyOutcome(text), 'success', text);
  for (const text of ['验证失败，反例：node=22 下仍然报错。', '验证失败：缓存没有恢复。', 'verified failure: the index remains corrupt.', 'counterexample: the known input still fails.']) assert.equal(classifyOutcome(text), 'failure', text);
});

test('three negated outcomes across two sessions do not promote experience; explicit results still do', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-outcomes-'));
  const episode = 'node=22 时重建索引可恢复 ERR_CACHE；离线时除外，不得删除生产数据。';
  const models: LocalModels = {
    status: () => ({ phase: 'ready', generationLoaded: false, embeddingLoaded: false, modelVersion: 'outcome-fixture' }),
    prepare: async () => {}, shutdown: async () => {},
    embed: async () => { throw new Error('controlled text fallback'); },
    extract: async events => events.filter(event => event.text.includes(episode)).map(event => ({ type: 'episode', text: episode, sourceIds: [event.id], conditions: ['node=22', '离线时除外', '不得删除生产数据'], confidence: 1, evidence: [{ sourceId: event.id, quote: episode }] })),
  };
  const service = await MemoryService.open(directory, { models, now: () => Date.parse('2026-09-10T00:00:00Z') });
  try {
    const first = await service.bind({ workspace: '/workspace/outcome-regression', sessionId: 'first', origin: 'hook' });
    const second = await service.bind({ workspace: '/workspace/outcome-regression', sessionId: 'second', origin: 'hook' });
    await service.updateEnvironment(first, { node: '22' });
    const unverified = [`尚未验证通过：${episode}`, `we have not verified success: ${episode}`, `验证通过了吗？${episode}`];
    const observed: boolean[] = [];
    for (let i = 0; i < unverified.length; i++) {
      const scope = i === 2 ? second : first;
      const source = await service.record(scope, { id: `uncertain-${i}`, role: 'user', taskId: `uncertain-task-${i}`, text: unverified[i]! });
      await service.processPending();
      observed.push((await service.feedback(scope, { taskId: `uncertain-task-${i}`, sourceIds: [source.id], text: 'check the actual source outcome' })).verified);
    }
    const afterUnverified = await service.recall(first, 'ERR_CACHE');
    assert.equal(afterUnverified.memories.some(memory => memory.type === 'experience'), false, 'negated or interrogative source outcomes must not promote an experience');
    assert.deepEqual(observed, [false, false, false]);
    assert.ok(afterUnverified.memories.some(memory => memory.text.includes('不得删除生产数据')));
    for (let i = 0; i < 3; i++) {
      const scope = i === 2 ? second : first;
      const source = await service.record(scope, { id: `success-${i}`, role: 'user', taskId: `success-task-${i}`, text: `${i === 2 ? 'verified success' : '验证通过'}：${episode}` });
      await service.processPending();
      assert.equal((await service.feedback(scope, { taskId: `success-task-${i}`, sourceIds: [source.id], text: 'verified result with original conditions' })).verified, true);
    }
    const promoted = (await service.recall(first, 'ERR_CACHE')).memories.find(memory => memory.type === 'experience');
    assert.ok(promoted); assert.ok(promoted.text.includes('离线时除外')); assert.ok(promoted.text.includes('不得删除生产数据'));
    const counterexample = await service.record(second, { id: 'failure', role: 'user', taskId: 'failure-task', text: `验证失败，反例：${episode}` });
    assert.equal((await service.feedback(second, { taskId: 'failure-task', sourceIds: [counterexample.id], text: 'explicit failure' })).verified, true);
    assert.equal((await service.recall(first, 'ERR_CACHE')).memories.some(memory => memory.type === 'experience'), false);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
