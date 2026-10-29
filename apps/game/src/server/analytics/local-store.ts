/**
 * MetricsDO "local" storage logic (docs/design/admin-dashboard.md §4.3).
 * OWNER: T-analytics-core. Pure over a SqlStore, so tests run it on
 * node:sqlite (tests/support/fake-sql.ts); do/metrics.ts adapts it.
 *
 * Table metric_point: the Analytics Engine column layout (schema.ts) as SQLite
 * columns: t (epoch ms), b1..b10 (b1 = metric name), d1..d10, idx (index1),
 * sample (_sample_interval). Every aggregate is weighted by `sample`.
 *
 * This file also holds the query planning shared with the AE SQL backend
 * (ae-sql.ts): field names are resolved through schema.ts only, never taken
 * from input, so both backends build SQL from a fixed set of column names.
 */
import type { SqlStore } from "../contracts.ts";
import {
  MAX_BLOB_CHARS,
  MAX_BLOBS,
  MAX_DOUBLES,
  METRICS,
  blobColumn,
  doubleColumn,
  type BlobName,
  type DoubleName,
  type MetricName,
  type StoredPoint,
} from "./schema.ts";
import {
  LOCAL_LIMITS,
  type DistinctQuery,
  type QuantileQuery,
  type QueryBase,
  type SeriesQuery,
  type SeriesRow,
  type TotalsQuery,
  type TotalsRow,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Query planning (shared with ae-sql.ts)
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
/** Most weighted values a local quantile query reads (newest first). */
export const MAX_QUANTILE_VALUES = 50_000;
/** Most (bucket, group) rows a series query reads before the top-groups cut. */
export const MAX_SERIES_ROWS = 20_000;

/** A resolved filter/group column: the AE name ("blob3", "double2"). */
export interface PlannedColumn {
  field: string;
  column: string;
}

export interface BasePlan {
  metric: MetricName;
  /** Epoch ms, [from, to). */
  from: number;
  to: number;
  /** Blob filters, sorted by column for stable SQL. */
  where: { column: string; value: string }[];
  index: string | null;
}

export interface GroupPlan extends BasePlan {
  groups: PlannedColumn[];
  /** null = count; else the double column summed. */
  sumColumn: string | null;
  limit: number;
}

function assertMetric(metric: string): asserts metric is MetricName {
  if (typeof metric !== "string" || !Object.hasOwn(METRICS, metric)) {
    throw new Error(`analytics: unknown metric ${JSON.stringify(metric)}`);
  }
}

function blobCol(metric: MetricName, field: string): string {
  const col = blobColumn(metric, field as BlobName<typeof metric>);
  if (!col) throw new Error(`analytics: ${metric} has no blob ${JSON.stringify(field)}`);
  return col;
}

function doubleCol(metric: MetricName, field: string): string {
  const col = doubleColumn(metric, field as DoubleName<typeof metric>);
  if (!col) throw new Error(`analytics: ${metric} has no double ${JSON.stringify(field)}`);
  return col;
}

function finiteMs(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`analytics: ${name} must be a finite number`);
  }
  return Math.floor(v);
}

export function planBase(q: QueryBase<MetricName>): BasePlan {
  assertMetric(q.metric);
  const metric = q.metric;
  const where: { column: string; value: string }[] = [];
  for (const [field, value] of Object.entries(q.where ?? {})) {
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`analytics: filter ${field} must be a string`);
    where.push({ column: blobCol(metric, field), value });
  }
  where.sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
  if (q.index !== undefined && typeof q.index !== "string") {
    throw new Error("analytics: index must be a string");
  }
  return {
    metric,
    from: finiteMs(q.from, "from"),
    to: finiteMs(q.to, "to"),
    where,
    index: q.index ?? null,
  };
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function planGroups(q: TotalsQuery<MetricName>): GroupPlan {
  const base = planBase(q);
  const groups = (q.groupBy ?? []).map((field) => ({
    field,
    column: blobCol(base.metric, field),
  }));
  let sumColumn: string | null = null;
  if (q.value?.op === "sum") sumColumn = doubleCol(base.metric, q.value.field);
  else if (q.value?.op !== "count") throw new Error("analytics: value.op must be count or sum");
  return { ...base, groups, sumColumn, limit: clampLimit(q.limit) };
}

export function planQuantileField(q: QuantileQuery<MetricName>): { column: string; qs: number[] } {
  assertMetric(q.metric);
  const column = doubleCol(q.metric, q.field);
  const qs = (q.q ?? []).map((v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error("analytics: quantiles must be in [0, 1]");
    }
    return v;
  });
  return { column, qs };
}

/** Bucket width in whole seconds (AE timestamps are seconds); at least 1 s. */
export function bucketSeconds(bucketMs: number): number {
  if (typeof bucketMs !== "number" || !Number.isFinite(bucketMs)) {
    throw new Error("analytics: bucketMs must be a finite number");
  }
  return Math.max(1, Math.floor(bucketMs / 1000));
}

/** Rows of an ungrouped totals query: always exactly one row (0 when empty). */
export function ungroupedRow(value: number): TotalsRow[] {
  return [{ keys: {}, value: Number.isFinite(value) ? value : 0 }];
}

function groupKey(keys: Record<string, string>, fields: readonly string[]): string {
  return JSON.stringify(fields.map((f) => keys[f] ?? ""));
}

/**
 * Series rows limited to the top `limit` groups by total value (ties: keys
 * ascending), sorted by bucket then value descending then keys.
 */
export function topSeriesGroups(
  rows: SeriesRow[],
  fields: readonly string[],
  limit: number,
): SeriesRow[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const k = groupKey(r.keys, fields);
    totals.set(k, (totals.get(k) ?? 0) + r.value);
  }
  const keep = new Set(
    [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, limit)
      .map(([k]) => k),
  );
  return rows
    .filter((r) => keep.has(groupKey(r.keys, fields)))
    .sort((a, b) => {
      if (a.t !== b.t) return a.t - b.t;
      if (a.value !== b.value) return b.value - a.value;
      const ka = groupKey(a.keys, fields);
      const kb = groupKey(b.keys, fields);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

/**
 * Weighted quantiles: for each q, the smallest value whose cumulative weight
 * reaches q × total weight (q = 0 gives the minimum). Zeros when empty.
 */
export function weightedQuantiles(
  values: readonly { v: number; w: number }[],
  qs: readonly number[],
): number[] {
  const pts = values.filter((p) => Number.isFinite(p.v) && Number.isFinite(p.w) && p.w > 0);
  if (pts.length === 0) return qs.map(() => 0);
  pts.sort((a, b) => a.v - b.v);
  let total = 0;
  for (const p of pts) total += p.w;
  return qs.map((q) => {
    const target = q * total;
    let acc = 0;
    for (const p of pts) {
      acc += p.w;
      if (acc >= target) return p.v;
    }
    return pts[pts.length - 1]!.v;
  });
}

// ---------------------------------------------------------------------------
// MetricsStore
// ---------------------------------------------------------------------------

const BLOB_COLS = Array.from({ length: MAX_BLOBS }, (_, i) => `b${i + 1}`);
const DOUBLE_COLS = Array.from({ length: MAX_DOUBLES }, (_, i) => `d${i + 1}`);
const INSERT_SQL = `INSERT INTO metric_point (t, ${BLOB_COLS.join(", ")}, ${DOUBLE_COLS.join(
  ", ",
)}, idx, sample) VALUES (${Array.from({ length: 3 + MAX_BLOBS + MAX_DOUBLES }, () => "?").join(
  ", ",
)})`;

/** AE column name -> local column name ("blob3" -> "b3", "double2" -> "d2"). */
export function localColumn(aeColumn: string): string {
  const m = /^(blob|double)(\d+)$/.exec(aeColumn);
  if (!m) throw new Error(`analytics: bad column ${aeColumn}`);
  const n = Number(m[2]);
  const max = m[1] === "blob" ? MAX_BLOBS : MAX_DOUBLES;
  if (n < 1 || n > max) throw new Error(`analytics: column ${aeColumn} out of range`);
  return `${m[1] === "blob" ? "b" : "d"}${n}`;
}

export interface MetricsStoreOptions {
  now?: () => number;
  maxRows?: number;
  keepMs?: number;
}

interface WhereSql {
  sql: string;
  params: (string | number)[];
}

export class MetricsStore {
  readonly #store: SqlStore;
  readonly #now: () => number;
  readonly #maxRows: number;
  readonly #keepMs: number;

  constructor(store: SqlStore, opts: MetricsStoreOptions = {}) {
    this.#store = store;
    this.#now = opts.now ?? Date.now;
    this.#maxRows = opts.maxRows ?? LOCAL_LIMITS.maxRows;
    this.#keepMs = opts.keepMs ?? LOCAL_LIMITS.keepMs;
    this.migrate();
  }

  /** Idempotent schema creation. */
  migrate(): void {
    const sql = this.#store.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS metric_point (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        t INTEGER NOT NULL,
        ${BLOB_COLS.map((c) => `${c} TEXT NOT NULL DEFAULT ''`).join(",\n        ")},
        ${DOUBLE_COLS.map((c) => `${c} REAL NOT NULL DEFAULT 0`).join(",\n        ")},
        idx TEXT NOT NULL DEFAULT '',
        sample INTEGER NOT NULL DEFAULT 1
      )`,
    );
    sql.exec("CREATE INDEX IF NOT EXISTS metric_point_b1_t ON metric_point (b1, t)");
    sql.exec("CREATE INDEX IF NOT EXISTS metric_point_idx_t ON metric_point (idx, t)");
    // Not in the design's index list: keeps the time prune and the row cap O(log n).
    sql.exec("CREATE INDEX IF NOT EXISTS metric_point_t ON metric_point (t)");
    // Running row count, so the row cap never needs a COUNT(*) scan per ingest.
    sql.exec(
      "CREATE TABLE IF NOT EXISTS metric_meta (id INTEGER PRIMARY KEY CHECK (id = 1), rows INTEGER NOT NULL)",
    );
  }

  /** The stored running row count; counted once (old tables) when missing. */
  #rowCount(): number {
    const sql = this.#store.sql;
    const row = sql.exec("SELECT rows FROM metric_meta WHERE id = 1").toArray()[0];
    if (row) return Number(row.rows);
    const n = this.count();
    this.#setRows(n);
    return n;
  }

  #setRows(n: number): void {
    this.#store.sql.exec(
      "INSERT INTO metric_meta (id, rows) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET rows = excluded.rows",
      Math.max(0, n),
    );
  }

  /** Inserts valid points in one transaction, then prunes. Returns the rows inserted. */
  ingest(points: readonly StoredPoint[]): number {
    const rows: (string | number)[][] = [];
    for (const p of Array.isArray(points) ? points : []) {
      const row = toRow(p);
      if (row) rows.push(row);
    }
    this.#store.transactionSync(() => {
      if (rows.length > 0) {
        const before = this.#rowCount();
        for (const row of rows) this.#store.sql.exec(INSERT_SQL, ...row);
        this.#setRows(before + rows.length);
      }
      this.#prune();
    });
    return rows.length;
  }

  /**
   * Drops rows older than keepMs, then the oldest rows beyond maxRows. Only
   * index lookups (t) and the running count: never a full-table scan, so it
   * is cheap enough to run on every ingest.
   */
  prune(): void {
    this.#store.transactionSync(() => this.#prune());
  }

  /** prune() inside the caller's transaction. */
  #prune(): void {
    const sql = this.#store.sql;
    const cutoff = this.#now() - this.#keepMs;
    let count = this.#rowCount();
    const min = sql.exec("SELECT MIN(t) AS m FROM metric_point").one().m;
    if (typeof min === "number" && min < cutoff) {
      const old = Number(
        sql.exec("SELECT COUNT(*) AS n FROM metric_point WHERE t < ?", cutoff).one().n,
      );
      sql.exec("DELETE FROM metric_point WHERE t < ?", cutoff);
      count -= old;
    }
    if (count > this.#maxRows) {
      sql.exec(
        "DELETE FROM metric_point WHERE id IN (SELECT id FROM metric_point ORDER BY t ASC, id ASC LIMIT ?)",
        count - this.#maxRows,
      );
      count = this.#maxRows;
    }
    this.#setRows(count);
  }

  /** Row count (tests, dev tools). */
  count(): number {
    return Number(this.#store.sql.exec("SELECT COUNT(*) AS n FROM metric_point").one().n);
  }

  /** Deletes every point, or only seeded ones (index starting with "seed"). Returns rows deleted. */
  reset(seedOnly = false): number {
    const before = this.count();
    if (seedOnly) this.#store.sql.exec("DELETE FROM metric_point WHERE idx LIKE 'seed%'");
    else this.#store.sql.exec("DELETE FROM metric_point");
    const after = this.count();
    this.#setRows(after);
    return before - after;
  }

  #where(base: BasePlan): WhereSql {
    const parts = ["b1 = ?", "t >= ?", "t < ?"];
    const params: (string | number)[] = [base.metric, base.from, base.to];
    for (const w of base.where) {
      parts.push(`${localColumn(w.column)} = ?`);
      params.push(w.value);
    }
    if (base.index !== null) {
      parts.push("idx = ?");
      params.push(base.index);
    }
    return { sql: parts.join(" AND "), params };
  }

  #rows(query: string, params: (string | number)[]): Record<string, unknown>[] {
    return this.#store.sql.exec(query, ...params).toArray() as Record<string, unknown>[];
  }

  totals(q: TotalsQuery<MetricName>): TotalsRow[] {
    const plan = planGroups(q);
    const where = this.#where(plan);
    const value = plan.sumColumn ? `SUM(sample * ${localColumn(plan.sumColumn)})` : "SUM(sample)";
    if (plan.groups.length === 0) {
      const row = this.#rows(
        `SELECT ${value} AS v FROM metric_point WHERE ${where.sql}`,
        where.params,
      )[0];
      return ungroupedRow(Number(row?.v ?? 0));
    }
    const sel = plan.groups.map((g, i) => `${localColumn(g.column)} AS k${i}`).join(", ");
    const keys = plan.groups.map((_, i) => `k${i}`).join(", ");
    const rows = this.#rows(
      `SELECT ${sel}, ${value} AS v FROM metric_point WHERE ${where.sql}
       GROUP BY ${keys} ORDER BY v DESC, ${keys} LIMIT ?`,
      [...where.params, plan.limit],
    );
    return rows.map((r) => ({ keys: keysOf(r, plan.groups), value: Number(r.v ?? 0) }));
  }

  series(q: SeriesQuery<MetricName>): SeriesRow[] {
    const plan = planGroups(q);
    const bucket = bucketSeconds(q.bucketMs) * 1000;
    const where = this.#where(plan);
    const value = plan.sumColumn ? `SUM(sample * ${localColumn(plan.sumColumn)})` : "SUM(sample)";
    const sel = plan.groups.map((g, i) => `, ${localColumn(g.column)} AS k${i}`).join("");
    const keys = plan.groups.map((_, i) => `, k${i}`).join("");
    const rows = this.#rows(
      // `bucket` is an integer literal we computed (bound numbers can arrive as REAL,
      // which would turn this into float division).
      `SELECT (t / ${bucket}) * ${bucket} AS bt${sel}, ${value} AS v FROM metric_point
       WHERE ${where.sql} GROUP BY bt${keys} ORDER BY bt ASC LIMIT ?`,
      [...where.params, MAX_SERIES_ROWS],
    );
    const out: SeriesRow[] = rows.map((r) => ({
      t: Number(r.bt),
      keys: keysOf(r, plan.groups),
      value: Number(r.v ?? 0),
    }));
    return topSeriesGroups(
      out,
      plan.groups.map((g) => g.field),
      plan.limit,
    );
  }

  quantiles(q: QuantileQuery<MetricName>): number[] {
    const { column, qs } = planQuantileField(q);
    const where = this.#where(planBase(q));
    const rows = this.#rows(
      `SELECT ${localColumn(column)} AS v, sample AS w FROM metric_point WHERE ${where.sql}
       ORDER BY t DESC LIMIT ?`,
      [...where.params, MAX_QUANTILE_VALUES],
    );
    return weightedQuantiles(
      rows.map((r) => ({ v: Number(r.v), w: Number(r.w) })),
      qs,
    );
  }

  /** Distinct non-empty index values (session ids, account ids, DO names). */
  distinct(q: DistinctQuery<MetricName>): number {
    const where = this.#where(planBase(q));
    const row = this.#rows(
      `SELECT COUNT(DISTINCT idx) AS v FROM metric_point WHERE ${where.sql} AND idx != ''`,
      where.params,
    )[0];
    return Number(row?.v ?? 0);
  }
}

function keysOf(
  row: Record<string, unknown>,
  groups: readonly PlannedColumn[],
): Record<string, string> {
  const keys: Record<string, string> = {};
  groups.forEach((g, i) => {
    const v = row[`k${i}`];
    keys[g.field] = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  });
  return keys;
}

/** Validated insert row of one point, or null when it is not a point. */
function toRow(p: StoredPoint): (string | number)[] | null {
  if (!p || typeof p !== "object") return null;
  if (typeof p.t !== "number" || !Number.isFinite(p.t)) return null;
  if (!Array.isArray(p.blobs) || typeof p.blobs[0] !== "string" || p.blobs[0] === "") return null;
  const row: (string | number)[] = [Math.floor(p.t)];
  for (let i = 0; i < MAX_BLOBS; i++) {
    const v = p.blobs[i];
    const s = typeof v === "string" ? v : "";
    row.push(s.length > MAX_BLOB_CHARS ? s.slice(0, MAX_BLOB_CHARS) : s);
  }
  const doubles = Array.isArray(p.doubles) ? p.doubles : [];
  for (let i = 0; i < MAX_DOUBLES; i++) {
    const v = doubles[i];
    row.push(typeof v === "number" && Number.isFinite(v) ? v : 0);
  }
  row.push(typeof p.index === "string" ? p.index : "");
  const sample =
    typeof p.sample === "number" && Number.isFinite(p.sample) ? Math.floor(p.sample) : 1;
  row.push(Math.max(1, sample));
  return row;
}
