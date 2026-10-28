/** Economy telemetry and the moderation queue over migrated tables (node:sqlite). */
import { describe, expect, it } from "vite-plus/test";
import { parseDays, readEconomyTelemetry } from "../../src/server/admin/telemetry.ts";
import { readModeration } from "../../src/server/admin/moderation.ts";
import { FakeD1 } from "../leaderboards/fake-d1.ts";

const MIGRATIONS = [
  "0005_chat.sql",
  "0006_market.sql",
  "0007_shops.sql",
  "0008_arena.sql",
  "0009_economy.sql",
];
const NOW = Date.UTC(2026, 9, 28, 12);
const HOUR = 3_600_000;
const DAY = 86_400_000;

function insert(d1: FakeD1, table: string, row: Record<string, unknown>): void {
  const full: Record<string, unknown> = { _version: 1, _deleted: 0, _updated_at: 1, ...row };
  const cols = Object.keys(full);
  d1.db
    .prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(...(cols.map((c) => full[c]) as never[]));
}

function seeded(): FakeD1 {
  const d1 = new FakeD1();
  d1.migrate(MIGRATIONS);

  insert(d1, "account_wallet", { account_id: "a1", coin: 100, gem: 5, updated_at: NOW });
  insert(d1, "account_wallet", { account_id: "a2", coin: 50, gem: 0, updated_at: NOW });
  insert(d1, "account_wallet", { account_id: "gone", coin: 999, gem: 999, _deleted: 1 });

  const ledger = (id: string, o: Record<string, unknown>) =>
    insert(d1, "economy_ledger", { id, account_id: "a1", tx_id: id, currency: "coin", ...o });
  ledger("l1", {
    amount: 40,
    flow: "faucet",
    reason_group: "bank.deposit",
    reason: "bank.deposit:classic",
    at: NOW - HOUR,
  });
  ledger("l2", {
    amount: -10,
    flow: "sink",
    reason_group: "market.fee",
    reason: "market.fee:weapon/1",
    at: NOW - HOUR,
  });
  ledger("l3", {
    amount: 5,
    flow: "sink",
    reason_group: "market.fee",
    reason: "market.fee:refund",
    at: NOW - 2 * HOUR,
  });
  ledger("l4", {
    amount: 7,
    flow: "faucet",
    reason_group: "",
    reason: "arena.reward",
    at: NOW - 3 * DAY,
  });
  ledger("l5", {
    amount: -300,
    flow: "transfer",
    reason_group: "trade.coin",
    reason: "trade.coin",
    at: NOW - HOUR,
  });
  ledger("old", {
    amount: 1000,
    flow: "faucet",
    reason_group: "dev.grant",
    reason: "dev.grant",
    at: NOW - 40 * DAY,
  });
  // Gem flows: a store grant and the premium pass. Never part of the coin chart.
  ledger("g1", {
    currency: "gem",
    amount: 5200,
    flow: "faucet",
    reason_group: "store.gems",
    reason: "store.gems:order-1",
    at: NOW - HOUR,
  });
  ledger("g2", {
    currency: "gem",
    amount: -500,
    flow: "sink",
    reason_group: "pass.premium",
    reason: "pass.premium:2026-s1",
    at: NOW - HOUR,
  });
  ledger("gone", {
    amount: 1000,
    flow: "faucet",
    reason_group: "dev.grant",
    reason: "dev.grant",
    at: NOW - HOUR,
    _deleted: 1,
  });

  const sale = (id: string, o: Record<string, unknown>) => insert(d1, "economy_sale", { id, ...o });
  sale("s1", { venue: "market", scope: "classic", category: "weapon", price: 200, at: NOW - HOUR });
  sale("s2", {
    venue: "market",
    scope: "classic",
    category: "weapon",
    price: 100,
    at: NOW - 2 * HOUR,
  });
  sale("s3", { venue: "shop", scope: "classic", category: "armor", price: 50, at: NOW - HOUR });
  sale("s4", {
    venue: "market",
    scope: "classic",
    category: "weapon",
    price: 999,
    at: NOW - 30 * HOUR,
  });

  const listing = (id: string, o: Record<string, unknown>) =>
    insert(d1, "market_listing", {
      id,
      shard: "classic:weapon",
      scope: "classic",
      category: "weapon",
      price: 1,
      ...o,
    });
  listing("m1", { status: "active", ends_at: NOW + HOUR });
  listing("m2", { status: "active", ends_at: NOW + 2 * HOUR });
  listing("m3", { status: "active", ends_at: NOW - HOUR });
  listing("m4", { status: "sold", ends_at: NOW + HOUR });

  const shop = (id: string, state: string, o: Record<string, unknown> = {}) =>
    insert(d1, "shop_index", { id, world: "classic-town", plot_id: id, state, ...o });
  shop("p1", "leased");
  shop("p2", "leased");
  shop("p3", "auction");
  shop("p4", "grace");
  shop("p5", "leased", { _deleted: 1 });

  const purchase = (id: string, o: Record<string, unknown>) =>
    insert(d1, "purchase", { id, account_id: "a1", sku: "gems.100", provider: "stub", ...o });
  purchase("u1", { currency: "USD", amount_minor: 1000, status: "paid", updated_at: NOW - HOUR });
  purchase("u2", {
    currency: "BRL",
    amount_minor: 5000,
    status: "paid",
    updated_at: NOW - 2 * HOUR,
  });
  purchase("u3", { currency: "USD", amount_minor: 900, status: "pending", updated_at: NOW - HOUR });
  purchase("u4", { currency: "EUR", amount_minor: 300, status: "paid", updated_at: NOW - 2 * DAY });

  const report = (id: string, o: Record<string, unknown>) =>
    insert(d1, "chat_report", { id, channel: "global", message_id: id, reporter_id: "r", ...o });
  report("r1", {
    reported_id: "acc-x",
    reason: "spam",
    text: "spam one",
    at: NOW - 300,
    verdict: null,
  });
  report("r2", {
    reported_id: "acc-x",
    reason: "spam",
    text: "spam two",
    at: NOW - 200,
    verdict: "",
  });
  report("r3", {
    reported_id: "acc-x",
    reason: "spam",
    text: "spam three",
    at: NOW - 100,
    verdict: "mute",
  });
  report("r4", {
    reported_id: "acc-y",
    reason: "rude",
    text: "rude",
    at: NOW - 50,
    verdict: "hide",
    channel: "guild:iron",
  });
  report("r5", { reported_id: "acc-z", reason: "rude", text: "gone", at: NOW - 10, _deleted: 1 });
  return d1;
}

describe("readEconomyTelemetry", () => {
  it("reads money, flows, prices, market, shops and purchases", async () => {
    const t = await readEconomyTelemetry(seeded().asD1(), 14, NOW);
    expect(t.at).toBe(NOW);
    expect(t.moneySupply).toEqual({ coin: 150, gem: 5 });
    expect(t.accounts).toBe(2);

    expect(t.flows).toHaveLength(14);
    const today = t.flows[13]!;
    expect(today.day).toBe("2026-10-28");
    expect(today.faucets).toEqual({ "bank.deposit": 40 });
    // Sinks: -(−10 + 5); the transfer, the deleted row and the gem rows are excluded.
    expect(today.sinks).toEqual({ "market.fee": 5 });
    // The empty reason group falls back to the raw reason.
    expect(t.flows[10]!.day).toBe("2026-10-25");
    expect(t.flows[10]!.faucets).toEqual({ "arena.reward": 7 });
    expect(t.flows[0]!.faucets).toEqual({});

    expect(t.priceIndex).toEqual([
      { day: "2026-10-27", category: "weapon", median: 999, volume: 1 },
      { day: "2026-10-28", category: "armor", median: 50, volume: 1 },
      { day: "2026-10-28", category: "weapon", median: 100, volume: 2 },
    ]);

    expect(t.market).toEqual({ active: 2, sold24h: 2, volume24h: 300 });
    expect(t.shops).toEqual({ leased: 2, auction: 1, grace: 1 });
    expect(t.purchases).toEqual({ paid24h: 2, revenueMinor24h: { USD: 1000, BRL: 5000 } });
  });

  it("answers zeros when the tables are not migrated", async () => {
    const t = await readEconomyTelemetry(new FakeD1().asD1(), 7, NOW);
    expect(t.moneySupply).toEqual({ coin: 0, gem: 0 });
    expect(t.accounts).toBe(0);
    expect(t.flows).toHaveLength(7);
    expect(t.flows.every((d) => Object.keys(d.faucets).length === 0)).toBe(true);
    expect(t.priceIndex).toEqual([]);
    expect(t.market).toEqual({ active: 0, sold24h: 0, volume24h: 0 });
    expect(t.shops).toEqual({ leased: 0, auction: 0, grace: 0 });
    expect(t.purchases).toEqual({ paid24h: 0, revenueMinor24h: {} });
  });

  it("is deterministic for the same rows and clock", async () => {
    const d1 = seeded().asD1();
    const a = await readEconomyTelemetry(d1, 14, NOW);
    const b = await readEconomyTelemetry(d1, 14, NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("parseDays", () => {
  it("defaults to 14 and clamps to 1..60", () => {
    expect(parseDays(null)).toBe(14);
    expect(parseDays("abc")).toBe(14);
    expect(parseDays("0")).toBe(1);
    expect(parseDays("-5")).toBe(1);
    expect(parseDays("61")).toBe(60);
    expect(parseDays("7.9")).toBe(7);
    expect(parseDays("30")).toBe(30);
  });
});

describe("readModeration", () => {
  it("groups reports by account, newest first, with samples and verdicts", async () => {
    const q = await readModeration(seeded().asD1(), NOW);
    expect(q.at).toBe(NOW);
    expect(q.accounts.map((a) => a.accountId)).toEqual(["acc-y", "acc-x"]);
    const x = q.accounts[1]!;
    expect(x.reports).toBe(3);
    expect(x.open).toBe(2);
    expect(x.lastAt).toBe(NOW - 100);
    expect(x.samples.map((s) => s.text)).toEqual(["spam three", "spam two", "spam one"]);
    expect(x.verdicts).toEqual({ mute: 1, open: 2 });
    const y = q.accounts[0]!;
    expect(y.samples[0]).toMatchObject({ channel: "guild:iron", messageId: "r4", verdict: "hide" });
    expect(y.open).toBe(0);
  });

  it("answers an empty queue when the table is missing", async () => {
    const q = await readModeration(new FakeD1().asD1(), NOW);
    expect(q).toEqual({ at: NOW, accounts: [] });
  });
});
