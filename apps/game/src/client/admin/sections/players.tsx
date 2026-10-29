/**
 * Admin section "Players" (docs/design/admin-dashboard.md §2.2, §10.3). OWNER: T-ui-sections-a.
 * Signups, active players, retention cohorts, sessions and the platform, device,
 * country and continent mix. Retention shows the number as text in every cell
 * (the signal is never shading alone), and "–" where the day has not happened yet.
 */
import type { AdminPlayers, RetentionCohort } from "@gamez/protocol";
import {
  DataTable,
  defineSection,
  DistributionChart,
  Panel,
  QuantilesTile,
  SourcesNote,
  StatTile,
  TimeSeriesChart,
  type DataColumn,
} from "../kit/index.tsx";
import { sinceNote } from "./overview.tsx";

const DAY_MS = 86_400_000;

export const RETENTION_COLUMNS: readonly DataColumn<RetentionCohort>[] = [
  { key: "day", label: "Cohort (UTC)", value: (r) => r.day },
  { key: "size", label: "Size", value: (r) => r.size, format: "int", align: "right" },
  { key: "d1", label: "D1", value: (r) => r.d1 ?? "–", format: "pct", align: "right" },
  { key: "d7", label: "D7", value: (r) => r.d7 ?? "–", format: "pct", align: "right" },
  { key: "d30", label: "D30", value: (r) => r.d30 ?? "–", format: "pct", align: "right" },
];

function PlayersView({ data }: { data: AdminPlayers }) {
  return (
    <div className="adm-grid">
      <SourcesNote sources={data.sources} />
      <div className="adm-tiles">
        <StatTile label="Accounts" value={data.accounts.total} />
        <StatTile label="Guest" value={data.accounts.guest} />
        <StatTile label="Registered" value={data.accounts.registered} />
      </div>
      <Panel
        title="Signups"
        hint="New accounts and registrations per bucket. Registrations are dated only from migration 0010 on (registered_at); earlier registrations have no date and are not counted here."
        wide
      >
        <TimeSeriesChart
          title="Signups: new vs registered"
          series={data.signups}
          kind="bar"
          format="int"
          bucketMs={data.range.bucketMs}
          emptyText="No signups in this range."
          csvName="players-signups"
        />
      </Panel>
      <Panel
        title="Active players"
        hint={`Per day of the range, from D1 account_activity. WAU and MAU are trailing 7- and 30-day windows ending that day.${sinceNote(data.activitySince)}`}
        wide
      >
        <TimeSeriesChart
          title="Active players: DAU, WAU, MAU"
          series={data.active}
          kind="line"
          format="int"
          bucketMs={DAY_MS}
          emptyText="No activity in this range."
          csvName="players-active"
        />
      </Panel>
      <Panel
        title="Retention"
        hint="Cohorts are accounts by signup day (UTC, newest first). D1, D7 and D30 are the share of the cohort active exactly 1, 7 or 30 days later. – means that day has not happened yet or the cohort is empty. Cohorts need several days of data to be meaningful."
        wide
      >
        <DataTable
          caption="Retention by signup day"
          columns={[...RETENTION_COLUMNS]}
          rows={data.retention}
          csvName="players-retention"
        />
      </Panel>
      <Panel
        title="Sessions"
        hint="A session is one page load. Sessions without an end (crash, closed tab) count in the bars but not in the length figures below."
        wide
      >
        <TimeSeriesChart
          title="Sessions per bucket"
          series={data.sessions.perBucket}
          kind="bar"
          format="int"
          bucketMs={data.range.bucketMs}
          emptyText="No sessions in this range."
          csvName="players-sessions"
        />
      </Panel>
      <div className="adm-grid two">
        <Panel title="Session length" hint="Only sessions with an end event.">
          <QuantilesTile label="Session length (p50 / p95)" q={data.sessions.lengthS} format="s" />
          <DistributionChart
            dist={data.sessions.lengthHistogram}
            format="int"
            share
            csvName="players-session-length"
          />
        </Panel>
        <Panel title="Platform and device" hint="Sessions started, by platform and device class.">
          <DistributionChart dist={data.platforms} format="int" share csvName="players-platforms" />
          <DistributionChart dist={data.devices} format="int" share csvName="players-devices" />
        </Panel>
      </div>
      <div className="adm-grid two">
        <Panel
          title="Countries"
          hint="Top 20 by sessions started. XX means unknown (Cloudflare request.cf)."
        >
          <DistributionChart dist={data.countries} format="int" share csvName="players-countries" />
        </Panel>
        <Panel title="Continents" hint="Sessions started, from Cloudflare request.cf.">
          <DistributionChart
            dist={data.continents}
            format="int"
            share
            csvName="players-continents"
          />
        </Panel>
      </div>
    </div>
  );
}

export const playersSection = defineSection<AdminPlayers>({
  id: "players",
  label: "Players",
  group: "Players",
  load: (ctx) => ctx.get<AdminPlayers>(`/api/admin/players?${ctx.query}`),
  Component: ({ data }) =>
    data ? <PlayersView data={data} /> : <p className="adm-muted">Loading players…</p>,
});
