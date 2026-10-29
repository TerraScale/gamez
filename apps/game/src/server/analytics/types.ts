/**
 * Analytics write and query interfaces (docs/design/admin-dashboard.md §4).
 * CONTRACT (architect). Implementations: analytics/index.ts (T-analytics-core).
 *
 * Write path: `Analytics.write()` never throws and never awaits. It forwards
 * the point to the Analytics Engine binding (env.ANALYTICS) when bound, and to
 * the local stub (MetricsDO "local") when the local sink is on (index.ts
 * localSinkOn: ANALYTICS_LOCAL "1", or a dev build without AE SQL credentials;
 * never "0"). Local points are buffered per isolate and flushed through `waitUntil`.
 *
 * Query path: `AnalyticsQuery` answers aggregate questions over the same
 * column layout, from the AE SQL API (ANALYTICS_ACCOUNT_ID + ANALYTICS_API_TOKEN)
 * or from MetricsDO. Every result is weighted by the sample interval.
 */
import type {
  BlobName,
  DoubleName,
  MetricName,
  BlobsOf,
  DoublesOf,
  StoredPoint,
} from "./schema.ts";

export interface Analytics {
  write<M extends MetricName>(
    metric: M,
    blobs: BlobsOf<M>,
    doubles?: DoublesOf<M>,
    index?: string,
  ): void;
  /** Sends buffered local points now (the factory already schedules this via waitUntil). */
  flush(): Promise<void>;
}

/** What to aggregate: a count of points, or the sum of one double (sample-weighted). */
export type ValueSpec<M extends MetricName> = { op: "count" } | { op: "sum"; field: DoubleName<M> };

export interface QueryBase<M extends MetricName> {
  metric: M;
  from: number;
  to: number;
  /** Exact-match filters on blob fields. */
  where?: Partial<Record<BlobName<M>, string>>;
  /** Restrict to one sampling key (accountId / session id). */
  index?: string;
}

/** Grouped totals: one row per distinct combination of `groupBy` (top `limit` by value). */
export interface TotalsQuery<M extends MetricName> extends QueryBase<M> {
  groupBy: BlobName<M>[];
  value: ValueSpec<M>;
  /** Default 50, max 500. */
  limit?: number;
}

/** Bucketed series: like totals plus a time bucket. */
export interface SeriesQuery<M extends MetricName> extends TotalsQuery<M> {
  bucketMs: number;
}

export interface QuantileQuery<M extends MetricName> extends QueryBase<M> {
  field: DoubleName<M>;
  /** e.g. [0.5, 0.95] */
  q: number[];
}

/** Distinct sampling keys (index1) — approximate on AE. */
export type DistinctQuery<M extends MetricName> = QueryBase<M>;

export interface TotalsRow {
  /** groupBy field -> value. */
  keys: Record<string, string>;
  value: number;
}

export interface SeriesRow extends TotalsRow {
  /** Bucket start (epoch ms, aligned to bucketMs since epoch). */
  t: number;
}

export type AnalyticsSourceKind = "ae" | "local" | "none";

export interface AnalyticsQuery {
  readonly source: AnalyticsSourceKind;
  totals<M extends MetricName>(q: TotalsQuery<M>): Promise<TotalsRow[]>;
  series<M extends MetricName>(q: SeriesQuery<M>): Promise<SeriesRow[]>;
  /** One value per requested quantile, in order; zeros when there is no data. */
  quantiles<M extends MetricName>(q: QuantileQuery<M>): Promise<number[]>;
  distinct<M extends MetricName>(q: DistinctQuery<M>): Promise<number>;
}

/**
 * RPC surface of MetricsDO "local" (the local/dev analytics stub). Queries
 * use the same shapes as AnalyticsQuery (structured-clone safe).
 */
export interface MetricsApi {
  ingest(points: StoredPoint[]): Promise<void>;
  totals(q: TotalsQuery<MetricName>): Promise<TotalsRow[]>;
  series(q: SeriesQuery<MetricName>): Promise<SeriesRow[]>;
  quantiles(q: QuantileQuery<MetricName>): Promise<number[]>;
  distinct(q: DistinctQuery<MetricName>): Promise<number>;
}

/** Local stub limits (MetricsDO keeps a bounded ring). */
export const LOCAL_LIMITS = {
  /** Rows kept; older rows are pruned on ingest. */
  maxRows: 200_000,
  /** Rows older than this are pruned. */
  keepMs: 14 * 86_400_000,
  /** Per-isolate buffer size that triggers a flush. */
  flushAt: 50,
  /** Per-isolate cap on points sent to MetricsDO per second (excess sampled out, weight kept). */
  perSecond: 200,
} as const;

/** The env the analytics factory reads (subset of Env). */
export interface AnalyticsEnv {
  ANALYTICS?: AnalyticsEngineDataset;
  METRICS?: DurableObjectNamespace<import("../do/metrics.ts").MetricsDO>;
  ANALYTICS_ACCOUNT_ID?: string;
  ANALYTICS_API_TOKEN?: string;
  /** AE dataset name for SQL queries (default "gamez_events"). */
  ANALYTICS_DATASET?: string;
  /** "0": never write/read the local stub. "1": always write it (even in production). Unset: dev builds only. */
  ANALYTICS_LOCAL?: string;
}
