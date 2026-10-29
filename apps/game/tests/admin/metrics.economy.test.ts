/**
 * readEconomyDetails (docs/design/admin-dashboard.md §2.4) over a migrated
 * FakeD1 (real ledger reason groups from apps/game/src/server) and a fake
 * AnalyticsQuery for the gold-per-hour reads. Expected numbers come from the
 * fixture below.
 */
import { describe, expect, it } from "vite-plus/test";
import { currentSeason } from "@gamez/economy";
import type { AdminRange } from "@gamez/protocol";
import type {
  Analytics,
  AnalyticsQuery,
  SeriesQuery,
  SeriesRow,
  TotalsQuery,
  TotalsRow,
} from "../../src/server/analytics/types.ts";
import type { MetricName } from "../../src/server/analytics/schema.ts";
import type { Env } from "../../src/server/contracts.ts";
import { readEconomyDetails } from "../../src/server/admin/metrics/economy.ts";
import type { MetricsDeps } from "../../src/server/admin/metrics/util.ts";
import { FakeD1 } from "../leaderboards/fake-d1.ts";

const MIGRATIONS = [
  "0001_init.sql",
  "0002_leaderboards.sql",
  "0003_accounts.sql",
  "0004_guilds.sql",
  "0005_chat.sql",
  "0006_market.sql",
  "0007_shops.sql",
  "0008_arena.sql",
  "0009_economy.sql",
  "0010_admin.sql",
];

const HOUR = 3_600_000;
const DAY = 86_400_000;
const DAY0 = Date.UTC(2026, 9, 20);
const RANGE: AdminRange = { from: DAY0, to: DAY0 + 3 * DAY, bucket: "day", bucketMs: DAY };
const NOW = DAY0 + 3 * DAY + HOUR;
const SEASON = currentSeason(NOW).id;

// ---------------------------------------------------------------------------
// Fake Analytics Engine (sim.tally only here).
// ---------------------------------------------------------------------------

type Fields = Record<string, string>;
interface Pt {
  metric: string;
  t: number;
  fields: Fields;
  values: Record<string, number>;
}
interface Call {
  fn: "totals" | "series";
  metric: string;
  where: Fields;
  groupBy: string[];
}
interface Loose {
  metric: string;
  from: number;
  to: number;
  where?: Fields;
  groupBy: string[];
  value: { op: "count" } | { op: "sum"; field: string };
  limit?: number;
  bucketMs?: number;
}

class FakeAq implements AnalyticsQuery {
  readonly calls: Call[] = [];
  constructor(
    private readonly pts: Pt[],
    readonly source: "ae" | "local" | "none" = "ae",
  ) {}

  #match(q: Loose): Pt[] {
    return this.pts.filter(
      (p) =>
        p.metric === q.metric &&
        p.t >= q.from &&
        p.t < q.to &&
        Object.entries(q.where ?? {}).every(([k, v]) => p.fields[k] === v),
    );
  }

  #value(p: Pt, value: Loose["value"]): number {
    return value.op === "count" ? 1 : (p.values[value.field] ?? 0);
  }

  #keys(p: Pt, groupBy: string[]): Fields {
    const out: Fields = {};
    for (const g of groupBy) out[g] = p.fields[g] ?? "";
    return out;
  }

  async totals<M extends MetricName>(q: TotalsQuery<M>): Promise<TotalsRow[]> {
    const x = q as unknown as Loose;
    this.calls.push({ fn: "totals", metric: x.metric, where: x.where ?? {}, groupBy: x.groupBy });
    const groups = new Map<string, { keys: Fields; value: number }>();
    for (const p of this.#match(x)) {
      const keys = this.#keys(p, x.groupBy);
      const id = JSON.stringify(keys);
      const g = groups.get(id) ?? { keys, value: 0 };
      g.value += this.#value(p, x.value);
      groups.set(id, g);
    }
    return [...groups.values()].slice(0, x.limit ?? 50);
  }

  async series<M extends MetricName>(q: SeriesQuery<M>): Promise<SeriesRow[]> {
    const x = q as unknown as Loose;
    this.calls.push({ fn: "series", metric: x.metric, where: x.where ?? {}, groupBy: x.groupBy });
    const bucketMs = x.bucketMs ?? DAY;
    const groups = new Map<string, SeriesRow>();
    for (const p of this.#match(x)) {
      const t = Math.floor(p.t / bucketMs) * bucketMs;
      const keys = this.#keys(p, x.groupBy);
      const id = `${t}|${JSON.stringify(keys)}`;
      const g = groups.get(id) ?? { t, keys, value: 0 };
      g.value += this.#value(p, x.value);
      groups.set(id, g);
    }
    return [...groups.values()];
  }

  async quantiles(): Promise<number[]> {
    return [];
  }

  async distinct(): Promise<number> {
    return 0;
  }
}

const tally = (t: number, metric: string, k1: string, k2: string, amount: number): Pt => ({
  metric: "sim.tally",
  t,
  fields: { mode: "classic", metric, k1, k2 },
  values: { amount },
});

/** play.ms: 1-9 = 3 h, 10-19 = 4 h. gold: 1-9 = 150, 10-19 = 400. */
const POINTS: Pt[] = [
  tally(DAY0 + 1 * HOUR, "play.ms", "manual", "1-9", 7_200_000),
  tally(DAY0 + 2 * HOUR, "play.ms", "manual", "10-19", 3_600_000),
  tally(DAY0 + DAY + 1 * HOUR, "play.ms", "auto", "10-19", 10_800_000),
  tally(DAY0 + 2 * DAY + 4 * HOUR, "play.ms", "idle", "1-9", 3_600_000),
  tally(DAY0 + 1 * HOUR, "gold", "1-9", "loot", 150),
  tally(DAY0 + 2 * HOUR, "gold", "10-19", "quest", 400),
];

function insert(d1: FakeD1, table: string, row: Record<string, unknown>): void {
  const full: Record<string, unknown> = { _version: 1, _deleted: 0, _updated_at: 1, ...row };
  const cols = Object.keys(full);
  d1.db
    .prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(...(cols.map((c) => full[c]) as never[]));
}

function seedD1(d1: FakeD1): void {
  // Market sales (venue market). s5 is out of range, s6 is a tombstone.
  const sale = (
    id: string,
    venue: string,
    category: string,
    rarity: string,
    price: number,
    tax: number,
    at: number,
    extra: Record<string, unknown> = {},
  ) => insert(d1, "economy_sale", { id, venue, category, rarity, price, tax, at, ...extra });
  sale("s1", "market", "weapon", "rare", 100, 5, DAY0 + HOUR);
  sale("s2", "market", "armor", "common", 300, 15, DAY0 + DAY + HOUR);
  sale("s3", "market", "weapon", "common", 200, 10, DAY0 + DAY + 2 * HOUR);
  sale("s4", "market", "weapon", "rare", 500, 25, DAY0 + 2 * DAY + HOUR);
  sale("s5", "market", "armor", "common", 9000, 0, DAY0 + 5 * DAY);
  sale("s6", "market", "armor", "common", 7777, 0, DAY0 + HOUR, { _deleted: 1 });
  sale("s7", "shop", "potion", "common", 40, 2, DAY0 + HOUR);
  sale("s8", "shop", "potion", "common", 60, 3, DAY0 + DAY + HOUR);
  sale("s9", "shop", "potion", "common", 1000, 0, DAY0 + 5 * DAY);

  // Ledger (coin unless noted). Trade A and B are counted, C is a tombstone.
  const L = (
    id: string,
    tx: string,
    currency: string,
    amount: number,
    flow: string,
    group: string,
    reason: string,
    at: number,
    extra: Record<string, unknown> = {},
  ) =>
    insert(d1, "economy_ledger", {
      id,
      account_id: "acc",
      tx_id: tx,
      currency,
      amount,
      flow,
      reason_group: group,
      reason,
      at,
      ...extra,
    });
  L("l1", "trade:A:s1:coin", "coin", -100, "transfer", "trade", "trade:A", DAY0 + HOUR);
  L("l2", "trade:A:s2:recv", "coin", 100, "transfer", "trade", "trade:A", DAY0 + HOUR);
  L("l3", "trade:A:s1:fee", "coin", -5, "sink", "trade.fee", "trade.fee:A", DAY0 + HOUR);
  L("l4", "trade:B:s1:coin", "coin", -200, "transfer", "trade", "trade:B", DAY0 + DAY + HOUR);
  L("l5", "trade:B:s2:recv", "coin", 200, "transfer", "trade", "trade:B", DAY0 + DAY + HOUR);
  L("l6", "trade:B:s2:fee", "coin", -10, "sink", "trade.fee", "trade.fee:B", DAY0 + DAY + HOUR);
  L("l7", "trade:C:s1:coin", "coin", -50, "transfer", "trade", "trade:C", DAY0 + HOUR, {
    _deleted: 1,
  });
  L("l8", "mk:1:fee", "coin", -20, "sink", "market.fee", "market.fee:1", DAY0 + HOUR);
  L(
    "l9",
    "plot:w/1:rent:1",
    "coin",
    -30,
    "sink",
    "shop.rent",
    "shop.rent:w/1",
    DAY0 + DAY + 3 * HOUR,
  );
  L(
    "l10",
    "arena:M1:coin",
    "coin",
    80,
    "faucet",
    "arena.reward",
    "arena.reward:M1",
    DAY0 + DAY + 2 * HOUR,
  );
  L(
    "l11",
    "arena:M2:coin",
    "coin",
    120,
    "faucet",
    "arena.reward",
    "arena.reward:M2",
    DAY0 + 2 * DAY + HOUR,
  );
  L("l12", "arena:M0:coin", "coin", 999, "faucet", "arena.reward", "arena.reward:M0", DAY0 - HOUR);
  L(
    "l13",
    "pass:reward:1",
    "coin",
    50,
    "faucet",
    "pass.reward",
    "pass.reward:2026-s1:1",
    DAY0 + HOUR,
  );
  // Gems: store grants and sinks. Coin filters must not see them.
  L("g1", "store:o1:gems", "gem", 500, "faucet", "store.gems", "store.gems:pack1", DAY0 + HOUR);
  L(
    "g2",
    "store:o2:gems",
    "gem",
    1000,
    "faucet",
    "store.gems",
    "store.gems:pack2",
    DAY0 + DAY + HOUR,
  );
  L(
    "g3",
    "store:o1:gems:refund",
    "gem",
    -200,
    "sink",
    "store.refund",
    "store.refund:pack1",
    DAY0 + DAY + 2 * HOUR,
  );
  L(
    "g4",
    "pass:premium:gems",
    "gem",
    -500,
    "sink",
    "pass.premium",
    "pass.premium:2026-s1",
    DAY0 + 2 * DAY,
  );

  // Shops and wallets.
  insert(d1, "shop_index", { id: "sh1", state: "leased" });
  insert(d1, "shop_index", { id: "sh2", state: "leased" });
  insert(d1, "shop_index", { id: "sh3", state: "auction" });
  insert(d1, "shop_index", { id: "sh4", state: "grace", _deleted: 1 });
  insert(d1, "account_wallet", { account_id: "w1", coin: 0, gem: 300 });
  insert(d1, "account_wallet", { account_id: "w2", coin: 0, gem: 200 });
  insert(d1, "account_wallet", { account_id: "w3", coin: 0, gem: 999, _deleted: 1 });

  // Arena ladder: current season, 3 players, 10 games (5 matches).
  const ar = (
    id: string,
    season: string,
    rating: number,
    wins: number,
    losses: number,
    draws: number,
    extra: Record<string, unknown> = {},
  ) =>
    insert(d1, "arena_rating", {
      id,
      season_id: season,
      mode: "classic",
      account_id: id,
      rating,
      wins,
      losses,
      draws,
      ...extra,
    });
  ar("ar1", SEASON, 1050, 3, 1, 0);
  ar("ar2", SEASON, 950, 1, 3, 0);
  ar("ar3", SEASON, 1250, 2, 0, 0);
  ar("ar4", "old-season", 3000, 9, 0, 0);
  ar("ar5", SEASON, 800, 5, 0, 0, { _deleted: 1 });
}

function deps(d1: FakeD1, aq: AnalyticsQuery): MetricsDeps {
  const analytics = { write() {}, flush: async () => {} } as unknown as Analytics;
  return { env: {} as Env, db: d1.asD1(), aq, analytics, now: NOW };
}

describe("readEconomyDetails", () => {
  it("computes gold per hour by level band from verified play", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const out = await readEconomyDetails(deps(d1, new FakeAq(POINTS)), RANGE);

    const gold = Object.fromEntries(out.goldPerHourByBand.buckets.map((b) => [b.label, b.value]));
    expect(gold["1-9"]).toBe(50); // 150 gold / 3 h
    expect(gold["10-19"]).toBe(100); // 400 gold / 4 h
    // Bands without play time are left out (no data), not shown as 0.
    expect(gold["90+"]).toBeUndefined();
    expect(out.goldPerHourByBand.buckets.map((b) => b.label)).toEqual(["1-9", "10-19"]);
  });

  it("reports the all-time coin reconciliation (ledger vs wallets, gems excluded)", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedD1(d1);
    // Custody: a market bid of 70 taken from a wallet that now holds 1114.
    insert(d1, "account_wallet", { account_id: "w9", coin: 1114, gem: 0 });
    insert(d1, "economy_ledger", {
      id: "b1",
      account_id: "w9",
      tx_id: "mk:bid:1",
      currency: "coin",
      amount: -70,
      flow: "transfer",
      reason_group: "market.bid",
      reason: "market.bid:1",
      at: DAY0 + HOUR,
    });
    const out = await readEconomyDetails(deps(d1, new FakeAq(POINTS)), RANGE);
    // Faucets 80 + 120 + 999 + 50; sinks 5 + 10 + 20 + 30; transfers net -70 (custody).
    expect(out.coinLedger).toEqual({ supply: 1114, faucets: 1249, sinks: 65, transfersNet: -70 });
    const c = out.coinLedger!;
    expect(c.faucets - c.sinks + c.transfersNet).toBe(c.supply);
  });

  it("reads market sales, median price and the volume series", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedD1(d1);
    const out = await readEconomyDetails(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.market.sales).toBe(4);
    expect(out.market.volume).toBe(1100);
    expect(out.market.taxes).toBe(55);
    // Prices 100, 200, 300, 500: median is (200 + 300) / 2.
    expect(out.market.medianPrice).toBe(250);
    expect(out.market.series[0]?.points.map((p) => p.v)).toEqual([100, 500, 500]);
    expect(out.market.byCategory.buckets).toEqual([
      { label: "weapon", value: 3 },
      { label: "armor", value: 1 },
    ]);
    expect(out.market.byRarity.buckets).toEqual([
      { label: "common", value: 2 },
      { label: "rare", value: 2 },
    ]);
  });

  it("counts trades by distinct trade reason and sums the trade fees", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedD1(d1);
    const out = await readEconomyDetails(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.trades.count).toBe(2);
    expect(out.trades.fees).toBe(15);
    expect(out.trades.series[0]?.points.map((p) => p.v)).toEqual([1, 1, 0]);
  });

  it("reads shop rent, shop sales and shop states (tombstones excluded)", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedD1(d1);
    const out = await readEconomyDetails(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.shops.rentPaid).toBe(30);
    expect(out.shops.sales).toBe(2);
    expect(out.shops.volume).toBe(100);
    expect(out.shops.byState.buckets).toEqual([
      { label: "leased", value: 2 },
      { label: "auction", value: 1 },
    ]);
  });

  it("separates gem purchases, gem sinks and the wallet supply", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedD1(d1);
    const out = await readEconomyDetails(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.gems.bought).toBe(1500);
    expect(out.gems.spent).toBe(700);
    expect(out.gems.supply).toBe(500);
    const bought = out.gems.series.find((s) => s.key === "bought");
    const spent = out.gems.series.find((s) => s.key === "spent");
    expect(bought?.points.map((p) => p.v)).toEqual([500, 1000, 0]);
    expect(spent?.points.map((p) => p.v)).toEqual([0, 200, 500]);
  });

  it("reads arena rewards in range and the current season ladder", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedD1(d1);
    const out = await readEconomyDetails(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.arena.rewardsCoin).toBe(200);
    expect(out.arena.players).toBe(3);
    expect(out.arena.matches).toBe(5);
    expect(out.arena.ratingHistogram.buckets).toEqual([
      { label: "900-999", value: 1 },
      { label: "1000-1099", value: 1 },
      { label: "1100-1199", value: 0 },
      { label: "1200-1299", value: 1 },
    ]);
    expect(SEASON).toBe("2026-s1");
  });

  it("splits coin faucets and sinks by reason group, excluding gems and transfers", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedD1(d1);
    const out = await readEconomyDetails(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.faucets.buckets).toEqual([
      { label: "arena.reward", value: 200 },
      { label: "pass.reward", value: 50 },
    ]);
    expect(out.sinks.buckets).toEqual([
      { label: "shop.rent", value: 30 },
      { label: "market.fee", value: 20 },
      { label: "trade.fee", value: 15 },
    ]);
  });

  it("queries the AE gold and play reads by metric, grouped by band", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const aq = new FakeAq(POINTS);
    await readEconomyDetails(deps(d1, aq), RANGE);

    const tallyCalls = aq.calls.filter((c) => c.metric === "sim.tally");
    expect(tallyCalls.map((c) => [c.where.metric, c.groupBy])).toEqual([
      ["play.ms", ["k2"]],
      ["gold", ["k1"]],
    ]);
  });

  it("gives empty data and ok:false sources when the tables are not migrated", async () => {
    const d1 = new FakeD1();
    const out = await readEconomyDetails(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.market.sales).toBe(0);
    expect(out.trades.count).toBe(0);
    expect(out.gems.bought).toBe(0);
    expect(out.faucets.buckets).toEqual([]);
    const d1Sources = out.sources.filter((s) => s.kind === "d1");
    expect(d1Sources.length).toBeGreaterThan(0);
    expect(d1Sources.every((s) => s.ok === false)).toBe(true);
    // The AE part still answers.
    expect(out.goldPerHourByBand.buckets[0]?.value).toBe(50);
  });

  it("marks AE sources ok:false and does not query when there is no analytics backend", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedD1(d1);
    const aq = new FakeAq(POINTS, "none");
    const out = await readEconomyDetails(deps(d1, aq), RANGE);

    expect(aq.calls).toHaveLength(0);
    const ae = out.sources.filter((s) => s.name === "sim.tally");
    expect(ae).toHaveLength(1);
    expect(ae[0]?.ok).toBe(false);
    expect(ae[0]?.note).toBe("no analytics backend");
    expect(out.goldPerHourByBand.buckets).toEqual([]);
    // The D1 part still answers.
    expect(out.market.sales).toBe(4);
  });
});
