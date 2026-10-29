/**
 * GET /api/admin/economy/details (docs/design/admin-dashboard.md §2.4). OWNER: T-api-game.
 * The wave C GET /api/admin/economy (admin/telemetry.ts) is unchanged.
 *
 * Ledger facts (grepped from apps/game/src/server, not guessed): `reason` is
 * "<group>:<detail>" and `reason_group` is the group ("market.fee", "trade",
 * "trade.fee", "shop.rent", "store.gems", "arena.reward"…). Sinks carry
 * negative amounts, faucets positive ones, transfers net to zero. Trades use
 * the reason "trade:<id>" (escrow.ts), so one trade = one distinct reason.
 */
import { currentSeason } from "@gamez/economy";
import type { AdminEconomyDetails, AdminRange, Distribution, Series } from "@gamez/protocol";
import type { TotalsRow } from "../../analytics/types.ts";
import {
  HOUR_MS,
  LEVEL_BANDS,
  SourceLog,
  dist,
  num,
  rows,
  toSeries,
  type MetricsDeps,
} from "./util.ts";

/** Top-N cap for ranked lists. */
const TOP = 20;
/** Enough groups to sum a whole dimension. */
const ALL_GROUPS = 50;
const SUM_AMOUNT = { op: "sum", field: "amount" } as const;

/** Bucket index of a time column relative to range.from (bind: from, bucketMs). */
const BUCKET = (col: string) => `CAST((${col} - ?) / ? AS INTEGER)`;

interface BucketRow {
  b: number;
  v: number;
}

/** Bucket rows of one key -> toSeries input (t = bucket start). */
function points(
  range: AdminRange,
  key: string,
  rs: readonly BucketRow[],
): { t: number; key: string; value: number }[] {
  return rs.map((r) => ({
    t: range.from + num(r.b) * range.bucketMs,
    key,
    value: num(r.v),
  }));
}

/** A distribution cut to the top-N buckets (already sorted). */
function topN(d: Distribution): Distribution {
  return { ...d, buckets: d.buckets.slice(0, TOP) };
}

/** Totals keyed by one groupBy field. */
function keyed(data: readonly TotalsRow[], field: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of data) out.set(r.keys[field] ?? "", num(r.value));
  return out;
}

// ---------------------------------------------------------------------------
// Market (economy_sale venue = 'market')
// ---------------------------------------------------------------------------

interface MarketStats {
  sales: number;
  volume: number;
  taxes: number;
  medianPrice: number;
  series: Series[];
  byCategory: Distribution;
  byRarity: Distribution;
}

async function readMarket(db: D1Database, range: AdminRange): Promise<MarketStats> {
  const from = range.from;
  const to = range.to;
  const [t] = await rows<{ sales: number; volume: number; taxes: number }>(
    db,
    `SELECT COUNT(*) AS sales, COALESCE(SUM(price), 0) AS volume, COALESCE(SUM(tax), 0) AS taxes
     FROM economy_sale WHERE _deleted = 0 AND venue = 'market' AND at >= ? AND at < ?`,
    from,
    to,
  );
  const sales = num(t?.sales);

  // Median of the sale prices: the mean of the two middle values (equal for odd n).
  const priceAt = async (index: number): Promise<number> => {
    const [r] = await rows<{ price: number }>(
      db,
      `SELECT price FROM economy_sale
       WHERE _deleted = 0 AND venue = 'market' AND at >= ? AND at < ?
       ORDER BY price ASC LIMIT 1 OFFSET ?`,
      from,
      to,
      index,
    );
    return num(r?.price);
  };
  const medianPrice =
    sales > 0
      ? ((await priceAt(Math.floor((sales - 1) / 2))) + (await priceAt(Math.floor(sales / 2)))) / 2
      : 0;

  const volumeRows = await rows<BucketRow>(
    db,
    `SELECT ${BUCKET("at")} AS b, SUM(price) AS v FROM economy_sale
     WHERE _deleted = 0 AND venue = 'market' AND at >= ? AND at < ? GROUP BY b`,
    from,
    range.bucketMs,
    from,
    to,
  );

  const byCategory = await rows<{ label: string; n: number }>(
    db,
    `SELECT COALESCE(category, 'unknown') AS label, COUNT(*) AS n FROM economy_sale
     WHERE _deleted = 0 AND venue = 'market' AND at >= ? AND at < ? GROUP BY label`,
    from,
    to,
  );
  const byRarity = await rows<{ label: string; n: number }>(
    db,
    `SELECT COALESCE(rarity, 'unknown') AS label, COUNT(*) AS n FROM economy_sale
     WHERE _deleted = 0 AND venue = 'market' AND at >= ? AND at < ? GROUP BY label`,
    from,
    to,
  );

  return {
    sales,
    volume: num(t?.volume),
    taxes: num(t?.taxes),
    medianPrice,
    series: toSeries(range, points(range, "volume", volumeRows), { volume: "Volume" }),
    byCategory: dist(
      "marketByCategory",
      "Sales by category",
      byCategory.map((r) => ({ label: r.label, value: num(r.n) })),
      "desc",
    ),
    byRarity: dist(
      "marketByRarity",
      "Sales by rarity",
      byRarity.map((r) => ({ label: r.label, value: num(r.n) })),
      "desc",
    ),
  };
}

// ---------------------------------------------------------------------------
// Trades, shops, gems, arena, faucets and sinks (economy_ledger and friends)
// ---------------------------------------------------------------------------

interface TradeStats {
  count: number;
  fees: number;
  series: Series[];
}

async function readTrades(db: D1Database, range: AdminRange): Promise<TradeStats> {
  const from = range.from;
  const to = range.to;
  const [c] = await rows<{ count: number }>(
    db,
    `SELECT COUNT(DISTINCT reason) AS count FROM economy_ledger
     WHERE _deleted = 0 AND reason_group = 'trade' AND flow = 'transfer' AND at >= ? AND at < ?`,
    from,
    to,
  );
  const [f] = await rows<{ fees: number }>(
    db,
    `SELECT COALESCE(-SUM(amount), 0) AS fees FROM economy_ledger
     WHERE _deleted = 0 AND reason_group = 'trade.fee' AND COALESCE(currency, 'coin') = 'coin'
       AND at >= ? AND at < ?`,
    from,
    to,
  );
  const perBucket = await rows<BucketRow>(
    db,
    `SELECT ${BUCKET("at")} AS b, COUNT(DISTINCT reason) AS v FROM economy_ledger
     WHERE _deleted = 0 AND reason_group = 'trade' AND flow = 'transfer' AND at >= ? AND at < ?
     GROUP BY b`,
    from,
    range.bucketMs,
    from,
    to,
  );
  return {
    count: num(c?.count),
    fees: num(f?.fees),
    series: toSeries(range, points(range, "trades", perBucket), { trades: "Trades" }),
  };
}

interface ShopStats {
  rentPaid: number;
  sales: number;
  volume: number;
  byState: Distribution;
}

async function readShops(db: D1Database, range: AdminRange): Promise<ShopStats> {
  const from = range.from;
  const to = range.to;
  const [rent] = await rows<{ rent: number }>(
    db,
    `SELECT COALESCE(-SUM(amount), 0) AS rent FROM economy_ledger
     WHERE _deleted = 0 AND reason_group = 'shop.rent' AND COALESCE(currency, 'coin') = 'coin'
       AND at >= ? AND at < ?`,
    from,
    to,
  );
  const [sold] = await rows<{ sales: number; volume: number }>(
    db,
    `SELECT COUNT(*) AS sales, COALESCE(SUM(price), 0) AS volume FROM economy_sale
     WHERE _deleted = 0 AND venue = 'shop' AND at >= ? AND at < ?`,
    from,
    to,
  );
  const states = await rows<{ label: string; n: number }>(
    db,
    `SELECT COALESCE(state, 'unknown') AS label, COUNT(*) AS n FROM shop_index
     WHERE _deleted = 0 GROUP BY label`,
  );
  return {
    rentPaid: num(rent?.rent),
    sales: num(sold?.sales),
    volume: num(sold?.volume),
    byState: dist(
      "shopsByState",
      "Shops",
      states.map((r) => ({ label: r.label, value: num(r.n) })),
      "desc",
    ),
  };
}

interface GemStats {
  bought: number;
  spent: number;
  supply: number;
  series: Series[];
}

async function readGems(db: D1Database, range: AdminRange): Promise<GemStats> {
  const from = range.from;
  const to = range.to;
  const [b] = await rows<{ v: number }>(
    db,
    `SELECT COALESCE(SUM(amount), 0) AS v FROM economy_ledger
     WHERE _deleted = 0 AND currency = 'gem' AND reason_group = 'store.gems' AND amount > 0
       AND at >= ? AND at < ?`,
    from,
    to,
  );
  const [s] = await rows<{ v: number }>(
    db,
    `SELECT COALESCE(-SUM(amount), 0) AS v FROM economy_ledger
     WHERE _deleted = 0 AND currency = 'gem' AND flow = 'sink' AND at >= ? AND at < ?`,
    from,
    to,
  );
  const [w] = await rows<{ v: number }>(
    db,
    `SELECT COALESCE(SUM(gem), 0) AS v FROM account_wallet WHERE _deleted = 0`,
  );
  const boughtRows = await rows<BucketRow>(
    db,
    `SELECT ${BUCKET("at")} AS b, SUM(amount) AS v FROM economy_ledger
     WHERE _deleted = 0 AND currency = 'gem' AND reason_group = 'store.gems' AND amount > 0
       AND at >= ? AND at < ? GROUP BY b`,
    from,
    range.bucketMs,
    from,
    to,
  );
  const spentRows = await rows<BucketRow>(
    db,
    `SELECT ${BUCKET("at")} AS b, -SUM(amount) AS v FROM economy_ledger
     WHERE _deleted = 0 AND currency = 'gem' AND flow = 'sink' AND at >= ? AND at < ?
     GROUP BY b`,
    from,
    range.bucketMs,
    from,
    to,
  );
  return {
    bought: num(b?.v),
    spent: num(s?.v),
    supply: num(w?.v),
    series: toSeries(
      range,
      [...points(range, "bought", boughtRows), ...points(range, "spent", spentRows)],
      { bought: "Bought", spent: "Spent" },
    ),
  };
}

interface ArenaStats {
  rewardsCoin: number;
  matches: number;
  players: number;
  ratingHistogram: Distribution;
}

/** Arena rewards in range; the ladder figures are the current season, all modes. */
async function readArena(db: D1Database, range: AdminRange, season: string): Promise<ArenaStats> {
  const [r] = await rows<{ v: number }>(
    db,
    `SELECT COALESCE(SUM(amount), 0) AS v FROM economy_ledger
     WHERE _deleted = 0 AND reason_group = 'arena.reward' AND COALESCE(currency, 'coin') = 'coin'
       AND at >= ? AND at < ?`,
    range.from,
    range.to,
  );
  const [ladder] = await rows<{ players: number; games: number }>(
    db,
    `SELECT COUNT(*) AS players, COALESCE(SUM(wins + losses + draws), 0) AS games
     FROM arena_rating WHERE _deleted = 0 AND season_id = ?`,
    season,
  );
  const bands = await rows<{ b: number; n: number }>(
    db,
    `SELECT CAST(rating / 100 AS INTEGER) AS b, COUNT(*) AS n FROM arena_rating
     WHERE _deleted = 0 AND season_id = ? GROUP BY b`,
    season,
  );
  const counts = new Map(bands.map((x) => [num(x.b), num(x.n)]));
  const buckets: { label: string; value: number }[] = [];
  if (bands.length > 0) {
    const lo = Math.min(...bands.map((x) => num(x.b)));
    const hi = Math.max(...bands.map((x) => num(x.b)));
    for (let b = lo; b <= hi; b++) {
      buckets.push({ label: `${b * 100}-${b * 100 + 99}`, value: counts.get(b) ?? 0 });
    }
  }
  return {
    rewardsCoin: num(r?.v),
    // Each match has two ladder rows (one per side), so games / 2 counts matches.
    matches: Math.floor(num(ladder?.games) / 2),
    players: num(ladder?.players),
    ratingHistogram: dist("arenaRating", "Arena rating", buckets),
  };
}

interface FlowStats {
  faucets: Distribution;
  sinks: Distribution;
}

/**
 * Coin faucets (flow faucet, positive) and sinks (flow sink, summed as
 * -amount so the total is positive), grouped by reason group.
 */
async function readFlows(db: D1Database, range: AdminRange): Promise<FlowStats> {
  const groups = await rows<{ grp: string; flow: string; total: number }>(
    db,
    `SELECT COALESCE(NULLIF(reason_group, ''), reason, 'other') AS grp, flow, SUM(amount) AS total
     FROM economy_ledger
     WHERE _deleted = 0 AND COALESCE(currency, 'coin') = 'coin' AND flow IN ('faucet', 'sink')
       AND at >= ? AND at < ?
     GROUP BY grp, flow`,
    range.from,
    range.to,
  );
  const faucets: { label: string; value: number }[] = [];
  const sinks: { label: string; value: number }[] = [];
  for (const g of groups) {
    if (g.flow === "faucet") faucets.push({ label: g.grp, value: num(g.total) });
    else if (g.flow === "sink") sinks.push({ label: g.grp, value: -num(g.total) });
  }
  return {
    faucets: dist("faucets", "Faucets", faucets, "desc"),
    sinks: dist("sinks", "Sinks", sinks, "desc"),
  };
}

/**
 * All-time coin totals for the reconciliation line: wallet supply against the
 * ledger's faucets, sinks and net transfers (custody).
 */
async function readCoinLedger(
  db: D1Database,
): Promise<NonNullable<AdminEconomyDetails["coinLedger"]>> {
  const [w] = await rows<{ v: number }>(
    db,
    "SELECT COALESCE(SUM(coin), 0) AS v FROM account_wallet WHERE _deleted = 0",
  );
  const flows = await rows<{ flow: string; total: number }>(
    db,
    `SELECT flow, COALESCE(SUM(amount), 0) AS total FROM economy_ledger
     WHERE _deleted = 0 AND COALESCE(currency, 'coin') = 'coin' GROUP BY flow`,
  );
  const by = new Map(flows.map((f) => [f.flow, num(f.total)]));
  return {
    supply: num(w?.v),
    faucets: by.get("faucet") ?? 0,
    sinks: -(by.get("sink") ?? 0),
    transfersNet: by.get("transfer") ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/economy/details. Gold per hour uses sim.tally across every
 * mode (the endpoint has no mode parameter; only classic emits tallies today).
 */
export async function readEconomyDetails(
  d: MetricsDeps,
  range: AdminRange,
): Promise<AdminEconomyDetails> {
  const log = new SourceLog(d);
  const from = range.from;
  const to = range.to;
  const season = currentSeason(d.now).id;

  const playByBand = await log.ae("sim.tally", [] as TotalsRow[], (aq) =>
    aq.totals({
      metric: "sim.tally",
      from,
      to,
      where: { metric: "play.ms" },
      groupBy: ["k2"],
      value: SUM_AMOUNT,
      limit: ALL_GROUPS,
    }),
  );
  const goldByBand = await log.ae("sim.tally", [] as TotalsRow[], (aq) =>
    aq.totals({
      metric: "sim.tally",
      from,
      to,
      where: { metric: "gold" },
      groupBy: ["k1"],
      value: SUM_AMOUNT,
      limit: ALL_GROUPS,
    }),
  );
  const playMs = keyed(playByBand, "k2");
  const gold = keyed(goldByBand, "k1");
  const goldPerHourByBand = dist(
    "goldPerHour",
    "Gold per hour",
    // Bands with no play time have no rate: they are left out (no data), not 0.
    LEVEL_BANDS.filter((band) => (playMs.get(band) ?? 0) > 0).map((band) => ({
      label: band,
      value: (gold.get(band) ?? 0) / ((playMs.get(band) ?? 0) / HOUR_MS),
    })),
  );

  const market = await log.d1(
    "economy_sale",
    {
      sales: 0,
      volume: 0,
      taxes: 0,
      medianPrice: 0,
      series: [],
      byCategory: dist("marketByCategory", "Sales by category", []),
      byRarity: dist("marketByRarity", "Sales by rarity", []),
    } as MarketStats,
    () => readMarket(d.db, range),
  );
  const trades = await log.d1(
    "economy_ledger",
    { count: 0, fees: 0, series: [] } as TradeStats,
    () => readTrades(d.db, range),
  );
  const shops = await log.d1(
    "shop_index",
    { rentPaid: 0, sales: 0, volume: 0, byState: dist("shopsByState", "Shops", []) } as ShopStats,
    () => readShops(d.db, range),
  );
  const gems = await log.d1(
    "account_wallet",
    { bought: 0, spent: 0, supply: 0, series: [] } as GemStats,
    () => readGems(d.db, range),
  );
  const arena = await log.d1(
    "arena_rating",
    {
      rewardsCoin: 0,
      matches: 0,
      players: 0,
      ratingHistogram: dist("arenaRating", "Arena rating", []),
    } as ArenaStats,
    () => readArena(d.db, range, season),
  );
  const flows = await log.d1(
    "economy_ledger",
    { faucets: dist("faucets", "Faucets", []), sinks: dist("sinks", "Sinks", []) } as FlowStats,
    () => readFlows(d.db, range),
  );

  const coinLedger = await log.d1(
    "economy_ledger",
    { supply: 0, faucets: 0, sinks: 0, transfersNet: 0 },
    () => readCoinLedger(d.db),
  );

  return {
    at: d.now,
    range,
    sources: log.sources,
    goldPerHourByBand,
    market,
    trades,
    shops,
    gems,
    arena: {
      rewardsCoin: arena.rewardsCoin,
      matches: arena.matches,
      players: arena.players,
      ratingHistogram: arena.ratingHistogram,
    },
    faucets: topN(flows.faucets),
    sinks: topN(flows.sinks),
    coinLedger,
  };
}
