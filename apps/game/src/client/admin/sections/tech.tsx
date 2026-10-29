/**
 * Admin section "Tech health" (docs/design/admin-dashboard.md §2.7, §10.3). OWNER: T-ui-sections-b.
 * Requests and errors, routes, websockets, Durable Object activity,
 * verification resyncs, the D1 sync (lag, apply, dead, retries), D1 latency,
 * client performance and errors, and build / content-hash adoption.
 */
import type { AdminTech, Distribution, Series } from "@gamez/protocol";
import {
  DataTable,
  DistributionChart,
  Panel,
  QuantilesTile,
  SourcesNote,
  StatTile,
  TimeSeriesChart,
  defineSection,
  formatValue,
} from "../kit/index.tsx";
import type { DataColumn, ValueFormat } from "../kit/index.tsx";

type RouteRow = AdminTech["routes"][number];
type ClientErrorRow = AdminTech["client"]["errors"][number];

export const techSection = defineSection<AdminTech>({
  id: "tech",
  label: "Tech health",
  group: "Ops",
  load: (ctx) => ctx.get<AdminTech>(`/api/admin/tech?${ctx.query}`),
  Component: ({ data }) =>
    data ? <TechView d={data} /> : <p className="adm-muted">Loading tech health…</p>,
});

const ROUTE_COLUMNS: DataColumn<RouteRow>[] = [
  { key: "route", label: "Route", value: (r) => r.route },
  { key: "requests", label: "Requests", value: (r) => r.requests, align: "right" },
  { key: "e5", label: "5xx", value: (r) => r.errors5xx, align: "right" },
  { key: "e4", label: "4xx", value: (r) => r.errors4xx, align: "right" },
  { key: "p50", label: "p50 ms", value: (r) => r.p50Ms, format: "ms", align: "right" },
  { key: "p95", label: "p95 ms", value: (r) => r.p95Ms, format: "ms", align: "right" },
];

const CLIENT_ERROR_COLUMNS: DataColumn<ClientErrorRow>[] = [
  { key: "build", label: "Build", value: (r) => r.build },
  { key: "kind", label: "Kind", value: (r) => r.kind },
  { key: "messageKey", label: "Message", value: (r) => r.messageKey },
  { key: "count", label: "Count", value: (r) => r.count, align: "right" },
];

function hasData(dist: Distribution): boolean {
  return dist.buckets.some((b) => b.value > 0);
}

function seriesHasData(series: Series[]): boolean {
  return series.some((s) => s.points.some((p) => p.v > 0));
}

function Empty() {
  return <p className="adm-muted">No data in this range yet.</p>;
}

function DistPanel({
  title,
  hint,
  dist,
  csvName,
  format,
  maxBars,
}: {
  title: string;
  hint?: string;
  dist: Distribution;
  csvName: string;
  format?: ValueFormat;
  maxBars?: number;
}) {
  return (
    <Panel title={title} hint={hint}>
      {hasData(dist) ? (
        <DistributionChart dist={dist} csvName={csvName} format={format} maxBars={maxBars} />
      ) : (
        <Empty />
      )}
    </Panel>
  );
}

function SeriesPanel({
  title,
  hint,
  series,
  kind,
  format,
  bucketMs,
  csvName,
}: {
  title: string;
  hint?: string;
  series: Series[];
  kind?: "line" | "bar" | "stacked";
  format?: ValueFormat;
  bucketMs: number;
  csvName: string;
}) {
  return (
    <Panel title={title} hint={hint}>
      {seriesHasData(series) ? (
        <TimeSeriesChart
          title={title}
          series={series}
          kind={kind}
          format={format}
          bucketMs={bucketMs}
          csvName={csvName}
          emptyText="No data in this range yet."
        />
      ) : (
        <Empty />
      )}
    </Panel>
  );
}

function TechView({ d }: { d: AdminTech }) {
  const bucketMs = d.range.bucketMs;
  const sync = d.sync;
  const verify = d.verification;
  const ws = d.websockets;

  return (
    <>
      <SourcesNote sources={d.sources} />

      <SeriesPanel
        title="Requests by status class"
        hint="HTTP requests per bucket, stacked by status class. 1xx is WebSocket upgrades; the overview error rate leaves them out."
        series={d.requests}
        kind="stacked"
        bucketMs={bucketMs}
        csvName="tech-requests"
      />
      <SeriesPanel
        title="Errors by route"
        hint="5xx responses per bucket, top routes."
        series={d.errors}
        kind="stacked"
        bucketMs={bucketMs}
        csvName="tech-errors"
      />

      <Panel title="Routes" hint="Top routes by request count.">
        {d.routes.length > 0 ? (
          <DataTable
            caption="Routes"
            columns={ROUTE_COLUMNS}
            rows={d.routes}
            csvName="tech-routes"
          />
        ) : (
          <Empty />
        )}
      </Panel>

      <Panel title="WebSockets" hint="Connections opened in the range and how long they lasted.">
        <div className="adm-tiles" aria-label="WebSocket totals">
          <StatTile label="Opened" value={ws.opens} />
          <QuantilesTile label="Duration" q={ws.durationS} format="s" />
        </div>
      </Panel>
      <div className="adm-grid two">
        <DistPanel title="WebSockets by kind" dist={ws.byKind} csvName="tech-ws-kind" />
        <SeriesPanel
          title="WebSocket opens per bucket"
          series={ws.series}
          kind="bar"
          bucketMs={bucketMs}
          csvName="tech-ws-series"
        />
      </div>

      <DistPanel
        title="Durable Object activity"
        hint="DO-slots (10 min): each bar counts 10-minute slots in which an instance of that class was active."
        dist={d.durableObjects}
        csvName="tech-do"
      />

      <Panel
        title="Verification"
        hint="Anti-cheat. Every verified segment has an outcome: ok, or a rejection code (input_rejected, gap, bad_segment, too_fast…). A rejected segment is dropped; a resync is the server sending its state back to the client, which happens only for some rejections, so resyncs are fewer than non-ok segments."
      >
        <div className="adm-tiles" aria-label="Verification totals">
          <StatTile label="Segments" value={verify.segments} />
          <StatTile
            label="Resyncs"
            value={verify.resyncs}
            status={verify.resyncs > 0 ? "warning" : "good"}
          />
        </div>
      </Panel>
      <div className="adm-grid two">
        <DistPanel title="Resyncs by code" dist={verify.byCode} csvName="tech-resync-code" />
        <SeriesPanel
          title="Verification per bucket"
          series={verify.series}
          kind="bar"
          bucketMs={bucketMs}
          csvName="tech-verify-series"
        />
      </div>

      <Panel title="Sync to D1" hint="The transactional outbox, queue and D1 apply.">
        <div className="adm-tiles" aria-label="Sync totals">
          <StatTile label="Batches" value={sync.batches} />
          <StatTile label="Records" value={sync.records} />
          <StatTile
            label="Dead (DLQ inflow)"
            value={sync.dead}
            status={sync.dead > 0 ? "critical" : "good"}
            hint="Messages sent to the dead-letter queue"
          />
          <StatTile
            label="Retries"
            value={sync.retries}
            status={sync.retries > 0 ? "warning" : undefined}
          />
          <QuantilesTile label="Lag" q={sync.lagMs} format="ms" />
          <QuantilesTile label="Apply" q={sync.applyMs} format="ms" />
        </div>
      </Panel>
      <SeriesPanel
        title="Sync batches by outcome"
        series={sync.series}
        kind="stacked"
        bucketMs={bucketMs}
        csvName="tech-sync-series"
      />

      <Panel title="D1" hint="Read model query latency.">
        <div className="adm-tiles" aria-label="D1 totals">
          <StatTile label="Queries" value={d.d1.queries} />
          <QuantilesTile label="Latency" q={d.d1.latencyMs} format="ms" />
        </div>
      </Panel>
      <DistPanel title="D1 queries by label" dist={d.d1.byLabel} csvName="tech-d1-label" />

      <Panel
        title="Client performance"
        hint="Frames per second and load time, from sampled player sessions."
      >
        <div className="adm-tiles" aria-label="Client performance">
          <StatTile
            label="FPS: typical / slow frames"
            value={
              d.client.fps.n > 0
                ? `${formatValue(d.client.fps.p50)} / ${formatValue(d.client.fps.p95)}`
                : "–"
            }
            hint={`median over sessions of each session's median fps / fps at its slowest 5 % of frames · n=${formatValue(d.client.fps.n, "compact")}`}
          />
          <QuantilesTile label="Frame time p95" q={d.client.frameMsP95} format="ms" />
          <QuantilesTile label="Load time" q={d.client.loadMs} format="ms" />
        </div>
      </Panel>

      <Panel
        title="Client errors"
        hint="Most frequent client errors, by build. Messages are scrubbed on the client and again on the server (no URLs, e-mails, ids or numbers)."
      >
        {d.client.errors.length > 0 ? (
          <DataTable
            caption="Client errors"
            columns={CLIENT_ERROR_COLUMNS}
            rows={d.client.errors}
            csvName="tech-client-errors"
          />
        ) : (
          <Empty />
        )}
      </Panel>

      <div className="adm-grid two">
        <DistPanel title="Build adoption" dist={d.client.builds} csvName="tech-builds" />
        <DistPanel
          title="Content hash adoption"
          dist={d.client.contentHashes}
          csvName="tech-content-hash"
        />
      </div>
    </>
  );
}
