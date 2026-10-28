import {
  PLOT_AUCTION_MS,
  PLOT_LEASE_MS,
  RENT_GRACE_MS,
  RENT_PERIOD_MS,
  RENT_RETRY_MS,
} from "@gamez/economy";
import { describe, expect, it } from "vite-plus/test";
import { shopFixtureId } from "../../src/shared/plots.ts";
import { testItem } from "../support/fake-gateway.ts";
import { Harness, WORLD, touched } from "./support.ts";

const alice = (h: Harness) => h.party("alice", "Alice");
const bob = (h: Harness) => h.party("bob", "Bob");

/** Lets the plot's auction run out (drives the book). */
async function endAuction(h: Harness): Promise<void> {
  h.clock.advance(PLOT_AUCTION_MS);
  await h.plots.plots();
}

describe("PlotBook: auction and lease start", () => {
  it("starts one auction per plot of the world", async () => {
    const h = new Harness();
    const plots = await h.plots.plots();
    expect(plots.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
    for (const p of plots) {
      expect(p.state).toBe("auction");
      expect(p.auction?.endsAt).toBe(h.clock.now() + PLOT_AUCTION_MS);
      expect(p.auction?.minBid).toBe(100);
    }
  });

  it("refuses bids below the minimum and unknown plots", async () => {
    const h = new Harness();
    gwSeed(h, "alice", 1000);
    const low = await h.plots.bid({
      opId: "bid-low-0001",
      bidder: alice(h),
      plotId: "p1",
      amount: 99,
    });
    expect(low).toMatchObject({ ok: false, code: "too_low" });
    const nope = await h.plots.bid({
      opId: "bid-nope-0001",
      bidder: alice(h),
      plotId: "p9",
      amount: 100,
    });
    expect(nope).toMatchObject({ ok: false, code: "not_found" });
    const bad = await h.plots.bid({
      opId: "bid-frac-0001",
      bidder: alice(h),
      plotId: "p1",
      amount: 100.5,
    });
    expect(bad).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("leases to the top bidder at the end, with rent and a prepaid first period", async () => {
    const h = new Harness();
    gwSeed(h, "alice", 1000);
    const r = await h.plots.bid({
      opId: "bid-alice-0001",
      bidder: alice(h),
      plotId: "p1",
      amount: 100,
    });
    expect(r.ok).toBe(true);
    expect(h.gw.balance("alice")).toBe(900);
    await endAuction(h);
    const p1 = (await h.plots.plots()).find((p) => p.id === "p1")!;
    expect(p1.state).toBe("leased");
    expect(p1.lease?.owner.accountId).toBe("alice");
    expect(p1.lease?.endsAt).toBe(h.clock.now() + PLOT_LEASE_MS);
    expect(p1.lease?.rent).toBe(20);
    expect(p1.lease?.paidUntil).toBe(h.clock.now() + RENT_PERIOD_MS);
    // The winning bid is burnt: a sink, nothing refunded.
    expect(h.gw.sunk(["alice"])).toBe(100);
    expect(h.gw.noticesOf("alice").notices.map((n) => n.kind)).toContain("plot.won");
    expect(h.gw.balance("alice")).toBe(900);
  });

  it("restarts the auction when nobody bid", async () => {
    const h = new Harness();
    await endAuction(h);
    const p = (await h.plots.plots()).find((x) => x.id === "p2")!;
    expect(p.state).toBe("auction");
    expect(p.auction?.topBid).toBeNull();
    expect(p.auction?.endsAt).toBe(h.clock.now() + PLOT_AUCTION_MS);
  });

  it("refunds the outbid bidder in full and keeps only the top bid as sink", async () => {
    const h = new Harness();
    gwSeed(h, "alice", 500);
    gwSeed(h, "bob", 500);
    await h.plots.bid({ opId: "bid-alice-0002", bidder: alice(h), plotId: "p3", amount: 100 });
    // Next minimum after 100 is 100 + max(1, 5 %) = 105.
    const short = await h.plots.bid({
      opId: "bid-bob-00000a",
      bidder: bob(h),
      plotId: "p3",
      amount: 104,
    });
    expect(short).toMatchObject({ ok: false, code: "too_low" });
    const r = await h.plots.bid({
      opId: "bid-bob-00000b",
      bidder: bob(h),
      plotId: "p3",
      amount: 105,
    });
    expect(r.ok).toBe(true);
    expect(h.gw.balance("alice")).toBe(500);
    expect(h.gw.balance("bob")).toBe(395);
    expect(h.gw.noticesOf("alice").notices.map((n) => n.kind)).toContain("plot.outbid");
    await endAuction(h);
    expect(h.gw.sunk(["alice", "bob"])).toBe(105);
    // Conservation: balances plus sinks equal what was seeded.
    expect(h.gw.totalCoin(touched(h)) + h.gw.sunk(touched(h))).toBe(1000);
  });

  it("enforces one plot per account (leases, top bids and in-flight bids)", async () => {
    const h = new Harness();
    gwSeed(h, "alice", 1000);
    await h.plots.bid({ opId: "bid-alice-0003", bidder: alice(h), plotId: "p4", amount: 100 });
    const second = await h.plots.bid({
      opId: "bid-alice-0004",
      bidder: alice(h),
      plotId: "p5",
      amount: 100,
    });
    expect(second).toMatchObject({ ok: false, code: "too_many" });
    // Raising the bid on the same plot is still allowed.
    const raise = await h.plots.bid({
      opId: "bid-alice-0005",
      bidder: alice(h),
      plotId: "p4",
      amount: 105,
    });
    expect(raise.ok).toBe(true);
  });

  it("answers a replayed bid opId with the first result (no second debit)", async () => {
    const h = new Harness();
    gwSeed(h, "alice", 1000);
    const first = await h.plots.bid({
      opId: "bid-alice-0006",
      bidder: alice(h),
      plotId: "p6",
      amount: 100,
    });
    const again = await h.plots.bid({
      opId: "bid-alice-0006",
      bidder: alice(h),
      plotId: "p6",
      amount: 100,
    });
    expect(first.ok && again.ok).toBe(true);
    expect(again.ok && again.replayed).toBe(true);
    expect(h.gw.balance("alice")).toBe(900);
  });

  it("rejects a bid the bidder cannot afford without changing the auction", async () => {
    const h = new Harness();
    gwSeed(h, "alice", 50);
    const r = await h.plots.bid({
      opId: "bid-alice-0007",
      bidder: alice(h),
      plotId: "p7",
      amount: 100,
    });
    expect(r).toMatchObject({ ok: false, code: "insufficient_funds" });
    const p = (await h.plots.plots()).find((x) => x.id === "p7")!;
    expect(p.auction?.topBid).toBeNull();
    expect(h.gw.balance("alice")).toBe(50);
  });
});

describe("PlotBook: rent, grace, repossession", () => {
  it("charges rent at paidUntil as a sink", async () => {
    const h = new Harness();
    gwSeed(h, "bob", 1000);
    await h.plots.bid({ opId: "bid-bob-rent01", bidder: bob(h), plotId: "p2", amount: 100 });
    await endAuction(h);
    h.clock.advance(RENT_PERIOD_MS);
    const p = (await h.plots.plots()).find((x) => x.id === "p2")!;
    expect(p.state).toBe("leased");
    expect(h.gw.balance("bob")).toBe(1000 - 100 - 20);
    expect(h.gw.sunk(["bob"])).toBe(120);
    expect(p.lease?.paidUntil).toBe(h.clock.now() + RENT_PERIOD_MS);
  });

  it("full cycle: auction, lease, unpaid rent, grace, repossession (stock and earnings returned), new auction", async () => {
    const h = new Harness();
    // Alice spends everything on the bid: rent cannot be paid.
    gwSeed(h, "alice", 100);
    const [sword] = h.gw.seed("alice", { items: [itemOf("sword")] }) ?? [];
    expect(sword).toBeDefined();
    await h.plots.bid({ opId: "bid-alice-cycle", bidder: alice(h), plotId: "p1", amount: 100 });
    await endAuction(h);
    expect(h.gw.balance("alice")).toBe(0);

    // Shop: stock the sword at 50 and open it.
    const shop = h.shop("p1");
    const stocked = await shop.stock({
      opId: "stock-cycle-01",
      accountId: "alice",
      uid: sword!.uid,
      price: 50,
    });
    expect(stocked.ok).toBe(true);
    const opened = await shop.configure({ accountId: "alice", open: true });
    expect(opened.ok).toBe(true);
    expect(h.gw.vault("alice").length).toBe(0);

    // Rent period ends unpaid: grace starts.
    h.clock.advance(RENT_PERIOD_MS);
    let p1 = (await h.plots.plots()).find((x) => x.id === "p1")!;
    expect(p1.state).toBe("grace");
    expect(p1.lease?.graceUntil).toBe(h.clock.now() + RENT_GRACE_MS);
    expect(h.gw.noticesOf("alice").notices.map((n) => n.kind)).toContain("shop.rent_due");
    // Still in grace while retries fail (retries every RENT_RETRY_MS).
    h.clock.advance(RENT_RETRY_MS * 3);
    p1 = (await h.plots.plots()).find((x) => x.id === "p1")!;
    expect(p1.state).toBe("grace");

    // Grace over: repossessed.
    h.clock.advance(RENT_GRACE_MS);
    p1 = (await h.plots.plots()).find((x) => x.id === "p1")!;
    expect(p1.state).toBe("auction");
    expect(p1.lease).toBeNull();
    expect(p1.auction?.endsAt).toBe(h.clock.now() + PLOT_AUCTION_MS);
    // Stock came back to the vault, with the same item.
    const back = h.gw.vault("alice");
    expect(back.map((i) => i.itemId)).toEqual([sword!.itemId]);
    expect(h.gw.noticesOf("alice").notices.map((n) => n.kind)).toContain("shop.repossessed");
    // The shop is closed on the ShopDO side too.
    expect(await h.shop("p1").view(null)).toBeNull();
    // Nothing was paid for the rent.
    expect(h.gw.sunk(["alice"])).toBe(100);
  });

  it("a payment during grace returns the plot to leased without a second charge at once", async () => {
    const h = new Harness();
    gwSeed(h, "alice", 100);
    await h.plots.bid({ opId: "bid-alice-grace1", bidder: alice(h), plotId: "p1", amount: 100 });
    await endAuction(h);
    h.clock.advance(RENT_PERIOD_MS);
    expect((await h.plots.plots()).find((x) => x.id === "p1")!.state).toBe("grace");
    // Alice tops up: the next retry pays the rent.
    gwSeed(h, "alice", 20);
    h.clock.advance(RENT_RETRY_MS);
    const p1 = (await h.plots.plots()).find((x) => x.id === "p1")!;
    expect(p1.state).toBe("leased");
    expect(p1.lease?.graceUntil).toBeNull();
    expect(p1.lease!.paidUntil - h.clock.now()).toBeGreaterThan(RENT_PERIOD_MS - RENT_RETRY_MS - 1);
    expect(h.gw.balance("alice")).toBe(0);
  });

  it("the lease end closes the shop, returns stock and starts a new auction", async () => {
    const h = new Harness();
    gwSeed(h, "bob", 100_000);
    const [sword] = h.gw.seed("bob", { items: [itemOf("axe")] }) ?? [];
    await h.plots.bid({ opId: "bid-bob-lease01", bidder: bob(h), plotId: "p5", amount: 100 });
    await endAuction(h);
    await h.shop("p5").configure({ accountId: "bob", name: "Bob's Axes", open: true });
    await h
      .shop("p5")
      .stock({ opId: "stock-bob-lease1", accountId: "bob", uid: sword!.uid, price: 70 });
    h.clock.advance(PLOT_LEASE_MS + 1);
    const p5 = (await h.plots.plots()).find((x) => x.id === "p5")!;
    expect(p5.state).toBe("auction");
    expect(h.gw.vault("bob").map((i) => i.itemId)).toEqual([sword!.itemId]);
    expect(h.gw.noticesOf("bob").notices.map((n) => n.kind)).toContain("shop.lease_ended");
  });

  it("rent is charged once per missed period when the clock jumps over several", async () => {
    const h = new Harness();
    gwSeed(h, "bob", 1000);
    await h.plots.bid({ opId: "bid-bob-multi1", bidder: bob(h), plotId: "p8", amount: 100 });
    await endAuction(h);
    h.clock.advance(RENT_PERIOD_MS * 3 + 1);
    await h.plots.plots();
    expect(h.gw.balance("bob")).toBe(1000 - 100 - 3 * 20);
  });
});

describe("PlotBook: fixtures and index", () => {
  it("pushes one shopkeeper fixture per leased plot, tagged with owner and state", async () => {
    const h = new Harness();
    gwSeed(h, "alice", 1000);
    await h.plots.bid({ opId: "bid-alice-fix01", bidder: alice(h), plotId: "p1", amount: 100 });
    await endAuction(h);
    // A new lease shows its shopkeeper at once, closed until the owner opens it.
    expect(h.chunk.shops().map((f) => f.tag)).toEqual(["Alice · Closed"]);
    await h.shop("p1").configure({
      accountId: "alice",
      name: "Alice's Wares",
      appearance: "unit.hero.blue",
      open: true,
    });
    const [f] = h.chunk.shops();
    expect(f).toEqual({
      id: shopFixtureId("p1"),
      kind: "shopkeeper",
      name: "Alice's Wares",
      appearance: "unit.hero.blue",
      pos: { x: 46, y: 33 },
      path: [],
      pathStartedAt: 0,
      speed: 0,
      tag: "Alice · Open",
    });
    await h.shop("p1").configure({ accountId: "alice", open: false });
    expect(h.chunk.shops()[0]?.tag).toBe("Alice · Closed");
  });

  it("writes a shop_index outbox row for each plot change", async () => {
    const h = new Harness();
    gwSeed(h, "alice", 1000);
    await h.plots.bid({ opId: "bid-alice-idx01", bidder: alice(h), plotId: "p1", amount: 100 });
    await endAuction(h);
    const rows = h.outboxRows("shop_index").filter((r) => r.pk === `${WORLD}/p1`);
    expect(rows.length).toBeGreaterThan(0);
    const last = rows.at(-1)!;
    expect((last.payload as { plot: { state: string } }).plot.state).toBe("leased");
  });

  it("devAdvance moves the clock forward and runs the due work", async () => {
    const h = new Harness();
    gwSeed(h, "alice", 1000);
    await h.plots.bid({ opId: "bid-alice-dev01", bidder: alice(h), plotId: "p3", amount: 100 });
    const plots = await h.plots.devAdvance(PLOT_AUCTION_MS);
    expect(plots.find((p) => p.id === "p3")!.state).toBe("leased");
    expect(h.plots.nextWakeAt()).not.toBeNull();
  });
});

// ---- helpers -----------------------------------------------------------------

function gwSeed(h: Harness, accountId: string, coin: number): void {
  h.gw.seed(accountId, { coin });
}

function itemOf(name: string) {
  return testItem(name);
}
