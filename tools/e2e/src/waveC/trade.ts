/**
 * Wave C e2e: direct trade through the EscrowDO (docs/design/wave-C.md §3.3).
 * OWNER: T-escrow.
 *
 * Two registered accounts; A gets 1000 coin + a test item from the dev grant.
 * A opens a trade, offers the item + 100 coin; B offers 50 coin; both accept.
 * Vaults and wallets swap, the 2 % fee is charged on coin sent, a replayed
 * accept is a no-op, notices exist, guests/outsiders are refused, and after a
 * dev-server restart everything is still there.
 */
import type {
  NoticesResponse,
  TradeListResponse,
  TradeView,
  VaultItemInput,
  VaultResponse,
  WalletView,
} from "@gamez/protocol";
import { api, registerGuest } from "../accounts.ts";
import { loginGuest } from "../client.ts";
import type { E2eFeature } from "../features.ts";
import { check } from "../report.ts";

interface TradeState {
  tradeId: string;
  a: { token: string; accountId: string };
  b: { token: string; accountId: string };
  coinA: number;
  coinB: number;
  itemId: string;
}

const ERR = (b: unknown) => JSON.stringify(b).slice(0, 200);

function e2eItem(tag: string): VaultItemInput {
  return {
    itemId: `e2e.weapon.blade_${tag}`,
    origin: "classic",
    count: 1,
    universal: false,
    tradable: true,
    summary: {
      name: `E2E Blade ${tag}`,
      rarity: "rare",
      level: 12,
      category: "weapon",
      slot: "weapon",
      icon: "item.sword",
      lines: ["+5 Strength"],
    },
    data: JSON.stringify({ tag }),
  };
}

async function coinOf(url: string, token: string): Promise<number> {
  const r = await api<WalletView>(url, "/api/account/wallet", { token });
  return r.body.balances?.coin ?? -1;
}

async function vaultOf(url: string, token: string): Promise<VaultResponse> {
  return (await api<VaultResponse>(url, "/api/account/vault", { token })).body;
}

export const tradeFeature: E2eFeature = {
  name: "trade",
  async run(ctx) {
    const url = ctx.url;
    const tag = Date.now().toString(36);
    const a = await registerGuest(url, await loginGuest(url), `Trader A ${tag.slice(-4)}`);
    const b = await registerGuest(url, await loginGuest(url), `Trader B ${tag.slice(-4)}`);
    const guest = await loginGuest(url);

    // Seed A with coin and a tradable test item, B with coin (dev hosts only).
    const grantA = await api<{ items?: { uid: string }[] }>(url, "/api/dev/economy/grant", {
      token: a.token,
      body: { opId: `e2e-grant-a-${tag}`, coin: 1000, items: [e2eItem(tag)] },
    });
    const grantB = await api<unknown>(url, "/api/dev/economy/grant", {
      token: b.token,
      body: { opId: `e2e-grant-b-${tag}`, coin: 200 },
    });
    const itemUid = grantA.body.items?.[0]?.uid ?? "";
    check(
      grantA.status === 200 && grantB.status === 200 && itemUid !== "",
      `trade: dev grant seeds coin and an item (${grantA.status}/${grantB.status})`,
    );
    const replayGrant = await api<unknown>(url, "/api/dev/economy/grant", {
      token: a.token,
      body: { opId: `e2e-grant-a-${tag}`, coin: 1000, items: [e2eItem(tag)] },
    });
    const coinA0 = await coinOf(url, a.token);
    check(
      replayGrant.status === 200 &&
        coinA0 === 1000 &&
        (await vaultOf(url, a.token)).items.length === 1,
      `trade: a replayed grant (same opId) is a no-op (coin ${coinA0})`,
    );

    // Guests may not trade; the target must be registered.
    const byGuest = await api<{ error?: { code: string } }>(url, "/api/trade", {
      token: guest.token,
      body: { opId: `e2e-open-g-${tag}`, with: b.accountId },
    });
    check(
      byGuest.status === 403 && byGuest.body.error?.code === "guest_forbidden",
      `trade: a guest gets guest_forbidden (${byGuest.status})`,
    );
    const toGuest = await api<{ error?: { code: string } }>(url, "/api/trade", {
      token: a.token,
      body: { opId: `e2e-open-x-${tag}`, with: guest.accountId },
    });
    check(
      toGuest.status === 400 || toGuest.status === 404,
      `trade: trading with a guest is refused (${toGuest.status})`,
    );

    // A opens; the same opId reopens the same trade.
    const opId = `e2e-open-${tag}`;
    const opened = await api<TradeView>(url, "/api/trade", {
      token: a.token,
      body: { opId, with: b.accountId },
    });
    const tradeId = opened.body.id;
    check(
      opened.status === 200 && opened.body.status === "open",
      `trade: A opens a trade with B (${opened.status} ${ERR(opened.body)})`,
    );
    const reopened = await api<TradeView>(url, "/api/trade", {
      token: a.token,
      body: { opId, with: b.accountId },
    });
    check(reopened.body.id === tradeId, "trade: the same opId returns the same trade");
    const listB = await api<TradeListResponse>(url, "/api/trade", { token: b.token });
    check(
      listB.status === 200 && listB.body.trades.some((t) => t.id === tradeId),
      "trade: B sees the trade in GET /api/trade",
    );
    const outsider = await registerGuest(url, await loginGuest(url), `Peek ${tag.slice(-4)}`);
    const peek = await api<unknown>(url, `/api/trade/${tradeId}`, { token: outsider.token });
    check(peek.status === 404, `trade: an outsider gets 404 (${peek.status})`);

    // Offers.
    const offerA = await api<TradeView>(url, `/api/trade/${tradeId}/offer`, {
      token: a.token,
      body: { coin: 100, uids: [itemUid] },
    });
    const offerB = await api<TradeView>(url, `/api/trade/${tradeId}/offer`, {
      token: b.token,
      body: { coin: 50, uids: [] },
    });
    const versions: [number, number] = [
      offerB.body.offers?.a.version ?? -1,
      offerB.body.offers?.b.version ?? -1,
    ];
    check(
      offerA.status === 200 && offerB.status === 200 && versions[0] === 1 && versions[1] === 1,
      `trade: both sides offer (versions ${versions.join(",")})`,
    );
    check(
      offerB.body.fees?.a === 2 && offerB.body.fees?.b === 1,
      `trade: fees are 2 % of coin sent (min 1): ${ERR(offerB.body.fees)}`,
    );
    const stale = await api<{ error?: { code: string } }>(url, `/api/trade/${tradeId}/accept`, {
      token: a.token,
      body: { versions: [0, 0] },
    });
    check(stale.status === 409, `trade: accepting a stale pair -> 409 (${stale.status})`);

    // Accept.
    const accA = await api<TradeView>(url, `/api/trade/${tradeId}/accept`, {
      token: a.token,
      body: { versions },
    });
    const accB = await api<TradeView>(url, `/api/trade/${tradeId}/accept`, {
      token: b.token,
      body: { versions },
    });
    check(
      accA.status === 200 && accB.status === 200 && accB.body.status === "done",
      `trade: both accept -> done (${accB.status} ${accB.body.status})`,
    );

    const coinA = await coinOf(url, a.token);
    const coinB = await coinOf(url, b.token);
    check(coinA === 1000 - 100 - 2 + 50, `trade: A paid 100 + fee 2 and got 50 (coin ${coinA})`);
    check(coinB === 200 - 50 - 1 + 100, `trade: B paid 50 + fee 1 and got 100 (coin ${coinB})`);
    const vaultA = await vaultOf(url, a.token);
    const vaultB = await vaultOf(url, b.token);
    const itemId = `e2e.weapon.blade_${tag}`;
    check(
      vaultA.items.length === 0 && vaultB.items.some((i) => i.itemId === itemId),
      `trade: the item moved from A's vault to B's (${vaultA.items.length}/${vaultB.items.length})`,
    );

    // A replayed accept is a no-op.
    const replay = await api<TradeView>(url, `/api/trade/${tradeId}/accept`, {
      token: b.token,
      body: { versions },
    });
    check(
      replay.status === 200 &&
        (await coinOf(url, a.token)) === coinA &&
        (await coinOf(url, b.token)) === coinB &&
        (await vaultOf(url, b.token)).items.length === vaultB.items.length,
      `trade: a replayed accept changes nothing (${replay.status})`,
    );

    // Notices.
    const nA = await api<NoticesResponse>(url, "/api/account/notices", { token: a.token });
    const nB = await api<NoticesResponse>(url, "/api/account/notices", { token: b.token });
    const kindsB = nB.body.notices.map((n) => n.kind);
    check(
      nA.body.notices.some((n) => n.kind === "trade.done") &&
        kindsB.includes("trade.invite") &&
        kindsB.includes("trade.done"),
      `trade: notices trade.invite/trade.done exist (B: ${kindsB.join(",")})`,
    );
    const lastB = nB.body.notices.at(-1)?.id ?? "";
    const marked = await api<{ marked: number }>(url, "/api/account/notices/read", {
      token: b.token,
      body: { upTo: lastB },
    });
    const after = await api<NoticesResponse>(url, "/api/account/notices", { token: b.token });
    check(
      marked.status === 200 && marked.body.marked >= 2 && after.body.unread === 0,
      `trade: notices can be marked read (marked ${marked.body.marked})`,
    );
    const listAfter = await api<TradeListResponse>(url, "/api/trade", { token: a.token });
    check(
      !listAfter.body.trades.some((t) => t.id === tradeId),
      "trade: a finished trade leaves the open list",
    );

    const state: TradeState = {
      tradeId,
      a: { token: a.token, accountId: a.accountId },
      b: { token: b.token, accountId: b.accountId },
      coinA,
      coinB,
      itemId,
    };
    ctx.state.set("trade", state);
  },

  async afterRestart(ctx) {
    const s = ctx.state.get("trade") as TradeState | undefined;
    if (!s) {
      check(false, "trade: no state from run() to check after the restart");
      return;
    }
    const url = ctx.url;
    const view = await api<TradeView>(url, `/api/trade/${s.tradeId}`, { token: s.a.token });
    check(
      view.status === 200 && view.body.status === "done",
      `trade: the trade is still done after the restart (${view.status} ${view.body.status})`,
    );
    const coinA = await coinOf(url, s.a.token);
    const coinB = await coinOf(url, s.b.token);
    const vaultB = await vaultOf(url, s.b.token);
    check(
      coinA === s.coinA && coinB === s.coinB && vaultB.items.some((i) => i.itemId === s.itemId),
      `trade: wallets and vaults persist across the restart (${coinA}/${coinB})`,
    );
    const nB = await api<NoticesResponse>(url, "/api/account/notices", { token: s.b.token });
    check(
      nB.body.notices.some((n) => n.kind === "trade.done"),
      "trade: notices persist across the restart",
    );
  },
};
