/**
 * Admin section "Economy" (docs/design/admin-dashboard.md §2.4, §10.3). OWNER: T-ui-sections-b.
 * Wave C economy telemetry (tiles, faucets vs sinks, price index) kept as is,
 * plus the details endpoint: gold per hour by band, market, trades, shops,
 * gems, arena, and the faucet / sink breakdown.
 */
import type { AdminEconomyDetails, EconomyTelemetry, Series } from "@gamez/protocol";
import { EconomyCharts, Tiles } from "../dashboard.tsx";
import {
  DistributionChart,
  Panel,
  SourcesNote,
  StatTile,
  TimeSeriesChart,
  defineSection,
  formatValue,
} from "../kit/index.tsx";
import type { ValueFormat } from "../kit/index.tsx";
import type { Distribution } from "@gamez/protocol";

export interface EconomySectionData {
  telemetry: EconomyTelemetry;
  details: AdminEconomyDetails;
}

export const economySection = defineSection<EconomySectionData>({
  id: "economy",
  label: "Economy",
  group: "Business",
  load: async (ctx) => {
    const [telemetry, details] = await Promise.all([
      ctx.get<EconomyTelemetry>(`/api/admin/economy?days=${ctx.days}`),
      ctx.get<AdminEconomyDetails>(`/api/admin/economy/details?${ctx.query}`),
    ]);
    if (!telemetry.ok) return telemetry;
    if (!details.ok) return details;
    return { ok: true, value: { telemetry: telemetry.value, details: details.value } };
  },
  Component: ({ data }) =>
    data ? <EconomyView data={data} /> : <p className="adm-muted">Loading economy…</p>,
});

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
  share,
}: {
  title: string;
  hint?: string;
  dist: Distribution;
  csvName: string;
  format?: ValueFormat;
  share?: boolean;
}) {
  return (
    <Panel title={title} hint={hint}>
      {hasData(dist) ? (
        <DistributionChart dist={dist} csvName={csvName} format={format} share={share} />
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
  bucketMs,
  csvName,
  kind,
  format,
}: {
  title: string;
  hint?: string;
  series: Series[];
  bucketMs: number;
  csvName: string;
  kind?: "line" | "bar" | "stacked";
  format?: ValueFormat;
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

/**
 * All-time check that the coin numbers add up: wallets hold what the ledger
 * created, minus what it destroyed, minus what sits in custody.
 */
function CoinReconciliation({ c }: { c: NonNullable<AdminEconomyDetails["coinLedger"]> }) {
  const custody = -c.transfersNet;
  const expected = c.faucets - c.sinks + c.transfersNet;
  const gap = c.supply - expected;
  return (
    <Panel
      title="Coin reconciliation (all time)"
      hint="Coin in accounts = faucets − sinks − coin in custody (open market bids and other escrow, i.e. net ledger transfers). A non-zero difference means coin moved without a ledger row."
    >
      <div className="adm-tiles" aria-label="Coin reconciliation">
        <StatTile label="Faucets" value={c.faucets} hint="coin created" />
        <StatTile label="Sinks" value={c.sinks} hint="coin destroyed" />
        <StatTile label="In custody" value={custody} hint="net transfers out of wallets" />
        <StatTile
          label="Coin in accounts"
          value={c.supply}
          hint={`expected ${formatValue(expected)}`}
        />
        <StatTile
          label="Difference"
          value={gap}
          status={gap === 0 ? "good" : "warning"}
          hint={gap === 0 ? "Balanced" : "Unbalanced: check the ledger"}
        />
      </div>
    </Panel>
  );
}

function EconomyView({ data }: { data: EconomySectionData }) {
  const { telemetry, details: d } = data;
  const bucketMs = d.range.bucketMs;
  return (
    <>
      <Tiles telemetry={telemetry} />
      <EconomyCharts telemetry={telemetry} />

      <DistPanel
        title="Gold per hour by level band"
        hint="Hero gold earned per hour of verified play, classic, by the hero's level at play time (not current level). Bands with no play in the range are not shown."
        dist={d.goldPerHourByBand}
        csvName="economy-gold-per-hour"
      />

      <SourcesNote sources={d.sources} />

      {d.coinLedger ? <CoinReconciliation c={d.coinLedger} /> : null}

      <Panel title="Market" hint="Player sales on the market, in coin, for the range.">
        <div className="adm-tiles" aria-label="Market totals">
          <StatTile label="Sales" value={d.market.sales} />
          <StatTile label="Volume" value={d.market.volume} hint="coin" />
          <StatTile label="Taxes" value={d.market.taxes} hint="coin" />
          <StatTile label="Median price" value={d.market.medianPrice} hint="coin" />
        </div>
      </Panel>
      <SeriesPanel
        title="Market volume per bucket"
        series={d.market.series}
        kind="bar"
        bucketMs={bucketMs}
        csvName="economy-market-volume"
      />
      <div className="adm-grid two">
        <DistPanel
          title="Market sales by category"
          dist={d.market.byCategory}
          csvName="economy-market-category"
        />
        <DistPanel
          title="Market sales by rarity"
          dist={d.market.byRarity}
          csvName="economy-market-rarity"
        />
      </div>

      <Panel title="Trades" hint="Player to player trades in the range.">
        <div className="adm-tiles" aria-label="Trade totals">
          <StatTile label="Trades" value={d.trades.count} />
          <StatTile label="Fees" value={d.trades.fees} hint="coin" />
        </div>
      </Panel>
      <SeriesPanel
        title="Trades per bucket"
        series={d.trades.series}
        kind="bar"
        bucketMs={bucketMs}
        csvName="economy-trades"
      />

      <Panel title="Shops" hint="Shop rent, sales and state (state is now, not the range).">
        <div className="adm-tiles" aria-label="Shop totals">
          <StatTile label="Rent paid" value={d.shops.rentPaid} hint="coin" />
          <StatTile label="Shop sales" value={d.shops.sales} />
          <StatTile label="Shop volume" value={d.shops.volume} hint="coin" />
        </div>
      </Panel>
      <DistPanel title="Shops by state" dist={d.shops.byState} csvName="economy-shops-state" />

      <Panel title="Gems" hint="Gems bought with money, spent, and held in accounts.">
        <div className="adm-tiles" aria-label="Gem totals">
          <StatTile label="Bought" value={d.gems.bought} hint="gems" />
          <StatTile label="Spent" value={d.gems.spent} hint="gems" />
          <StatTile label="Supply" value={d.gems.supply} hint="held in accounts" />
        </div>
      </Panel>
      <SeriesPanel
        title="Gems per bucket"
        hint="Bought and spent."
        series={d.gems.series}
        kind="line"
        bucketMs={bucketMs}
        csvName="economy-gems"
      />

      <Panel title="Arena" hint="Arena rewards and players in the current season.">
        <div className="adm-tiles" aria-label="Arena totals">
          <StatTile label="Rewards" value={d.arena.rewardsCoin} hint="coin" />
          <StatTile label="Matches" value={d.arena.matches} />
          <StatTile label="Players" value={d.arena.players} />
        </div>
      </Panel>
      <DistPanel
        title="Arena rating histogram"
        dist={d.arena.ratingHistogram}
        csvName="economy-arena-rating"
      />

      <div className="adm-grid two">
        <DistPanel title="Faucets (coin created)" dist={d.faucets} csvName="economy-faucets" />
        <DistPanel title="Sinks (coin destroyed)" dist={d.sinks} csvName="economy-sinks" />
      </div>
    </>
  );
}
