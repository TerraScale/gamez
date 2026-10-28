import { VAULT_ITEM_DATA_MAX, VAULT_MAX_ITEMS, type VaultItemInput } from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import { describe, expect, it } from "vite-plus/test";
import { AccountEconomy } from "../../src/server/account/economy.ts";
import { AccountVault, legacySummary, vaultItemProblem } from "../../src/server/account/vault.ts";
import type { AccountWalletPayload, EconomyLedgerPayload } from "../../src/server/contracts.ts";
import { FakeGateway, testItem } from "../support/fake-gateway.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const NOW = 1_700_000_000_000;

function fresh(store = fakeSqlStore()) {
  const outbox = new Outbox(store.sql, "account:acc1");
  const economy = new AccountEconomy(store, () => NOW);
  const vault = new AccountVault(store, economy, outbox, "acc1", () => NOW);
  outbox.init();
  economy.init();
  vault.init();
  return { store, outbox, economy, vault };
}

describe("vault: schema", () => {
  it("upgrades a wave B stash table: rows kept, read as universal/tradable with a derived summary", () => {
    const store = fakeSqlStore();
    store.sql.exec(`CREATE TABLE stash (
      item_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      uid TEXT NOT NULL UNIQUE,
      count INTEGER NOT NULL,
      PRIMARY KEY (item_id, origin)
    )`);
    store.sql.exec(
      "INSERT INTO stash (item_id, origin, uid, count) VALUES ('universal.material.ember_dust', '', 'stk:old', 7)",
    );
    const { vault, economy } = fresh(store);
    expect(economy.stash()).toEqual([
      { uid: "stk:old", itemId: "universal.material.ember_dust", count: 7, origin: "" },
    ]);
    expect(vault.vault()).toEqual([
      {
        uid: "stk:old",
        itemId: "universal.material.ember_dust",
        count: 7,
        origin: "",
        universal: true,
        tradable: true,
        data: null,
        summary: {
          name: "Ember Dust",
          rarity: "common",
          level: 0,
          category: "material",
          slot: null,
          icon: "universal.material.ember_dust",
          lines: [],
        },
      },
    ]);
    // Two items with the same itemId + origin may now coexist (the wave B PK is gone).
    expect(
      vault.vaultPut("p1", testItem("a", { itemId: "universal.material.ember_dust", origin: "" }))
        .ok,
    ).toBe(true);
    expect(vault.vault()).toHaveLength(2);
    // init is repeatable on the upgraded table.
    fresh(store);
  });

  it("legacySummary falls back to category other", () => {
    expect(legacySummary("x")).toMatchObject({ name: "X", category: "other", icon: "x" });
  });
});

describe("vault: put and take", () => {
  it("puts with a fresh uid, replays return the same item, uids are never reused", () => {
    const { vault } = fresh();
    const first = vault.vaultPut("tx-1", testItem("sword"));
    expect(first).toMatchObject({ ok: true, replayed: false });
    if (!first.ok) throw new Error("put failed");
    expect(first.item.uid).toBe("v1");
    expect(vault.vaultPut("tx-1", testItem("other"))).toEqual({ ...first, replayed: true });
    expect(vault.vault()).toHaveLength(1);
    expect(vault.vaultGet("v1")).toEqual(first.item);

    const take = vault.vaultTake("take-1", "v1");
    expect(take).toEqual({ ok: true, item: first.item, replayed: false });
    expect(vault.vaultTake("take-1", "v1")).toEqual({ ok: true, item: first.item, replayed: true });
    expect(vault.vaultGet("v1")).toBeNull();
    expect(vault.vaultTake("take-2", "v1")).toEqual({ ok: false, code: "not_found" });

    const again = vault.vaultPut("tx-2", testItem("sword"));
    expect(again.ok && again.item.uid).toBe("v2");
  });

  it("not_found writes nothing, so the same txId works later", () => {
    const { vault } = fresh();
    expect(vault.vaultTake("t", "v1")).toEqual({ ok: false, code: "not_found" });
    vault.vaultPut("p", testItem("a"));
    expect(vault.vaultTake("t", "v1")).toMatchObject({ ok: true, replayed: false });
  });

  it("stops at VAULT_MAX_ITEMS with vault_full (not recorded: retry after a take works)", () => {
    const { vault } = fresh();
    for (let i = 0; i < VAULT_MAX_ITEMS; i++)
      expect(vault.vaultPut(`p${i}`, testItem(`i${i}`)).ok).toBe(true);
    expect(vault.vaultPut("over", testItem("x"))).toEqual({ ok: false, code: "vault_full" });
    // A replay of an already applied put still answers (no room needed).
    expect(vault.vaultPut("p0", testItem("i0"))).toMatchObject({ ok: true, replayed: true });
    vault.vaultTake("t0", "v1");
    expect(vault.vaultPut("over", testItem("x"))).toMatchObject({ ok: true, replayed: false });
  });

  it("validates input strictly", () => {
    const { vault } = fresh();
    const bad: [string, VaultItemInput][] = [
      ["empty itemId", testItem("a", { itemId: "" })],
      ["count 0", testItem("a", { count: 0 })],
      ["count float", testItem("a", { count: 1.5 })],
      ["universal not bool", testItem("a", { universal: 1 as unknown as boolean })],
      ["data too long", testItem("a", { data: "x".repeat(VAULT_ITEM_DATA_MAX + 1) })],
      [
        "name too long",
        testItem("a", { summary: { ...testItem("a").summary, name: "n".repeat(61) } }),
      ],
      [
        "bad category",
        testItem("a", { summary: { ...testItem("a").summary, category: "x" as "weapon" } }),
      ],
      [
        "too many lines",
        testItem("a", { summary: { ...testItem("a").summary, lines: Array(9).fill("l") } }),
      ],
      ["negative level", testItem("a", { summary: { ...testItem("a").summary, level: -1 } })],
    ];
    for (const [why, item] of bad) {
      expect(vaultItemProblem(item), why).not.toBeNull();
      expect(vault.vaultPut(`bad-${why}`, item), why).toEqual({ ok: false, code: "bad_item" });
    }
    expect(vault.vaultPut("x".repeat(129), testItem("a"))).toEqual({ ok: false, code: "bad_item" });
    expect(vault.vault()).toEqual([]);
    // Data at the limit is fine; unknown fields are dropped.
    const ok = vault.vaultPut("ok", {
      ...testItem("a", { data: "x".repeat(VAULT_ITEM_DATA_MAX) }),
      extra: 1,
    } as VaultItemInput);
    expect(ok.ok).toBe(true);
    expect(vault.vault()[0]).not.toHaveProperty("extra");
  });

  it("stashAdd never merges into an item with data", () => {
    const { vault, economy } = fresh();
    vault.vaultPut("p", testItem("a", { itemId: "m", origin: "" }));
    economy.stashAdd("s", { itemId: "m", origin: "", count: 3 });
    expect(vault.vault().map((i) => [i.uid, i.count])).toEqual([
      ["v1", 1],
      ["stk:s", 3],
    ]);
  });
});

describe("vault: walletTx telemetry", () => {
  const ledgerOf = (outbox: Outbox) =>
    outbox
      .pending()
      .filter((r) => r.table === "economy_ledger")
      .map((r) => ({ pk: r.pk, ...(r.payload as EconomyLedgerPayload) }));
  const walletRows = (outbox: Outbox) =>
    outbox
      .pending()
      .filter((r) => r.table === "account_wallet")
      .map((r) => ({ pk: r.pk, ...(r.payload as AccountWalletPayload) }));

  it("writes economy_ledger + account_wallet rows only when not replayed", () => {
    const { vault, outbox } = fresh();
    const credit = {
      txId: "g1",
      currency: "coin" as const,
      amount: 500,
      reason: "dev.grant",
      flow: "faucet" as const,
    };
    expect(vault.walletTx(credit)).toEqual({ ok: true, balance: 500, replayed: false });
    expect(vault.walletTx(credit)).toEqual({ ok: true, balance: 500, replayed: true });
    expect(
      vault.walletTx({
        txId: "f1",
        currency: "coin",
        amount: -10,
        reason: "trade.fee:t1",
        flow: "sink",
      }),
    ).toMatchObject({ ok: true, balance: 490 });
    expect(
      vault.walletTx({ txId: "x1", currency: "coin", amount: -1000, reason: "trade:t1" }),
    ).toEqual({
      ok: false,
      code: "insufficient_funds",
      balance: 490,
    });
    expect(ledgerOf(outbox)).toEqual([
      {
        pk: "acc1/g1",
        accountId: "acc1",
        txId: "g1",
        currency: "coin",
        amount: 500,
        flow: "faucet",
        reasonGroup: "dev.grant",
        reason: "dev.grant",
        at: NOW,
      },
      {
        pk: "acc1/f1",
        accountId: "acc1",
        txId: "f1",
        currency: "coin",
        amount: -10,
        flow: "sink",
        reasonGroup: "trade.fee",
        reason: "trade.fee:t1",
        at: NOW,
      },
    ]);
    expect(walletRows(outbox)).toEqual([
      { pk: "acc1", accountId: "acc1", coin: 500, gem: 0, updatedAt: NOW },
      { pk: "acc1", accountId: "acc1", coin: 490, gem: 0, updatedAt: NOW },
    ]);
  });

  it("defaults: walletTx flow transfer; wave B applyWalletTx transfer, dev* faucet", () => {
    const { vault, economy, outbox } = fresh();
    vault.walletTx({ txId: "a", currency: "coin", amount: 5, reason: "dev.thing" });
    economy.applyWalletTx({ txId: "b", currency: "gem", amount: 5, reason: "dev:grant" });
    economy.applyWalletTx({ txId: "c", currency: "gem", amount: -1, reason: "shop:buy" });
    expect(ledgerOf(outbox).map((r) => [r.txId, r.flow, r.currency, r.amount])).toEqual([
      ["a", "transfer", "coin", 5],
      ["b", "faucet", "gem", 5],
      ["c", "transfer", "gem", -1],
    ]);
  });

  it("rejects an unknown flow as bad_tx and writes nothing", () => {
    const { vault, outbox } = fresh();
    expect(
      vault.walletTx({
        txId: "a",
        currency: "coin",
        amount: 5,
        reason: "r",
        flow: "gift" as "sink",
      }),
    ).toEqual({ ok: false, code: "bad_tx", balance: 0 });
    expect(outbox.size()).toBe(0);
  });

  it("a throw inside the transaction leaves neither balance nor outbox rows", () => {
    const { vault, economy, outbox } = fresh();
    const hook = economy.onWalletApplied;
    economy.onWalletApplied = (tx) => {
      hook?.(tx);
      throw new Error("boom");
    };
    expect(() => vault.walletTx({ txId: "a", currency: "coin", amount: 5, reason: "r" })).toThrow(
      "boom",
    );
    expect(economy.balanceOf("coin")).toBe(0);
    expect(outbox.size()).toBe(0);
  });
});

describe("FakeGateway", () => {
  it("is idempotent like AccountDO and injects failures", async () => {
    const gw = new FakeGateway();
    const [sword] = gw.seed("alice", { coin: 100, items: [testItem("sword")] });
    expect(gw.balance("alice")).toBe(100);
    const tx = { txId: "t1", currency: "coin" as const, amount: -40, reason: "x" };
    expect(await gw.walletTx("alice", tx)).toEqual({ ok: true, balance: 60, replayed: false });
    expect(await gw.walletTx("alice", tx)).toEqual({ ok: true, balance: 60, replayed: true });

    gw.failNext("vaultTake", { code: "not_found" }, { accountId: "alice" });
    expect(await gw.vaultTake("alice", "k", sword!.uid)).toEqual({ ok: false, code: "not_found" });
    gw.failNext("vaultTake", "throwAfter");
    await expect(gw.vaultTake("alice", "k", sword!.uid)).rejects.toThrow("after apply");
    expect(gw.vault("alice")).toEqual([]);
    expect(await gw.vaultTake("alice", "k", sword!.uid)).toMatchObject({
      ok: true,
      replayed: true,
    });

    gw.failNext("walletTx", "throw", { txId: /fee$/ });
    expect(await gw.walletTx("alice", { ...tx, txId: "no-match", amount: 1 })).toMatchObject({
      ok: true,
    });
    await expect(gw.walletTx("alice", { ...tx, txId: "a:fee", amount: 1 })).rejects.toThrow(
      "before apply",
    );
    expect(gw.pendingFailures()).toBe(0);

    await gw.notify("bob", { id: "n1", kind: "system", text: "hi", data: {} });
    await gw.notify("bob", { id: "n1", kind: "system", text: "hi again", data: {} });
    expect(gw.noticesOf("bob").notices.map((n) => n.text)).toEqual(["hi"]);
    expect(gw.sunk(["alice"])).toBe(0);
  });
});
