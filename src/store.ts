import { connect, Index, makeArrowTable, Session, type Connection, type Table } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';

export const VECTOR_DIMENSIONS = 1024;
export const RECORDS_TABLE = 'records';
export const STORE_CACHE_BYTES = Object.freeze({ index: 256 * 1024 ** 2, metadata: 64 * 1024 ** 2 });

export type StoredRecord = {
  id: string;
  kind: string;
  projectId: string;
  version: number;
  data: Record<string, unknown>;
  text?: string;
  vector?: number[];
};

export type StorageSnapshot = {
  version: number;
  versions: number[];
  tags: string[];
  branches: string[];
  rows: number;
  indexes: string[];
};

export type PurgeResult = {
  complete: boolean;
  removedRows: number;
  removedTags: string[];
  removedBranches: string[];
  bytesRemoved: number;
  remainingVersions: number[];
  remainingTags: string[];
  remainingBranches: string[];
};

const schema = new Schema([
  new Field('id', new Utf8(), false),
  new Field('kind', new Utf8(), false),
  new Field('projectId', new Utf8(), false),
  new Field('version', new Int32(), false),
  new Field('data', new Utf8(), false),
  new Field('text', new Utf8(), true),
  new Field('vector', new FixedSizeList(VECTOR_DIMENSIONS, new Field('item', new Float32(), true)), true),
]);

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function validateVector(vector: number[]): void {
  if (vector.length !== VECTOR_DIMENSIONS || vector.some(value => !Number.isFinite(value))) {
    throw new Error(`INVALID_VECTOR: expected ${VECTOR_DIMENSIONS} finite numbers`);
  }
}

function encode(record: StoredRecord): Record<string, unknown> {
  if (!record.id || !record.kind || !record.projectId || !Number.isInteger(record.version) || record.version < 1 || record.version > 2_147_483_647) {
    throw new Error('INVALID_RECORD: id, kind, projectId and a positive int32 version are required');
  }
  if (record.vector !== undefined) validateVector(record.vector);
  if (record.data === null || typeof record.data !== 'object' || Array.isArray(record.data)) {
    throw new Error('INVALID_RECORD: data must be a JSON object');
  }
  return {
    id: record.id,
    kind: record.kind,
    projectId: record.projectId,
    version: record.version,
    data: JSON.stringify(record.data),
    text: record.text ?? null,
    vector: record.vector ?? null,
  };
}

function decode(row: Record<string, unknown>): StoredRecord {
  const record: StoredRecord = {
    id: String(row.id),
    kind: String(row.kind),
    projectId: String(row.projectId),
    version: Number(row.version),
    data: JSON.parse(String(row.data)) as Record<string, unknown>,
  };
  if (typeof row.text === 'string') record.text = row.text;
  if (row.vector != null) record.vector = Array.from(row.vector as Iterable<number>);
  return record;
}

/** The caller owns the single-writer lock and serializes reads, writes and maintenance.
 * Records, dependencies, jobs and tombstones share a single atomic publication boundary.
 * No cached record state is changed before a successful database commit.
 */
export class UnifiedStore {
  private constructor(private readonly connection: Connection, private table: Table) {}

  static async open(path: string): Promise<UnifiedStore> {
    // The SDK defaults reserve cache budgets of 6 GiB + 1 GiB. Keep the local
    // memory service's caches bounded independently of the machine's RAM.
    const session = new Session(BigInt(STORE_CACHE_BYTES.index), BigInt(STORE_CACHE_BYTES.metadata));
    const connection = await connect(path, { readConsistencyInterval: 0 }, session);
    try {
      const names = await connection.tableNames();
      const table = names.includes(RECORDS_TABLE)
        ? await connection.openTable(RECORDS_TABLE)
        : await connection.createEmptyTable(RECORDS_TABLE, schema);
      return new UnifiedStore(connection, table);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async all(kind?: string, projectId?: string): Promise<StoredRecord[]> {
    const filters: string[] = [];
    if (kind !== undefined) filters.push(`kind = ${literal(kind)}`);
    if (projectId !== undefined) filters.push(`projectId = ${literal(projectId)}`);
    const query = this.table.query();
    if (filters.length > 0) query.where(filters.join(' AND '));
    return (await query.toArray()).map(decode);
  }

  async get(id: string): Promise<StoredRecord | undefined> {
    const rows = await this.table.query().where(`id = ${literal(id)}`).limit(1).toArray();
    return rows[0] === undefined ? undefined : decode(rows[0]);
  }

  async commit(records: StoredRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (new Set(records.map(record => record.id)).size !== records.length) {
      throw new Error('INVALID_RECORD: duplicate ids in one publication');
    }
    // Arrow conversion and validation finish before the only mutating operation.
    const batch = makeArrowTable(records.map(encode), { schema });
    await this.table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(batch);
  }

  async searchText(projectId: string, query: string, limit: number): Promise<StoredRecord[]> {
    const count = Math.max(0, Math.min(20, Math.floor(limit)));
    const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [])].slice(0, 32);
    if (count === 0 || terms.length === 0) return [];
    const scope = `projectId = ${literal(projectId)} AND kind = 'memory'`;
    // Exact code/name and CJK substrings also work before the FTS index exists.
    const exact = await this.table.query().where(`${scope} AND (${terms.map(term => `contains(lower(text), ${literal(term)})`).join(' OR ')})`).limit(count).toArray();
    const indexes = await this.table.listIndices();
    const fullText = indexes.some(index => index.columns.includes('text'))
      ? await this.table.query().fullTextSearch(query, { columns: ['text'] }).where(scope).limit(count).toArray()
      : [];
    const unique = new Map<string, StoredRecord>();
    for (const row of [...exact, ...fullText]) {
      const record = decode(row);
      unique.set(record.id, record);
    }
    return [...unique.values()].slice(0, count);
  }

  async searchVector(projectId: string, vector: number[], limit: number): Promise<StoredRecord[]> {
    validateVector(vector);
    const count = Math.max(0, Math.min(20, Math.floor(limit)));
    if (count === 0) return [];
    return (await this.table.vectorSearch(vector).distanceType('cosine')
      .where(`projectId = ${literal(projectId)} AND kind = 'memory' AND vector IS NOT NULL`)
      .limit(count).toArray()).map(decode);
  }

  /** Rebuildable acceleration only. Never enables fastSearch (which skips fresh fragments). */
  async maintainIndexes(): Promise<void> {
    await this.table.createIndex('text', {
      config: Index.fts({ baseTokenizer: 'icu', stem: false, removeStopWords: false }),
      replace: true,
    });
    if (await this.table.countRows('vector IS NOT NULL') >= 256) {
      await this.table.createIndex('vector', {
        config: Index.ivfFlat({ numPartitions: 1, distanceType: 'cosine' }),
        replace: true,
      });
    }
    await this.table.createIndex('id', { config: Index.btree(), replace: true });
  }

  /** Periodic maintenance under the same exclusive kernel lock. Business
   * history is stored as records, so obsolete physical snapshots need no lease.
   * Existing indexes are incrementally optimized rather than rebuilt.
   */
  async compact(): Promise<void> {
    await this.table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true });
  }

  async inspectStorage(): Promise<StorageSnapshot> {
    const tags = await this.table.tags();
    const branches = await this.table.branches();
    return {
      version: await this.table.version(),
      versions: (await this.table.listVersions()).map(version => version.version),
      tags: Object.keys(await tags.list()),
      branches: Object.keys(await branches.list()),
      rows: await this.table.countRows(),
      indexes: (await this.table.listIndices()).map(index => index.name),
    };
  }

  /** Call only after durable tombstones have blocked all affected content.
   * Rewriting survivors forces low-density deletions out of live fragments too.
   * Exclusive access is required: deleteUnverified is unsafe with other writers.
   * The private store intentionally offers no tag/branch creation API.
   */
  async purge(ids: string[]): Promise<PurgeResult> {
    const uniqueIds = [...new Set(ids)];
    const before = await this.inspectStorage();
    const tags = await this.table.tags();
    for (const name of before.tags) await tags.delete(name);
    const branches = await this.table.branches();
    for (const name of before.branches) await branches.delete(name);
    if (uniqueIds.length > 0) {
      await this.table.delete(`id IN (${uniqueIds.map(literal).join(', ')})`);
    }
    const survivors = await this.all();
    for (const index of await this.table.listIndices()) await this.table.dropIndex(index.name);
    if (survivors.length > 0) {
      await this.table.add(makeArrowTable(survivors.map(encode), { schema }), { mode: 'overwrite' });
    } else {
      // The Node add() path rejects a zero-batch Arrow table; this supported
      // empty-table overwrite preserves the dataset's versioned commit path.
      const previous = this.table;
      this.table = await this.connection.createEmptyTable(RECORDS_TABLE, schema, { mode: 'overwrite' });
      previous.close();
    }
    const stats = await this.table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true });
    const after = await this.inspectStorage();
    return {
      complete: after.versions.length === 1 && after.tags.length === 0 && after.branches.length === 0,
      removedRows: before.rows - after.rows,
      removedTags: before.tags,
      removedBranches: before.branches,
      bytesRemoved: Number(stats.prune?.bytesRemoved ?? 0),
      remainingVersions: after.versions,
      remainingTags: after.tags,
      remainingBranches: after.branches,
    };
  }

  async close(): Promise<void> {
    this.table.close();
    this.connection.close();
  }
}
