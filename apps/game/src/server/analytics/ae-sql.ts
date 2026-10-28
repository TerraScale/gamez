/**
 * AnalyticsQuery over the Workers Analytics Engine SQL API
 * (docs/design/admin-dashboard.md §4.2). OWNER: T-analytics-core.
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql
 *   Authorization: Bearer <token>, body = the SQL text.
 *
 * SQL is built only from schema columns (blobColumn/doubleColumn through the
 * shared planner in local-store.ts); filter values are single-quote escaped
 * and must be printable (control characters and backslashes are rejected, so
 * no literal can end early under either quoting convention). Every aggregate
 * is weighted by `_sample_interval`.
 *
 * UNVERIFIED against the live API: there are no AE credentials in this
 * environment. Tests pin the SQL strings and parse responses from a fake fetch.
 */
import { DATASET_DEFAULT, type MetricName } from "./schema.ts";
import type {
  AnalyticsQuery,
  DistinctQuery,
  QuantileQuery,
  SeriesQuery,
  SeriesRow,
  TotalsQuery,
  TotalsRow,
} from "./types.ts";
import {
  MAX_SERIES_ROWS,
  bucketSeconds,
  planBase,
  planGroups,
  planQuantileField,
  topSeriesGroups,
  ungroupedRow,
  type BasePlan,
  type GroupPlan,
} from "./local-store.ts";

export const AE_SQL_URL = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`;

export interface AeSqlOptions {
  accountId: string;
  token: string;
  dataset?: string;
  fetchFn: typeof fetch;
}

/** A SQL string literal; throws on control characters and backslashes. */
export function sqlString(value: string): string {
  if (typeof value !== "string") throw new Error("analytics: SQL value must be a string");
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(value)) {
    throw new Error("analytics: SQL value has control characters or backslashes");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function datasetName(dataset: string | undefined): string {
  const name = dataset && dataset.length > 0 ? dataset : DATASET_DEFAULT;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new Error("analytics: bad dataset name");
  }
  return name;
}

function whereSql(base: BasePlan): string {
  const parts = [
    `blob1 = ${sqlString(base.metric)}`,
    `timestamp >= toDateTime(${Math.floor(base.from / 1000)})`,
    `timestamp < toDateTime(${Math.ceil(base.to / 1000)})`,
  ];
  for (const w of base.where) parts.push(`${w.column} = ${sqlString(w.value)}`);
  if (base.index !== null) parts.push(`index1 = ${sqlString(base.index)}`);
  return parts.join(" AND ");
}

function valueSql(plan: GroupPlan): string {
  return plan.sumColumn ? `SUM(_sample_interval * ${plan.sumColumn})` : "SUM(_sample_interval)";
}

/** SQL of a totals query (exported for tests). */
export function totalsSql(q: TotalsQuery<MetricName>, dataset?: string): string {
  const plan = planGroups(q);
  const from = datasetName(dataset);
  if (plan.groups.length === 0) {
    return `SELECT ${valueSql(plan)} AS v FROM ${from} WHERE ${whereSql(plan)} FORMAT JSON`;
  }
  const sel = plan.groups.map((g, i) => `${g.column} AS k${i}`).join(", ");
  const keys = plan.groups.map((_, i) => `k${i}`).join(", ");
  return (
    `SELECT ${sel}, ${valueSql(plan)} AS v FROM ${from} WHERE ${whereSql(plan)}` +
    ` GROUP BY ${keys} ORDER BY v DESC, ${keys} LIMIT ${plan.limit} FORMAT JSON`
  );
}

/**
 * SQL of a series query (exported for tests). Groups are cut to the top
 * `limit` by total in JS after the read (as the local backend does), so the
 * SQL needs no subquery.
 */
export function seriesSql(q: SeriesQuery<MetricName>, dataset?: string): string {
  const plan = planGroups(q);
  const s = bucketSeconds(q.bucketMs);
  const sel = plan.groups.map((g, i) => `, ${g.column} AS k${i}`).join("");
  const keys = plan.groups.map((_, i) => `, k${i}`).join("");
  return (
    `SELECT intDiv(toUInt32(timestamp), ${s}) * ${s} AS bt${sel}, ${valueSql(plan)} AS v` +
    ` FROM ${datasetName(dataset)} WHERE ${whereSql(plan)}` +
    ` GROUP BY bt${keys} ORDER BY bt ASC LIMIT ${MAX_SERIES_ROWS} FORMAT JSON`
  );
}

/** SQL of a quantile query (exported for tests). */
export function quantilesSql(q: QuantileQuery<MetricName>, dataset?: string): string {
  const { column, qs } = planQuantileField(q);
  const base = planBase(q);
  const sel =
    qs.length === 0
      ? "SUM(_sample_interval) AS n"
      : qs
          .map((v, i) => `quantileExactWeighted(${v})(${column}, _sample_interval) AS q${i}`)
          .join(", ");
  return `SELECT ${sel} FROM ${datasetName(dataset)} WHERE ${whereSql(base)} FORMAT JSON`;
}

/** SQL of a distinct query (exported for tests). Empty index values are not counted. */
export function distinctSql(q: DistinctQuery<MetricName>, dataset?: string): string {
  const base = planBase(q);
  return (
    `SELECT COUNT(DISTINCT index1) AS v FROM ${datasetName(dataset)}` +
    ` WHERE ${whereSql(base)} AND index1 != '' FORMAT JSON`
  );
}

function num(v: unknown): number {
  // ClickHouse JSON quotes 64-bit integers; nan/inf come back as null or strings.
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function keysOf(row: Record<string, unknown>, plan: GroupPlan): Record<string, string> {
  const keys: Record<string, string> = {};
  plan.groups.forEach((g, i) => {
    const v = row[`k${i}`];
    keys[g.field] = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  });
  return keys;
}

export function aeSqlQuery(opts: AeSqlOptions): AnalyticsQuery {
  const url = AE_SQL_URL(opts.accountId);
  const token = opts.token;
  const dataset = opts.dataset;
  // Called as a plain function: Workers' fetch throws "Illegal invocation" when called as a method.
  const doFetch = opts.fetchFn;

  async function run(sql: string): Promise<Record<string, unknown>[]> {
    const res = await doFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: sql,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`analytics: AE SQL ${res.status}: ${text.slice(0, 200)}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`analytics: AE SQL answered non-JSON: ${text.slice(0, 200)}`);
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new Error("analytics: AE SQL response has no data array");
    return data.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object");
  }

  return {
    source: "ae",
    async totals<M extends MetricName>(q: TotalsQuery<M>): Promise<TotalsRow[]> {
      const query = q as unknown as TotalsQuery<MetricName>;
      const plan = planGroups(query);
      const rows = await run(totalsSql(query, dataset));
      if (plan.groups.length === 0) return ungroupedRow(num(rows[0]?.v));
      return rows.map((r) => ({ keys: keysOf(r, plan), value: num(r.v) }));
    },
    async series<M extends MetricName>(q: SeriesQuery<M>): Promise<SeriesRow[]> {
      const query = q as unknown as SeriesQuery<MetricName>;
      const plan = planGroups(query);
      const rows = await run(seriesSql(query, dataset));
      const out = rows.map((r) => ({
        t: num(r.bt) * 1000,
        keys: keysOf(r, plan),
        value: num(r.v),
      }));
      return topSeriesGroups(
        out,
        plan.groups.map((g) => g.field),
        plan.limit,
      );
    },
    async quantiles<M extends MetricName>(q: QuantileQuery<M>): Promise<number[]> {
      const query = q as unknown as QuantileQuery<MetricName>;
      const { qs } = planQuantileField(query);
      if (qs.length === 0) return [];
      const rows = await run(quantilesSql(query, dataset));
      const row = rows[0] ?? {};
      return qs.map((_, i) => num(row[`q${i}`]));
    },
    async distinct<M extends MetricName>(q: DistinctQuery<M>): Promise<number> {
      const rows = await run(distinctSql(q as unknown as DistinctQuery<MetricName>, dataset));
      return num(rows[0]?.v);
    },
  };
}
