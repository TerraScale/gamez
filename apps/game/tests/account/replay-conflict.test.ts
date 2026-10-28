/**
 * ADR 0007 R2: every AccountDO txId is bound to its parameters. An identical
 * replay answers the first result (ok, replayed: true); the same txId with
 * other parameters answers { ok: false, code: "conflict" } and writes nothing
 * (no balance, vault, tx or outbox change).
 */
import { Outbox } from "@gamez/sync";
import { describe, expect, it } from "vite-plus/test";
import { AccountEconomy } from "../../src/server/account/economy.ts";
import { AccountVault } from "../../src/server/account/vault.ts";
import { testItem } from "../support/fake-gateway.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const NOW = 1_700_000_000_000;

function fresh() {
  const store = fakeSqlStore();
  const outbox = new Outbox(store.sql, "account:acc1");
  const economy = new AccountEconomy(store, () => NOW);
  const vault = new AccountVault(store, economy, outbox, "acc1", () => NOW);
  outbox.init();
  economy.init();
  vault.init();
  /** Everything a replay could change: balances, vault, tx rows, outbox rows. */
  const state = () => ({
    wallet: economy.wallet(),
    vault: vault.vault(),
    tx: store.sql.exec("SELECT * FROM tx ORDER BY kind, tx_id").toArray(),
    outbox: outbox.pending(100_000).length,
  });
  return { store, outbox, economy, vault, state };
}

describe("wallet replays are bound to currency and amount", () => {
  it("an identical replay is ok/replayed with the first balance", () => {
    const { vault, state } = fresh();
    vault.walletTx({ txId: "seed", currency: "coin", amount: 100, reason: "dev.seed" });
    const first = vault.walletTx({ txId: "w1", currency: "coin", amount: -1, reason: "bank" });
    expect(first).toEqual({ ok: true, balance: 99, replayed: false });
    const before = state();
    expect(vault.walletTx({ txId: "w1", currency: "coin", amount: -1, reason: "bank" })).toEqual({
      ok: true,
      balance: 99,
      replayed: true,
    });
    expect(state()).toEqual(before);
  });

  it("the same txId with another amount is a conflict and writes nothing", () => {
    const { vault, economy, state } = fresh();
    vault.walletTx({ txId: "seed", currency: "coin", amount: 100, reason: "dev.seed" });
    vault.walletTx({ txId: "w1", currency: "coin", amount: -1, reason: "bank" });
    const before = state();
    expect(
      vault.walletTx({ txId: "w1", currency: "coin", amount: -1_000_000_000, reason: "bank" }),
    ).toEqual({ ok: false, code: "conflict", balance: 99 });
    // A positive amount under a debit's txId: same answer.
    expect(economy.applyWalletTx({ txId: "w1", currency: "coin", amount: 5, reason: "x" })).toEqual(
      { ok: false, code: "conflict", balance: 99 },
    );
    expect(state()).toEqual(before);
  });

  it("the same txId with another currency is a conflict and writes nothing", () => {
    const { vault, state } = fresh();
    vault.walletTx({ txId: "g", currency: "gem", amount: 7, reason: "dev.seed" });
    vault.walletTx({ txId: "w1", currency: "coin", amount: 10, reason: "dev.seed" });
    const before = state();
    expect(vault.walletTx({ txId: "w1", currency: "gem", amount: 10, reason: "dev.seed" })).toEqual(
      { ok: false, code: "conflict", balance: 7 },
    );
    expect(state()).toEqual(before);
  });

  it("a stored row without currency/amount (cannot be proven equal) is a conflict", () => {
    const { store, vault, state } = fresh();
    store.sql.exec(
      "INSERT INTO tx (kind, tx_id, result, at) VALUES ('wallet', 'legacy', ?, ?)",
      JSON.stringify({ balance: 0 }),
      NOW,
    );
    const before = state();
    expect(
      vault.walletTx({ txId: "legacy", currency: "coin", amount: 1, reason: "dev.seed" }),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(state()).toEqual(before);
  });
});

describe("vaultTake replays are bound to the uid", () => {
  it("an identical replay is ok/replayed with the first item", () => {
    const { vault, state } = fresh();
    const a = vault.vaultPut("p1", testItem("axe"));
    if (!a.ok) throw new Error("put");
    const first = vault.vaultTake("t1", a.item.uid);
    expect(first).toEqual({ ok: true, item: a.item, replayed: false });
    const before = state();
    expect(vault.vaultTake("t1", a.item.uid)).toEqual({ ok: true, item: a.item, replayed: true });
    expect(state()).toEqual(before);
  });

  it("the same txId with another uid is a conflict and takes nothing", () => {
    const { vault, state } = fresh();
    const a = vault.vaultPut("p1", testItem("axe"));
    const b = vault.vaultPut("p2", testItem("bow"));
    if (!a.ok || !b.ok) throw new Error("put");
    vault.vaultTake("t1", a.item.uid);
    const before = state();
    expect(vault.vaultTake("t1", b.item.uid)).toEqual({ ok: false, code: "conflict" });
    expect(vault.vault().map((i) => i.uid)).toEqual([b.item.uid]);
    expect(state()).toEqual(before);
  });
});

describe("vaultPut replays are bound to the item", () => {
  it("an identical replay is ok/replayed with the first item (extra fields ignored)", () => {
    const { vault, state } = fresh();
    const first = vault.vaultPut("p1", testItem("axe"));
    if (!first.ok) throw new Error("put");
    const before = state();
    const again = vault.vaultPut("p1", {
      ...testItem("axe"),
      uid: "ignored",
    } as ReturnType<typeof testItem>);
    expect(again).toEqual({ ok: true, item: first.item, replayed: true });
    expect(state()).toEqual(before);
  });

  it("the same txId with another item, count, origin or data is a conflict and puts nothing", () => {
    const { vault, state } = fresh();
    vault.vaultPut("p1", testItem("axe"));
    const before = state();
    const variants = [
      testItem("bow"),
      testItem("axe", { count: 2 }),
      testItem("axe", { origin: "steps" }),
      testItem("axe", { data: JSON.stringify({ name: "axe", plus: 99 }) }),
      testItem("axe", { universal: true }),
      testItem("axe", { tradable: false }),
      testItem("axe", { summary: { ...testItem("axe").summary, rarity: "legendary" } }),
    ];
    for (const v of variants)
      expect(vault.vaultPut("p1", v)).toEqual({ ok: false, code: "conflict" });
    expect(vault.vault()).toHaveLength(1);
    expect(state()).toEqual(before);
  });

  it("a stored result that is not a valid item (cannot be proven equal) is a conflict", () => {
    const { store, vault, state } = fresh();
    store.sql.exec(
      "INSERT INTO tx (kind, tx_id, result, at) VALUES ('vault.put', 'legacy', ?, ?)",
      JSON.stringify({ uid: "v9" }),
      NOW,
    );
    const before = state();
    expect(vault.vaultPut("legacy", testItem("axe"))).toEqual({ ok: false, code: "conflict" });
    expect(state()).toEqual(before);
  });
});
