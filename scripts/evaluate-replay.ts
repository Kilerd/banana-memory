import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MemoryService } from '../src/service.js';
import type { ContextBundle, EventInput, Scope } from '../src/domain.js';
import type { ExplicitIntent } from '../src/host/contracts.js';
import { FixtureModels, type FixtureExtraction } from './fixture-models.js';

interface ExpectedMemory { id: string; text: string; version: number }
interface Operation { action: string; times?: number; text?: string; days?: number; values?: Record<string, string>; evidence?: string }
interface Checkpoint {
  id: string; scope: 'same' | 'other'; query: string; mode: 'current' | 'history'; before: Operation[];
  expected: { include: ExpectedMemory[]; excludeIds: string[]; excludeText: string[]; empty?: boolean };
}
interface Task {
  id: string; scenario: string; project: string; sessionId: string; inputOrigin: 'hook' | 'mcp';
  event: EventInput; candidate: FixtureExtraction; initialEnvironment: Record<string, string>; checkpoints: Checkpoint[];
}
interface Replay { version: string; startTime: string; projects: Record<string, string>; tasks: Task[] }

const fixturePath = new URL('../fixtures/replay.json', import.meta.url);
const replay = JSON.parse(await readFile(fixturePath, 'utf8')) as Replay;
if (replay.tasks.length !== 40 || replay.tasks.reduce((sum, task) => sum + task.checkpoints.length, 0) !== 160) throw new Error('Expected exactly 40 tasks and 160 checkpoints');
const directory = await mkdtemp(join(tmpdir(), 'banana-replay-'));
let now = Date.parse(replay.startTime);
// No expected answer, memory id or query checkpoint is passed to this model.
const models = new FixtureModels(replay.tasks.map(task => task.candidate));
let service = await MemoryService.open(directory, { models, now: () => now });
const failures: Array<{ checkpoint: string; reason: string; returned: Array<{ id: string; version: number; text: string }> }> = [];
const observations: Array<{ checkpoint: string; scenario: string; returnedIds: string[]; degradation?: string; latencyMs: number; passed: boolean }> = [];
let positiveExpected = 0;
let positiveFound = 0;
let sourceChecks = 0;
let sourceFailures = 0;
let crossProjectLeaks = 0;
let deletedLeaks = 0;
let correctedLeaks = 0;
let duplicateAttempts = 0;
let physicalPurges = 0;
const deletedIds = new Set<string>();
const staleTexts = new Set<string>();
const owners = new Map(replay.tasks.flatMap(task => task.checkpoints[0]!.expected.include.map(memory => [memory.id, task.project] as const)));
let latestBundle: ContextBundle | undefined;

async function bind(task: Task, project = task.project, origin: 'hook' | 'mcp' = task.inputOrigin): Promise<Scope> {
  return service.bind({ workspace: replay.projects[project]!, sessionId: task.sessionId, origin });
}
async function manage(scope: Scope, intent: ExplicitIntent): Promise<Record<string, any>> {
  return service.manage(scope, (await service.issueIntent(scope, intent)).intentToken);
}

try {
  for (const task of replay.tasks) {
    now += 60_000;
    let scope = await bind(task);
    let trusted = await bind(task, task.project, 'hook');
    if (Object.keys(task.initialEnvironment).length) await service.updateEnvironment(trusted, task.initialEnvironment);
    await service.record(scope, { ...task.event, occurredAt: new Date(now).toISOString() });
    await service.processPending(100);
    const target = task.checkpoints[0]!.expected.include[0];
    for (const checkpoint of task.checkpoints) {
      for (const operation of checkpoint.before) {
        if (operation.action === 'restart') {
          await service.close();
          service = await MemoryService.open(directory, { models, now: () => now });
          scope = await bind(task); trusted = await bind(task, task.project, 'hook');
          await service.processPending(100);
        } else if (operation.action === 'retry') {
          const before = Number((await service.inspect(scope)).events);
          for (let count = 0; count < operation.times!; count++) {
            const result = await service.record(scope, task.event);
            if (result.status !== 'duplicate') throw new Error(`Retry was not idempotent: ${task.id}`);
            duplicateAttempts++;
          }
          await service.processPending(100);
          if (Number((await service.inspect(scope)).events) !== before) throw new Error('Duplicate event changed evidence count');
        } else if (operation.action === 'correct') {
          await manage(trusted, { action: 'correct', target: target!.id, expectedVersion: target!.version, text: operation.text! });
          staleTexts.add(target!.text);
          if (latestBundle && (await service.deliver(scope, latestBundle)).memories.length !== 0) throw new Error('Pre-correction bundle was delivered');
        } else if (operation.action === 'delete') {
          const preview = await manage(trusted, { action: 'delete-preview', target: target!.id, expectedVersion: target!.version });
          const deletion = await manage(trusted, { action: 'delete', previewId: String(preview.previewId) });
          if (deletion.cleanup.complete !== true) throw new Error(`Physical purge incomplete: ${task.id}`);
          physicalPurges++;
          deletedIds.add(target!.id);
          await service.record(scope, task.event).then(() => { throw new Error('Deleted source was accepted again'); }, error => {
            if (error.code !== 'SOURCE_DELETED') throw error;
          });
        } else if (operation.action === 'pause' || operation.action === 'resume') {
          await manage(trusted, { action: operation.action });
        } else if (operation.action === 'recordWhilePaused') {
          const before = Number((await service.inspect(scope)).events);
          const result = await service.record(scope, { ...task.event, id: task.event.id + '-paused', text: 'PAUSED_INPUT_MUST_NOT_BE_STORED' });
          if (result.status !== 'paused' || Number((await service.inspect(scope)).events) !== before) throw new Error('Paused event was captured');
        } else if (operation.action === 'advanceDays') {
          now += operation.days! * 86_400_000;
        } else if (operation.action === 'pin') {
          await manage(trusted, { action: 'pin', target: target!.id, expectedVersion: target!.version });
        } else if (operation.action === 'environment') {
          await service.updateEnvironment(trusted, operation.values!);
        } else if (operation.action === 'counterexample') {
          const taskId = task.id + '-counterexample';
          const source = await service.record(trusted, { id: taskId, taskId, role: 'user', text: `验证失败，反例：${task.event.text} ${operation.evidence}` });
          const result = await service.feedback(trusted, { taskId, sourceIds: [source.id], text: operation.evidence! });
          if (!result.verified) throw new Error('Trusted counterexample was not verified');
        } else throw new Error(`Unknown fixture operation ${operation.action}`);
      }
      const queryScope = checkpoint.scope === 'same' ? scope : await bind(task, task.project === 'a' ? 'b' : 'a');
      const start = performance.now();
      const bundle = await service.recall(queryScope, checkpoint.query, checkpoint.mode);
      if (checkpoint.scope === 'same') latestBundle = bundle;
      const elapsed = performance.now() - start;
      const reasons: string[] = [];
      for (const expected of checkpoint.expected.include) {
        positiveExpected++;
        if (bundle.memories.some(memory => memory.id === expected.id && memory.version === expected.version && memory.text === expected.text)) positiveFound++;
        else reasons.push(`missing expected memory ${expected.id} v${expected.version}`);
      }
      for (const memory of bundle.memories) {
        const queriedProject = checkpoint.scope === 'same' ? task.project : task.project === 'a' ? 'b' : 'a';
        if (owners.has(memory.id) && owners.get(memory.id) !== queriedProject) {
          crossProjectLeaks++; reasons.push(`memory from another project ${memory.id}`);
        }
        if (checkpoint.expected.excludeIds.includes(memory.id) || checkpoint.expected.excludeText.some(text => memory.text.includes(text))) {
          reasons.push(`forbidden memory ${memory.id}`);
        }
        if (deletedIds.has(memory.id)) { deletedLeaks++; reasons.push('deleted source resurfaced'); }
        if (staleTexts.has(memory.text)) { correctedLeaks++; reasons.push('corrected old fact resurfaced'); }
        for (const source of memory.sources) {
          sourceChecks++;
          const event = await service.inspect(queryScope, source).catch(() => undefined);
          if (!event || event.kind !== 'event' || !String(event.data.text).includes(memory.text)) { sourceFailures++; reasons.push(`invalid source ${source}`); }
        }
      }
      if (bundle.memories.length > 6 || bundle.tokens > 800) reasons.push('context budget exceeded');
      if (checkpoint.expected.empty && bundle.memories.length > 0) reasons.push('expected empty context');
      if (reasons.length) failures.push({ checkpoint: checkpoint.id, reason: reasons.join('; '), returned: bundle.memories.map(({ id, version, text }) => ({ id, version, text })) });
      observations.push({ checkpoint: checkpoint.id, scenario: task.scenario, returnedIds: bundle.memories.map(memory => memory.id), degradation: bundle.degradation, latencyMs: elapsed, passed: reasons.length === 0 });
    }
  }
  const report = {
    version: replay.version, executedAt: new Date().toISOString(), status: failures.length ? 'failed' : 'passed',
    scope: 'Deterministic model-output replay through the real Memory Service and LanceDB. Measures consistency, not real-model quality or production Recall@6.',
    tasks: replay.tasks.length, checkpoints: observations.length, passedCheckpoints: observations.filter(item => item.passed).length,
    projects: Object.keys(replay.projects).length, scenarios: [...new Set(replay.tasks.map(task => task.scenario))],
    expectedPositiveMemories: positiveExpected, retrievedPositiveMemories: positiveFound,
    fixtureRecallAt6: positiveFound / positiveExpected, sourceChecks, sourceFailures,
    crossProjectLeaks, deletedLeaks, correctedLeaks, duplicateAttempts, physicalPurges,
    failures, observations,
  };
  const output = process.argv.indexOf('--output');
  if (output >= 0 && process.argv[output + 1]) await writeFile(resolve(process.argv[output + 1]!), `${JSON.stringify(report, null, 2)}\n`);
  const { observations: _, ...summary } = report;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
} finally {
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
