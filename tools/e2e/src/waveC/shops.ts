/**
 * Wave C e2e: shop plots (docs/design/wave-C.md §5, §11). OWNER: T-shops.
 *
 * Read and guard checks always run. The economy story needs coin and items from
 * POST /api/dev/economy/grant (dev hosts only). The story: A wins plot auction, stocks an axe at 300 and opens the
 * shop; B buys; A claims 291 (300 minus the 3 % tax, 9). C bids with exactly the
 * bid, cannot pay rent, goes to grace and is repossessed, and the axe comes back to
 * C's vault. A presence bot then checks the shopkeeper fixture in the town welcome.
 *
 * The dev server keeps DO state between runs, so plots are picked from the live
 * state (free auctions) rather than fixed ids, and every run first ends open auctions.
 */
import type { EntityState, PlotsResponse, ServerMessage, ShopView } from "@gamez/protocol";
// The rule constants the e2e checks against (same files the DOs use).
import {
  PLOT_AUCTION_MS,
  PLOT_LEASE_MS,
  RENT_GRACE_MS,
  RENT_PERIOD_MS,
  RENT_RETRY_MS,
} from "../../../../modules/economy/src/lease.ts";
import { shopTax } from "../../../../modules/economy/src/fees.ts";
// The same codec constant the browser client uses.
import { codec } from "../../../../apps/game/src/shared/codec.ts";
import { api, registerGuest, type Registered } from "../accounts.ts";
import { loginGuest } from "../client.ts";
import type { E2eContext, E2eFeature } from "../features.ts";
import { check } from "../report.ts";

const WORLD = "classic-town";
const PRICE = 300;
const BROKE_BID = 100;
const SHOPKEEPER_WAIT_MS = 4_000;

interface Wallet {
  balances: { coin: number; gem: number };
}
interface VaultItemOut {
  uid: string;
  itemId: string;
}

/** A random op id suffix (the e2e is not sim code, so Math.random is fine here). */
const suffix = (): string => Math.random().toString(36).slice(2, 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function advance(url: string, token: string, ms: number): Promise<PlotsResponse | null> {
  const r = await api<PlotsResponse>(url, "/api/dev/shops/advance", {
    token,
    body: { world: WORLD, ms },
  });
  return r.status === 200 ? r.body : null;
}

async function plotsNow(url: string, token: string): Promise<PlotsResponse["plots"]> {
  const r = await api<PlotsResponse>(url, `/api/shops?world=${WORLD}`, { token });
  return r.status === 200 ? r.body.plots : [];
}

async function coinOf(url: string, token: string): Promise<number> {
  const r = await api<Wallet>(url, "/api/account/wallet", { token });
  return r.body.balances.coin;
}

async function vaultOf(url: string, token: string): Promise<VaultItemOut[]> {
  const r = await api<{ items: VaultItemOut[] }>(url, "/api/account/vault", { token });
  return r.status === 200 ? r.body.items : [];
}

/** Dev grant of coin and one axe; the axe's uid, or null when the grant route is absent. */
async function grant(
  url: string,
  acct: Registered,
  coin: number,
  withAxe: boolean,
): Promise<{ ok: boolean; uid: string | null }> {
  const r = await api(url, "/api/dev/economy/grant", {
    token: acct.token,
    body: {
      coin,
      items: withAxe
        ? [
            {
              itemId: "e2e.weapon.axe",
              origin: "classic",
              count: 1,
              universal: false,
              tradable: true,
              summary: {
                name: "E2E Axe",
                rarity: "magic",
                level: 5,
                category: "weapon",
                slot: "weapon",
                icon: "item.sword",
                lines: [],
              },
              data: null,
            },
          ]
        : [],
    },
  });
  if (r.status !== 200) return { ok: false, uid: null };
  const axe = withAxe
    ? (await vaultOf(url, acct.token)).find((i) => i.itemId === "e2e.weapon.axe")
    : null;
  return { ok: true, uid: axe?.uid ?? null };
}

/**
 * The shopkeeper fixture id in the presence welcome of the town (null when the
 * welcome has no such entity, e.g. before the chunk stores fixtures).
 */
async function fixtureSeen(
  baseUrl: string,
  token: string,
  id: string,
): Promise<EntityState | null> {
  const url = `${baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}&world=${WORLD}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const welcomes: Extract<ServerMessage, { t: "welcome" }>[] = [];
  ws.addEventListener("message", (ev: MessageEvent<string | ArrayBuffer>) => {
    const m: ServerMessage = codec.decodeServer(ev.data);
    if (m.t === "welcome") welcomes.push(m);
  });
  try {
    const deadline = Date.now() + SHOPKEEPER_WAIT_MS;
    while (welcomes.length === 0 && Date.now() < deadline) await sleep(100);
    const welcome = welcomes[0];
    return welcome ? (welcome.entities.find((e) => e.id === id) ?? null) : null;
  } finally {
    ws.close();
  }
}

export const shopsFeature: E2eFeature = {
  name: "shops",
  async run(ctx: E2eContext) {
    const url = ctx.url;
    const guestToken = (await loginGuest(url)).token;

    // ---- read and guard checks (no economy needed)
    const listed = await api<PlotsResponse>(url, `/api/shops?world=${WORLD}`, {
      token: guestToken,
    });
    check(
      listed.status === 200 && listed.body.plots.length === 8,
      "GET /api/shops lists the 8 classic-town plots to a guest",
    );
    const unknown = await api(url, `/api/shops?world=nowhere`, { token: guestToken });
    check(unknown.status === 400, "shops: an unknown world is rejected (400)");

    const guestBid = await api(url, "/api/shops/plots/bid", {
      token: guestToken,
      body: { opId: `bid-guest-${suffix()}`, world: WORLD, plotId: "p1", amount: 100 },
    });
    check(
      guestBid.status === 403 &&
        (guestBid.body as { error?: { code?: string } }).error?.code === "guest_forbidden",
      "shops: a guest cannot bid (403 guest_forbidden)",
    );

    const devAdvance = await api(url, "/api/dev/shops/advance", {
      token: guestToken,
      body: { world: WORLD, ms: 1000 },
    });
    check(devAdvance.status === 200, "POST /api/dev/shops/advance answers on the dev host");

    // ---- accounts
    const a = await registerGuest(url, await loginGuest(url), "ShopA");
    const b = await registerGuest(url, await loginGuest(url), "ShopB");
    const c = await registerGuest(url, await loginGuest(url), "ShopC");

    // The dev state outlives a run: end every lease and auction left by earlier runs,
    // so all eight plots start free (leases last a week, the clock is moved here).
    await advance(url, a.token, PLOT_LEASE_MS + PLOT_AUCTION_MS + 1000);
    const free = (await plotsNow(url, a.token)).filter(
      (p) => p.state === "auction" && p.auction?.topBid === null,
    );
    const saleId = free[0]?.id;
    const brokeId = free[1]?.id;

    // Each e2e run starts from empty state, so two free plots must exist.
    check(saleId !== undefined && brokeId !== undefined, "shops: two free plots after the advance");
    if (saleId === undefined || brokeId === undefined) return;

    // ---- the sale story: A wins p(sale), stocks an axe at 300, opens; B buys; A claims
    const grantA = await grant(url, a, BROKE_BID, true);
    const grantB = await grant(url, b, 1000, false);
    const grantC = await grant(url, c, BROKE_BID, true);
    check(
      grantA.ok && grantB.ok && grantC.ok && grantA.uid !== null && grantC.uid !== null,
      "dev grant gives coin and an axe",
    );
    if (!grantA.ok || !grantB.ok || !grantC.ok || !grantA.uid || !grantC.uid) return;

    const bidOk = await api<unknown>(url, "/api/shops/plots/bid", {
      token: a.token,
      body: { opId: `bid-a-${suffix()}`, world: WORLD, plotId: saleId, amount: BROKE_BID },
    });
    check(bidOk.status === 200, `A bids ${BROKE_BID} on ${saleId}`);
    check((await coinOf(url, a.token)) === 0, "A's bid is debited (coin 0 left)");

    await advance(url, a.token, PLOT_AUCTION_MS + 1000);
    const leased = (await plotsNow(url, a.token)).find((p) => p.id === saleId);
    check(
      leased?.state === "leased" && leased.lease?.owner.accountId === a.accountId,
      `A holds ${saleId} after the auction (state leased)`,
    );

    const aOwnAxe = (await vaultOf(url, a.token)).find((i) => i.itemId === "e2e.weapon.axe");
    const stock = await api<ShopView>(url, `/api/shops/${WORLD}/${saleId}/stock`, {
      token: a.token,
      body: { opId: `stock-a-${suffix()}`, uid: aOwnAxe?.uid, price: PRICE },
    });
    check(stock.status === 200 && stock.body.stock.length === 1, `A stocks the axe at ${PRICE}`);
    const open = await api<ShopView>(url, `/api/shops/${WORLD}/${saleId}/configure`, {
      token: a.token,
      body: { name: "E2E Shop A", open: true },
    });
    check(open.status === 200 && open.body.open === true, "A opens the shop");

    const entryId = stock.status === 200 ? stock.body.stock[0]?.entryId : undefined;
    const buy = await api<ShopView>(url, `/api/shops/${WORLD}/${saleId}/buy`, {
      token: b.token,
      body: { opId: `buy-b-${suffix()}`, entryId },
    });
    check(buy.status === 200, "B buys the axe");
    check(
      (await coinOf(url, b.token)) === 1000 - PRICE,
      `B pays ${PRICE} (1000 -> ${1000 - PRICE})`,
    );

    const claim = await api<ShopView>(url, `/api/shops/${WORLD}/${saleId}/claim`, {
      token: a.token,
      body: { opId: `claim-a-${suffix()}` },
    });
    const net = PRICE - shopTax(PRICE);
    check(claim.status === 200, "A claims the earnings");
    check(
      (await coinOf(url, a.token)) === net,
      `A nets ${net} (300 minus the ${shopTax(PRICE)} tax)`,
    );
    const kinds = (
      await api<{ notices: { kind: string }[] }>(url, "/api/account/notices", { token: a.token })
    ).body.notices.map((n) => n.kind);
    check(kinds.includes("shop.sold"), "A gets a shop.sold notice");

    // ---- the repossession story: C bids its last coin, cannot pay rent, loses the plot
    const bidC = await api(url, "/api/shops/plots/bid", {
      token: c.token,
      body: { opId: `bid-c-${suffix()}`, world: WORLD, plotId: brokeId, amount: BROKE_BID },
    });
    check(bidC.status === 200, `C bids ${BROKE_BID} on ${brokeId} with all its coin`);
    await advance(url, c.token, PLOT_AUCTION_MS + 1000);
    const cAxe = (await vaultOf(url, c.token)).find((i) => i.itemId === "e2e.weapon.axe");
    const stockC = await api<ShopView>(url, `/api/shops/${WORLD}/${brokeId}/stock`, {
      token: c.token,
      body: { opId: `stock-c-${suffix()}`, uid: cAxe?.uid, price: 50 },
    });
    check(stockC.status === 200, "C stocks its axe (the shop is leased)");

    await advance(url, c.token, RENT_PERIOD_MS + 1000);
    const graced = (await plotsNow(url, c.token)).find((p) => p.id === brokeId);
    check(graced?.state === "grace", `C's rent is unpaid: ${brokeId} is in grace`);
    check(
      (
        await api<{ notices: { kind: string }[] }>(url, "/api/account/notices", { token: c.token })
      ).body.notices.some((n) => n.kind === "shop.rent_due"),
      "C gets a shop.rent_due notice",
    );

    await advance(url, c.token, RENT_GRACE_MS + RENT_RETRY_MS);
    const repo = (await plotsNow(url, c.token)).find((p) => p.id === brokeId);
    check(repo?.state === "auction", `${brokeId} is repossessed and back up for auction`);
    const back = (await vaultOf(url, c.token)).filter((i) => i.itemId === "e2e.weapon.axe");
    check(back.length === 1, "the repossessed shop's axe returns to C's vault");
    check(
      (
        await api<{ notices: { kind: string }[] }>(url, "/api/account/notices", { token: c.token })
      ).body.notices.some((n) => n.kind === "shop.repossessed"),
      "C gets a shop.repossessed notice",
    );

    // ---- presence: the shopkeeper of the leased shop is a fixture in the town
    const id = `shops:${saleId}`;
    const fixture = await fixtureSeen(url, a.token, id);
    check(
      fixture?.kind === "shopkeeper" && fixture.name === "E2E Shop A",
      `presence shows the shopkeeper ${id}`,
    );
  },
};
