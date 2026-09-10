import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeHook } from '../src/host/adapter.js';
import { MemoryService } from '../src/service.js';
import type { LocalModels } from '../src/models/types.js';

test('a canonical python3 version hook excludes Python 3.12 memories after a 3.13 upgrade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'banana-python-environment-'));
  const models: LocalModels = {
    status: () => ({ phase: 'ready', generationLoaded: true, embeddingLoaded: true, modelVersion: 'runtime-fixture-1' }),
    prepare: async () => {}, shutdown: async () => {},
    embed: async () => { throw new Error('fixture: lexical retrieval only'); },
    extract: async events => events.map(event => ({
      type: 'fact', text: event.text, sourceIds: [event.id],
      conditions: event.text.includes('python3=3.12') ? ['python3=3.12'] : [],
      confidence: 1, evidence: [{ sourceId: event.id, quote: event.text }]
    }))
  };
  const service = await MemoryService.open(directory, { models });
  try {
    const scope = await service.bind({ workspace: directory, sessionId: 'python-upgrade', origin: 'hook' });
    const updateFromHook = async (version: string) => {
      const event = await normalizeHook({
        hook_event_name: 'PostToolUse', session_id: scope.sessionId, tool_name: 'Bash',
        tool_use_id: `python-version-${version}`, tool_input: { command: 'python3 --version' },
        tool_response: { stdout: `Python ${version}\n`, stderr: '' }
      }, directory);
      assert.equal(event.filtered, false);
      const reported = JSON.parse(event.text) as { runtime: string; version: string };
      assert.deepEqual(reported, { runtime: 'python', version });
      await service.updateEnvironment(scope, { [reported.runtime]: reported.version });
    };

    await updateFromHook('3.12.8');
    await service.record(scope, { id: 'natural', role: 'user', text: 'Python3 3.12 is required to resolve ERR_PYTHON_NATURAL.' });
    await service.record(scope, { id: 'conditional', role: 'user', text: 'When python3=3.12, resolve ERR_PYTHON_CONDITION with the compatibility adapter.' });
    await service.record(scope, { id: 'unrelated', role: 'user', text: 'Project documentation for DOCS_LOCATION lives in docs/.' });
    await service.processPending();

    const natural = await service.recall(scope, 'ERR_PYTHON_NATURAL');
    const conditional = await service.recall(scope, 'ERR_PYTHON_CONDITION');
    assert.equal(natural.memories.length, 1);
    assert.equal(conditional.memories.length, 1);
    for (const memory of [...natural.memories, ...conditional.memories]) {
      assert.deepEqual((await service.inspect(scope, memory.id)).data.environment, { python: '3.12' });
    }
    assert.deepEqual(conditional.memories[0]!.conditions, ['python3=3.12']);

    await updateFromHook('3.13.0');
    assert.equal((await service.recall(scope, 'ERR_PYTHON_NATURAL')).memories.length, 0);
    assert.equal((await service.recall(scope, 'ERR_PYTHON_CONDITION')).memories.length, 0);
    assert.equal((await service.deliver(scope, natural)).text, '');
    assert.equal((await service.deliver(scope, conditional)).text, '');
    assert.equal((await service.inspect(scope, natural.memories[0]!.id)).effectiveState, 'review');
    assert.equal((await service.inspect(scope, conditional.memories[0]!.id)).effectiveState, 'review');
    assert.equal((await service.recall(scope, 'DOCS_LOCATION')).memories.length, 1);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
