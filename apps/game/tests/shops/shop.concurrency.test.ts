/**
 * ADR 0007 R6: a shop buy saga driven twice at once (two identical POST /buy and
 * the alarm's drive()) must book the sale exactly once. The deliver call is held
 * open so every driver reaches it before any of them books.
 */
import { PLOT_AUCTION_MS, shopTax } from "@gamez/economy";
import { describe, expect, it } from "vite-plus/test";
import { testItem } from "../support/fake-gateway.ts";
import { Harness, touched } from "./support.ts";

const PRICE = 1_000;

/** Alice leases p1, stocks one item at PRICE and opens; bob has PRICE coin. */
async function setup(): Promise<{ h: Harness; entryId: string }> {
  const h = new Harness();
  h.gw.seed("alice", { coin: 100 });
  await h.plots.bid({
    opId: "bid-alice-conc1",
    bidder: h.party("alice", "Alice"),
    plotId: "p1",
    amount: 100,
  });
  h.clock.advance(PLOT_AUCTION_MS);
  await h.plots.plots();
  const [item] = h.gw.seed("alice", { items: [testItem("relic")] });
  const r = await h.shop("p1").stock({
    opId: "stock-alice-conc1",
    accountId: "alice",
    uid: item!.uid,
    price: PRICE,
  });
  expect(r.ok).toBe(true);
  await h.shop("p1").configure({ accountId: "alice", open: true });
  h.gw.seed("bob", { coin: PRICE });
  const v = await h.shop("p1").view("bob");
  return { h, entryId: v!.stock[0]!.entryId };
}

/** Holds every deliver vaultPut until release(); returns how many were held. */
function holdDeliveries(h: Harness): { release: () => void; held: () => number } {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let held = 0;
  h.gw.putHook = async (_acc, txId) => {
    if (!txId.includes(":deliver:")) return;
    held += 1;
    await gate;
  };
  return { release: () => open(), held: () => held };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("ShopBook: concurrent drives of one buy saga (R6)", () => {
  it("two identical buys plus a drive() book gross and tax once, debit once, deliver once", async () => {
    const { h, entryId } = await setup();
    const shop = h.shop("p1");
    const hold = holdDeliveries(h);
    const bob = h.party("bob", "Bob");
    const a = shop.buy({ opId: "buy-bob-conc-01", buyer: bob, entryId });
    await settle();
    const b = shop.buy({ opId: "buy-bob-conc-01", buyer: bob, entryId });
    await settle();
    const d = shop.drive();
    await settle();
    // One driver: the repeated request and drive() joined the running saga.
    expect(hold.held()).toBe(1);
    hold.release();
    const [ra, rb] = await Promise.all([a, b, d]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);

    expect(h.gw.balance("bob")).toBe(0);
    expect(h.gw.vault("bob").map((i) => i.summary.name)).toEqual(["relic"]);
    const view = await shop.view("alice");
    expect(view!.stock).toHaveLength(0);
    expect(view!.earnings).toBe(PRICE - shopTax(PRICE));
    expect(h.outboxRows("economy_sale")).toHaveLength(1);

    // The claim pays exactly price - tax, once.
    const before = h.gw.balance("alice");
    const c = await shop.claim({ opId: "claim-alice-conc1", accountId: "alice" });
    expect(c.ok).toBe(true);
    expect(h.gw.balance("alice") - before).toBe(PRICE - shopTax(PRICE));
    const again = await shop.claim({ opId: "claim-alice-conc2", accountId: "alice" });
    expect(again.ok).toBe(true);
    expect(h.gw.balance("alice") - before).toBe(PRICE - shopTax(PRICE));
    // Coin is conserved: 100 + PRICE seeded, the plot bid and the tax were burnt.
    expect(h.gw.totalCoin(touched(h)) + h.gw.sunk(touched(h))).toBe(100 + PRICE);
  });

  it("a second driver without the in-memory lock (stale step) books nothing", async () => {
    const { h, entryId } = await setup();
    const shop = h.shop("p1");
    const twin = h.shopTwin("p1");
    const hold = holdDeliveries(h);
    const bob = h.party("bob", "Bob");
    const a = shop.buy({ opId: "buy-bob-conc-02", buyer: bob, entryId });
    await settle();
    // The twin (as after an eviction race) drives the same pending op.
    const d = twin.drive();
    await settle();
    expect(hold.held()).toBe(2);
    hold.release();
    const [ra] = await Promise.all([a, d]);
    expect(ra.ok).toBe(true);

    expect(h.gw.balance("bob")).toBe(0);
    expect(h.gw.vault("bob")).toHaveLength(1);
    const view = await shop.view("alice");
    expect(view!.earnings).toBe(PRICE - shopTax(PRICE));
    expect(h.outboxRows("economy_sale")).toHaveLength(1);
    const before = h.gw.balance("alice");
    await shop.claim({ opId: "claim-alice-conc3", accountId: "alice" });
    expect(h.gw.balance("alice") - before).toBe(PRICE - shopTax(PRICE));
  });

  it("a debit refused with conflict (txId reused with other params) fails and frees the entry", async () => {
    const { h, entryId } = await setup();
    const shop = h.shop("p1");
    h.gw.failNext("walletTx", { code: "conflict" }, { accountId: "bob" });
    const r = await shop.buy({ opId: "buy-bob-conc-03", buyer: h.party("bob"), entryId });
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(h.gw.balance("bob")).toBe(PRICE);
    expect(shop.nextWakeAt()).toBeNull();
    // The entry is back on the shelf and a fresh purchase goes through.
    const ok = await shop.buy({ opId: "buy-bob-conc-04", buyer: h.party("bob"), entryId });
    expect(ok.ok).toBe(true);
    expect(h.gw.vault("bob")).toHaveLength(1);
  });
});
