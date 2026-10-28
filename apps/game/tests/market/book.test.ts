/** MarketBook rules (wave-C.md §4): list, bid, buy, expiry, cancel, busy lock, crash re-drive, conservation. OWNER: T-market. */
import { describe, expect, it } from "vite-plus/test";
import { listingFee, salesTax } from "@gamez/economy";
import type { MarketListing, VaultItem, VaultItemInput } from "@gamez/protocol";
import { RESUME_AFTER_MS, RETRY_MS } from "../../src/server/market/book.ts";
import {
  assertConserved,
  harness,
  HOUR,
  item,
  MINUTE,
  opId,
  party,
  SHARD,
  viewOf,
  type Harness,
} from "./harness.ts";

const S = "acc-seller";
const B = "acc-bidder";
const C = "acc-carol";

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Gives `accountId` coin and one item; returns the vault uid of the item. */
function give(h: Harness, accountId: string, coin: number, it: VaultItemInput = item()): string {
  const [granted] = h.accounts.grant(accountId, coin, [it]);
  return (granted as VaultItem).uid;
}

async function listOne(
  h: Harness,
  seller: string,
  uid: string,
  over: { buyout?: number | null; startBid?: number | null; durationH?: number } = {},
) {
  return h.book.list({
    opId: opId("list"),
    seller: party(seller),
    uid,
    buyout: over.buyout === undefined ? 1000 : over.buyout,
    startBid: over.startBid ?? null,
    durationH: over.durationH ?? 12,
  });
}

/** A listed item (seller has `coin`); returns the listing id. */
async function listed(
  h: Harness,
  over: {
    buyout?: number | null;
    startBid?: number | null;
    durationH?: number;
    coin?: number;
  } = {},
): Promise<string> {
  const uid = give(h, S, over.coin ?? 1000);
  const res = await listOne(h, S, uid, over);
  if (!res.ok) throw new Error(`list failed: ${res.code} ${res.message}`);
  return res.value.id;
}

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

describe("list", () => {
  it("lists an eligible item: the fee is a sink and the item moves into custody", async () => {
    const h = harness();
    const uid = give(h, S, 1000);
    const res = await listOne(h, S, uid, { buyout: 1000 });
    expect(res.ok).toBe(true);
    const l = viewOf(res.ok ? res.value : null);
    expect(l.id).toBe(`${SHARD}/1`);
    expect(l.status).toBe("active");
    expect(l.fee).toBe(listingFee(1000, null));
    expect(l.fee).toBe(20);
    expect(l.endsAt - h.clock.now()).toBe(12 * HOUR);
    expect(l.item.summary.name).toBe("Ember Blade");
    expect("data" in l.item).toBe(false);
    expect(h.accounts.coin(S)).toBe(980);
    expect(h.accounts.sinkNet()).toBe(20);
    expect(h.accounts.vaultOf(S)).toHaveLength(0);
    assertConserved(h, [l.id], 1000, 1);
  });

  it("publishes the listing to the outbox once it is active", async () => {
    const h = harness();
    const uid = give(h, S, 1000);
    await listOne(h, S, uid, { buyout: 1000 });
    const rows = h.outbox.pending(100).filter((r) => r.table === "market_listing");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pk).toBe(`${SHARD}/1`);
    expect((rows[0]!.payload as { listing: MarketListing }).listing.status).toBe("active");
  });

  it("a retried list with the same opId replays and charges the fee once", async () => {
    const h = harness();
    const uid = give(h, S, 1000);
    const key = opId("list");
    const args = { opId: key, seller: party(S), uid, buyout: 1000, startBid: null, durationH: 12 };
    const first = await h.book.list(args);
    const again = await h.book.list(args);
    expect(first.ok && again.ok).toBe(true);
    expect(again.ok && again.replayed).toBe(true);
    expect(again.ok && again.value.id).toBe(first.ok ? first.value.id : "");
    expect(h.accounts.coin(S)).toBe(980);
    expect(h.accounts.sinkNet()).toBe(20);
  });

  it("the same opId for a different request is a conflict", async () => {
    const h = harness();
    const uid = give(h, S, 1000);
    const key = opId("list");
    await h.book.list({
      opId: key,
      seller: party(S),
      uid,
      buyout: 1000,
      startBid: null,
      durationH: 12,
    });
    const other = await h.book.list({
      opId: key,
      seller: party(S),
      uid,
      buyout: 900,
      startBid: null,
      durationH: 12,
    });
    expect(other).toMatchObject({ ok: false, code: "conflict" });
  });

  it("refuses bad requests before any money moves", async () => {
    const h = harness();
    const uid = give(h, S, 1000);
    const cases = [
      { buyout: null, startBid: null, durationH: 12 },
      { buyout: 1000, startBid: 2000, durationH: 12 },
      { buyout: 0, startBid: null, durationH: 12 },
      { buyout: 1.5, startBid: null, durationH: 12 },
      { buyout: 1000, startBid: null, durationH: 5 },
    ];
    for (const c of cases) {
      const res = await h.book.list({ opId: opId(), seller: party(S), uid, ...c });
      expect(res).toMatchObject({ ok: false, code: "bad_request" });
    }
    const badOp = await h.book.list({
      opId: "short",
      seller: party(S),
      uid,
      buyout: 1000,
      startBid: null,
      durationH: 12,
    });
    expect(badOp).toMatchObject({ ok: false, code: "bad_request" });
    expect(h.accounts.coin(S)).toBe(1000);
    expect(h.accounts.vaultOf(S)).toHaveLength(1);
  });

  it("refuses an item that is not tradable or not eligible, and charges no fee", async () => {
    const h = harness();
    const notTradable = give(h, S, 1000, item({ tradable: false }));
    expect(await listOne(h, S, notTradable)).toMatchObject({ ok: false, code: "not_tradable" });
    const low = give(h, S, 0, item({}, { level: 5 }));
    expect(await listOne(h, S, low)).toMatchObject({ ok: false, code: "not_eligible" });
    expect(h.accounts.coin(S)).toBe(1000);
    expect(h.accounts.sinkNet()).toBe(0);
    expect(h.accounts.vaultOf(S)).toHaveLength(2);
  });

  it("an unknown uid is not_found", async () => {
    const h = harness();
    expect(await listOne(h, S, "nope")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("an item of another origin is refused by this shard", async () => {
    const h = harness("universal:weapon");
    const uid = give(h, S, 1000);
    expect(await listOne(h, S, uid)).toMatchObject({ ok: false, code: "wrong_origin" });
    expect(h.accounts.coin(S)).toBe(1000);
  });

  it("an insufficient fee leaves the item in the vault and no listing behind", async () => {
    const h = harness();
    const uid = give(h, S, 5);
    expect(await listOne(h, S, uid, { buyout: 1000 })).toMatchObject({
      ok: false,
      code: "insufficient_funds",
    });
    expect(h.book.get(`${SHARD}/1`)).toBeNull();
    expect(h.accounts.vaultOf(S)).toHaveLength(1);
    expect(h.accounts.coin(S)).toBe(5);
  });

  it("an item gone between the check and the take refunds the fee", async () => {
    const h = harness();
    const uid = give(h, S, 1000);
    h.accounts.before = (c) => {
      if (c.op === "walletTx" && c.txId?.endsWith(":fee")) h.accounts.vaults.get(S)?.delete(uid);
    };
    const res = await listOne(h, S, uid, { buyout: 1000 });
    h.accounts.before = null;
    expect(res).toMatchObject({ ok: false, code: "not_found" });
    expect(h.accounts.coin(S)).toBe(1000);
    expect(h.accounts.sinkNet()).toBe(0);
    expect(h.book.get(`${SHARD}/1`)).toBeNull();
    assertConserved(h, [], 1000, 0);
  });

  it("a seller has at most 20 active listings per shard", async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) {
      const uid = give(h, S, 100);
      expect((await listOne(h, S, uid, { buyout: 100 })).ok).toBe(true);
    }
    const uid = give(h, S, 100);
    expect(await listOne(h, S, uid, { buyout: 100 })).toMatchObject({
      ok: false,
      code: "too_many",
    });
  });
});

describe("bid", () => {
  it("the first bid must meet the start bid and is held in custody", async () => {
    const h = harness();
    const id = await listed(h, { buyout: null, startBid: 100 });
    h.accounts.grant(B, 500);
    expect(
      await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 99 }),
    ).toMatchObject({
      ok: false,
      code: "too_low",
    });
    const res = await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 100 });
    expect(res.ok).toBe(true);
    const l = viewOf(res.ok ? res.value : null);
    expect(l.topBid).toBe(100);
    expect(l.topBidder?.accountId).toBe(B);
    expect(l.bids).toBe(1);
    expect(h.accounts.coin(B)).toBe(400);
    assertConserved(h, [id], 1500, 1);
  });

  it("the next bid must beat the top bid by 5 percent", async () => {
    const h = harness();
    const id = await listed(h, { buyout: null, startBid: 100 });
    h.accounts.grant(B, 500);
    h.accounts.grant(C, 500);
    await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 100 });
    const low = await h.book.bid({ opId: opId(), bidder: party(C), listingId: id, amount: 104 });
    expect(low).toMatchObject({ ok: false, code: "too_low" });
    expect(low.ok === false && low.message).toContain("105");
    expect(
      (await h.book.bid({ opId: opId(), bidder: party(C), listingId: id, amount: 105 })).ok,
    ).toBe(true);
  });

  it("outbid: the previous top bidder is refunded and told", async () => {
    const h = harness();
    const id = await listed(h, { buyout: null, startBid: 100 });
    h.accounts.grant(B, 500);
    h.accounts.grant(C, 500);
    await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 100 });
    await h.book.bid({ opId: opId(), bidder: party(C), listingId: id, amount: 110 });
    expect(h.accounts.coin(B)).toBe(500);
    expect(h.accounts.coin(C)).toBe(390);
    const notice = h.accounts.noticesOf(B).find((n) => n.kind === "market.outbid");
    expect(notice?.id).toBe(`market:${id}:outbid:1`);
    expect(viewOf(h.book.get(id)).topBidder?.accountId).toBe(C);
    assertConserved(h, [id], 2000, 1);
  });

  it("the seller cannot bid on its own listing", async () => {
    const h = harness();
    const id = await listed(h, { buyout: null, startBid: 100 });
    expect(
      await h.book.bid({ opId: opId(), bidder: party(S), listingId: id, amount: 100 }),
    ).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("a bid in the last 5 minutes moves the end to 5 minutes from now", async () => {
    const h = harness();
    const id = await listed(h, { buyout: null, startBid: 100, durationH: 12 });
    h.accounts.grant(B, 500);
    h.clock.advance(12 * HOUR - 2 * MINUTE);
    const res = await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 100 });
    expect(viewOf(res.ok ? res.value : null).endsAt).toBe(h.clock.now() + 5 * MINUTE);
  });

  it("a bid with more than 5 minutes left leaves the end alone", async () => {
    const h = harness();
    const id = await listed(h, { buyout: null, startBid: 100, durationH: 12 });
    h.accounts.grant(B, 500);
    const before = viewOf(h.book.get(id)).endsAt;
    h.clock.advance(HOUR);
    const res = await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 100 });
    expect(viewOf(res.ok ? res.value : null).endsAt).toBe(before);
  });

  it("a bid after the end is refused as expired", async () => {
    const h = harness();
    const id = await listed(h, { buyout: null, startBid: 100, durationH: 12 });
    h.accounts.grant(B, 500);
    h.clock.advance(12 * HOUR);
    expect(
      await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 100 }),
    ).toMatchObject({
      ok: false,
      code: "expired",
    });
  });

  it("a bid at or above the buyout buys the item", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000, startBid: 100 });
    h.accounts.grant(B, 2000);
    const res = await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 1200 });
    expect(res.ok).toBe(true);
    const l = viewOf(res.ok ? res.value : null);
    expect(l.status).toBe("sold");
    expect(l.soldFor).toBe(1000);
    expect(h.accounts.coin(B)).toBe(1000);
    expect(h.accounts.vaultOf(B)).toHaveLength(1);
    assertConserved(h, [id], 3000, 1);
  });

  it("a buy-only listing refuses bids below the buyout", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000, startBid: null });
    h.accounts.grant(B, 2000);
    expect(
      await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 500 }),
    ).toMatchObject({
      ok: false,
      code: "too_low",
    });
  });
});

describe("buy", () => {
  it("a buyout moves the item and pays the seller net of tax and fee", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    h.accounts.grant(B, 2000);
    const res = await h.book.buy({ opId: opId(), buyer: party(B), listingId: id });
    expect(res.ok).toBe(true);
    const l = viewOf(res.ok ? res.value : null);
    expect(l.status).toBe("sold");
    expect(l.soldFor).toBe(1000);
    expect(l.topBidder?.accountId).toBe(B);
    expect(h.accounts.coin(B)).toBe(1000);
    // 1000 (sale) - 50 (5 % tax) - 20 (2 % fee, paid at listing) + the 1000 they listed with, less the fee.
    expect(h.accounts.coin(S)).toBe(1000 - 20 + 1000 - salesTax(1000));
    expect(h.accounts.sinkNet()).toBe(20 + 50);
    expect(h.accounts.vaultOf(B).map((i) => i.summary.name)).toEqual(["Ember Blade"]);
    expect(h.accounts.noticesOf(S).map((n) => n.id)).toContain(`market:${id}:sold`);
    expect(h.accounts.noticesOf(B).map((n) => n.id)).toContain(`market:${id}:won`);
    assertConserved(h, [id], 3000, 1);
  });

  it("writes an economy_sale row to the outbox", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    h.accounts.grant(B, 2000);
    await h.book.buy({ opId: opId(), buyer: party(B), listingId: id });
    const sales = h.outbox.pending(100).filter((r) => r.table === "economy_sale");
    expect(sales).toHaveLength(1);
    expect(sales[0]!.pk).toBe(`mk:${id}`);
    expect(sales[0]!.payload).toMatchObject({
      venue: "market",
      price: 1000,
      tax: 50,
      sellerId: S,
      buyerId: B,
    });
  });

  it("buying over a top bid refunds that bidder", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000, startBid: 100 });
    h.accounts.grant(B, 2000);
    h.accounts.grant(C, 500);
    await h.book.bid({ opId: opId(), bidder: party(C), listingId: id, amount: 100 });
    await h.book.buy({ opId: opId(), buyer: party(B), listingId: id });
    expect(h.accounts.coin(C)).toBe(500);
    expect(h.accounts.noticesOf(C).some((n) => n.kind === "market.outbid")).toBe(true);
    assertConserved(h, [id], 2500 + 1000, 1);
  });

  it("an insufficient buyer changes nothing", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    h.accounts.grant(B, 500);
    expect(await h.book.buy({ opId: opId(), buyer: party(B), listingId: id })).toMatchObject({
      ok: false,
      code: "insufficient_funds",
    });
    expect(viewOf(h.book.get(id)).status).toBe("active");
    expect(h.accounts.coin(B)).toBe(500);
  });

  it("the seller cannot buy, and an auction-only listing cannot be bought", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    expect(await h.book.buy({ opId: opId(), buyer: party(S), listingId: id })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    const auction = await listed(h, { buyout: null, startBid: 100 });
    h.accounts.grant(B, 500);
    expect(await h.book.buy({ opId: opId(), buyer: party(B), listingId: auction })).toMatchObject({
      ok: false,
      code: "bad_request",
    });
  });

  it("a buyer whose vault is full gets the coin back, and the buy can be retried", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    h.accounts.grant(B, 2000, [item()]);
    h.accounts.vaultMax = 1;
    const first = await h.book.buy({ opId: opId(), buyer: party(B), listingId: id });
    expect(first).toMatchObject({ ok: false, code: "vault_full" });
    expect(h.accounts.coin(B)).toBe(2000);
    expect(viewOf(h.book.get(id)).status).toBe("active");

    h.accounts.vaultMax = 200;
    const retry = await h.book.buy({ opId: opId(), buyer: party(B), listingId: id });
    expect(retry.ok).toBe(true);
    expect(h.accounts.coin(B)).toBe(1000);
    const debits = h.accounts.flows.filter((f) => f.reason === `market.buy:${id}` && f.amount < 0);
    expect(debits.map((f) => f.txId)).toEqual([`mk:${id}:buy`, `mk:${id}:buy.1`]);
    assertConserved(h, [id], 3000, 2);
  });
});

describe("expiry (alarm)", () => {
  it("an unsold listing goes back to the seller when it ends; the fee is kept", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000, durationH: 12 });
    await h.book.tick();
    expect(viewOf(h.book.get(id)).status).toBe("active");
    h.clock.advance(12 * HOUR);
    await h.book.tick();
    expect(viewOf(h.book.get(id)).status).toBe("expired");
    expect(h.accounts.vaultOf(S)).toHaveLength(1);
    expect(h.accounts.noticesOf(S).map((n) => n.id)).toContain(`market:${id}:expired`);
    expect(h.accounts.sinkNet()).toBe(20);
    assertConserved(h, [id], 1000, 1);
  });

  it("a listing with a bid sells to the top bidder at the end", async () => {
    const h = harness();
    const id = await listed(h, { buyout: null, startBid: 100, durationH: 12 });
    h.accounts.grant(B, 500);
    await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 100 });
    h.clock.advance(12 * HOUR);
    await h.book.tick();
    const l = viewOf(h.book.get(id));
    expect(l.status).toBe("sold");
    expect(l.soldFor).toBe(100);
    expect(h.accounts.vaultOf(B)).toHaveLength(1);
    expect(h.accounts.coin(B)).toBe(400);
    // 1000 - fee 2 + proceeds 100 - tax 5
    expect(h.accounts.coin(S)).toBe(1000 - 2 + 100 - 5);
    expect(h.accounts.noticesOf(B).map((n) => n.id)).toContain(`market:${id}:won`);
    assertConserved(h, [id], 1500, 1);
  });

  it("nothing happens before the end", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000, durationH: 12 });
    h.clock.advance(12 * HOUR - MINUTE);
    await h.book.tick();
    expect(viewOf(h.book.get(id)).status).toBe("active");
  });

  it("a top bidder with a full vault gets the bid back and the item returns to the seller", async () => {
    const h = harness();
    const id = await listed(h, { buyout: null, startBid: 100, durationH: 12 });
    h.accounts.grant(B, 500, [item()]);
    await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 100 });
    h.accounts.vaultMax = 1;
    h.clock.advance(12 * HOUR);
    await h.book.tick();
    const l = viewOf(h.book.get(id));
    expect(l.status).toBe("expired");
    expect(l.topBid).toBeNull();
    expect(h.accounts.coin(B)).toBe(500);
    expect(h.accounts.vaultOf(S)).toHaveLength(1);
    expect(h.accounts.noticesOf(B).map((n) => n.id)).toContain(`market:${id}:refunded`);
    assertConserved(h, [id], 1500 + 0, 2);
  });

  it("a seller with a full vault keeps the listing until there is room", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000, durationH: 12 });
    h.accounts.grant(S, 0, [item()]);
    h.accounts.vaultMax = 1;
    h.clock.advance(12 * HOUR);
    await h.book.tick();
    expect(viewOf(h.book.get(id)).status).toBe("active");
    expect(h.book.nextWake(h.clock.now())).toBe(h.clock.now() + RETRY_MS);

    h.accounts.vaultMax = 200;
    h.clock.advance(RETRY_MS);
    await h.book.tick();
    expect(viewOf(h.book.get(id)).status).toBe("expired");
    expect(h.accounts.vaultOf(S)).toHaveLength(2);
  });
});

describe("cancel", () => {
  it("the seller takes the item back when nobody has bid; the fee is kept", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    const res = await h.book.cancel({ opId: opId(), accountId: S, listingId: id });
    expect(res.ok).toBe(true);
    expect(viewOf(res.ok ? res.value : null).status).toBe("cancelled");
    expect(h.accounts.vaultOf(S)).toHaveLength(1);
    expect(h.accounts.coin(S)).toBe(980);
    assertConserved(h, [id], 1000, 1);
  });

  it("only the seller can cancel", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    expect(await h.book.cancel({ opId: opId(), accountId: B, listingId: id })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("a listing with bids cannot be cancelled", async () => {
    const h = harness();
    const id = await listed(h, { buyout: null, startBid: 100 });
    h.accounts.grant(B, 500);
    await h.book.bid({ opId: opId(), bidder: party(B), listingId: id, amount: 100 });
    expect(await h.book.cancel({ opId: opId(), accountId: S, listingId: id })).toMatchObject({
      ok: false,
      code: "conflict",
    });
  });

  it("a cancelled listing cannot be bought", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    await h.book.cancel({ opId: opId(), accountId: S, listingId: id });
    h.accounts.grant(B, 2000);
    expect(await h.book.buy({ opId: opId(), buyer: party(B), listingId: id })).toMatchObject({
      ok: false,
      code: "closed",
    });
  });

  it("a replayed cancel answers the same listing", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    const key = opId("cancel");
    await h.book.cancel({ opId: key, accountId: S, listingId: id });
    const again = await h.book.cancel({ opId: key, accountId: S, listingId: id });
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(h.accounts.vaultOf(S)).toHaveLength(1);
  });
});

describe("busy lock and crash recovery", () => {
  it("a concurrent op on a busy listing answers busy, and a replay of the held op too", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    h.accounts.grant(B, 2000);
    h.accounts.grant(C, 2000);
    const hold = gate();
    h.accounts.before = async (c) => {
      if (c.op === "walletTx" && c.accountId === B && c.txId?.startsWith(`mk:${id}:buy`))
        await hold.wait;
    };
    const key = opId("buy");
    const held = h.book.buy({ opId: key, buyer: party(B), listingId: id });
    await settle();

    expect(
      await h.book.bid({ opId: opId(), bidder: party(C), listingId: id, amount: 100 }),
    ).toMatchObject({
      ok: false,
      code: "busy",
    });
    expect(await h.book.buy({ opId: key, buyer: party(B), listingId: id })).toMatchObject({
      ok: false,
      code: "busy",
    });
    hold.open();
    const done = await held;
    expect(done.ok).toBe(true);
    expect(viewOf(h.book.get(id)).status).toBe("sold");
    h.accounts.before = null;
    assertConserved(h, [id], 5000, 1);
  });

  it("a crash mid-saga is re-driven by the alarm and completes exactly once", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    h.accounts.grant(B, 2000);
    let crashed = false;
    h.accounts.before = (c) => {
      if (!crashed && c.op === "vaultPut" && c.accountId === B) {
        crashed = true;
        throw new Error("network dropped");
      }
    };
    await expect(h.book.buy({ opId: opId(), buyer: party(B), listingId: id })).rejects.toThrow(
      "network dropped",
    );
    expect(h.accounts.coin(B)).toBe(1000);
    expect(viewOf(h.book.get(id)).status).toBe("active");
    expect(h.book.nextWake(h.clock.now())).not.toBeNull();

    h.clock.advance(RESUME_AFTER_MS + 1);
    await h.book.tick();
    await h.book.tick();
    const l = viewOf(h.book.get(id));
    expect(l.status).toBe("sold");
    expect(h.accounts.coin(B)).toBe(1000);
    expect(h.accounts.vaultOf(B)).toHaveLength(1);
    expect(h.accounts.coin(S)).toBe(1000 - 20 + 1000 - 50);
    expect(h.accounts.noticesOf(S).filter((n) => n.id === `market:${id}:sold`)).toHaveLength(1);
    assertConserved(h, [id], 3000, 1);
  });

  it("a crash while notifying is re-driven without paying twice", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    h.accounts.grant(B, 2000);
    let armed = true;
    h.accounts.before = (c) => {
      if (armed && c.op === "notify") {
        armed = false;
        throw new Error("queue unavailable");
      }
    };
    await expect(h.book.buy({ opId: opId(), buyer: party(B), listingId: id })).rejects.toThrow();
    h.clock.advance(RESUME_AFTER_MS + 1);
    await h.book.tick();
    expect(viewOf(h.book.get(id)).status).toBe("sold");
    expect(h.accounts.coin(B)).toBe(1000);
    expect(h.accounts.coin(S)).toBe(1000 - 20 + 1000 - 50);
    expect(h.accounts.noticesOf(B).filter((n) => n.kind === "market.won")).toHaveLength(1);
    assertConserved(h, [id], 3000, 1);
  });

  it("a restart of the DO sees the same saga and finishes it", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    h.accounts.grant(B, 2000);
    h.accounts.before = (c) => {
      if (c.op === "vaultPut" && c.accountId === B) throw new Error("boom");
    };
    await expect(h.book.buy({ opId: opId(), buyer: party(B), listingId: id })).rejects.toThrow();
    h.accounts.before = null;
    const again = h.restart();
    h.clock.advance(RESUME_AFTER_MS + 1);
    await again.tick();
    expect(viewOf(again.get(id)).status).toBe("sold");
    assertConserved(h, [id], 3000, 1);
  });

  it("a listing whose fee is held shows nothing to the outside until it is active", async () => {
    const h = harness();
    const uid = give(h, S, 1000);
    const hold = gate();
    h.accounts.before = async (c) => {
      if (c.op === "walletTx" && c.txId?.endsWith(":fee")) await hold.wait;
    };
    const pending = listOne(h, S, uid, { buyout: 1000 });
    await settle();
    expect(h.book.get(`${SHARD}/1`)).toBeNull();
    expect(h.outbox.pending(100).some((r) => r.table === "market_listing")).toBe(false);
    hold.open();
    expect((await pending).ok).toBe(true);
    h.accounts.before = null;
    expect(h.outbox.pending(100).some((r) => r.table === "market_listing")).toBe(true);
  });
});

describe("views and shards", () => {
  it("get() answers null for another shard's listing and unknown ids", async () => {
    const h = harness();
    expect(h.book.get("universal:weapon/1")).toBeNull();
    expect(h.book.get(`${SHARD}/999`)).toBeNull();
  });

  it("a bid or buy on another shard's id is not_found", async () => {
    const h = harness();
    const res = await h.book.buy({
      opId: opId(),
      buyer: party(B),
      listingId: "universal:weapon/1",
    });
    expect(res).toMatchObject({ ok: false, code: "not_found" });
  });

  it("the sale of a listing and the public item hide the vault data", async () => {
    const h = harness();
    const id = await listed(h, { buyout: 1000 });
    const l = viewOf(h.book.get(id));
    expect(JSON.stringify(l)).not.toContain("gear-");
    expect(l.item.origin).toBe("classic");
  });
});
