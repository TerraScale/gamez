/**
 * ADR 0007 R7: a market saga must never be driven twice at once (a user request
 * whose AccountDO call hangs past RESUME_AFTER_MS while the alarm's tick() runs),
 * and a stale driver's save must never bring a finished saga back.
 */
import { listingFee, salesTax } from "@gamez/economy";
import type { VaultItem } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { RESUME_AFTER_MS } from "../../src/server/market/book.ts";
import type { CallInfo } from "./fake-accounts.ts";
import { assertConserved, harness, item, opId, party, viewOf, type Harness } from "./harness.ts";

const S = "acc-seller";
const B = "acc-bidder";
const C = "acc-carol";

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Holds the FIRST call matching `match` until open(); later calls pass. */
function holdFirst(h: Harness, match: (c: CallInfo) => boolean) {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  let held = false;
  let calls = 0;
  h.accounts.before = async (c) => {
    if (!match(c)) return;
    calls += 1;
    if (!held) {
      held = true;
      await wait;
    }
  };
  return { open, held: () => held, calls: () => calls };
}

/** The raw saga columns of a listing. */
function raw(h: Harness, id: string): { busy_json: string | null; bids: number; status: string } {
  return h.store.sql
    .exec<{
      busy_json: string | null;
      bids: number;
      status: string;
    }>("SELECT busy_json, bids, status FROM mk_listing WHERE id = ?", id)
    .one();
}

async function listed(
  h: Harness,
  buyout: number | null,
  startBid: number | null,
): Promise<{ id: string; fee: number }> {
  const [granted] = h.accounts.grant(S, 1000, [item()]);
  const res = await h.book.list({
    opId: opId("list"),
    seller: party(S),
    uid: (granted as VaultItem).uid,
    buyout,
    startBid,
    durationH: 12,
  });
  if (!res.ok) throw new Error(`list failed: ${res.code}`);
  return { id: res.value.id, fee: listingFee(buyout, startBid) };
}

describe("MarketBook: one driver per listing (R7)", () => {
  it("a buy whose deliver is held past RESUME_AFTER_MS while tick() runs sells once and refunds nobody twice", async () => {
    const h = harness();
    const { id, fee } = await listed(h, 1000, 100);
    h.accounts.grant(B, 2000);
    h.accounts.grant(C, 2000);
    // Carol leads with 200, so the buy has a top bid to refund.
    const bid = await h.book.bid({ opId: opId(), bidder: party(C), listingId: id, amount: 200 });
    expect(bid.ok).toBe(true);

    const hold = holdFirst(
      h,
      (c) => c.op === "vaultPut" && c.accountId === B && !!c.txId?.includes(":deliver"),
    );
    const buy = h.book.buy({ opId: opId("buy"), buyer: party(B), listingId: id });
    await settle();
    expect(hold.held()).toBe(true);
    h.clock.advance(RESUME_AFTER_MS + 1_000);
    const tick = h.book.tick();
    await settle();
    // One driver: tick() joined the held drive instead of delivering again.
    expect(hold.calls()).toBe(1);
    hold.open();
    const [res] = await Promise.all([buy, tick]);
    h.accounts.before = null;
    expect(res.ok).toBe(true);

    const r = raw(h, id);
    expect(r.status).toBe("sold");
    expect(r.busy_json).toBeNull();
    expect(r.bids).toBe(1);
    expect(h.accounts.coin(B)).toBe(2000 - 1000);
    expect(h.accounts.vaultOf(B)).toHaveLength(1);
    expect(h.accounts.coin(C)).toBe(2000);
    expect(h.accounts.coin(S)).toBe(1000 - fee + 1000 - salesTax(1000));
    expect(h.outbox.pending(1000).filter((x) => x.table === "economy_sale")).toHaveLength(1);
    // One more alarm changes nothing.
    h.clock.advance(RESUME_AFTER_MS + 1_000);
    await h.book.tick();
    expect(h.accounts.coin(B)).toBe(1000);
    assertConserved(h, [id], 5000, 1);
  });

  it("a bid whose debit is held while tick() re-drives it commits once (bids + 1)", async () => {
    const h = harness();
    const { id } = await listed(h, null, 100);
    h.accounts.grant(B, 2000);
    const hold = holdFirst(
      h,
      (c) => c.op === "walletTx" && c.accountId === B && c.txId === `mk:${id}:bid:1`,
    );
    const bid = h.book.bid({ opId: opId("bid"), bidder: party(B), listingId: id, amount: 100 });
    await settle();
    h.clock.advance(RESUME_AFTER_MS + 1_000);
    const tick = h.book.tick();
    await settle();
    expect(hold.calls()).toBe(1);
    hold.open();
    const [res] = await Promise.all([bid, tick]);
    h.accounts.before = null;
    expect(res.ok).toBe(true);

    const r = raw(h, id);
    expect(r.busy_json).toBeNull();
    expect(r.bids).toBe(1);
    expect(viewOf(h.book.get(id)).topBid).toBe(100);
    expect(h.accounts.coin(B)).toBe(2000 - 100);
    assertConserved(h, [id], 3000, 1);
  });

  it("a stale driver (no shared in-memory lock) cannot revive a committed saga", async () => {
    const h = harness();
    const { id } = await listed(h, null, 100);
    h.accounts.grant(B, 2000);
    const hold = holdFirst(
      h,
      (c) => c.op === "walletTx" && c.accountId === B && c.txId === `mk:${id}:bid:1`,
    );
    const bid = h.book.bid({ opId: opId("bid"), bidder: party(B), listingId: id, amount: 100 });
    await settle();
    // A second MarketBook over the same storage finishes the saga meanwhile.
    const twin = h.restart();
    h.clock.advance(RESUME_AFTER_MS + 1_000);
    await twin.tick();
    expect(raw(h, id)).toMatchObject({ busy_json: null, bids: 1 });

    hold.open();
    const res = await bid;
    h.accounts.before = null;
    expect(res.ok).toBe(true);
    const r = raw(h, id);
    expect(r.busy_json).toBeNull();
    expect(r.bids).toBe(1);
    expect(h.accounts.coin(B)).toBe(2000 - 100);
    expect(h.book.nextWake(h.clock.now())).toBe(viewOf(h.book.get(id)).endsAt);
    assertConserved(h, [id], 3000, 1);
  });
});
