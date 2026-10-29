/**
 * Admin section "Gameplay" (docs/design/admin-dashboard.md §2.3, §10.3). OWNER: T-ui-sections-b.
 * Classic first: heroes, playtime split, kills and deaths, bosses, quests,
 * rifts, achievements / skills / talents, drops, offline grants, XP per hour
 * and party. Sim counters come from verified play only (lag up to 5 minutes).
 */
import type { AdminGameplay, Distribution, Series } from "@gamez/protocol";
import {
  DataTable,
  DistributionChart,
  FunnelChart,
  Panel,
  SourcesNote,
  StatTile,
  TimeSeriesChart,
  defineSection,
} from "../kit/index.tsx";
import type { DataColumn, ValueFormat } from "../kit/index.tsx";

type BossRow = AdminGameplay["bosses"]["rows"][number];
type QuestRow = AdminGameplay["quests"]["rows"][number];
interface QuestTableRow extends QuestRow {
  rate: number;
}

export const gameplaySection = defineSection<AdminGameplay>({
  id: "gameplay",
  label: "Gameplay",
  group: "Game",
  load: (ctx) => ctx.get<AdminGameplay>(`/api/admin/gameplay?mode=classic&${ctx.query}`),
  Component: ({ data }) =>
    data ? <GameplayView d={data} /> : <p className="adm-muted">Loading gameplay…</p>,
});

const BOSS_COLUMNS: DataColumn<BossRow>[] = [
  { key: "monster", label: "Boss", value: (r) => r.monster },
  { key: "spawned", label: "Spawned", value: (r) => r.spawned, align: "right" },
  { key: "killed", label: "Killed", value: (r) => r.killed, align: "right" },
  { key: "killRate", label: "Kill rate", value: (r) => r.killRate, format: "pct", align: "right" },
];

const QUEST_COLUMNS: DataColumn<QuestTableRow>[] = [
  { key: "quest", label: "Quest", value: (r) => r.quest },
  { key: "accepted", label: "Accepted", value: (r) => r.accepted, align: "right" },
  { key: "completed", label: "Completed", value: (r) => r.completed, align: "right" },
  { key: "rate", label: "Completion", value: (r) => r.rate, format: "pct", align: "right" },
];

/** Share n/d in 0..1, 0 when d is 0 (never NaN). */
function rate(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function hasData(dist: Distribution): boolean {
  return dist.buckets.some((b) => b.value > 0);
}

function seriesHasData(series: Series[]): boolean {
  return series.some((s) => s.points.some((p) => p.v > 0));
}

function Empty() {
  return <p className="adm-muted">No data in this range yet.</p>;
}

interface DistPanelProps {
  title: string;
  hint?: string;
  dist: Distribution;
  csvName: string;
  format?: ValueFormat;
  maxBars?: number;
  share?: boolean;
}

function DistPanel({ title, hint, dist, csvName, format, maxBars, share }: DistPanelProps) {
  return (
    <Panel title={title} hint={hint}>
      {hasData(dist) ? (
        <DistributionChart
          dist={dist}
          csvName={csvName}
          format={format}
          maxBars={maxBars}
          share={share}
        />
      ) : (
        <Empty />
      )}
    </Panel>
  );
}

interface SeriesPanelProps {
  title: string;
  hint?: string;
  series: Series[];
  bucketMs: number;
  csvName: string;
  kind?: "line" | "bar" | "stacked";
  format?: ValueFormat;
}

function SeriesPanel({ title, hint, series, bucketMs, csvName, kind, format }: SeriesPanelProps) {
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

function GameplayView({ d }: { d: AdminGameplay }) {
  const h = d.heroes;
  const pt = d.playtimeHours;
  const o = d.offline;
  const bucketMs = d.range.bucketMs;
  const playtimeTotal = pt.manual + pt.auto + pt.idle + pt.offline;

  const playtimeSplit: Distribution = {
    key: "playtime-split",
    label: "Playtime split (hours)",
    buckets: [
      { label: "Manual", value: pt.manual },
      { label: "Auto", value: pt.auto },
      { label: "Idle", value: pt.idle },
      { label: "Offline", value: pt.offline },
    ],
  };

  const questRows: QuestTableRow[] = d.quests.rows.map((r) => ({
    ...r,
    rate: rate(r.completed, r.accepted),
  }));
  const funnelHasData = d.quests.funnel.some((s) => s.value > 0);
  // Steps are event counts in the range, not a cohort: quests accepted before
  // the range can be turned in inside it, so a later step can be larger.
  const funnelInverted = d.quests.funnel.some(
    (s, i) => i > 0 && s.value > (d.quests.funnel[i - 1]?.value ?? 0),
  );
  const rifts = d.rifts;

  return (
    <>
      <SourcesNote sources={d.sources} />

      <Panel
        title="Heroes and playtime"
        hint={`Mode ${d.mode}. Sim counters come from verified play only and can lag up to 5 minutes.`}
      >
        <div className="adm-tiles" aria-label="Hero totals">
          <StatTile label="Heroes" value={h.total} />
          <StatTile label="Deepest depth" value={h.deepestDepth} />
          <StatTile label="Kills (lifetime)" value={h.kills} hint="all time, not the range" />
          <StatTile label="Deaths (lifetime)" value={h.deaths} hint="all time, not the range" />
          <StatTile label="Playtime in range" value={playtimeTotal} format="h" hint="hours" />
        </div>
      </Panel>

      <div className="adm-grid two">
        <DistPanel title="Heroes by class" dist={h.byClass} csvName="gameplay-classes" />
        <DistPanel title="Heroes by level" dist={h.byLevel} csvName="gameplay-levels" />
      </div>
      <DistPanel
        title="Heroes by deepest depth"
        dist={h.byDeepestDepth}
        maxBars={24}
        csvName="gameplay-depth"
      />

      <div className="adm-grid two">
        <DistPanel
          title="Playtime split"
          hint="Hours per control mode in the range. Offline is granted offline time."
          dist={playtimeSplit}
          share
          format="h"
          csvName="gameplay-playtime"
        />
        <SeriesPanel
          title="Playtime per bucket"
          hint="Stacked by control mode, in hours."
          series={d.playtimeSeries}
          kind="stacked"
          format="h"
          bucketMs={bucketMs}
          csvName="gameplay-playtime-series"
        />
      </div>

      <div className="adm-grid two">
        <DistPanel
          title="Kills by monster"
          dist={d.kills.byMonster}
          maxBars={20}
          csvName="gameplay-kills-monster"
        />
        <DistPanel
          title="Kills by rarity"
          dist={d.kills.byRarity}
          csvName="gameplay-kills-rarity"
        />
      </div>
      <SeriesPanel
        title="Kills per bucket"
        series={d.kills.series}
        kind="bar"
        bucketMs={bucketMs}
        csvName="gameplay-kills"
      />

      <div className="adm-grid two">
        <DistPanel
          title="Deaths by depth"
          dist={d.deaths.byDepth}
          maxBars={24}
          csvName="gameplay-deaths-depth"
        />
        <DistPanel
          title="Deaths by killer"
          dist={d.deaths.byKiller}
          maxBars={20}
          csvName="gameplay-deaths-killer"
        />
      </div>

      <Panel title="Boss kill rate" hint="Killed divided by spawned, in the range.">
        {d.bosses.rows.length > 0 ? (
          <DataTable
            caption="Boss kill rate"
            columns={BOSS_COLUMNS}
            rows={d.bosses.rows}
            csvName="gameplay-bosses"
          />
        ) : (
          <Empty />
        )}
      </Panel>

      <Panel
        title="Quest funnel"
        hint={`Accepted, objective done, turned in: event counts in the range.${funnelInverted ? " A later step is larger than an earlier one here, because quests accepted before the range (or seeded dev data) are completed inside it; read the steps as counts, not conversion." : ""}`}
      >
        {funnelHasData ? (
          <FunnelChart
            title="Quest funnel"
            steps={d.quests.funnel}
            csvName="gameplay-quest-funnel"
          />
        ) : (
          <Empty />
        )}
        {questRows.length > 0 ? (
          <DataTable
            caption="Quests"
            columns={QUEST_COLUMNS}
            rows={questRows}
            csvName="gameplay-quests"
          />
        ) : null}
      </Panel>

      <Panel title="Rifts" hint="Leaderboard rows updated in the range.">
        <div className="adm-tiles" aria-label="Rift totals">
          <StatTile label="Runs" value={rifts.runs} />
          <StatTile
            label="Completed"
            value={rifts.completed}
            hint={`${Math.round(rate(rifts.completed, rifts.runs) * 100)}% of runs`}
          />
          <StatTile label="Best score" value={rifts.bestScore} />
        </div>
      </Panel>
      <DistPanel
        title="Rift score histogram"
        dist={rifts.scoreHistogram}
        csvName="gameplay-rift-scores"
      />

      <div className="adm-grid two">
        <DistPanel
          title="Achievements"
          dist={d.achievements}
          maxBars={16}
          csvName="gameplay-achievements"
        />
        <DistPanel title="Skills cast" dist={d.skills} maxBars={16} csvName="gameplay-skills" />
      </div>
      <DistPanel title="Talents taken" dist={d.talents} maxBars={16} csvName="gameplay-talents" />

      <div className="adm-grid two">
        <DistPanel
          title="Drops by rarity"
          hint="Item drops only."
          dist={d.drops.byRarity}
          csvName="gameplay-drops"
        />
        <DistPanel
          title="Drops per 100 kills"
          hint="Whole numbers."
          dist={d.drops.perKill}
          format="int"
          csvName="gameplay-drops-per-kill"
        />
      </div>

      <Panel
        title="Offline progress"
        hint="Offline grants applied in the range. XP follows the Offline XP % tunable (Flags and config)."
      >
        <div className="adm-tiles" aria-label="Offline totals">
          <StatTile label="Grants" value={o.grants} />
          <StatTile label="Hours" value={o.hours} format="h" />
          <StatTile label="Kills" value={o.kills} />
          <StatTile label="XP" value={o.xp} />
          <StatTile label="Gold" value={o.gold} />
          <StatTile label="Items" value={o.items} />
          <StatTile label="Levels" value={o.levels} />
        </div>
      </Panel>
      <SeriesPanel
        title="Offline grants per bucket"
        series={o.series}
        kind="bar"
        bucketMs={bucketMs}
        csvName="gameplay-offline"
      />

      <DistPanel
        title="XP per hour by level band"
        hint="Online play only (offline XP is excluded), by the hero's level at play time. Bands with no play in the range are not shown."
        dist={d.xpPerHourByBand}
        csvName="gameplay-xp-per-hour"
      />

      <Panel title="Party" hint="Parties in classic.">
        {d.party === null ? (
          <p className="adm-muted">Not in the game yet.</p>
        ) : (
          <div className="adm-tiles" aria-label="Party totals">
            <StatTile label="Parties" value={d.party.parties} />
            <StatTile label="Average size" value={d.party.avgSize} />
          </div>
        )}
      </Panel>
    </>
  );
}
