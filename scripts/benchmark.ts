import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { connect } from '@lancedb/lancedb';
import { MemoryService } from '../src/service.js';
import { ManagedLocalModels } from '../src/models/index.js';
import type { ContextBundle } from '../src/domain.js';
import { FixtureModels, type FixtureExtraction } from './fixture-models.js';
import { STORE_CACHE_BYTES } from '../src/store.js';

const execute = promisify(execFile);
function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function number(name: string, fallback: number): number {
  const value = Number(argument(name) ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
const eventCount = number('--events', 20_000);
const memoryCount = number('--memories', 5_000);
const queryCount = number('--queries', 200);
if (memoryCount > eventCount || memoryCount < 2 || queryCount % 2) throw new Error('Need 2 <= memories <= events and an even query count');
const suppliedDirectory = argument('--directory');
const reuse = process.argv.includes('--reuse');
if (reuse && !suppliedDirectory) throw new Error('--reuse requires an existing --directory');
const directory = suppliedDirectory ? resolve(suppliedDirectory) : await mkdtemp(join(tmpdir(), 'banana-benchmark-'));
const startedAt = new Date().toISOString();
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(`${directory}/${entry.name}`) : Promise.resolve(entry.name.endsWith('.ts') ? [`${directory}/${entry.name}`] : [])))).flat().sort();
}
const sourceFileSha256 = Object.fromEntries(await Promise.all([
  ...await sourceFiles('src'),
  'scripts/benchmark.ts', 'scripts/fixture-models.ts', 'models/manifest.json',
].map(async name => [name, createHash('sha256').update(await readFile(new URL(`../${name}`, import.meta.url))).digest('hex')])));
const realDirectory = argument('--models-dir');
const realModels = realDirectory ? new ManagedLocalModels({ directory: resolve(realDirectory) }) : undefined;
const markerFor = (index: number) => {
  let value = index;
  let suffix = '';
  for (let place = 0; place < 5; place++) { suffix = String.fromCharCode(65 + value % 26) + suffix; value = Math.floor(value / 26); }
  return `PERF_${suffix}`;
};
const textFor = (index: number) => `${markerFor(index)} This resource uses explicit limit ${index + 1}; the fact only applies to this workspace.`;
const candidates: FixtureExtraction[] = Array.from({ length: memoryCount }, (_, index) => ({ text: textFor(index), type: 'fact', conditions: [] }));
// Only extraction is replayed. --models-dir uses the actual pinned local model
// for both document vectors and every timed foreground query embedding.
const models = new FixtureModels(candidates, realModels);
// Read-only audit: the database is never populated through this connection.
// On reuse, validate before opening the Service so an invalid dataset is untouched.
async function verifyPersistedDataset(): Promise<{ events: number; memories: number; vectorMemories: number; matchingEmbeddingVersion: number }> {
  await stat(join(directory, 'memory.lance', 'records.lance'));
  const connection = await connect(join(directory, 'memory.lance'));
  try {
    const table = await connection.openTable('records');
    const events = await table.countRows("kind = 'event'");
    const memories = await table.countRows("kind = 'memory'");
    const vectorMemories = await table.countRows("kind = 'memory' AND vector IS NOT NULL");
    const metadata = await table.query().where("kind = 'memory'").select(['data']).toArray();
    const matchingEmbeddingVersion = metadata.filter(row => (JSON.parse(String(row.data)) as { embeddingVersion?: string }).embeddingVersion === models.status().modelVersion).length;
    if (events !== eventCount || memories !== memoryCount || vectorMemories !== memoryCount || matchingEmbeddingVersion !== memoryCount) {
      throw new Error(`Persisted dataset mismatch: ${events} events, ${memories} memories, ${vectorMemories} vectors, ${matchingEmbeddingVersion} current-model vectors`);
    }
    return { events, memories, vectorMemories, matchingEmbeddingVersion };
  } finally { connection.close(); }
}
const reusedDataset = reuse ? await verifyPersistedDataset() : undefined;
const seedReportPath = argument('--seed-report');
const seedReport = seedReportPath ? JSON.parse(await readFile(resolve(seedReportPath), 'utf8')) as Record<string, unknown> : undefined;
const started = performance.now();
if (realModels) await realModels.prepare();
const preparationMs = performance.now() - started;
const service = await MemoryService.open(directory, { models });
let peakHostRssMiB = 0;
const rssSample = setInterval(() => { peakHostRssMiB = Math.max(peakHostRssMiB, process.memoryUsage().rss / 1024 ** 2); }, 100);
rssSample.unref();
let physicalBytes = 0;
async function bytes(path: string): Promise<number> {
  let total = 0;
  for (const item of await readdir(path, { withFileTypes: true })) total += item.isDirectory() ? await bytes(join(path, item.name)) : (await stat(join(path, item.name))).size;
  return total;
}
function quantile(values: number[], fraction: number): number { return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]!; }

try {
  const scopes = await Promise.all([0, 1].map(session => service.bind({ workspace: `/benchmark/project-${session}/shared-name`, sessionId: `benchmark-session-${session}`, origin: 'hook' })));
  if (!reuse && ((await service.inspect(scopes[0]!)).events || (await service.inspect(scopes[1]!)).events)) throw new Error('Benchmark directory must contain an empty database');
  const ingestStart = performance.now();
  for (let index = 0; !reuse && index < eventCount; index++) {
    await service.record(scopes[index % 2]!, { id: `perf-event-${index}`, taskId: `perf-task-${index}`, role: 'user',
      text: index < memoryCount ? textFor(index) : `Audit event ${index}: no reusable memory candidate.`,
    });
    if ((index + 1) % 1000 === 0 || index + 1 === eventCount) {
      await service.processPending(1000);
      process.stderr.write(`Benchmark persisted and processed ${index + 1}/${eventCount} source events (${((performance.now() - ingestStart) / 1000).toFixed(1)} s).\n`);
    }
  }
  // Retry delays are not silently fast-forwarded. A failed batch remains visible.
  const status = await Promise.all(scopes.map(scope => service.inspect(scope)));
  const actualEvents = status.reduce((sum, item) => sum + Number(item.events), 0);
  const actualMemories = status.reduce((sum, item) => sum + Number(item.memories), 0);
  const remainingJobs = status.reduce((sum, item) => sum + Number(item.queue), 0);
  const remainingVectorJobs = status.reduce((sum, item) => sum + Number(item.vectorQueue), 0);
  if (actualEvents !== eventCount || actualMemories !== memoryCount || remainingJobs !== 0 || remainingVectorJobs !== 0) throw new Error(`Dataset incomplete: ${actualEvents} events, ${actualMemories} memories, ${remainingJobs} queued, ${remainingVectorJobs} vector jobs`);
  const ingestionMs = reuse ? null : performance.now() - ingestStart;
  const datasetValidation = reusedDataset ?? await verifyPersistedDataset();
  physicalBytes = await bytes(directory);
  const coldStart = performance.now();
  await service.recall(scopes[0]!, markerFor(0));
  const firstRecallMs = performance.now() - coldStart;
  for (let warmup = 0; warmup < 10; warmup++) await Promise.all(scopes.map((scope, session) => service.recall(scope, markerFor(session))));
  const latencies: number[] = [];
  const degradation: Record<string, number> = {};
  let exactHits = 0;
  let crossProjectLeaks = 0;
  async function measured(session: number, round: number): Promise<void> {
    let index = (round * 2 + session) % memoryCount;
    if (index % 2 !== session) index = session;
    const began = performance.now();
    const selected = await service.recall(scopes[session]!, markerFor(index));
    const bundle: ContextBundle = await service.deliver(scopes[session]!, selected);
    latencies.push(performance.now() - began);
    const state = bundle.degradation ?? 'none'; degradation[state] = (degradation[state] ?? 0) + 1;
    if (bundle.memories.some(memory => memory.text === textFor(index))) exactHits++;
    for (const memory of bundle.memories) {
      const match = /^PERF_([A-Z]{5})/.exec(memory.text);
      const owner = match?.[1] ? [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 65, 0) % 2 : session;
      if (owner !== session) crossProjectLeaks++;
    }
  }
  for (let round = 0; round < queryCount / 2; round++) await Promise.all([measured(0, round), measured(1, round)]);
  physicalBytes = Math.max(physicalBytes, await bytes(directory));
  // ps includes host and llama-server children. It is diagnostic, not a peak or
  // attribution of all processes that may exist elsewhere on the machine.
  let processes: string[] = [];
  try {
    const result = await execute('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm=']);
    processes = result.stdout.split('\n').filter(line => line.includes('llama-server') || new RegExp(`^\\s*${process.pid}\\s`).test(line)).map(line => line.trim());
  } catch { /* Process inspection may be blocked by the host sandbox. */ }
  const report = {
    executedAt: new Date().toISOString(), status: 'completed',
    startedAt, sourceFileSha256,
    phase: reuse ? 'queries-on-existing-service-dataset' : 'populate-and-query',
    ...(reuse ? { datasetOrigin: { directory, seedReportPath: seedReportPath ? resolve(seedReportPath) : undefined, seedStartedAt: seedReport?.startedAt, seedSourceFileSha256: seedReport?.sourceFileSha256 } } : {}),
    mode: realModels ? 'fixture-extraction-with-real-local-embedding' : 'fixture-extraction-and-fixture-embedding',
    scope: 'Dataset populated through MemoryService.record and processPending; timed recall includes query embedding, authoritative scope/state checks, bundle persistence and delivery checks. No Claude client or hook adapter timing.',
    machine: { cpu: cpus()[0]?.model, memoryGiB: totalmem() / 1024 ** 3, platform: process.platform, arch: process.arch, node: process.version },
    dataset: { events: actualEvents, memories: actualMemories, concurrentSessions: 2, projects: 2, remainingJobs, remainingVectorJobs },
    datasetValidation,
    preparationMs, ingestionMs, firstRecallMs,
    model: realModels?.status(), databaseCacheBudgetBytes: STORE_CACHE_BYTES,
    hotRecall: { samples: latencies.length, p50Ms: quantile(latencies, 0.5), p95Ms: quantile(latencies, 0.95), maxMs: Math.max(...latencies), exactHits, crossProjectLeaks, degradation },
    resources: { sampledPeakNodeRssMiB: peakHostRssMiB, measuredPeakDatabaseBytes: physicalBytes, processSnapshot: processes,
      limitations: 'Node RSS is sampled, child model RSS is a final snapshot, and disk is measured after ingestion and queries. Does not include model download temporary files, cold generation or Claude co-running impact.' },
    prdPerformanceGate: { measuredOn16GiBTarget: totalmem() / 1024 ** 3 <= 16.1, actualQueryEmbedding: !!realModels, actualHookAndClaudeAdapter: false, passed: false,
      reason: 'This harness alone cannot satisfy the PRD host/end-to-end and 16 GiB target requirements.' },
  };
  const output = argument('--output');
  if (output) await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  clearInterval(rssSample);
  await service.close();
  await realModels?.shutdown();
  if (!suppliedDirectory) await rm(directory, { recursive: true, force: true });
}
