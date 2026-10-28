import { describe, expect, it } from "vite-plus/test";
import { AccountEconomy, EconomyError } from "../../src/server/account/economy.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

function fresh(): AccountEconomy {
  const economy = new AccountEconomy(fakeSqlStore(), () => 1_700_000_000_000);
  economy.init();
  return economy;
}

/** The EconomyError code thrown by fn, or null when it does not throw. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof EconomyError ? err.code : `other:${String(err)}`;
  }
}

describe("wallet", () => {
  it("starts at zero in both currencies and init is repeatable", () => {
    const economy = fresh();
    economy.init();
    expect(economy.wallet()).toEqual({ balances: { coin: 0, gem: 0 } });
  });

  it("credits and debits, and a replayed txId is not applied twice", () => {
    const economy = fresh();
    const credit = { txId: "w-1", currency: "coin" as const, amount: 100, reason: "test" };
    expect(economy.applyWalletTx(credit)).toEqual({ ok: true, balance: 100, replayed: false });
    expect(economy.applyWalletTx(credit)).toEqual({ ok: true, balance: 100, replayed: true });
    expect(economy.wallet().balances.coin).toBe(100);
  });

  it("a replay with the same currency and amount returns the first result (reason not compared)", () => {
    const economy = fresh();
    economy.applyWalletTx({ txId: "w-1", currency: "gem", amount: 5, reason: "a" });
    const replay = economy.applyWalletTx({ txId: "w-1", currency: "gem", amount: 5, reason: "b" });
    expect(replay).toEqual({ ok: true, balance: 5, replayed: true });
    expect(economy.wallet().balances.gem).toBe(5);
  });

  it("ADR 0007: a replay with another amount is a conflict and writes nothing", () => {
    const economy = fresh();
    economy.applyWalletTx({ txId: "w-1", currency: "gem", amount: 5, reason: "a" });
    const replay = economy.applyWalletTx({
      txId: "w-1",
      currency: "gem",
      amount: 999,
      reason: "b",
    });
    expect(replay).toEqual({ ok: false, code: "conflict", balance: 5 });
    expect(economy.wallet().balances.gem).toBe(5);
  });

  it("refuses to go below zero, writes nothing, and allows a retry with the same txId later", () => {
    const economy = fresh();
    economy.applyWalletTx({ txId: "w-1", currency: "coin", amount: 30, reason: "seed" });
    const refused = economy.applyWalletTx({
      txId: "w-2",
      currency: "coin",
      amount: -50,
      reason: "buy",
    });
    expect(refused).toEqual({ ok: false, code: "insufficient_funds", balance: 30 });
    expect(economy.wallet().balances.coin).toBe(30);

    economy.applyWalletTx({ txId: "w-3", currency: "coin", amount: 40, reason: "income" });
    const retry = economy.applyWalletTx({
      txId: "w-2",
      currency: "coin",
      amount: -50,
      reason: "buy",
    });
    expect(retry).toEqual({ ok: true, balance: 20, replayed: false });
  });

  it("never lets a sequence of debits go negative", () => {
    const economy = fresh();
    economy.applyWalletTx({ txId: "seed", currency: "coin", amount: 10, reason: "seed" });
    const results = [1, 2, 3, 4, 5].map((i) =>
      economy.applyWalletTx({ txId: `d-${i}`, currency: "coin", amount: -4, reason: "spend" }),
    );
    expect(results.filter((r) => r.ok).length).toBe(2);
    expect(economy.wallet().balances.coin).toBe(2);
  });

  it("keeps currencies separate", () => {
    const economy = fresh();
    economy.applyWalletTx({ txId: "c", currency: "coin", amount: 7, reason: "x" });
    economy.applyWalletTx({ txId: "g", currency: "gem", amount: 3, reason: "x" });
    expect(economy.wallet()).toEqual({ balances: { coin: 7, gem: 3 } });
  });

  it("rejects bad input as bad_tx without writing", () => {
    const economy = fresh();
    const bad = [
      { txId: "", currency: "coin", amount: 1, reason: "" },
      { txId: "x".repeat(129), currency: "coin", amount: 1, reason: "" },
      { txId: "b1", currency: "coin", amount: 1.5, reason: "" },
      { txId: "b2", currency: "coin", amount: 0, reason: "" },
      { txId: "b3", currency: "coin", amount: Number.NaN, reason: "" },
      { txId: "b4", currency: "coin", amount: Number.POSITIVE_INFINITY, reason: "" },
      { txId: "b5", currency: "doubloons", amount: 1, reason: "" },
      { txId: "b6", currency: "coin", amount: 1, reason: "r".repeat(201) },
    ] as unknown as Parameters<AccountEconomy["applyWalletTx"]>[0][];
    for (const tx of bad) {
      expect(economy.applyWalletTx(tx)).toMatchObject({ ok: false, code: "bad_tx" });
    }
    expect(economy.wallet()).toEqual({ balances: { coin: 0, gem: 0 } });
  });

  it("writes a ledger row per applied transaction", () => {
    const economy = fresh();
    economy.applyWalletTx({ txId: "l-1", currency: "coin", amount: 9, reason: "quest" });
    const rows = economy.store.sql
      .exec<{ kind: string; tx_id: string; amount: number; reason: string }>(
        "SELECT kind, tx_id, amount, reason FROM tx",
      )
      .toArray();
    expect(rows).toEqual([{ kind: "wallet", tx_id: "l-1", amount: 9, reason: "quest" }]);
  });
});

describe("universal stash", () => {
  it("merges counts per itemId and origin, keeps the first uid", () => {
    const economy = fresh();
    const first = economy.stashAdd("s-1", {
      itemId: "universal.material.ember_dust",
      count: 3,
      origin: "classic",
    });
    expect(first).toEqual([
      { uid: "stk:s-1", itemId: "universal.material.ember_dust", count: 3, origin: "classic" },
    ]);
    const merged = economy.stashAdd("s-2", {
      itemId: "universal.material.ember_dust",
      count: 4,
      origin: "classic",
    });
    expect(merged).toEqual([
      { uid: "stk:s-1", itemId: "universal.material.ember_dust", count: 7, origin: "classic" },
    ]);
  });

  it("keeps the same item from different origins in separate stacks", () => {
    const economy = fresh();
    economy.stashAdd("a", { itemId: "universal.gem", count: 1, origin: "classic" });
    economy.stashAdd("b", { itemId: "universal.gem", count: 2, origin: "" });
    expect(economy.stash().map((s) => [s.origin, s.count])).toEqual([
      ["", 2],
      ["classic", 1],
    ]);
  });

  it("replays an add without doubling and returns the first result", () => {
    const economy = fresh();
    economy.stashAdd("dup", { itemId: "universal.gem", count: 2, origin: "classic" });
    economy.stashAdd("other", { itemId: "universal.gem", count: 1, origin: "classic" });
    const replay = economy.stashAdd("dup", {
      itemId: "universal.gem",
      count: 2,
      origin: "classic",
    });
    // The replay returns the first result (count 2 after "dup"), and the live stack
    // stays at 3 (2 from "dup" + 1 from "other"): the replay did not add its 2 again.
    expect(replay).toEqual([
      { uid: "stk:dup", itemId: "universal.gem", count: 2, origin: "classic" },
    ]);
    expect(economy.stash()[0]!.count).toBe(3);
  });

  it("removes part of a stack, then the whole stack at zero", () => {
    const economy = fresh();
    economy.stashAdd("s", { itemId: "universal.gem", count: 5, origin: "classic" });
    expect(economy.stashRemove("r-1", "stk:s", 2)[0]!.count).toBe(3);
    expect(economy.stashRemove("r-2", "stk:s", 3)).toEqual([]);
    expect(economy.stash()).toEqual([]);
  });

  it("refuses to remove more than the stack holds, without recording the txId", () => {
    const economy = fresh();
    economy.stashAdd("s", { itemId: "universal.gem", count: 2, origin: "classic" });
    expect(codeOf(() => economy.stashRemove("r-1", "stk:s", 3))).toBe("insufficient_items");
    expect(economy.stash()[0]!.count).toBe(2);
    // The same txId can still be used once the stack is large enough.
    expect(economy.stashRemove("r-1", "stk:s", 2)).toEqual([]);
  });

  it("refuses an unknown uid", () => {
    const economy = fresh();
    expect(codeOf(() => economy.stashRemove("r-1", "stk:none", 1))).toBe("not_found");
  });

  it("replays a remove without removing twice", () => {
    const economy = fresh();
    economy.stashAdd("s", { itemId: "universal.gem", count: 5, origin: "classic" });
    economy.stashRemove("r", "stk:s", 2);
    expect(economy.stashRemove("r", "stk:s", 2)[0]!.count).toBe(3);
    expect(economy.stash()[0]!.count).toBe(3);
  });

  it("rejects non-positive or fractional counts", () => {
    const economy = fresh();
    for (const count of [0, -1, 1.5, Number.NaN]) {
      expect(codeOf(() => economy.stashAdd("bad", { itemId: "x", count, origin: "" }))).toBe(
        "bad_item",
      );
    }
    expect(economy.stash()).toEqual([]);
  });
});

describe("entitlements and cosmetics", () => {
  it("grants an entitlement once per txId", () => {
    const economy = fresh();
    const grant = { txId: "g-1", sku: "cosmetic.title.founder", source: "test" };
    const first = economy.grantEntitlement(grant);
    expect(first.granted).toBe(true);
    expect(first.entitlement).toEqual({
      id: "g-1",
      sku: "cosmetic.title.founder",
      grantedAt: 1_700_000_000_000,
      source: "test",
    });
    const replay = economy.grantEntitlement({ ...grant, sku: "something.else" });
    expect(replay.granted).toBe(false);
    expect(replay.entitlement).toEqual(first.entitlement);
    expect(economy.entitlements()).toHaveLength(1);
  });

  it("allows the same sku under different txIds", () => {
    const economy = fresh();
    economy.grantEntitlement({ txId: "a", sku: "cosmetic.title.founder", source: "t" });
    economy.grantEntitlement({ txId: "b", sku: "cosmetic.title.founder", source: "t" });
    expect(economy.entitlements()).toHaveLength(2);
    expect(economy.cosmetics().owned).toEqual(["cosmetic.title.founder"]);
  });

  it("rejects malformed grants", () => {
    const economy = fresh();
    expect(
      codeOf(() => economy.grantEntitlement({ txId: "", sku: "cosmetic.a", source: "t" })),
    ).toBe("bad_tx");
    expect(
      codeOf(() => economy.grantEntitlement({ txId: "g", sku: "bad sku!", source: "t" })),
    ).toBe("bad_sku");
    expect(economy.entitlements()).toEqual([]);
  });

  it("lists only cosmetic.* skus as owned", () => {
    const economy = fresh();
    economy.grantEntitlement({ txId: "1", sku: "vip.pass", source: "t" });
    economy.grantEntitlement({ txId: "2", sku: "cosmetic.nameplate.gold", source: "t" });
    economy.grantEntitlement({ txId: "3", sku: "cosmetic.chatColor.teal", source: "t" });
    expect(economy.cosmetics()).toEqual({
      owned: ["cosmetic.chatColor.teal", "cosmetic.nameplate.gold"],
      equipped: {},
    });
  });

  it("equips only owned cosmetics and unequips with null", () => {
    const economy = fresh();
    expect(codeOf(() => economy.equipCosmetic("title", "cosmetic.title.founder"))).toBe(
      "not_owned",
    );
    expect(economy.cosmetics().equipped).toEqual({});

    economy.grantEntitlement({ txId: "g", sku: "cosmetic.title.founder", source: "dev" });
    expect(economy.equipCosmetic("title", "cosmetic.title.founder").equipped).toEqual({
      title: "cosmetic.title.founder",
    });
    expect(economy.equipCosmetic("title", null).equipped).toEqual({});
  });

  it("refuses a non-cosmetic id and an unknown slot", () => {
    const economy = fresh();
    economy.grantEntitlement({ txId: "v", sku: "vip.pass", source: "t" });
    expect(codeOf(() => economy.equipCosmetic("title", "vip.pass"))).toBe("bad_cosmetic");
    expect(codeOf(() => economy.equipCosmetic("hat" as never, null))).toBe("bad_slot");
  });

  it("replaces the equipped id within a slot", () => {
    const economy = fresh();
    economy.grantEntitlement({ txId: "a", sku: "cosmetic.title.a", source: "t" });
    economy.grantEntitlement({ txId: "b", sku: "cosmetic.title.b", source: "t" });
    economy.equipCosmetic("title", "cosmetic.title.a");
    expect(economy.equipCosmetic("title", "cosmetic.title.b").equipped).toEqual({
      title: "cosmetic.title.b",
    });
  });
});
