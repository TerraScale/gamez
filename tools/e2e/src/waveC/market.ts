/**
 * Wave C e2e: auction house: list (fee), search via D1, buyout by B (tax), bid/outbid refund, cancel (docs/design/wave-C.md §11). OWNER: T-market.
 * Uses the dev grant (POST /api/dev/economy/grant, T-escrow) to seed coin and
 * eligible items. Runs
 * registered accounts only (trading needs an account). afterRestart re-reads
 * the listing statuses from D1 and the DO-backed search.
 */
import type {
  ApiError,
  MarketListing,
  MarketMineResponse,
  MarketSearchResponse,
  NoticesResponse,
  VaultItem,
  VaultItemInput,
  VaultResponse,
} from "@gamez/protocol";
import { api, registerGuest, type Registered } from "../accounts.ts";
import { loginGuest } from "../client.ts";
import type { E2eContext, E2eFeature } from "../features.ts";
import { check } from "../report.ts";

const POLL_MS = 20_000;
const TAG = `Mkt${Date.now().toString(36)}`;

interface GrantBody {
  balances: { coin: number; gem: number };
  items: VaultItem[];
  vault: VaultResponse;
}

interface MarketState {
  aToken: string;
  bToken: string;
  cToken: string;
  id1: string;
  id2: string;
  id3: string;
}

const itemName = (label: string): string => `E2E ${TAG} ${label}`;

function itemFor(label: string): VaultItemInput {
  return {
    itemId: "classic.item.sword",
    count: 1,
    origin: "classic",
    universal: false,
    tradable: true,
    summary: {
      name: itemName(label),
      rarity: "rare",
      level: 12,
      category: "weapon",
      slot: "weapon",
      icon: "item.sword",
      lines: ["+12 Strength"],
    },
    data: null,
  };
}

/** Unique, valid op ids (8..64 chars of [A-Za-z0-9_-]). */
function opId(label: string): string {
  return `${label}-${TAG}-${Math.random().toString(36).slice(2, 10)}`;
}

async function coinOf(baseUrl: string, token: string): Promise<number> {
  const res = await api<{ balances: { coin: number } }>(baseUrl, "/api/account/wallet", { token });
  return res.body.balances.coin;
}

async function vaultOf(baseUrl: string, token: string): Promise<VaultItem[]> {
  const res = await api<VaultResponse>(baseUrl, "/api/account/vault", { token });
  return res.body.items;
}

/** Calls `read` until it returns a value or POLL_MS passes. */
async function poll<T>(read: () => Promise<T | null>): Promise<T | null> {
  const until = Date.now() + POLL_MS;
  while (Date.now() < until) {
    const v = await read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function listItem(
  baseUrl: string,
  token: string,
  uid: string,
  over: { buyout: number | null; startBid: number | null; durationH: 12 | 24 | 48 },
) {
  return api<MarketListing & Partial<ApiError>>(baseUrl, "/api/market/list", {
    token,
    body: { opId: opId("list"), uid, ...over },
  });
}

async function bidOn(baseUrl: string, token: string, listingId: string, amount: number) {
  return api<MarketListing & Partial<ApiError>>(baseUrl, "/api/market/bid", {
    token,
    body: { opId: opId("bid"), listingId, amount },
  });
}

export const marketFeature: E2eFeature = {
  name: "market",
  async run(ctx: E2eContext) {
    const base = ctx.url;
    const a: Registered = await registerGuest(base, await loginGuest(base));
    const b: Registered = await registerGuest(base, await loginGuest(base));
    const c: Registered = await registerGuest(base, await loginGuest(base));

    const grant = await api<GrantBody>(base, "/api/dev/economy/grant", {
      token: a.token,
      body: { coin: 5000, items: [itemFor("A1"), itemFor("A2"), itemFor("A3")] },
    });
    check(grant.status === 200, "market: dev grant seeds A with coin and three eligible items");
    if (grant.status !== 200) return;
    await api(base, "/api/dev/economy/grant", { token: b.token, body: { coin: 3000 } });
    await api(base, "/api/dev/economy/grant", { token: c.token, body: { coin: 1000 } });

    const uidOf = (label: string): string => {
      const found = grant.body.items.find((i) => i.summary.name === itemName(label));
      if (!found) throw new Error(`market: grant did not return ${label}`);
      return found.uid;
    };
    const aCoin0 = await coinOf(base, a.token);
    const bCoin0 = await coinOf(base, b.token);
    const cCoin0 = await coinOf(base, c.token);

    // 1. A lists A1 at a 1000 buyout: fee 2 % = 20
    const l1 = await listItem(base, a.token, uidOf("A1"), {
      buyout: 1000,
      startBid: null,
      durationH: 12,
    });
    check(
      l1.status === 200 && l1.body.status === "active" && l1.body.fee === 20,
      "market: A lists A1 at a 1000 buyout with a 20 coin fee",
    );
    const id1 = l1.body.id ?? "";
    check(
      (await coinOf(base, a.token)) === aCoin0 - 20,
      "market: the listing fee leaves A's wallet",
    );

    // 2. D1 (via the queue) shows the listing in search
    const seen = await poll(async () => {
      const r = await api<MarketSearchResponse>(base, `/api/market/search?q=${TAG}&sort=newest`);
      return r.body.available && r.body.listings.some((l) => l.id === id1) ? r.body : null;
    });
    check(seen !== null, "market: A1 appears in /api/market/search within 20 s");

    // 3. B buys it at the buyout: tax 5 % = 50 comes off A's proceeds
    const bought = await api<MarketListing & Partial<ApiError>>(base, "/api/market/buy", {
      token: b.token,
      body: { opId: opId("buy"), listingId: id1 },
    });
    check(
      bought.status === 200 && bought.body.status === "sold" && bought.body.soldFor === 1000,
      "market: B buys A1 at the buyout (sold for 1000)",
    );
    check(
      (await coinOf(base, b.token)) === bCoin0 - 1000,
      "market: the buyer pays exactly the buyout",
    );
    check(
      (await coinOf(base, a.token)) === aCoin0 - 20 + 1000 - 50,
      "market: A nets 1000 - 50 tax - 20 fee",
    );
    check(
      (await vaultOf(base, b.token)).some((i) => i.summary.name === itemName("A1")),
      "market: A1 is in B's vault",
    );

    // 4. A lists A2 by auction (start bid 100, fee 2); B bids, C outbids B
    const l2 = await listItem(base, a.token, uidOf("A2"), {
      buyout: null,
      startBid: 100,
      durationH: 24,
    });
    check(
      l2.status === 200 && l2.body.fee === 2,
      "market: A lists A2 by auction (start bid 100, fee 2)",
    );
    const id2 = l2.body.id ?? "";
    const bidB = await bidOn(base, b.token, id2, 100);
    check(bidB.status === 200 && bidB.body.topBid === 100, "market: B opens the bidding at 100");
    check((await coinOf(base, b.token)) === bCoin0 - 1000 - 100, "market: B's bid is held");
    const low = await bidOn(base, c.token, id2, 104);
    check(
      low.status === 400 && low.body.error?.code === "too_low",
      "market: C's 104 is below the 5 % step",
    );
    const bidC = await bidOn(base, c.token, id2, 110);
    check(
      bidC.status === 200 && bidC.body.topBidder?.accountId === c.accountId,
      "market: C outbids B at 110",
    );
    check(
      (await coinOf(base, b.token)) === bCoin0 - 1000,
      "market: B is refunded in full when outbid",
    );
    check((await coinOf(base, c.token)) === cCoin0 - 110, "market: C's bid is held");
    const notices = await api<NoticesResponse>(base, "/api/account/notices", { token: b.token });
    check(
      notices.body.notices.some(
        (n) => n.id === `market:${id2}:outbid:1` && n.kind === "market.outbid",
      ),
      "market: B is told it was outbid",
    );

    // 5. A lists A3 and cancels it: the item returns to A's vault, the fee is kept
    const l3 = await listItem(base, a.token, uidOf("A3"), {
      buyout: 500,
      startBid: null,
      durationH: 12,
    });
    const id3 = l3.body.id ?? "";
    check(l3.status === 200, "market: A lists A3 at 500");
    const cancelled = await api<MarketListing & Partial<ApiError>>(base, "/api/market/cancel", {
      token: a.token,
      body: { opId: opId("cancel"), listingId: id3 },
    });
    check(
      cancelled.status === 200 && cancelled.body.status === "cancelled",
      "market: A cancels A3",
    );
    check(
      (await vaultOf(base, a.token)).some((i) => i.summary.name === itemName("A3")),
      "market: A3 is back in A's vault after the cancel",
    );

    // 6. refusals: a sold listing cannot be bought again; a guest cannot trade
    const again = await api<MarketListing & Partial<ApiError>>(base, "/api/market/buy", {
      token: c.token,
      body: { opId: opId("buy"), listingId: id1 },
    });
    check(
      again.status === 400 && again.body.error?.code === "closed",
      "market: a sold listing is closed",
    );
    const guest = await loginGuest(base);
    const guestBuy = await api<ApiError>(base, "/api/market/buy", {
      token: guest.token,
      body: { opId: opId("buy"), listingId: id2 },
    });
    check(
      guestBuy.status === 403 && guestBuy.body.error?.code === "guest_forbidden",
      "market: a guest cannot buy",
    );

    // 7. D1 projection: my listings show the three outcomes
    const mine = await poll(async () => {
      const r = await api<MarketMineResponse>(base, "/api/market/mine", { token: a.token });
      const s = new Map(r.body.listings.map((l) => [l.id, l.status]));
      return s.get(id1) === "sold" && s.get(id2) === "active" && s.get(id3) === "cancelled"
        ? s
        : null;
    });
    check(mine !== null, "market: D1 shows A1 sold, A2 active and A3 cancelled within 20 s");

    const state: MarketState = { aToken: a.token, bToken: b.token, cToken: c.token, id1, id2, id3 };
    ctx.state.set("market", state);
  },

  async afterRestart(ctx: E2eContext) {
    const st = ctx.state.get("market") as MarketState | undefined;
    if (!st) return;
    const base = ctx.url;
    const mine = await api<MarketMineResponse>(base, "/api/market/mine", { token: st.aToken });
    const byId = new Map(mine.body.listings.map((l) => [l.id, l]));
    check(byId.get(st.id1)?.status === "sold", "market: A1 is still sold after the restart");
    check(byId.get(st.id2)?.status === "active", "market: A2 is still active after the restart");
    check(byId.get(st.id2)?.topBid === 110, "market: A2 still leads at 110 after the restart");
    check(
      byId.get(st.id3)?.status === "cancelled",
      "market: A3 is still cancelled after the restart",
    );
    const search = await api<MarketSearchResponse>(base, `/api/market/search?q=${TAG}`);
    const ids = search.body.listings.map((l) => l.id);
    check(
      ids.includes(st.id2) && !ids.includes(st.id1),
      "market: search after the restart shows only the active listing",
    );
    check(
      (await vaultOf(base, st.bToken)).some((i) => i.summary.name === itemName("A1")),
      "market: B still holds A1 after the restart",
    );
  },
};
