/**
 * AnalyticsQuery over MetricsDO "local" (docs/design/admin-dashboard.md §4.2).
 * OWNER: T-analytics-core. Every call forwards to the DO's RPC; the stub is
 * created per call so it never outlives the request that made it.
 */
import type { MetricName } from "./schema.ts";
import type {
  AnalyticsQuery,
  DistinctQuery,
  MetricsApi,
  QuantileQuery,
  SeriesQuery,
  SeriesRow,
  TotalsQuery,
  TotalsRow,
} from "./types.ts";

/** The DO name every isolate writes to and reads from. */
export const LOCAL_METRICS_NAME = "local";

/** The part of the METRICS namespace this file uses (a fake in tests). */
export interface MetricsNamespaceLike {
  getByName(name: string): MetricsApi;
}

export function localQuery(ns: MetricsNamespaceLike): AnalyticsQuery {
  const stub = (): MetricsApi => ns.getByName(LOCAL_METRICS_NAME);
  return {
    source: "local",
    totals: <M extends MetricName>(q: TotalsQuery<M>): Promise<TotalsRow[]> =>
      stub().totals(q as unknown as TotalsQuery<MetricName>),
    series: <M extends MetricName>(q: SeriesQuery<M>): Promise<SeriesRow[]> =>
      stub().series(q as unknown as SeriesQuery<MetricName>),
    quantiles: <M extends MetricName>(q: QuantileQuery<M>): Promise<number[]> =>
      stub().quantiles(q as unknown as QuantileQuery<MetricName>),
    distinct: <M extends MetricName>(q: DistinctQuery<M>): Promise<number> =>
      stub().distinct(q as unknown as DistinctQuery<MetricName>),
  };
}
