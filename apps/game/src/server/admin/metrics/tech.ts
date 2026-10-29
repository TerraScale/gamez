/**
 * GET /api/admin/tech (docs/design/admin-dashboard.md §2.7). OWNER: T-api-tech.
 * Every number comes from Analytics Engine (the local stub on dev), read
 * through SourceLog so a failed read yields empty data and `ok: false`.
 *
 * Quantiles are p50/p95 of the points' values. Counts are sample-weighted by
 * the query layer. `n` (values the quantiles were computed from) is the
 * weighted count of the metric's points, read with one extra totals query.
 */
import type { AdminRange, AdminTech, Quantiles, RouteHealth, Series } from "@gamez/protocol";
import type { AnalyticsQuery, SeriesRow, TotalsRow } from "../../analytics/types.ts";
import {
  METRICS,
  type BlobName,
  type DoubleName,
  type MetricName,
} from "../../analytics/schema.ts";
import {
  distOf,
  EMPTY_QUANTILES,
  num,
  SourceLog,
  seriesRows,
  toSeries,
  type MetricsDeps,
} from "./util.ts";

/** Routes in the route table (top by requests). */
const ROUTE_LIMIT = 20;
/** Routes in the 5xx series. */
const ERROR_ROUTES = 5;
/** Client error groups listed. */
const CLIENT_ERROR_LIMIT = 20;
/** Group limit of a totals/series read (the query layer caps at 500). */
const GROUP_LIMIT = 50;
const COUNT = { op: "count" } as const;

interface Span {
  from: number;
  to: number;
}

const sumOf = (rows: readonly TotalsRow[]): number =>
  rows.reduce((acc, r) => acc + num(r.value), 0);

/** Sum of the rows whose `field` equals `key`. */
const valueOf = (rows: readonly TotalsRow[], field: string, key: string): number =>
  rows.filter((r) => r.keys[field] === key).reduce((acc, r) => acc + num(r.value), 0);

/** The weighted count of a metric's points (optionally filtered), read via a grouped total. */
async function countOf<M extends MetricName>(
  aq: AnalyticsQuery,
  span: Span,
  metric: M,
  where?: Partial<Record<BlobName<M>, string>>,
): Promise<number> {
  // Grouping by the first blob and summing the groups gives the total count
  // (an empty groupBy is not part of the query contract).
  const first = METRICS[metric].blobs[0] as BlobName<M>;
  const rows = await aq.totals({
    metric,
    from: span.from,
    to: span.to,
    where,
    groupBy: [first],
    value: COUNT,
    limit: 500,
  });
  return sumOf(rows);
}

/** p50/p95 of one double field, with the count of its points. */
async function quantilesOf<M extends MetricName>(
  aq: AnalyticsQuery,
  span: Span,
  metric: M,
  field: DoubleName<M>,
  where?: Partial<Record<BlobName<M>, string>>,
): Promise<Quantiles> {
  const [values, n] = await Promise.all([
    aq.quantiles({ metric, field, from: span.from, to: span.to, where, q: [0.5, 0.95] }),
    countOf(aq, span, metric, where),
  ]);
  return pct(values, n);
}

/** Quantiles from [p50, p95] values and their count. */
function pct(values: readonly number[], n: number): Quantiles {
  return { p50: num(values[0]), p95: num(values[1]), n };
}

/** Median (q = 0.5) of one double field over the points. */
async function medianOf<M extends MetricName>(
  aq: AnalyticsQuery,
  span: Span,
  metric: M,
  field: DoubleName<M>,
): Promise<number> {
  const [median] = await aq.quantiles({
    metric,
    field,
    from: span.from,
    to: span.to,
    q: [0.5],
  });
  return num(median);
}

/** The route table: top routes by requests, with 5xx/4xx counts and p50/p95 latency. */
async function routeTable(aq: AnalyticsQuery, span: Span): Promise<RouteHealth[]> {
  const data = await aq.totals({
    metric: "http.request",
    from: span.from,
    to: span.to,
    groupBy: ["route", "statusClass"],
    value: COUNT,
    limit: 500,
  });
  const byRoute = new Map<string, { requests: number; errors5xx: number; errors4xx: number }>();
  for (const row of data) {
    const route = row.keys.route ?? "";
    const cur = byRoute.get(route) ?? { requests: 0, errors5xx: 0, errors4xx: 0 };
    const v = num(row.value);
    cur.requests += v;
    if (row.keys.statusClass === "5xx") cur.errors5xx += v;
    else if (row.keys.statusClass === "4xx") cur.errors4xx += v;
    byRoute.set(route, cur);
  }
  const top = [...byRoute.entries()]
    .sort((a, b) => b[1].requests - a[1].requests || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, ROUTE_LIMIT);
  const latency = await Promise.all(
    top.map(([route]) =>
      aq.quantiles({
        metric: "http.request",
        field: "ms",
        from: span.from,
        to: span.to,
        where: { route },
        q: [0.5, 0.95],
      }),
    ),
  );
  return top.map(([route, c], i) => ({
    route,
    requests: c.requests,
    errors5xx: c.errors5xx,
    errors4xx: c.errors4xx,
    p50Ms: num(latency[i]?.[0]),
    p95Ms: num(latency[i]?.[1]),
  }));
}

/** Content-hash label for sessions outside a mode (telemetry sends "" there). */
export const NO_MODE_HASH = "(none, outside a mode)";

/** Series labels: "101" is the WebSocket upgrade, the only single status code kept. */
const STATUS_LABELS: Record<string, string> = {
  "101": "1xx (WebSocket upgrade)",
  "2xx": "2xx",
  "3xx": "3xx",
  "4xx": "4xx",
  "5xx": "5xx",
};

export async function readTech(d: MetricsDeps, range: AdminRange): Promise<AdminTech> {
  const log = new SourceLog(d);
  const span: Span = { from: range.from, to: range.to };
  const bucketMs = range.bucketMs;

  const requests = await log.ae("http.request", [] as Series[], async (aq) =>
    toSeries(
      range,
      seriesRows(
        await aq.series({
          metric: "http.request",
          ...span,
          groupBy: ["statusClass"],
          value: COUNT,
          bucketMs,
          limit: GROUP_LIMIT,
        }),
        "statusClass",
      ),
      STATUS_LABELS,
    ),
  );

  // 5xx per bucket for the top routes (the series query groups by route).
  const errors = await log.ae("http.request", [] as Series[], async (aq) => {
    const data: SeriesRow[] = await aq.series({
      metric: "http.request",
      ...span,
      where: { statusClass: "5xx" },
      groupBy: ["route"],
      value: COUNT,
      bucketMs,
      limit: GROUP_LIMIT,
    });
    return toSeries(range, seriesRows(data, "route")).slice(0, ERROR_ROUTES);
  });

  const routes = await log.ae("http.request", [] as RouteHealth[], (aq) => routeTable(aq, span));

  // Sockets: opens per kind, the series per kind, and close durations.
  const wsKinds = await log.ae("ws.open", [] as TotalsRow[], (aq) =>
    aq.totals({ metric: "ws.open", ...span, groupBy: ["kind"], value: COUNT, limit: GROUP_LIMIT }),
  );
  const wsSeries = await log.ae("ws.open", [] as Series[], async (aq) =>
    toSeries(
      range,
      seriesRows(
        await aq.series({
          metric: "ws.open",
          ...span,
          groupBy: ["kind"],
          value: COUNT,
          bucketMs,
          limit: GROUP_LIMIT,
        }),
        "kind",
      ),
    ),
  );
  const wsDuration = await log.ae("ws.close", EMPTY_QUANTILES, (aq) =>
    quantilesOf(aq, span, "ws.close", "durationS"),
  );

  // DO activity: one point per DO id per 10 minutes (DO-slots).
  const doRows = await log.ae("do.active", [] as TotalsRow[], (aq) =>
    aq.totals({
      metric: "do.active",
      ...span,
      groupBy: ["class"],
      value: COUNT,
      limit: GROUP_LIMIT,
    }),
  );

  // Verification: segments by outcome, resyncs by code.
  const segRows = await log.ae("verify.segment", [] as TotalsRow[], (aq) =>
    aq.totals({
      metric: "verify.segment",
      ...span,
      groupBy: ["outcome"],
      value: COUNT,
      limit: GROUP_LIMIT,
    }),
  );
  const segSeries = await log.ae("verify.segment", [] as Series[], async (aq) =>
    toSeries(
      range,
      seriesRows(
        await aq.series({
          metric: "verify.segment",
          ...span,
          groupBy: ["outcome"],
          value: COUNT,
          bucketMs,
          limit: GROUP_LIMIT,
        }),
        "outcome",
      ),
    ),
  );
  const resyncRows = await log.ae("verify.resync", [] as TotalsRow[], (aq) =>
    aq.totals({
      metric: "verify.resync",
      ...span,
      groupBy: ["code"],
      value: COUNT,
      limit: GROUP_LIMIT,
    }),
  );

  // Sync: batches by outcome (dead = DLQ inflow, retry), records, lag and apply times.
  const syncBlock = await log.ae(
    "sync.batch",
    {
      batches: [] as TotalsRow[],
      records: 0,
      lag: EMPTY_QUANTILES,
      apply: EMPTY_QUANTILES,
      series: [] as Series[],
    },
    async (aq) => {
      const batches = await aq.totals({
        metric: "sync.batch",
        ...span,
        groupBy: ["outcome"],
        value: COUNT,
        limit: GROUP_LIMIT,
      });
      const n = sumOf(batches);
      const [recordRows, lagValues, applyValues, outcomeSeries] = await Promise.all([
        aq.totals({
          metric: "sync.batch",
          ...span,
          groupBy: ["outcome"],
          value: { op: "sum", field: "records" },
          limit: GROUP_LIMIT,
        }),
        aq.quantiles({ metric: "sync.batch", field: "lagMs", ...span, q: [0.5, 0.95] }),
        aq.quantiles({ metric: "sync.batch", field: "applyMs", ...span, q: [0.5, 0.95] }),
        aq.series({
          metric: "sync.batch",
          ...span,
          groupBy: ["outcome"],
          value: COUNT,
          bucketMs,
          limit: GROUP_LIMIT,
        }),
      ]);
      return {
        batches,
        records: sumOf(recordRows),
        lag: pct(lagValues, n),
        apply: pct(applyValues, n),
        series: toSeries(range, seriesRows(outcomeSeries, "outcome")),
      };
    },
  );

  // D1 (timed reads of our own readers and the sync apply).
  const d1Block = await log.ae(
    "d1.query",
    { rows: [] as TotalsRow[], latency: EMPTY_QUANTILES },
    async (aq) => {
      const rowsByLabel = await aq.totals({
        metric: "d1.query",
        ...span,
        groupBy: ["label"],
        value: COUNT,
        limit: GROUP_LIMIT,
      });
      const n = sumOf(rowsByLabel);
      const values = await aq.quantiles({
        metric: "d1.query",
        field: "ms",
        ...span,
        q: [0.5, 0.95],
      });
      return { rows: rowsByLabel, latency: pct(values, n) };
    },
  );

  // Client: frame stats from client.perf, load time from session starts, errors and versions.
  const fps = await log.ae("client.perf", EMPTY_QUANTILES, async (aq) => {
    const [p50, p95, n] = await Promise.all([
      medianOf(aq, span, "client.perf", "fpsP50"),
      medianOf(aq, span, "client.perf", "fpsP95"),
      countOf(aq, span, "client.perf"),
    ]);
    return { p50, p95, n };
  });
  const frameMsP95 = await log.ae("client.perf", EMPTY_QUANTILES, (aq) =>
    quantilesOf(aq, span, "client.perf", "frameMsP95"),
  );
  const loadMs = await log.ae("client.session", EMPTY_QUANTILES, (aq) =>
    quantilesOf(aq, span, "client.session", "loadMs", { phase: "start" }),
  );
  const clientErrors = await log.ae("client.error", [] as TotalsRow[], (aq) =>
    aq.totals({
      metric: "client.error",
      ...span,
      groupBy: ["build", "kind", "messageKey"],
      value: COUNT,
      limit: CLIENT_ERROR_LIMIT,
    }),
  );
  const builds = await log.ae("client.session", [] as TotalsRow[], (aq) =>
    aq.totals({
      metric: "client.session",
      ...span,
      where: { phase: "start" },
      groupBy: ["build"],
      value: COUNT,
      limit: GROUP_LIMIT,
    }),
  );
  const contentHashes = await log.ae("client.session", [] as TotalsRow[], async (aq) =>
    // Sessions outside a mode send contentHash "": give them a readable label.
    (
      await aq.totals({
        metric: "client.session",
        ...span,
        where: { phase: "start" },
        groupBy: ["contentHash"],
        value: COUNT,
        limit: GROUP_LIMIT,
      })
    ).map((r) =>
      r.keys.contentHash ? r : { ...r, keys: { ...r.keys, contentHash: NO_MODE_HASH } },
    ),
  );

  // Totals of the reads above (a failed read contributes nothing).
  const wsOpens = sumOf(wsKinds);
  const segments = sumOf(segRows);
  const resyncs = sumOf(resyncRows);

  return {
    at: d.now,
    range,
    sources: log.sources,
    requests,
    errors,
    routes,
    websockets: {
      opens: wsOpens,
      byKind: distOf("wsByKind", "Sockets", wsKinds, "kind"),
      durationS: wsDuration,
      series: wsSeries,
    },
    durableObjects: distOf("doActive", "Active DOs", doRows, "class"),
    verification: {
      segments,
      resyncs,
      byCode: distOf("resyncs", "Resyncs", resyncRows, "code"),
      series: segSeries,
    },
    sync: {
      batches: sumOf(syncBlock.batches),
      records: syncBlock.records,
      lagMs: syncBlock.lag,
      applyMs: syncBlock.apply,
      dead: valueOf(syncBlock.batches, "outcome", "dead"),
      retries: valueOf(syncBlock.batches, "outcome", "retry"),
      series: syncBlock.series,
    },
    d1: {
      queries: sumOf(d1Block.rows),
      latencyMs: d1Block.latency,
      byLabel: distOf("d1ByLabel", "D1 reads", d1Block.rows, "label"),
    },
    client: {
      fps,
      frameMsP95,
      loadMs,
      errors: clientErrors.map((r) => ({
        build: r.keys.build ?? "",
        kind: r.keys.kind ?? "",
        messageKey: r.keys.messageKey ?? "",
        count: num(r.value),
      })),
      builds: distOf("builds", "Builds", builds, "build"),
      contentHashes: distOf("contentHashes", "Content hashes", contentHashes, "contentHash"),
    },
  };
}
