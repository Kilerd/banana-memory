import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connect } from '@lancedb/lancedb';
import { RECORDS_TABLE, UnifiedStore, VECTOR_DIMENSIONS, type StoredRecord } from '../src/store.js';

const vector = (axis = 0) => Array.from({ length: VECTOR_DIMENSIONS }, (_, index) => index === axis ? 1 : 0);
const record = (id: string, kind = 'memory', overrides: Partial<StoredRecord> = {}): StoredRecord => ({
  id, kind, projectId: 'project-a', version: 1, data: { state: 'active', source: 'event-1' },
  text: `Memory ${id}`, ...overrides,
});

async function fixture(t: test.TestContext): Promise<{ path: string; store: UnifiedStore }> {
  const path = await mkdtemp(join(tmpdir(), 'banana-store-'));
  const store = await UnifiedStore.open(path);
  t.after(async () => { await store.close(); await rm(path, { recursive: true, force: true }); });
  return { path, store };
}

async function filesContaining(path: string, marker: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) found.push(...await filesContaining(child, marker));
    else if ((await readFile(child)).includes(Buffer.from(marker))) found.push(child);
  }
  return found;
}

test('all record families share an idempotent, durable publication', async t => {
  const { path, store } = await fixture(t);
  const records = ['project', 'event', 'memory', 'relation', 'job', 'bundle', 'control', 'tombstone']
    .map(kind => record(`${kind}-1`, kind));
  for (let retry = 0; retry < 10; retry++) await store.commit(records);
  assert.equal((await store.all()).length, records.length);
  await store.close();
  const reopened = await UnifiedStore.open(path);
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.all()).sort((a, b) => a.id.localeCompare(b.id)), records.sort((a, b) => a.id.localeCompare(b.id)));
});

test('a rejected mixed publication cannot expose its valid prefix', async t => {
  const { path, store } = await fixture(t);
  await store.commit([record('memory-1')]);
  const before = await store.inspectStorage();
  await assert.rejects(store.commit([
    record('memory-1', 'memory', { version: 2, text: 'must not publish' }),
    record('memory-2', 'memory', { vector: [1, 2] }),
  ]), /INVALID_VECTOR/);
  assert.equal((await store.inspectStorage()).version, before.version);
  await store.close();
  const reopened = await UnifiedStore.open(path);
  t.after(() => reopened.close());
  assert.equal((await reopened.get('memory-1'))?.version, 1);
  assert.equal(await reopened.get('memory-2'), undefined);
});

test('text and vector searches see unindexed new and corrected rows, scoped to project', async t => {
  const { path, store } = await fixture(t);
  await store.commit(Array.from({ length: 256 }, (_, index) => record(`indexed-${index}`, 'memory', {
    text: `baseline package tool ${index}`, vector: vector(1),
  })));
  await store.maintainIndexes();
  await store.commit([
    record('fresh', 'memory', { text: '独特中文故障 E_NEW_93077 pnpm', vector: vector() }),
    record('other', 'memory', { projectId: 'project-b', text: '独特中文故障 E_NEW_93077 pnpm', vector: vector() }),
    record('no-vector', 'memory', { text: 'null embedding is allowed' }),
  ]);
  assert.deepEqual((await store.searchText('project-a', 'E_NEW_93077', 20)).map(row => row.id), ['fresh']);
  assert.deepEqual((await store.searchText('project-a', '独特中文故障', 20)).map(row => row.id), ['fresh']);
  assert.equal((await store.searchVector('project-a', vector(), 1))[0]?.id, 'fresh');
  assert.equal((await store.searchVector('project-a', vector(), 20)).some(row => row.projectId !== 'project-a'), false);
  const reader = await connect(path, { readConsistencyInterval: 0 });
  const raw = await reader.openTable(RECORDS_TABLE);
  t.after(() => { raw.close(); reader.close(); });
  // Assert the native FTS engine itself includes fresh fragments. The store's
  // exact-substring channel must not conceal an incomplete index implementation.
  assert.ok((await raw.indexStats('text_idx'))!.numUnindexedRows > 0);
  assert.equal((await raw.query().fullTextSearch('E_NEW_93077').where("projectId = 'project-a'").toArray())[0]?.id, 'fresh');
  await store.commit([
    record('fresh', 'memory', { version: 2, text: 'corrected E_FIXED_93077', vector: vector(2) }),
    record('source-relation', 'relation', { version: 2, data: { from: 'fresh', fromVersion: 2, to: 'event-1' } }),
    record('generation', 'control', { version: 2, data: { generation: 2 } }),
  ]);
  assert.deepEqual(await store.searchText('project-a', 'E_NEW_93077', 20), []);
  assert.equal((await store.searchText('project-a', 'E_FIXED_93077', 20))[0]?.version, 2);
  assert.equal((await store.searchVector('project-a', vector(2), 1))[0]?.version, 2);
  assert.equal((await store.get('source-relation'))?.data.fromVersion, 2);
  assert.deepEqual(await raw.query().fullTextSearch('E_NEW_93077').where("projectId = 'project-a'").toArray(), []);
  assert.equal((await raw.query().fullTextSearch('E_FIXED_93077').where("projectId = 'project-a'").toArray())[0]?.version, 2);
});

test('SQL-shaped project ids and text remain literal and cannot cross scope', async t => {
  const { store } = await fixture(t);
  await store.commit([
    record('safe', 'memory', { text: "can't run E_ACCESS" }),
    record('secret', 'memory', { projectId: 'other', text: 'E_ACCESS' }),
  ]);
  assert.deepEqual(await store.searchText("' OR true --", 'E_ACCESS', 20), []);
  assert.equal((await store.searchText('project-a', 'E_ACCESS', 20))[0]?.id, 'safe');
  assert.equal(await store.get("' OR true --"), undefined);
});

test('physical purge removes old versions, tagged snapshots, branches and indexed payloads', async t => {
  const { path, store } = await fixture(t);
  const marker = 'SECRET_PURGE_9367281254';
  await store.commit([
    record('event-secret', 'event', { text: marker, data: { body: marker } }),
    record('memory-secret', 'memory', { text: marker, data: { body: marker }, vector: vector() }),
    record('relation-secret', 'relation', { text: marker, data: { body: marker } }),
    record('bundle-secret', 'bundle', { text: marker, data: { body: marker } }),
    record('keep', 'memory', { text: 'retained context', vector: vector(1) }),
  ]);
  await store.maintainIndexes();
  const connection = await connect(path, { readConsistencyInterval: 0 });
  const table = await connection.openTable(RECORDS_TABLE);
  const oldVersion = await table.version();
  await (await table.tags()).create('retained-snapshot', oldVersion);
  const branch = await (await table.branches()).create('retained-branch');
  await branch.add([{ id: 'branch-only', kind: 'event', projectId: 'project-a', version: 1,
    data: JSON.stringify({ body: marker }), text: marker, vector: null }]);
  await (await branch.tags()).create('branch-retained-snapshot', await branch.version());
  branch.close();
  table.close();
  connection.close();
  assert.ok((await filesContaining(path, marker)).length > 0, 'fixture sentinel must exist before purge');
  await store.commit([record('deny-event-secret', 'tombstone', { text: undefined, data: { sourceId: 'event-secret' } })]);
  const result = await store.purge(['event-secret', 'memory-secret', 'relation-secret', 'bundle-secret']);
  assert.equal(result.complete, true);
  assert.equal(result.removedRows, 4);
  assert.deepEqual(result.removedTags.sort(), ['branch-retained-snapshot', 'retained-snapshot']);
  assert.deepEqual(result.removedBranches, ['retained-branch']);
  assert.equal(result.remainingVersions.length, 1);
  assert.deepEqual(await filesContaining(path, marker), []);
  assert.deepEqual(await store.searchText('project-a', marker, 20), []);
  assert.equal((await store.searchVector('project-a', vector(), 20)).some(row => row.id === 'memory-secret'), false);
  const reopened = await UnifiedStore.open(path);
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.all()).map(row => row.id).sort(), ['deny-event-secret', 'keep']);
});

test('purging the final row removes old data while keeping the store writable', async t => {
  const { store } = await fixture(t);
  await store.commit([record('last')]);
  assert.equal((await store.purge(['last'])).complete, true);
  assert.deepEqual(await store.all(), []);
  await store.commit([record('next')]);
  assert.equal((await store.get('next'))?.id, 'next');
});

test('periodic compaction preserves authoritative history and updates live indexes', async t => {
  const { store } = await fixture(t);
  await store.commit([record('current', 'memory', { text: 'original state' })]);
  await store.maintainIndexes();
  for (let version = 2; version <= 8; version++) {
    const previous = (await store.get('current'))!;
    await store.commit([
      { ...previous, id: `history-${version - 1}`, kind: 'history' },
      record('current', 'memory', { version, text: `E_REVISION_${version}` }),
    ]);
  }
  const oldSnapshots = (await store.inspectStorage()).versions;
  await store.compact();
  assert.equal((await store.all('history')).length, 7);
  assert.equal((await store.searchText('project-a', 'E_REVISION_8', 20))[0]?.version, 8);
  assert.ok((await store.inspectStorage()).versions.length < oldSnapshots.length);
});

test('SIGKILL after a durable acknowledgement recovers one complete publication', { timeout: 30_000 }, async t => {
  const { path, store } = await fixture(t);
  const batchSize = 64;
  await store.commit(Array.from({ length: batchSize }, (_, index) => record(`batch-${index}`, index % 2 ? 'job' : 'event')));
  await store.close();
  const moduleUrl = new URL('../src/store.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { UnifiedStore } from ${JSON.stringify(moduleUrl)};
    const store = await UnifiedStore.open(${JSON.stringify(path)});
    for (let version = 2; version < 100; version++) {
      await store.commit(Array.from({length: ${batchSize}}, (_, index) => ({
        id: 'batch-' + index, kind: index % 2 ? 'job' : 'event', projectId: 'project-a', version,
        data: {generation: version}, text: 'generation ' + version + ' '.repeat(4096)
      })));
      process.stdout.write('ack:' + version + '\\n');
    }
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += String(chunk); });
  t.after(() => { child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  await Promise.race([
    once(child.stdout, 'data'),
    exit.then(() => { throw new Error(`writer exited without acknowledgement: ${diagnostics}`); }),
  ]);
  child.kill('SIGKILL');
  await exit;
  const reopened = await UnifiedStore.open(path);
  t.after(() => reopened.close());
  const recovered = await reopened.all();
  assert.equal(recovered.length, batchSize);
  const versions = new Set(recovered.map(row => row.version));
  assert.equal(versions.size, 1, 'event and job rows must have the same committed generation');
  assert.ok(recovered.every(row => row.version >= 2));
});
