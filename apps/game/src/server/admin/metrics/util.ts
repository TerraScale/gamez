/**
 * Shared helpers of the admin metric readers (docs/design/admin-dashboard.md §7).
 * CONTRACT (architect, implemented). Readers live next to this file, one per
 * section; each returns a full response even when every source fails.
 */
import type {
  AdminRange,
  AdminSource,
  AdminSourceKind,
  Distribution,
  Quantiles,
  Series,
  TimePoint,
} from "@gamez/protocol";
import type { Analytics, AnalyticsQuery, SeriesRow, TotalsRow } from "../../analytics/types.ts";
import type { Env } from "../../contracts.ts";
import { isMissingTable } from "../../leaderboards/read.ts";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** What every reader gets. `now` is fixed per request (tests pass their own). */
export interface MetricsDeps {
  env: Env;
  db: D1Database;
  aq: AnalyticsQuery;
  /** For "d1.query" timings of the readers themselves. */
  analytics: Analytics;
  now: number;
}

/**
 * Collects AdminSource entries while a reader runs. `d1()` / `ae()` / `live()`
 * run one read; a failure records ok: false and yields `fallback` (a missing
 * table is noted as "not migrated", not logged as an error).
 */
export class SourceLog {
  readonly sources: AdminSource[] = [];

  constructor(private readonly deps: Pick<MetricsDeps, "analytics" | "aq">) {}

  #push(name: string, kind: AdminSourceKind, ok: boolean, note?: string): void {
    // One entry per name+kind: a later failure wins over an earlier success.
    const i = this.sources.findIndex((s) => s.name === name && s.kind === kind);
    const entry: AdminSource = note === undefined ? { name, kind, ok } : { name, kind, ok, note };
    if (i < 0) this.sources.push(entry);
    else if (!ok) this.sources[i] = entry;
  }

  async d1<T>(name: string, fallback: T, read: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const v = await read();
      this.deps.analytics.write(
        "d1.query",
        { label: `admin.${name}`, outcome: "ok" },
        { ms: Date.now() - started, rows: Array.isArray(v) ? v.length : 1 },
      );
      this.#push(name, "d1", true);
      return v;
    } catch (err) {
      const missing = isMissingTable(err);
      if (!missing) console.error(`admin metrics: d1 ${name} failed`, err);
      this.deps.analytics.write(
        "d1.query",
        { label: `admin.${name}`, outcome: "error" },
        { ms: Date.now() - started, rows: 0 },
      );
      this.#push(name, "d1", false, missing ? "table not migrated" : "query failed");
      return fallback;
    }
  }

  /** An analytics read; the kind is the query backend ("ae" or "local"). */
  async ae<T>(name: string, fallback: T, read: (aq: AnalyticsQuery) => Promise<T>): Promise<T> {
    const kind: AdminSourceKind = this.deps.aq.source === "ae" ? "ae" : "local";
    if (this.deps.aq.source === "none") {
      this.#push(name, kind, false, "no analytics backend");
      return fallback;
    }
    try {
      const v = await read(this.deps.aq);
      this.#push(name, kind, true);
      return v;
    } catch (err) {
      console.error(`admin metrics: analytics ${name} failed`, err);
      this.#push(name, kind, false, "query failed");
      return fallback;
    }
  }

  async live<T>(name: string, fallback: T, read: () => Promise<T>): Promise<T> {
    try {
      const v = await read();
      this.#push(name, "live", true);
      return v;
    } catch (err) {
      console.error(`admin metrics: live ${name} failed`, err);
      this.#push(name, "live", false, "unreachable");
      return fallback;
    }
  }
}

/** All D1 rows of a statement. */
export function rows<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = db.prepare(sql);
  return (params.length ? stmt.bind(...params) : stmt).all<T>().then((r) => r.results);
}

/** A finite number or 0. */
export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Bucket starts covering [range.from, range.to). */
export function bucketStarts(range: AdminRange): number[] {
  const out: number[] = [];
  for (let t = range.from; t < range.to; t += range.bucketMs) out.push(t);
  return out;
}

/**
 * First UTC day with an account_activity row (when activity tracking started on
 * this database), or null when there is none. Days before it have no data, so
 * the active series start there instead of showing misleading zeros.
 */
export async function firstActivityDay(log: SourceLog, db: D1Database): Promise<number | null> {
  return log.d1<number | null>("account_activity", null, async () => {
    const [r] = await rows<{ day: number | null }>(
      db,
      "SELECT MIN(day) AS day FROM account_activity WHERE _deleted = 0",
    );
    return typeof r?.day === "number" ? r.day : null;
  });
}

/** "YYYY-MM-DD" (UTC) of an epoch ms. */
export function dayLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Series from rows of {t, keys, value}: one series per distinct `keyField`
 * value (or a single series `single` when keyField is null), every bucket of
 * the range present (missing = 0). Series sorted by total desc, then key.
 */
export function toSeries(
  range: AdminRange,
  data: readonly { t: number; key: string; value: number }[],
  labels: Record<string, string> = {},
): Series[] {
  const starts = bucketStarts(range);
  const index = new Map<number, number>();
  starts.forEach((t, i) => index.set(t, i));
  const byKey = new Map<string, number[]>();
  for (const row of data) {
    const aligned = range.from + Math.floor((row.t - range.from) / range.bucketMs) * range.bucketMs;
    const i = index.get(aligned);
    if (i === undefined) continue;
    let arr = byKey.get(row.key);
    if (!arr) {
      arr = starts.map(() => 0);
      byKey.set(row.key, arr);
    }
    arr[i]! += row.value;
  }
  const out: Series[] = [];
  for (const [key, values] of byKey) {
    const points: TimePoint[] = values.map((v, i) => ({ t: starts[i]!, v }));
    out.push({ key, label: labels[key] ?? key, points });
  }
  const total = (s: Series) => s.points.reduce((a, p) => a + p.v, 0);
  out.sort((a, b) => total(b) - total(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** Analytics SeriesRow[] -> toSeries input, keyed by one groupBy field ("" = single series `single`). */
export function seriesRows(
  data: readonly SeriesRow[],
  field: string | null,
  single = "total",
): { t: number; key: string; value: number }[] {
  return data.map((r) => ({ t: r.t, key: field ? (r.keys[field] ?? "") : single, value: r.value }));
}

/** Distribution from label/value pairs (keeps order unless `sort`). */
export function dist(
  key: string,
  label: string,
  pairs: readonly { label: string; value: number }[],
  sort: "desc" | "none" = "none",
): Distribution {
  const buckets = pairs.map((p) => ({ label: p.label, value: num(p.value) }));
  if (sort === "desc") {
    buckets.sort((a, b) => b.value - a.value || (a.label < b.label ? -1 : 1));
  }
  return { key, label, buckets };
}

/** Distribution from analytics totals grouped by one field. */
export function distOf(key: string, label: string, data: readonly TotalsRow[], field: string) {
  return dist(
    key,
    label,
    data.map((r) => ({ label: r.keys[field] ?? "", value: r.value })),
    "desc",
  );
}

export const EMPTY_QUANTILES: Quantiles = { p50: 0, p95: 0, n: 0 };

export function emptyDist(key: string, label: string): Distribution {
  return { key, label, buckets: [] };
}

/** Level bands used by every "by level" distribution (matches classic levelBand()). */
export const LEVEL_BANDS = [
  "1-9",
  "10-19",
  "20-29",
  "30-39",
  "40-49",
  "50-59",
  "60-69",
  "70-79",
  "80-89",
  "90+",
] as const;

/** SQL CASE expression mapping an integer level column to LEVEL_BANDS labels. */
export function levelBandSql(column: string): string {
  return `CASE WHEN ${column} >= 90 THEN '90+' WHEN ${column} < 10 THEN '1-9'
    ELSE CAST((${column} / 10) * 10 AS TEXT) || '-' || CAST((${column} / 10) * 10 + 9 AS TEXT) END`;
}
