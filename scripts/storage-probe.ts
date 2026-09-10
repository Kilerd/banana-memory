import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { connect } from '@lancedb/lancedb';
import { RECORDS_TABLE, UnifiedStore, VECTOR_DIMENSIONS, type StoredRecord } from '../src/store.js';

const root = await mkdtemp(join(tmpdir(), 'banana-storage-probe-'));
let store = await UnifiedStore.open(root);
const marker = 'PURGE_SENTINEL_614283794';
const vector = (axis: number) => Array.from({ length: VECTOR_DIMENSIONS }, (_, index) => index === axis ? 1 : 0);
const item = (id: string, kind: string, text?: string, version = 1): StoredRecord => ({
  id, kind, text, version, projectId: 'project-a', data: { generation: version },
});
const require = createRequire(import.meta.url);
const sdk = JSON.parse(await readFile(join(dirname(require.resolve('@lancedb/lancedb')), '..', 'package.json'), 'utf8')) as { version: string };
const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(),
  platform: { os: process.platform, arch: process.arch, kernel: release(),
    macOS: process.platform === 'darwin' ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() : null,
    cpu: cpus()[0]?.model, physicalMemoryGiB: totalmem() / 1024 ** 3,
    node: process.version, lanceDB: sdk.version },
  scope: 'Real local OSS SDK, one records table. Storage-only probes; not a model, Claude client, or 16 GiB performance acceptance.',
};

async function sentinelFiles(path: string): Promise<number> {
  let found = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const next = join(path, entry.name);
    found += entry.isDirectory() ? await sentinelFiles(next) : Number((await readFile(next)).includes(Buffer.from(marker)));
  }
  return found;
}

try {
  const begin = await store.inspectStorage();
  await store.commit([
    item('event', 'event', marker),
    { ...item('memory', 'memory', marker), vector: vector(0) },
    { ...item('relation', 'relation'), data: { from: 'memory', fromVersion: 1, to: 'event', toVersion: 1 } },
    item('job', 'job'), item('control', 'control'),
  ]);
  const published = await store.inspectStorage();
  assert.equal(published.version, begin.version + 1);
  for (let attempt = 0; attempt < 10; attempt++) await store.commit([item('event', 'event', marker)]);
  assert.equal((await store.all('event')).length, 1);
  report.atomicPublication = { beforeVersion: begin.version, afterVersion: published.version, objects: 5, duplicateRetries: 10, logicalEvents: 1 };

  await store.commit(Array.from({ length: 256 }, (_, index) => ({ ...item(`filler-${index}`, 'memory', `tool baseline ${index}`), vector: vector(1) })));
  await store.maintainIndexes();
  await store.commit([{ ...item('fresh', 'memory', '中文新增 E_FRESH_81347'), vector: vector(2) }]);
  const reader = await connect(root, { readConsistencyInterval: 0 });
  const raw = await reader.openTable(RECORDS_TABLE);
  const stats = await raw.indexStats('text_idx');
  assert.ok(stats && stats.numUnindexedRows > 0);
  assert.equal((await raw.query().fullTextSearch('E_FRESH_81347').toArray())[0]?.id, 'fresh');
  assert.equal((await store.searchVector('project-a', vector(2), 1))[0]?.id, 'fresh');
  await store.commit([{ ...item('fresh', 'memory', '中文纠正 E_FIXED_81347', 2), vector: vector(3) }]);
  assert.deepEqual(await raw.query().fullTextSearch('E_FRESH_81347').toArray(), []);
  assert.equal((await store.searchVector('project-a', vector(3), 1))[0]?.version, 2);
  report.indexVisibility = { indexedRows: stats.numIndexedRows, unindexedRows: stats.numUnindexedRows, nativeFtsFreshVisible: true, vectorFreshVisible: true, correctedVersion: 2, oldFtsTextAbsent: true };

  const oldVersion = await raw.version();
  await (await raw.tags()).create('probe-retained-tag', oldVersion);
  const branch = await (await raw.branches()).create('probe-retained-branch');
  branch.close();
  raw.close();
  reader.close();
  const beforePurge = await store.inspectStorage();
  const sentinelBefore = await sentinelFiles(root);
  assert.ok(sentinelBefore > 0);
  await store.commit([{ ...item('tombstone', 'tombstone'), data: { sourceId: 'event' } }]);
  const purge = await store.purge(['event', 'memory', 'relation', 'job']);
  const sentinelAfter = await sentinelFiles(root);
  assert.equal(purge.complete, true);
  assert.equal(sentinelAfter, 0);
  assert.equal((await store.get('tombstone'))?.data.sourceId, 'event');
  report.physicalPurge = { versionsBefore: beforePurge.versions.length, ...purge, sentinelFilesBefore: sentinelBefore, sentinelFilesAfter: sentinelAfter };

  const times: number[] = [];
  for (let count = 0; count < 50; count++) {
    const started = performance.now();
    await store.searchText('project-a', 'E_FIXED_81347', 20);
    await store.searchVector('project-a', vector(3), 20);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  report.storageMicrobenchmark = {
    description: 'Sequential text and vector reads on about 260 rows after purge; no embedding, adapter or Claude latency included.',
    runs: times.length, p50Ms: times[24], p95Ms: times[47], currentProcessRssMiB: process.memoryUsage().rss / 1024 ** 2,
  };

  await store.close();
  const moduleUrl = new URL('../src/store.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { UnifiedStore } from ${JSON.stringify(moduleUrl)};
    const store = await UnifiedStore.open(${JSON.stringify(root)});
    for (let generation = 1; generation < 100; generation++) {
      await store.commit(Array.from({ length: 64 }, (_, index) => ({
        id: 'crash-' + index, kind: index % 2 ? 'event' : 'job', projectId: 'crash-project',
        version: generation, data: {generation}, text: 'x'.repeat(4096)
      })));
      process.stdout.write('ack:' + generation + '\\n');
    }
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);
  try {
    await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error(`No durable acknowledgement: ${stderr}`); })]);
    child.kill('SIGKILL');
    await exited;
  } finally {
    clearTimeout(timeout);
    child.kill('SIGKILL');
  }
  store = await UnifiedStore.open(root);
  const recovered = await store.all(undefined, 'crash-project');
  assert.equal(recovered.length, 64);
  const generations = [...new Set(recovered.map(row => row.version))];
  assert.equal(generations.length, 1);
  assert.equal(await store.get('event'), undefined);
  report.crashRecovery = { signal: 'SIGKILL', acknowledged: true, recoveredRows: recovered.length, completeGenerations: generations, deletedSourceAbsent: true };
  report.status = 'passed';
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
