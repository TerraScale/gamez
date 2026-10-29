/**
 * Admin section "Overview" (docs/design/admin-dashboard.md §10.3). OWNER: T-ui-sections-a.
 * Tiles for accounts, active players, concurrency, 24 h revenue and two health
 * numbers with status, plus the DAU chart. Every status carries an icon and a
 * word, never colour alone.
 *
 * Status thresholds (kept here so the UI and the docs agree):
 * - errorRate1h (5xx share of requests, last hour): good below 1 %;
 *   warning from 1 % up to 5 %; critical from 5 % up.
 * - syncLagP95Ms (enqueue -> applied, p95, last hour): good up to and including
 *   5 s; warning above 5 s up to 30 s; critical above 30 s.
 */
import type { AdminOverview, FiatCurrency } from "@gamez/protocol";
import { defineSection, Panel, SourcesNote, StatTile, TimeSeriesChart } from "../kit/index.tsx";

export type Status = "good" | "warning" | "critical";

export const ERROR_RATE_WARNING = 0.01;
export const ERROR_RATE_CRITICAL = 0.05;
export const SYNC_LAG_WARNING_MS = 5_000;
export const SYNC_LAG_CRITICAL_MS = 30_000;

/** Status of the 1 h error rate (0..1). Non-finite input is critical. */
export function errorRateStatus(rate: number): Status {
  if (!Number.isFinite(rate)) return "critical";
  if (rate >= ERROR_RATE_CRITICAL) return "critical";
  if (rate >= ERROR_RATE_WARNING) return "warning";
  return "good";
}

/** Status of the p95 sync lag in ms. Non-finite input is critical. */
export function syncLagStatus(ms: number): Status {
  if (!Number.isFinite(ms)) return "critical";
  if (ms > SYNC_LAG_CRITICAL_MS) return "critical";
  if (ms > SYNC_LAG_WARNING_MS) return "warning";
  return "good";
}

/** The word shown next to a status icon. */
export function statusWord(status: Status): string {
  if (status === "good") return "Good";
  if (status === "warning") return "Warning";
  return "Critical";
}

/** Says from which day activity data exists (earlier days are not shown). */
export function sinceNote(since: string | null | undefined): string {
  if (since === undefined) return "";
  if (since === null) return " No activity has been recorded yet.";
  return ` Recorded from ${since}; earlier days have no data and are not shown.`;
}

function OverviewView({ data }: { data: AdminOverview }) {
  const errorStatus = errorRateStatus(data.errorRate1h);
  const lagStatus = syncLagStatus(data.syncLagP95Ms);
  const revenue = Object.entries(data.revenueMinor24h) as [FiatCurrency, number][];
  return (
    <div className="adm-grid">
      <SourcesNote sources={data.sources} />
      <Panel title="Players now" hint="Accounts are totals; active counts are UTC days.">
        <div className="adm-tiles">
          <StatTile label="Accounts" value={data.accounts.total} hint="all, not deleted" />
          <StatTile label="Guest accounts" value={data.accounts.guest} />
          <StatTile label="Registered accounts" value={data.accounts.registered} />
          <StatTile label="DAU" value={data.dau} hint="today (UTC)" />
          <StatTile label="WAU" value={data.wau} hint="last 7 days" />
          <StatTile label="MAU" value={data.mau} hint="last 30 days" />
          <StatTile
            label="Concurrent now"
            value={data.concurrent}
            hint="sessions with a heartbeat in the last 2 min (approx.)"
          />
        </div>
      </Panel>
      <Panel title="Revenue and health" hint="Revenue is paid purchases in the last 24 h.">
        <div className="adm-tiles">
          {revenue.length === 0 ? (
            <StatTile label="Revenue 24 h" value="–" hint="no paid purchases" />
          ) : (
            revenue.map(([cur, minor]) => (
              <StatTile
                key={cur}
                label={`Revenue 24 h (${cur})`}
                value={minor}
                format={{ money: cur }}
              />
            ))
          )}
          <StatTile
            label="Error rate, 1 h"
            value={data.errorRate1h}
            format="pct"
            status={errorStatus}
            hint={`${statusWord(errorStatus)} · 5xx share of requests; good <1 %, warning <5 %`}
          />
          <StatTile
            label="Sync lag p95, 1 h"
            value={data.syncLagP95Ms}
            format="ms"
            status={lagStatus}
            hint={`${statusWord(lagStatus)} · enqueue to D1; good ≤5 s, warning ≤30 s`}
          />
        </div>
      </Panel>
      <Panel
        title="Daily active players"
        hint={`DAU per day of the range (UTC), from D1 account_activity.${sinceNote(data.activitySince)}`}
      >
        <TimeSeriesChart
          title="Daily active players"
          series={data.activeSeries}
          kind="line"
          format="int"
          bucketMs={data.range.bucketMs}
          emptyText="No activity in this range yet."
          csvName="overview-dau"
        />
      </Panel>
    </div>
  );
}

export const overviewSection = defineSection<AdminOverview>({
  id: "overview",
  label: "Overview",
  group: "Live",
  load: (ctx) => ctx.get<AdminOverview>(`/api/admin/overview?${ctx.query}`),
  Component: ({ data }) =>
    data ? <OverviewView data={data} /> : <p className="adm-muted">Loading the overview…</p>,
});
