/**
 * readMonetization (docs/design/admin-dashboard.md §2.5) over a migrated FakeD1.
 * The reader is D1-only, so the analytics stub has no backend and must never
 * be called. Expected numbers come from the purchase fixture below.
 */
import { describe, expect, it } from "vite-plus/test";
import { currentSeason } from "@gamez/economy";
import type { AdminRange } from "@gamez/protocol";
import type {
  Analytics,
  AnalyticsQuery,
  SeriesRow,
  TotalsRow,
} from "../../src/server/analytics/types.ts";
import type { Env } from "../../src/server/contracts.ts";
import { readMonetization } from "../../src/server/admin/metrics/monetization.ts";
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

/** No analytics backend: the monetization reader must not touch AE at all. */
const NO_AE: AnalyticsQuery = {
  source: "none",
  async totals(): Promise<TotalsRow[]> {
    throw new Error("monetization must not query analytics");
  },
  async series(): Promise<SeriesRow[]> {
    throw new Error("monetization must not query analytics");
  },
  async quantiles(): Promise<number[]> {
    throw new Error("monetization must not query analytics");
  },
  async distinct(): Promise<number> {
    throw new Error("monetization must not query analytics");
  },
};

function insert(d1: FakeD1, table: string, row: Record<string, unknown>): void {
  const full: Record<string, unknown> = { _version: 1, _deleted: 0, _updated_at: 1, ...row };
  const cols = Object.keys(full);
  d1.db
    .prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(...(cols.map((c) => full[c]) as never[]));
}

function purchase(
  d1: FakeD1,
  id: string,
  account: string,
  sku: string,
  provider: string,
  currency: string,
  amount: number,
  status: string,
  created: number,
  updated: number,
  extra: Record<string, unknown> = {},
): void {
  insert(d1, "purchase", {
    id,
    account_id: account,
    sku,
    provider,
    currency,
    amount_minor: amount,
    status,
    created_at: created,
    updated_at: updated,
    ...extra,
  });
}

function seed(d1: FakeD1): void {
  // Paid in range (updated_at): p1 1000 USD stripe, p2 1000 USD stripe,
  // p3 5000 USD stripe, p4 4000 BRL asaas, p10 500 USD stub.
  purchase(d1, "p1", "acc1", "gems.small", "stripe", "USD", 1000, "paid", DAY0 + HOUR, DAY0 + HOUR);
  purchase(
    d1,
    "p2",
    "acc2",
    "gems.small",
    "stripe",
    "USD",
    1000,
    "paid",
    DAY0 + DAY,
    DAY0 + DAY + HOUR,
  );
  purchase(
    d1,
    "p3",
    "acc1",
    "gems.big",
    "stripe",
    "USD",
    5000,
    "paid",
    DAY0 + DAY + 2 * HOUR,
    DAY0 + DAY + 2 * HOUR,
  );
  purchase(
    d1,
    "p4",
    "acc3",
    "gems.small",
    "asaas",
    "BRL",
    4000,
    "paid",
    DAY0 + 2 * DAY,
    DAY0 + 2 * DAY + HOUR,
  );
  purchase(
    d1,
    "p10",
    "acc2",
    "gems.small",
    "stub",
    "USD",
    500,
    "paid",
    DAY0 + DAY,
    DAY0 + DAY + 4 * HOUR,
  );
  // Refunded in range (updated_at), pending and failed by created_at.
  purchase(
    d1,
    "p5",
    "acc4",
    "gems.small",
    "stub",
    "USD",
    1000,
    "refunded",
    DAY0 + HOUR,
    DAY0 + 2 * DAY + 2 * HOUR,
  );
  purchase(
    d1,
    "p6",
    "acc5",
    "gems.big",
    "mercadopago",
    "BRL",
    9000,
    "pending",
    DAY0 + DAY + 3 * HOUR,
    DAY0 + DAY + 3 * HOUR,
  );
  purchase(
    d1,
    "p7",
    "acc6",
    "gems.small",
    "stripe",
    "EUR",
    900,
    "failed",
    DAY0 + 2 * DAY,
    DAY0 + 2 * DAY,
  );
  // Out of range and tombstones: excluded everywhere.
  purchase(
    d1,
    "p8",
    "acc1",
    "gems.small",
    "stripe",
    "USD",
    1000,
    "paid",
    DAY0 - 2 * HOUR,
    DAY0 - HOUR,
  );
  purchase(
    d1,
    "p9",
    "acc7",
    "gems.small",
    "stripe",
    "USD",
    1000,
    "paid",
    DAY0 + HOUR,
    DAY0 + HOUR,
    { _deleted: 1 },
  );

  // Daily actives. Range days are d0, d0+1, d0+2; acc4 is active twice (one row).
  const d0 = Math.floor(DAY0 / DAY);
  insert(d1, "account_activity", {
    id: "acc1/d0",
    account_id: "acc1",
    day: d0,
    kind: "registered",
    first_at: DAY0,
  });
  insert(d1, "account_activity", {
    id: "acc2/d1",
    account_id: "acc2",
    day: d0 + 1,
    kind: "guest",
    first_at: DAY0 + DAY,
  });
  insert(d1, "account_activity", {
    id: "acc3/d2",
    account_id: "acc3",
    day: d0 + 2,
    kind: "registered",
    first_at: DAY0 + 2 * DAY,
  });
  insert(d1, "account_activity", {
    id: "acc4/d1",
    account_id: "acc4",
    day: d0 + 1,
    kind: "guest",
    first_at: DAY0 + DAY,
  });
  insert(d1, "account_activity", {
    id: "acc9/before",
    account_id: "acc9",
    day: d0 - 1,
    kind: "guest",
    first_at: DAY0 - DAY,
  });
  insert(d1, "account_activity", {
    id: "acc10/after",
    account_id: "acc10",
    day: d0 + 3,
    kind: "guest",
    first_at: DAY0 + 3 * DAY,
  });

  // Pass progress: the current season has 4 players, 2 premium.
  insert(d1, "pass_progress", {
    id: "acc1/s",
    account_id: "acc1",
    season_id: SEASON,
    premium: 1,
    updated_at: DAY0,
  });
  insert(d1, "pass_progress", {
    id: "acc2/s",
    account_id: "acc2",
    season_id: SEASON,
    premium: 0,
    updated_at: DAY0,
  });
  insert(d1, "pass_progress", {
    id: "acc3/s",
    account_id: "acc3",
    season_id: SEASON,
    premium: 1,
    updated_at: DAY0,
  });
  insert(d1, "pass_progress", {
    id: "acc4/s",
    account_id: "acc4",
    season_id: SEASON,
    premium: 0,
    updated_at: DAY0,
  });
  insert(d1, "pass_progress", {
    id: "acc9/old",
    account_id: "acc9",
    season_id: "old-season",
    premium: 1,
    updated_at: DAY0,
  });
  insert(d1, "pass_progress", {
    id: "acc8/s",
    account_id: "acc8",
    season_id: SEASON,
    premium: 1,
    updated_at: DAY0,
    _deleted: 1,
  });
}

function deps(d1: FakeD1): MetricsDeps {
  const analytics = { write() {}, flush: async () => {} } as unknown as Analytics;
  return { env: {} as Env, db: d1.asD1(), aq: NO_AE, analytics, now: NOW };
}

describe("readMonetization", () => {
  it("sums paid revenue per currency and provider, with the stub shown separately", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readMonetization(deps(d1), RANGE);

    expect(out.revenueMinor).toEqual({
      USD: { stripe: 7000, stub: 500 },
      BRL: { asaas: 4000 },
      EUR: {},
    });
    expect(out.revenueSeries.map((s) => [s.key, s.points.map((p) => p.v)])).toEqual([
      ["USD", [1000, 6500, 0]],
      ["BRL", [0, 0, 4000]],
    ]);
  });

  it("counts purchases by status with the right date column", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readMonetization(deps(d1), RANGE);

    expect(out.purchases).toEqual({ paid: 5, refunded: 1, pending: 1, failed: 1 });
    expect(out.payers).toBe(3);
  });

  it("breaks revenue down by SKU and currency, top sellers first", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readMonetization(deps(d1), RANGE);

    expect(out.bySku).toEqual([
      { sku: "gems.big", currency: "USD", paid: 1, refunded: 0, revenueMinor: 5000 },
      { sku: "gems.small", currency: "BRL", paid: 1, refunded: 0, revenueMinor: 4000 },
      { sku: "gems.small", currency: "USD", paid: 3, refunded: 1, revenueMinor: 2500 },
    ]);
  });

  it("computes ARPU over distinct active accounts and ARPPU over payers per currency", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readMonetization(deps(d1), RANGE);

    // Actives in range: acc1, acc2, acc3, acc4 (acc9 and acc10 are outside).
    expect(out.arpuMinor).toEqual({ USD: 7500 / 4, BRL: 4000 / 4, EUR: 0 });
    // Payers per currency: USD acc1 and acc2 (2), BRL acc3 (1), EUR none (0).
    expect(out.arppuMinor).toEqual({ USD: 7500 / 2, BRL: 4000, EUR: 0 });
  });

  it("counts a paid premium pass as premium even without a pass_progress row", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const sku = currentSeason(NOW).premiumSku;
    // acc11 bought the premium pass and never sent a pass_progress row; acc2 has
    // a premium=0 row but paid for premium; acc12's purchase was refunded.
    purchase(d1, "pp1", "acc11", sku, "stub", "USD", 999, "paid", DAY0, DAY0 + HOUR);
    purchase(d1, "pp2", "acc2", sku, "stub", "USD", 999, "paid", DAY0, DAY0 + HOUR);
    purchase(d1, "pp3", "acc12", sku, "stub", "USD", 999, "refunded", DAY0, DAY0 + HOUR);
    const out = await readMonetization(deps(d1), RANGE);

    // Players: acc1..acc4 + acc11; premium: acc1, acc3 (rows) + acc11, acc2 (paid).
    expect(out.pass).toEqual({ seasonId: SEASON, players: 5, premium: 4, conversion: 0.8 });
    expect(out.pass.premium).toBeLessThanOrEqual(out.pass.players);
  });

  it("keeps ARPU <= ARPPU when a payer has no activity row (payers count as active)", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    // acc20 pays 2000 USD in range with no account_activity row at all.
    purchase(d1, "px", "acc20", "gems.big", "stub", "USD", 2000, "paid", DAY0, DAY0 + HOUR);
    const out = await readMonetization(deps(d1), RANGE);

    // Actives: acc1..acc4 + acc20 (5). USD payers: acc1, acc2, acc20 (3).
    expect(out.arpuMinor.USD).toBe(9500 / 5);
    expect(out.arppuMinor.USD).toBe(9500 / 3);
    for (const c of ["USD", "BRL", "EUR"] as const) {
      expect(out.arpuMinor[c] ?? 0).toBeLessThanOrEqual(out.arppuMinor[c] ?? 0);
    }
  });

  it("reports the pass conversion for the current season", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readMonetization(deps(d1), RANGE);

    expect(out.pass).toEqual({ seasonId: SEASON, players: 4, premium: 2, conversion: 0.5 });
  });

  it("gives zeros and ok:false sources when the tables are not migrated", async () => {
    const d1 = new FakeD1();
    const out = await readMonetization(deps(d1), RANGE);

    expect(out.purchases).toEqual({ paid: 0, refunded: 0, pending: 0, failed: 0 });
    expect(out.payers).toBe(0);
    expect(out.bySku).toEqual([]);
    expect(out.pass).toEqual({ seasonId: SEASON, players: 0, premium: 0, conversion: 0 });
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.sources.every((s) => s.kind === "d1" && s.ok === false)).toBe(true);
  });

  it("never queries analytics (the stub throws if it is called)", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readMonetization(deps(d1), RANGE);
    expect(out.sources.every((s) => s.kind === "d1")).toBe(true);
    expect(out.sources.every((s) => s.ok)).toBe(true);
  });
});
