import { describe, expect, it } from "vite-plus/test";
import { Outbox } from "@gamez/sync";
import { AccountEconomy } from "../../src/server/account/economy.ts";
import { AccountPurchases } from "../../src/server/account/purchases.ts";
import type { AccountNotices } from "../../src/server/account/notices.ts";
import type { AccountVault } from "../../src/server/account/vault.ts";
import type { NoticeInput } from "@gamez/protocol";
import { fakeSqlStore } from "../support/fake-sql.ts";

const ORDER = "o0123456789abcdef01234567";
const ORDER_B = "oabcdef0123456789abcdef01";
const price = { currency: "USD" as const, amountMinor: 99 };

interface Harness {
  purchases: AccountPurchases;
  economy: AccountEconomy;
  notes: NoticeInput[];
  outbox: Outbox;
  store: ReturnType<typeof fakeSqlStore>;
}

/**
 * A real economy and purchases over in-memory SQLite; the vault is the
 * economy's walletTx (T-escrow owns the real vault, so tests do not depend on it).
 */
function harness(): Harness {
  const store = fakeSqlStore();
  const economy = new AccountEconomy(store, () => 1_700_000_000_000);
  economy.init();
  const outbox = new Outbox(store.sql, "account:acc_abc");
  outbox.init();
  const notes: NoticeInput[] = [];
  const notices = { notify: (n: NoticeInput) => void notes.push(n) } as unknown as AccountNotices;
  const vault = {
    walletTx: (tx: Parameters<AccountEconomy["applyWalletTx"]>[0]) => economy.applyWalletTx(tx),
  } as unknown as AccountVault;
  const purchases = new AccountPurchases(
    store,
    economy,
    vault,
    notices,
    outbox,
    "acc_abc",
    () => 1_700_000_000_000,
  );
  purchases.init();
  return { purchases, economy, notes, outbox, store };
}

function gems(h: Harness): number {
  return h.economy.wallet().balances.gem;
}

describe("orders", () => {
  it("creates a pending order once; a replay returns the same row", () => {
    const h = harness();
    const first = h.purchases.createOrder({
      orderId: ORDER,
      sku: "gems.small",
      provider: "stub",
      price,
    });
    expect(first).toMatchObject({
      orderId: ORDER,
      status: "pending",
      accountId: "acc_abc",
      providerRef: null,
    });
    const again = h.purchases.createOrder({
      orderId: ORDER,
      sku: "gems.small",
      provider: "stub",
      price,
    });
    expect(again).toEqual(first);
    expect(h.purchases.orders()).toHaveLength(1);
  });

  it("answers not_found for an unknown order", () => {
    const h = harness();
    expect(
      h.purchases.fulfillOrder({ orderId: ORDER, providerRef: null, eventId: "e" }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(h.purchases.refundOrder({ orderId: ORDER, eventId: "e" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("fulfilment", () => {
  it("credits the gems once, marks the order paid, notifies and appends the outbox row", () => {
    const h = harness();
    h.purchases.createOrder({ orderId: ORDER, sku: "gems.small", provider: "stub", price });
    const r = h.purchases.fulfillOrder({ orderId: ORDER, providerRef: "stub_1", eventId: "evt-1" });
    expect(r).toMatchObject({
      ok: true,
      replayed: false,
      value: { status: "paid", providerRef: "stub_1" },
    });
    expect(gems(h)).toBe(100);
    expect(h.notes.map((n) => [n.id, n.kind])).toEqual([
      [`store:${ORDER}:granted`, "store.granted"],
    ]);
    expect(h.outbox.size()).toBeGreaterThan(0);
  });

  it("is a no-op on replay: no second credit, no second notice", () => {
    const h = harness();
    h.purchases.createOrder({ orderId: ORDER, sku: "gems.small", provider: "stub", price });
    h.purchases.fulfillOrder({ orderId: ORDER, providerRef: "stub_1", eventId: "evt-1" });
    const replay = h.purchases.fulfillOrder({
      orderId: ORDER,
      providerRef: "stub_1",
      eventId: "evt-2",
    });
    expect(replay).toMatchObject({ ok: true, replayed: true, value: { status: "paid" } });
    expect(gems(h)).toBe(100);
    expect(h.notes).toHaveLength(1);
  });

  it("grants the pass entitlement with a txId per order and sku, and the cosmetic bundle's skus", () => {
    const h = harness();
    h.purchases.createOrder({
      orderId: ORDER,
      sku: "pass.premium.2026-s1",
      provider: "stub",
      price,
    });
    h.purchases.fulfillOrder({ orderId: ORDER, providerRef: null, eventId: "e" });
    expect(h.economy.entitlements().map((e) => [e.id, e.sku, e.source])).toEqual([
      [`store:${ORDER}:pass.premium.2026-s1`, "pass.premium.2026-s1", "store"],
    ]);
    h.purchases.createOrder({ orderId: ORDER_B, sku: "bundle.ember", provider: "stub", price });
    h.purchases.fulfillOrder({ orderId: ORDER_B, providerRef: null, eventId: "e2" });
    expect(h.economy.cosmetics().owned).toEqual([
      "cosmetic.chatColor.ember",
      "cosmetic.nameplate.ember",
      "cosmetic.title.ember",
    ]);
    expect(gems(h)).toBe(0);
  });

  it("does not grant anything for an order that was never created", () => {
    const h = harness();
    h.purchases.fulfillOrder({ orderId: ORDER, providerRef: null, eventId: "e" });
    expect(gems(h)).toBe(0);
    expect(h.economy.entitlements()).toHaveLength(0);
  });
});

describe("refunds", () => {
  it("debits the gems it granted and revokes the entitlements", () => {
    const h = harness();
    h.purchases.createOrder({ orderId: ORDER, sku: "gems.medium", provider: "stub", price });
    h.purchases.fulfillOrder({ orderId: ORDER, providerRef: null, eventId: "e" });
    expect(gems(h)).toBe(550);
    const r = h.purchases.refundOrder({ orderId: ORDER, eventId: "r1" });
    expect(r).toMatchObject({ ok: true, value: { status: "refunded" } });
    expect(gems(h)).toBe(0);
  });

  it("debits at most the gems still held: spent gems are not clawed back below zero", () => {
    const h = harness();
    h.purchases.createOrder({ orderId: ORDER, sku: "gems.small", provider: "stub", price });
    h.purchases.fulfillOrder({ orderId: ORDER, providerRef: null, eventId: "e" });
    h.economy.applyWalletTx({ txId: "spend-1", currency: "gem", amount: -60, reason: "test" });
    h.purchases.refundOrder({ orderId: ORDER, eventId: "r1" });
    expect(gems(h)).toBe(0);
  });

  it("replays a refund without a second debit, and a late paid event does not grant again", () => {
    const h = harness();
    h.purchases.createOrder({ orderId: ORDER, sku: "gems.small", provider: "stub", price });
    h.purchases.fulfillOrder({ orderId: ORDER, providerRef: null, eventId: "e" });
    h.purchases.refundOrder({ orderId: ORDER, eventId: "r1" });
    const again = h.purchases.refundOrder({ orderId: ORDER, eventId: "r2" });
    expect(again).toMatchObject({ ok: true, replayed: true, value: { status: "refunded" } });
    const late = h.purchases.fulfillOrder({ orderId: ORDER, providerRef: null, eventId: "e3" });
    expect(late).toMatchObject({ ok: true, value: { status: "refunded" } });
    expect(gems(h)).toBe(0);
  });

  it("refunds an order that never got paid without touching the wallet", () => {
    const h = harness();
    h.purchases.createOrder({ orderId: ORDER, sku: "gems.small", provider: "stub", price });
    expect(h.purchases.refundOrder({ orderId: ORDER, eventId: "r" })).toMatchObject({
      ok: true,
      value: { status: "refunded" },
    });
    expect(gems(h)).toBe(0);
  });

  it("marks the order's entitlement rows revoked_at (economy keeps the grant rows)", () => {
    const h = harness();
    h.purchases.createOrder({
      orderId: ORDER,
      sku: "pass.premium.2026-s1",
      provider: "stub",
      price,
    });
    h.purchases.fulfillOrder({ orderId: ORDER, providerRef: null, eventId: "e" });
    h.purchases.refundOrder({ orderId: ORDER, eventId: "r" });
    const rows = h.store.fake.db
      .prepare("SELECT tx_id, sku, revoked_at FROM entitlements ORDER BY tx_id")
      .all() as { tx_id: string; sku: string; revoked_at: number | null }[];
    expect(rows).toEqual([
      {
        tx_id: `store:${ORDER}:pass.premium.2026-s1`,
        sku: "pass.premium.2026-s1",
        revoked_at: 1_700_000_000_000,
      },
    ]);
    // A revoked grant is no longer owned (pass.ts premium reads entitlements()).
    expect(h.economy.entitlements()).toHaveLength(0);
  });

  it("a refunded cosmetic bundle is no longer owned or shown equipped", () => {
    const h = harness();
    h.purchases.createOrder({ orderId: ORDER, sku: "bundle.ember", provider: "stub", price });
    h.purchases.fulfillOrder({ orderId: ORDER, providerRef: null, eventId: "e" });
    const owned = h.economy.cosmetics().owned;
    expect(owned.length).toBeGreaterThan(0);
    const first = owned[0]!;
    const slot = first.split(".")[1] as Parameters<typeof h.economy.equipCosmetic>[0];
    h.economy.equipCosmetic(slot, first);
    h.purchases.refundOrder({ orderId: ORDER, eventId: "r" });
    expect(h.economy.cosmetics()).toEqual({ owned: [], equipped: {} });
    expect(() => h.economy.equipCosmetic(slot, first)).toThrow();
  });

  it("adds revoked_at once: a second init is a no-op, other grants stay unrevoked", () => {
    const h = harness();
    h.purchases.init();
    h.economy.grantEntitlement({ txId: "pass:free:1", sku: "cosmetic.title.x", source: "pass" });
    h.purchases.createOrder({ orderId: ORDER, sku: "gems.small", provider: "stub", price });
    h.purchases.fulfillOrder({ orderId: ORDER, providerRef: null, eventId: "e" });
    h.purchases.refundOrder({ orderId: ORDER, eventId: "r" });
    const row = h.store.fake.db
      .prepare("SELECT revoked_at FROM entitlements WHERE tx_id = 'pass:free:1'")
      .get() as { revoked_at: number | null };
    expect(row.revoked_at).toBeNull();
  });
});
