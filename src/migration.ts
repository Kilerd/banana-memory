import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { digest } from './domain.js';
import { UnifiedStore, type StoredRecord } from './store.js';
import { resolveWorkspace } from './host/adapter.js';
import { privateDirectory, runtimeDirectory } from './host/ipc.js';

export interface ProjectMigration { projectIds: string[]; workspace: string; name: string }

/** Explicit local-admin mapping only. Names never grant scope or trigger merges. */
export async function planProjectMigration(rows: StoredRecord[], mappings: ProjectMigration[]): Promise<StoredRecord[]> {
  if (!Array.isArray(mappings) || !mappings.length) throw new Error('invalid_migration_plan');
  const originals = new Map(rows.map(row => [row.id, row]));
  const changes = new Map<string, StoredRecord>();
  const assigned = new Set<string>();
  const targets = new Set<string>();
  for (const mapping of mappings) {
    if (!Array.isArray(mapping.projectIds) || !mapping.projectIds.length || typeof mapping.name !== 'string' || !mapping.name.trim() || mapping.name.length > 128) throw new Error('invalid_migration_plan');
    const resolved = await resolveWorkspace(mapping.workspace);
    const workspace = resolved.projectRoot ?? resolved.workspace;
    if (!workspace) throw new Error('migration_workspace_unavailable');
    const targetId = 'p:' + digest(workspace);
    if (targets.has(targetId)) throw new Error('duplicate_migration_target');
    targets.add(targetId);
    const sourceIds = new Set(mapping.projectIds);
    if (sourceIds.size !== mapping.projectIds.length) throw new Error('duplicate_migration_source');
    for (const id of sourceIds) {
      if (assigned.has(id)) throw new Error('duplicate_migration_source');
      assigned.add(id);
      const row = originals.get(id);
      if (!row || row.kind !== 'project' && !(row.kind === 'project-alias' && row.data.targetId === targetId)) throw new Error('migration_project_unavailable');
    }
    const moving = rows.filter(row => sourceIds.has(row.projectId) && row.projectId !== targetId && row.kind !== 'project-alias');
    if (!moving.length) continue; // Repeat application is a no-op.
    const target = originals.get(targetId);
    if (target && target.kind !== 'project') throw new Error('migration_target_invalid');
    const projects = [...sourceIds].map(id => originals.get(id)!).filter(row => row.kind === 'project');
    if (target && !sourceIds.has(targetId)) projects.push(target);
    if (projects.some(row => row.data.paused) || moving.some(row => row.kind === 'purge' && row.data.state === 'pending')) throw new Error('migration_project_requires_maintenance');
    const environment: Record<string, unknown> = {};
    for (const project of projects) for (const [key, value] of Object.entries(project.data.environment as Record<string, unknown> ?? {})) {
      if (key in environment && environment[key] !== value) throw new Error('migration_environment_conflict');
      environment[key] = value;
    }
    const generation = Math.max(0, ...projects.map(row => Number(row.data.generation ?? 0))) + 1;
    changes.set(targetId, { id: targetId, kind: 'project', projectId: targetId, version: (target?.version ?? 0) + 1,
      data: { ...target?.data, workspace, name: mapping.name, paused: false, generation, environment } });
    for (const row of moving) {
      if (row.kind === 'project') {
        changes.set(row.id, { ...row, kind: 'project-alias', version: row.version + 1, data: { ...row.data, targetId, migratedAt: new Date().toISOString() } });
        continue;
      }
      // IDs and semantic versions remain stable, preserving all provenance links.
      // Old session capabilities cannot be carried into the destination project.
      if (['intent', 'preview', 'bundle'].includes(row.kind)) {
        changes.set(row.id, { ...row, kind: 'deleted', projectId: targetId, version: row.version + 1, data: {} });
      } else {
        const moved: StoredRecord = { ...row, projectId: targetId, data: { ...row.data, originalProjectId: row.data.originalProjectId ?? row.projectId } };
        if (row.kind === 'job' || row.kind === 'summary-job') moved.data = { ...moved.data, generation, ...(row.data.state === 'running' ? { state: 'queued' } : {}) };
        if (row.kind === 'control' && typeof row.data.taskId === 'string') {
          const id = 'task:' + digest(targetId + row.data.taskId);
          const old = changes.get(id) ?? originals.get(id);
          changes.set(id, { ...moved, id, version: (old?.version ?? 0) + 1 });
        }
        changes.set(row.id, moved);
      }
    }
  }
  return [...changes.values()];
}

export async function migrateProjects(directory: string, planFile: string, apply = false): Promise<unknown> {
  const mappings = JSON.parse(await readFile(planFile, 'utf8')) as ProjectMigration[];
  const runtime = runtimeDirectory(directory);
  await privateDirectory(dirname(runtime)); await privateDirectory(runtime);
  let compromised = false;
  const release = await lockfile.lock(directory, { lockfilePath: join(runtime, 'kernel.lock'), realpath: false, retries: 0, stale: 5000, update: 1000,
    onCompromised: () => { compromised = true; } });
  let store: UnifiedStore | undefined;
  try {
    store = await UnifiedStore.open(join(directory, 'memory.lance'));
    const changes = await planProjectMigration(await store.all(), mappings);
    if (compromised) throw new Error('migration_lock_lost');
    if (apply) await store.commit(changes);
    return { applied: apply, records: changes.length, projects: changes.filter(row => row.kind === 'project').map(row => ({ id: row.id, name: row.data.name, workspace: row.data.workspace })), aliases: changes.filter(row => row.kind === 'project-alias').length };
  } finally { await store?.close(); await release(); }
}
