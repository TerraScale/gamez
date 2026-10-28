import type {
  ApplyResult,
  OutboxRecord,
  Projection,
  ProjectionMap,
  ReplicationBatch,
  SqlValue,
} from "./types.ts";

/**
 * Statements per `db.batch()` call. One call is one D1 transaction; 100 keeps
 * each write transaction short on D1's single writer. Larger inputs are split
 * into several sequential calls, which is safe because every statement is
 * version-guarded (a retry after a partial apply just finishes the job).
 * Note each statement also counts toward D1's per-invocation query limit.
 */
export const MAX_STATEMENTS_PER_D1_BATCH = 100;

/** D1 rejects statements with more than 100 bound parameters. */
const MAX_BOUND_PARAMS = 100;

/** D1 DDL for the monitoring cursor `applyBatch` maintains. */
export const SYNC_CURSOR_DDL = `CREATE TABLE IF NOT EXISTS sync_cursor (
  source TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const IDENT = /^[a-z_][a-z0-9_]*$/;
const META_COLUMNS = new Set(["_version", "_deleted", "_updated_at"]);

/**
 * Applies a replication batch to D1 in one `db.batch()` call.
 *
 * For each record with a known projection:
 *   INSERT INTO <table> (<pk>, ...cols, _version, _deleted, _updated_at)
 *   VALUES (...)
 *   ON CONFLICT(<pk>) DO UPDATE SET ...cols = excluded...., _version = excluded._version, ...
 *   WHERE excluded._version > <table>._version
 * Deletes write a tombstone: `_deleted = 1`, columns untouched, same version guard
 * (insert a bare tombstone row when the pk doesn't exist yet).
 *
 * Also upserts `sync_cursor(source TEXT PRIMARY KEY, last_seq INTEGER, updated_at INTEGER)`
 * with `last_seq = MAX(last_seq, <max seq in batch>)` for lag monitoring.
 *
 * `applied` vs `stale` is derived from each statement's `meta.changes`.
 *
 * Records for the same (table, pk) are coalesced first: only the highest
 * version is written and the superseded ones count as `stale`. More than
 * MAX_STATEMENTS_PER_D1_BATCH statements are split across sequential calls.
 * `_updated_at` is the record's `at`, so replays write identical rows.
 * Invalid projections (bad identifiers, meta/pk columns in `toRow`, too many
 * columns) throw before anything is written.
 */
export async function applyBatch(
  db: D1Database,
  batch: ReplicationBatch,
  projections: ProjectionMap,
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, stale: 0, unknown: 0 };
  const unknownTables = new Set<string>();
  const latest = new Map<string, { record: OutboxRecord; projection: Projection }>();
  let maxSeq = 0;

  for (const record of batch.records) {
    maxSeq = Math.max(maxSeq, record.seq);
    const projection = Object.hasOwn(projections, record.table)
      ? projections[record.table]
      : undefined;
    if (!projection) {
      result.unknown++;
      unknownTables.add(record.table);
      continue;
    }
    const key = `${projection.table}\0${record.pk}`;
    const prev = latest.get(key);
    if (prev) result.stale++;
    if (!prev || record.version > prev.record.version) latest.set(key, { record, projection });
  }

  if (unknownTables.size > 0) {
    console.warn(
      `[sync] ${batch.source}: dropped ${result.unknown} record(s) for unknown tables: ${[...unknownTables].join(", ")}`,
    );
  }
  if (batch.records.length === 0) return result;

  const statements = [...latest.values()].map(({ record, projection }) =>
    toStatement(db, projection, record),
  );
  const recordStatements = statements.length;
  statements.push(
    db
      .prepare(
        `INSERT INTO sync_cursor (source, last_seq, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (source) DO UPDATE SET
           last_seq = MAX(sync_cursor.last_seq, excluded.last_seq),
           updated_at = excluded.updated_at`,
      )
      .bind(batch.source, maxSeq, Date.now()),
  );

  let index = 0;
  for (let i = 0; i < statements.length; i += MAX_STATEMENTS_PER_D1_BATCH) {
    const results = await db.batch(statements.slice(i, i + MAX_STATEMENTS_PER_D1_BATCH));
    for (const res of results) {
      if (index++ >= recordStatements) break;
      if (res.meta.changes > 0) result.applied++;
      else result.stale++;
    }
  }
  return result;
}

function toStatement(
  db: D1Database,
  projection: Projection,
  record: OutboxRecord,
): D1PreparedStatement {
  const table = ident(projection.table);
  const pk = ident(projection.pkColumn);
  const guard = `WHERE excluded."_version" > ${table}."_version"`;
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    throw new Error(`[sync] ${projection.table}/${record.pk}: invalid version ${record.version}`);
  }

  if (record.op === "delete") {
    return db
      .prepare(
        `INSERT INTO ${table} (${pk}, "_version", "_deleted", "_updated_at") VALUES (?, ?, 1, ?)
         ON CONFLICT (${pk}) DO UPDATE SET
           "_version" = excluded."_version", "_deleted" = 1, "_updated_at" = excluded."_updated_at"
         ${guard}`,
      )
      .bind(record.pk, record.version, record.at);
  }
  if (record.op !== "upsert") {
    throw new Error(`[sync] ${projection.table}/${record.pk}: invalid op ${String(record.op)}`);
  }

  const row: Record<string, SqlValue> = projection.toRow(record.payload);
  const columns = Object.keys(row);
  for (const column of columns) {
    if (column === projection.pkColumn || META_COLUMNS.has(column)) {
      throw new Error(`[sync] ${projection.table}: toRow() must not return column "${column}"`);
    }
  }
  if (columns.length + 3 > MAX_BOUND_PARAMS) {
    throw new Error(`[sync] ${projection.table}: too many columns (${columns.length})`);
  }
  const quoted = columns.map(ident);
  const names = [pk, ...quoted, `"_version"`, `"_deleted"`, `"_updated_at"`];
  const values = ["?", ...quoted.map(() => "?"), "?", "0", "?"];
  const sets = [
    ...quoted.map((c) => `${c} = excluded.${c}`),
    `"_version" = excluded."_version"`,
    `"_deleted" = 0`,
    `"_updated_at" = excluded."_updated_at"`,
  ];
  return db
    .prepare(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${values.join(", ")})
       ON CONFLICT (${pk}) DO UPDATE SET ${sets.join(", ")}
       ${guard}`,
    )
    .bind(record.pk, ...columns.map((c) => row[c] ?? null), record.version, record.at);
}

/** Validates a table/column name and returns it double-quoted. */
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`[sync] invalid SQL identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}
