import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryService } from '../src/service.js';
import type { LocalModels } from '../src/models/types.js';

function blockedExtraction() {
  let release!: () => void;
  let started!: () => void;
  let calls = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const models: LocalModels = {
    status: () => ({ phase: 'ready', generationLoaded: false, embeddingLoaded: false, modelVersion: 'source-deletion-fixture' }),
    prepare: async () => {}, shutdown: async () => {},
    embed: async () => { throw new Error('controlled text fallback'); },
    extract: async events => {
      calls++;
      started();
      await barrier;
      return events.map(event => ({ type: 'fact', text: event.text, sourceIds: [event.id], conditions: [], confidence: 1, evidence: [{ sourceId: event.id, quote: event.text }] }));
    },
  };
  return { models, entered, release, calls: () => calls };
}

// PRD §10.2 and AC-13 require deletion of whole source events even before a memory exists.
test('deleting a source during extraction blocks late publication, restart recovery and both replay identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-source-deletion-'));
  const extraction = blockedExtraction();
  const input = { id: 'original-input', sourceRoot: 'original-root', role: 'user' as const, taskId: 'original-task', text: 'SOURCE_RETIREMENT uses the amber cache.' };
  let service: MemoryService | undefined;
  let processing: Promise<void> | undefined;
  try {
    service = await MemoryService.open(directory, { models: extraction.models });
    const scope = await service.bind({ workspace: '/workspace/source-deletion', sessionId: 'before-restart', origin: 'hook' });
    const event = await service.record(scope, input);
    assert.equal(event.status, 'received');
    assert.equal((await service.inspect(scope, event.id)).version, 1);
    processing = service.processPending(1);
    await extraction.entered;
    const preview = await service.manage(scope, (await service.issueIntent(scope, { action: 'delete-preview', target: event.id, expectedVersion: 1 })).intentToken);
    assert.deepEqual(preview.sources, [event.id]);
    assert.deepEqual(preview.affectedMemories, []);
    const deleted = await service.manage(scope, (await service.issueIntent(scope, { action: 'delete', previewId: preview.previewId })).intentToken);
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.cleanup.complete, true);
    await assert.rejects(service.inspect(scope, event.id), { code: 'UNAUTHORIZED' });
    assert.equal((await service.inspect(scope)).queue, 0);
    assert.equal((await service.recall(scope, 'SOURCE_RETIREMENT')).memories.length, 0);
    await assert.rejects(service.record(scope, { ...input, sourceRoot: 'another-root' }), { code: 'SOURCE_DELETED' });
    await assert.rejects(service.record(scope, { ...input, id: 'another-input' }), { code: 'SOURCE_DELETED' });

    extraction.release();
    await processing;
    assert.equal((await service.inspect(scope)).memories, 0, 'a valid-looking result from the deleted source must be discarded');
    assert.equal((await service.recall(scope, 'SOURCE_RETIREMENT', 'history')).memories.length, 0);
    await service.close();
    service = await MemoryService.open(directory, { models: extraction.models });
    const reopened = await service.bind({ workspace: '/workspace/source-deletion', sessionId: 'after-restart', origin: 'hook' });
    await service.processPending();
    const status = await service.inspect(reopened);
    assert.equal(status.events, 0);
    assert.equal(status.memories, 0);
    assert.equal(status.queue, 0);
    assert.equal(status.vectorQueue, 0);
    assert.equal(status.cleanupPending, false);
    assert.equal(extraction.calls(), 1, 'restart must not replay a deleted extraction job');
    await assert.rejects(service.inspect(reopened, event.id), { code: 'UNAUTHORIZED' });
    assert.equal((await service.recall(reopened, 'SOURCE_RETIREMENT')).memories.length, 0);
    assert.equal((await service.recall(reopened, 'SOURCE_RETIREMENT', 'history')).memories.length, 0);
    await assert.rejects(service.record(reopened, { ...input, sourceRoot: 'another-root' }), { code: 'SOURCE_DELETED' });
    await assert.rejects(service.record(reopened, { ...input, id: 'another-input' }), { code: 'SOURCE_DELETED' });
  } finally {
    extraction.release();
    await processing?.catch(() => {});
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a source deletion preview must be renewed when extraction publishes a previously unseen dependent memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-source-preview-'));
  const extraction = blockedExtraction();
  const service = await MemoryService.open(directory, { models: extraction.models });
  let processing: Promise<void> | undefined;
  try {
    const scope = await service.bind({ workspace: '/workspace/source-preview', sessionId: 'one', origin: 'hook' });
    const event = await service.record(scope, { id: 'source', role: 'user', text: 'PREVIEW_REFRESH uses the silver cache.' });
    processing = service.processPending(1);
    await extraction.entered;
    const preview = await service.manage(scope, (await service.issueIntent(scope, { action: 'delete-preview', target: event.id, expectedVersion: 1 })).intentToken);
    assert.deepEqual(preview.affectedMemories, []);
    const deletion = await service.issueIntent(scope, { action: 'delete', previewId: preview.previewId });
    extraction.release();
    await processing;
    const memory = (await service.recall(scope, 'PREVIEW_REFRESH')).memories[0];
    assert.ok(memory, 'the source must actually produce a memory before checking the stale preview');
    assert.equal((await service.inspect(scope, event.id)).version, 1, 'new dependent memory does not change the source version');
    await assert.rejects(service.manage(scope, deletion.intentToken), { code: 'VERSION_CONFLICT' });
    assert.equal((await service.recall(scope, 'PREVIEW_REFRESH')).memories.length, 1, 'rejected deletion must leave the newly published memory intact');
    const renewed = await service.manage(scope, (await service.issueIntent(scope, { action: 'delete-preview', target: event.id, expectedVersion: 1 })).intentToken);
    assert.deepEqual(renewed.sources, [event.id]);
    assert.deepEqual(renewed.affectedMemories, [{ id: memory.id, version: memory.version, text: memory.text }]);
    const deleted = await service.manage(scope, (await service.issueIntent(scope, { action: 'delete', previewId: renewed.previewId })).intentToken);
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.cleanup.complete, true);
    assert.equal((await service.recall(scope, 'PREVIEW_REFRESH')).memories.length, 0);
    assert.equal((await service.recall(scope, 'PREVIEW_REFRESH', 'history')).memories.length, 0);
  } finally {
    extraction.release();
    await processing?.catch(() => {});
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
