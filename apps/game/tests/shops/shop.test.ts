import { PLOT_AUCTION_MS, SHOP_TAX_PCT, shopTax } from "@gamez/economy";
import { SHOP_MAX_STOCK, type VaultItem } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { testItem } from "../support/fake-gateway.ts";
import { Harness, touched } from "./support.ts";

const LEASE_OPEN = { leaseId: "classic-town/p1/1", world: "classic-town", plotId: "p1" };

/** Alice leases p1 (bid 100 burnt), stocks `n` items at `price`, opens the shop. */
async function openShop(
  h: Harness,
  items: string[],
  price: number,
  open = true,
): Promise<VaultItem[]> {
  h.gw.seed("alice", { coin: 100 });
  await h.plots.bid({
    opId: "bid-alice-open1",
    bidder: h.party("alice", "Alice"),
    plotId: "p1",
    amount: 100,
  });
  h.clock.advance(PLOT_AUCTION_MS);
  await h.plots.plots();
  const stocked: VaultItem[] = h.gw.seed("alice", { items: items.map((n) => testItem(n)) });
  for (const [i, item] of stocked.entries()) {
    const r = await h.shop("p1").stock({
      opId: `stock-alice-${i}`.padEnd(12, "x"),
      accountId: "alice",
      uid: item.uid,
      price,
    });
    expect(r.ok).toBe(true);
  }
  if (open) {
    const r = await h.shop("p1").configure({ accountId: "alice", open: true });
    expect(r.ok).toBe(true);
  }
  return stocked;
}

/** Coin conservation: balances plus everything burnt equals the coin ever seeded. */
function conserved(h: Harness, seeded: number): boolean {
  return h.gw.totalCoin(touched(h)) + h.gw.sunk(touched(h)) === seeded;
}

describe("ShopBook: configure and stock", () => {
  it("only the owner configures; names and looks are checked", async () => {
    const h = new Harness();
    await openShop(h, [], 1, false);
    const shop = h.shop("p1");
    expect(await shop.configure({ accountId: "bob", name: "Bobs" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await shop.configure({ accountId: "alice", name: "ab" })).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    expect(await shop.configure({ accountId: "alice", name: "a".repeat(25) })).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    expect(await shop.configure({ accountId: "alice", name: "Bad<name>" })).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    expect(
      await shop.configure({ accountId: "alice", appearance: "unit.hero.Blue" }),
    ).toMatchObject({ ok: false, code: "bad_request" });
    expect(
      await shop.configure({ accountId: "alice", appearance: "unit.hero.blue_2" }),
    ).toMatchObject({ ok: true });
    const ok = await shop.configure({ accountId: "alice", name: "  Bob's  Axe_Shop-1 " });
    expect(ok.ok && ok.value.name).toBe("Bob's  Axe_Shop-1");
  });

  it("stocks only tradable vault items at a whole-coin price, and at most SHOP_MAX_STOCK", async () => {
    const h = new Harness();
    h.gw.seed("alice", { coin: 100 });
    await h.plots.bid({
      opId: "bid-alice-st001",
      bidder: h.party("alice"),
      plotId: "p1",
      amount: 100,
    });
    h.clock.advance(PLOT_AUCTION_MS);
    await h.plots.plots();
    const [locked] = h.gw.seed("alice", { items: [testItem("locked", { tradable: false })] });
    const r = await h
      .shop("p1")
      .stock({ opId: "stock-untrade1", accountId: "alice", uid: locked!.uid, price: 10 });
    expect(r).toMatchObject({ ok: false, code: "not_tradable" });
    const [ok] = h.gw.seed("alice", { items: [testItem("ok")] });
    expect(
      await h
        .shop("p1")
        .stock({ opId: "stock-price-1", accountId: "alice", uid: ok!.uid, price: 0 }),
    ).toMatchObject({ ok: false, code: "bad_request" });
    const good = await h
      .shop("p1")
      .stock({ opId: "stock-good-1", accountId: "alice", uid: ok!.uid, price: 10 });
    expect(good.ok && good.value.stock).toHaveLength(1);
    // The item left the vault: custody.
    expect(h.gw.vault("alice").map((i) => i.uid)).toEqual([locked!.uid]);
  });

  it("caps the stock at SHOP_MAX_STOCK entries", async () => {
    const h = new Harness();
    h.gw.seed("alice", { coin: 100 });
    await h.plots.bid({
      opId: "bid-alice-cap01",
      bidder: h.party("alice"),
      plotId: "p1",
      amount: 100,
    });
    h.clock.advance(PLOT_AUCTION_MS);
    await h.plots.plots();
    const items = h.gw.seed("alice", {
      items: Array.from({ length: SHOP_MAX_STOCK + 1 }, (_, i) => testItem(`i${i}`)),
    });
    for (const [i, item] of items.slice(0, SHOP_MAX_STOCK).entries()) {
      const r = await h.shop("p1").stock({
        opId: `stock-cap-${String(i).padStart(4, "0")}`,
        accountId: "alice",
        uid: item.uid,
        price: 5,
      });
      expect(r.ok).toBe(true);
    }
    const over = await h.shop("p1").stock({
      opId: "stock-cap-over1",
      accountId: "alice",
      uid: items[SHOP_MAX_STOCK]!.uid,
      price: 5,
    });
    expect(over).toMatchObject({ ok: false, code: "too_many" });
  });

  it("a replayed stock opId returns the same shop without taking the item twice", async () => {
    const h = new Harness();
    const items = await openShop(h, ["axe"], 300, false);
    const again = await h
      .shop("p1")
      .stock({ opId: "stock-alice-0", accountId: "alice", uid: items[0]!.uid, price: 300 });
    expect(again.ok && again.replayed).toBe(true);
    expect(h.gw.vault("alice")).toHaveLength(0);
    const other = await h
      .shop("p1")
      .stock({ opId: "stock-alice-0", accountId: "alice", uid: "someone-else", price: 300 });
    expect(other).toMatchObject({ ok: false, code: "bad_request" });
  });
});

describe("ShopBook: buy, claim and tax", () => {
  it("sells with tax and conservation: buyer pays price, owner claims price minus 3 %", async () => {
    const h = new Harness();
    const seeded = 100 + 1000; // alice's bid coin + bob's purse
    const items = await openShop(h, ["axe"], 300);
    h.gw.seed("bob", { coin: 1000 });
    const buy = await h.shop("p1").buy({
      opId: "buy-bob-00001",
      buyer: h.party("bob", "Bob"),
      entryId: (await h.shop("p1").view(null))!.stock[0]!.entryId,
    });
    expect(buy.ok).toBe(true);
    expect(h.gw.balance("bob")).toBe(700);
    expect(h.gw.vault("bob").map((i) => i.itemId)).toEqual([items[0]!.itemId]);
    expect(h.gw.noticesOf("alice").notices.map((n) => n.kind)).toContain("shop.sold");
    // The owner sees earnings; another viewer does not.
    const owner = await h.shop("p1").view("alice");
    expect(owner?.earnings).toBe(300 - shopTax(300));
    expect((await h.shop("p1").view("bob"))?.earnings).toBeNull();
    // Sale row for the D1 projection.
    const sale = h.outboxRows("economy_sale").at(-1)!.payload as {
      venue: string;
      price: number;
      tax: number;
    };
    expect(sale).toMatchObject({ venue: "shop", price: 300, tax: 9 });

    const claim = await h.shop("p1").claim({ opId: "claim-alice-01", accountId: "alice" });
    expect(claim.ok).toBe(true);
    // 300 gross to alice, 9 tax burnt: alice got 291 (after her 0 bid balance).
    expect(h.gw.balance("alice")).toBe(291);
    expect(h.gw.sunk(["alice"])).toBe(100 + 9);
    expect(conserved(h, seeded)).toBe(true);
    expect(SHOP_TAX_PCT).toBe(3);
  });

  it("claim is idempotent and pays nothing when there is nothing to claim", async () => {
    const h = new Harness();
    await openShop(h, [], 1);
    const empty = await h.shop("p1").claim({ opId: "claim-empty-01", accountId: "alice" });
    expect(empty.ok).toBe(true);
    expect(h.gw.balance("alice")).toBe(0);
    expect(await h.shop("p1").claim({ opId: "claim-bob-0001", accountId: "bob" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("refuses to sell to the owner, to a closed shop, or an unknown entry", async () => {
    const h = new Harness();
    await openShop(h, ["axe"], 50, false);
    const entry = (await h.shop("p1").view(null))!.stock[0]!.entryId;
    expect(
      await h.shop("p1").buy({ opId: "buy-alice-self", buyer: h.party("alice"), entryId: entry }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await h.shop("p1").buy({ opId: "buy-bob-closed", buyer: h.party("bob"), entryId: entry }),
    ).toMatchObject({ ok: false, code: "closed" });
    await h.shop("p1").configure({ accountId: "alice", open: true });
    expect(
      await h.shop("p1").buy({ opId: "buy-bob-nope1", buyer: h.party("bob"), entryId: "e999" }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("an unaffordable buy leaves the item on the shelf", async () => {
    const h = new Harness();
    await openShop(h, ["axe"], 300);
    h.gw.seed("bob", { coin: 10 });
    const entry = (await h.shop("p1").view(null))!.stock[0]!.entryId;
    expect(
      await h.shop("p1").buy({ opId: "buy-bob-poor1", buyer: h.party("bob"), entryId: entry }),
    ).toMatchObject({ ok: false, code: "insufficient_funds" });
    expect((await h.shop("p1").view(null))!.stock).toHaveLength(1);
    expect(h.gw.balance("bob")).toBe(10);
  });

  it("a failed delivery refunds the buyer and returns the item to the shelf", async () => {
    const h = new Harness();
    await openShop(h, ["axe"], 300);
    h.gw.seed("bob", { coin: 500 });
    h.gw.failNext("vaultPut", { code: "vault_full" }, { txId: /:deliver:/ });
    const entry = (await h.shop("p1").view(null))!.stock[0]!.entryId;
    const r = await h
      .shop("p1")
      .buy({ opId: "buy-bob-full1", buyer: h.party("bob"), entryId: entry });
    expect(r).toMatchObject({ ok: false, code: "vault_full" });
    expect(h.gw.balance("bob")).toBe(500);
    expect((await h.shop("p1").view(null))!.stock.map((s) => s.entryId)).toEqual([entry]);
    expect(conserved(h, 100 + 500)).toBe(true);
  });
});

describe("ShopBook: busy locks and crash re-drive", () => {
  it("an entry being bought is busy for other buys and for unstock", async () => {
    const h = new Harness();
    await openShop(h, ["axe"], 300);
    h.gw.seed("bob", { coin: 1000 });
    const entry = (await h.shop("p1").view(null))!.stock[0]!.entryId;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.gw.hook = async (accountId, txId) => {
      if (accountId === "bob" && txId.includes(":buy:")) await gate;
    };
    const first = h
      .shop("p1")
      .buy({ opId: "buy-bob-slow1", buyer: h.party("bob"), entryId: entry });
    // The first saga is in flight: its entry is locked.
    expect(
      await h.shop("p1").buy({ opId: "buy-bob-slow2", buyer: h.party("bob"), entryId: entry }),
    ).toMatchObject({ ok: false, code: "busy" });
    expect(
      await h.shop("p1").unstock({ opId: "unstock-al-slow", accountId: "alice", entryId: entry }),
    ).toMatchObject({ ok: false, code: "busy" });
    release();
    const done = await first;
    expect(done.ok).toBe(true);
    h.gw.hook = null;
  });

  it("a lease close waits for an in-flight sale, then returns only the unsold stock", async () => {
    const h = new Harness();
    const items = await openShop(h, ["axe", "bow"], 300);
    h.gw.seed("bob", { coin: 1000 });
    const entries = (await h.shop("p1").view(null))!.stock;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.gw.hook = async (accountId, txId) => {
      if (accountId === "bob" && txId.includes(":buy:")) await gate;
    };
    const sale = h
      .shop("p1")
      .buy({ opId: "buy-bob-close1", buyer: h.party("bob"), entryId: entries[0]!.entryId });
    const closing = h.shop("p1").closeLease({ leaseId: `classic-town/p1/1`, reason: "ended" });
    release();
    await sale;
    await closing;
    h.gw.hook = null;
    // Bob got the axe; alice got the unsold bow back and the proceeds.
    expect(h.gw.vault("bob").map((i) => i.itemId)).toEqual([items[0]!.itemId]);
    expect(h.gw.vault("alice").map((i) => i.itemId)).toEqual([items[1]!.itemId]);
    expect(await h.shop("p1").view(null)).toBeNull();
  });

  it("re-drives a sale after the buyer debit throws (crash before any effect)", async () => {
    const h = new Harness();
    await openShop(h, ["axe"], 300);
    h.gw.seed("bob", { coin: 1000 });
    const entry = (await h.shop("p1").view(null))!.stock[0]!.entryId;
    h.gw.failNext("walletTx", "throw", { txId: /:buy:/ });
    const first = await h
      .shop("p1")
      .buy({ opId: "buy-bob-crash1", buyer: h.party("bob"), entryId: entry });
    expect(first).toMatchObject({ ok: false, code: "unavailable" });
    // The saga is still pending; the alarm (drive) finishes it exactly once.
    await h.shop("p1").drive();
    expect(h.gw.balance("bob")).toBe(700);
    expect(h.gw.vault("bob")).toHaveLength(1);
    const replay = await h
      .shop("p1")
      .buy({ opId: "buy-bob-crash1", buyer: h.party("bob"), entryId: entry });
    expect(replay.ok && replay.replayed).toBe(true);
    expect(h.gw.balance("bob")).toBe(700);
  });

  it("re-drives after a lost reply of the delivery: the item is delivered exactly once", async () => {
    const h = new Harness();
    await openShop(h, ["axe"], 300);
    h.gw.seed("bob", { coin: 1000 });
    const entry = (await h.shop("p1").view(null))!.stock[0]!.entryId;
    h.gw.failNext("vaultPut", "throwAfter", { txId: /:deliver:/ });
    const first = await h
      .shop("p1")
      .buy({ opId: "buy-bob-lost1", buyer: h.party("bob"), entryId: entry });
    expect(first.ok).toBe(false);
    await h.shop("p1").drive();
    expect(h.gw.vault("bob")).toHaveLength(1);
    expect(h.gw.balance("bob")).toBe(700);
    // The owner claims: the sale's proceeds and tax settle, and every coin is accounted for.
    expect((await h.shop("p1").claim({ opId: "claim-lost-0001", accountId: "alice" })).ok).toBe(
      true,
    );
    expect(conserved(h, 100 + 1000)).toBe(true);
  });

  it("re-drives a stock whose vault take was lost, so the item is not duplicated", async () => {
    const h = new Harness();
    h.gw.seed("alice", { coin: 100 });
    await h.plots.bid({
      opId: "bid-alice-crash",
      bidder: h.party("alice"),
      plotId: "p1",
      amount: 100,
    });
    h.clock.advance(PLOT_AUCTION_MS);
    await h.plots.plots();
    const [axe] = h.gw.seed("alice", { items: [testItem("axe")] });
    h.gw.failNext("vaultTake", "throw", { txId: /:stock:/ });
    const r = await h
      .shop("p1")
      .stock({ opId: "stock-crash-01", accountId: "alice", uid: axe!.uid, price: 40 });
    expect(r).toMatchObject({ ok: false, code: "unavailable" });
    // The alarm re-drives the saga: the item leaves the vault exactly once and reaches the shelf.
    await h.shop("p1").drive();
    expect((await h.shop("p1").view(null))!.stock).toHaveLength(1);
    expect(h.gw.vault("alice")).toHaveLength(0);
    // A retry with the same opId answers the stored outcome, no second take.
    const retry = await h
      .shop("p1")
      .stock({ opId: "stock-crash-01", accountId: "alice", uid: axe!.uid, price: 40 });
    expect(retry.ok && retry.replayed).toBe(true);
    expect((await h.shop("p1").view(null))!.stock).toHaveLength(1);
  });
});

describe("ShopBook: lease open, close and idempotency", () => {
  it("openLease and closeLease are idempotent by leaseId", async () => {
    const h = new Harness();
    const shop = h.shop("p1");
    await shop.openLease({ ...LEASE_OPEN, owner: h.party("alice"), endsAt: 1 });
    await shop.openLease({ ...LEASE_OPEN, owner: h.party("alice"), endsAt: 1 });
    expect((await shop.fixture())?.owner.accountId).toBe("alice");
    await shop.closeLease({ leaseId: LEASE_OPEN.leaseId, reason: "ended" });
    await shop.closeLease({ leaseId: LEASE_OPEN.leaseId, reason: "ended" });
    // A late open for the same lease does nothing after it closed.
    await shop.openLease({ ...LEASE_OPEN, owner: h.party("alice"), endsAt: 1 });
    expect(await shop.view(null)).toBeNull();
  });

  it("closeLease for another lease id is ignored", async () => {
    const h = new Harness();
    await openShop(h, ["axe"], 300);
    await h.shop("p1").closeLease({ leaseId: "classic-town/p1/999", reason: "ended" });
    expect((await h.shop("p1").view(null))!.stock).toHaveLength(1);
  });

  it("refuses a lease for another plot", async () => {
    const h = new Harness();
    await expect(
      h.shop("p1").openLease({
        leaseId: "x",
        world: "classic-town",
        plotId: "p2",
        owner: h.party("alice"),
        endsAt: 1,
      }),
    ).rejects.toThrow(/sent to/);
  });
});
