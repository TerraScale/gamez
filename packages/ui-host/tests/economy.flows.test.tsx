import { describe, expect, it } from "vite-plus/test";
import type {
  ItemSummary,
  MarketListing,
  Notice,
  PlotView,
  ShopView,
  TradeView,
  VaultItem,
} from "@gamez/protocol";
import type { ApiResult, MarketApi, ShopsApi, TradeApi, VaultApi } from "../src/platform.ts";
import {
  EMPTY_BROWSE,
  EMPTY_SELL,
  browseQuery,
  bidFloor,
  bidPlot,
  buyConfirmText,
  buyListing,
  buyFromShop,
  canAccept,
  checkBid,
  checkCoinWithdraw,
  checkOffer,
  checkPlotBid,
  checkSell,
  checkShopName,
  configureShop,
  linkOf,
  listItem,
  loadResult,
  markAllRead,
  newestFirst,
  newestNoticeId,
  parseWhole,
  placeBid,
  plotMinBid,
  sellFeePreview,
  sellableItems,
  sendAccept,
  sendOffer,
  shopBuyConfirmText,
  sideOf,
  stockItem,
  tradeAccepts,
  tradeIsOver,
  tradeVersions,
  unreadCount,
  bankResult,
} from "../src/economy/parts/flows.ts";
import {
  formatCoin,
  formatTimeLeft,
  initials,
  economyErrorText,
  plotStateLabel,
  rarityColor,
  tradeStatusText,
} from "../src/economy/parts/text.ts";

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

const SUMMARY: ItemSummary = {
  name: "Iron Wolf Sword",
  rarity: "rare",
  level: 14,
  category: "weapon",
  slot: "weapon",
  icon: "item.sword",
  lines: ["+12 Strength"],
};

const GEM: ItemSummary = { ...SUMMARY, name: "Ember Gem", category: "gem", level: 0, slot: null };

function vaultItem(uid: string, summary: ItemSummary = SUMMARY, tradable = true): VaultItem {
  return {
    uid,
    itemId: "classic.sword",
    count: 1,
    origin: "classic",
    universal: false,
    tradable,
    summary,
    data: null,
  };
}

const party = (accountId: string, displayName: string) => ({ accountId, displayName });

function listing(patch: Partial<MarketListing> = {}): MarketListing {
  return {
    id: "classic:weapon/42",
    shard: "classic:weapon",
    seller: party("seller", "Seller"),
    item: {
      itemId: "classic.sword",
      count: 1,
      origin: "classic",
      universal: false,
      tradable: true,
      summary: SUMMARY,
    },
    buyout: 1000,
    startBid: 100,
    topBid: null,
    topBidder: null,
    bids: 0,
    fee: 20,
    createdAt: 1,
    endsAt: 10 * 3_600_000,
    status: "active",
    soldFor: null,
    ...patch,
  };
}

function trade(patch: Partial<TradeView> = {}): TradeView {
  const offer = (version: number, coin = 0) => ({ coin, items: [], version });
  return {
    id: "t0123456789abcdef01234567",
    a: party("me", "Me"),
    b: party("them", "Them"),
    offers: { a: offer(1, 50), b: offer(2, 0) },
    accepted: { a: null, b: null },
    status: "open",
    reason: null,
    fees: { a: 1, b: 0 },
    createdAt: 1,
    expiresAt: 600_001,
    ...patch,
  };
}

function plot(patch: Partial<PlotView> = {}): PlotView {
  return {
    id: "p1",
    world: "classic-town",
    pos: { x: 3, y: 4 },
    state: "auction",
    auction: {
      startedAt: 0,
      endsAt: 3_600_000,
      minBid: 50,
      topBid: null,
      topBidder: null,
      bids: 0,
    },
    lease: null,
    shopName: null,
    ...patch,
  } as PlotView;
}

function notice(id: string, patch: Partial<Notice> = {}): Notice {
  return { id, at: 1000, kind: "system", text: "Hi", data: {}, read: false, ...patch };
}

/** Records every call; each method answers with the given value. */
function recorder<T extends object>(answers: Partial<Record<keyof T, unknown>> = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const api = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
          const answer = answers[prop as keyof T];
          return Promise.resolve(answer ?? { ok: true, value: null });
        };
      },
    },
  ) as T;
  return { api, calls };
}

const OK = <T,>(value: T): ApiResult<T> => ({ ok: true, value });

// ---------------------------------------------------------------------------
// Amounts and withdrawals
// ---------------------------------------------------------------------------

describe("amount parsing", () => {
  it("accepts whole numbers inside the bounds only", () => {
    expect(parseWhole("12", 1, 100)).toBe(12);
    expect(parseWhole(" 7 ", 1, 100)).toBe(7);
    expect(parseWhole("0", 1, 100)).toBeNull();
    expect(parseWhole("0", 0, 100)).toBe(0);
    expect(parseWhole("101", 1, 100)).toBeNull();
    expect(parseWhole("1e3", 1, 5000)).toBeNull();
    expect(parseWhole("-1", 0, 5)).toBeNull();
    expect(parseWhole("1.5", 0, 5)).toBeNull();
    expect(parseWhole("", 0, 5)).toBeNull();
    expect(parseWhole("12345678901234", 0, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("checks coin withdrawals against the balance", () => {
    expect(checkCoinWithdraw("40", 100)).toEqual({ ok: true, coin: 40 });
    const over = checkCoinWithdraw("101", 100);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toBe("You only have 100 coin.");
    expect(checkCoinWithdraw("abc", 100).ok).toBe(false);
  });

  it("sellable items are tradable and eligible", () => {
    const junk = vaultItem("u-junk", { ...SUMMARY, level: 2 });
    const locked = vaultItem("u-locked", SUMMARY, false);
    const gem = vaultItem("u-gem", GEM);
    expect(sellableItems([vaultItem("u-sword"), junk, locked, gem]).map((i) => i.uid)).toEqual([
      "u-sword",
      "u-gem",
    ]);
  });

  it("bank answers map onto ApiResult", async () => {
    expect(await bankResult(async () => ({ ok: true }))).toEqual({ ok: true, value: null });
    expect(await bankResult(async () => ({ ok: false, message: "Walk to town" }))).toEqual({
      ok: false,
      code: "bank",
      message: "Walk to town",
    });
  });
});

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

describe("market browse", () => {
  it("builds the search query from the filter form", () => {
    const built = browseQuery(
      {
        ...EMPTY_BROWSE,
        category: "weapon",
        q: "  wolf  ",
        rarity: "rare",
        minLevel: "5",
        maxLevel: "",
        sort: "price_asc",
        offset: 20,
      },
      "classic",
    );
    expect(built).toEqual({
      ok: true,
      query: {
        scope: "classic",
        category: "weapon",
        q: "wolf",
        rarity: "rare",
        minLevel: 5,
        maxLevel: undefined,
        sort: "price_asc",
        limit: 20,
        offset: 20,
      },
    });
  });

  it("rejects bad level filters", () => {
    const built = browseQuery({ ...EMPTY_BROWSE, minLevel: "lots" });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.message).toBe("Levels are whole numbers from 0 to 999.");
  });
});

describe("market sell", () => {
  it("previews the listing fee and rejects bad prices", () => {
    expect(sellFeePreview({ ...EMPTY_SELL, uid: "u1", buyout: "1000" })).toBe(20);
    expect(sellFeePreview({ ...EMPTY_SELL, uid: "u1", startBid: "100" })).toBe(2);
    expect(sellFeePreview({ ...EMPTY_SELL, uid: "u1" })).toBeNull();
    expect(checkSell({ ...EMPTY_SELL, buyout: "10" })).toEqual({
      ok: false,
      message: "Pick an item from your vault.",
    });
    expect(checkSell({ ...EMPTY_SELL, uid: "u1" }).ok).toBe(false);
    expect(checkSell({ ...EMPTY_SELL, uid: "u1", buyout: "x" }).ok).toBe(false);
    const inverted = checkSell({ ...EMPTY_SELL, uid: "u1", buyout: "50", startBid: "100" });
    expect(inverted.ok).toBe(false);
  });

  it("lists with the form's values and never calls the server for an invalid form", async () => {
    const { api, calls } = recorder<MarketApi>({ list: OK(listing()) });
    const bad = await listItem(api, { ...EMPTY_SELL, uid: "u1" });
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(0);

    const good = await listItem(api, { uid: "u1", buyout: "1000", startBid: "", durationH: 48 });
    expect(good.ok).toBe(true);
    expect(calls).toEqual([
      { name: "list", args: [{ uid: "u1", buyout: 1000, startBid: null, durationH: 48 }] },
    ]);
  });
});

describe("market bids and buys", () => {
  it("computes the bid floor from the top bid", () => {
    expect(bidFloor(listing({ startBid: 100, topBid: null }))).toBe(100);
    expect(bidFloor(listing({ startBid: 100, topBid: 200 }))).toBe(210);
    expect(bidFloor(listing({ startBid: null, topBid: null, buyout: 500 }))).toBeNull();
    expect(bidFloor(listing({ status: "sold" }))).toBeNull();
  });

  it("checks bids against the floor before sending", async () => {
    const l = listing({ startBid: 100, topBid: 200 });
    const low = checkBid(l, "209");
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.message).toBe("Bid at least 210 coin.");
    expect(checkBid(l, "210")).toEqual({ ok: true, amount: 210 });

    const { api, calls } = recorder<MarketApi>({ bid: OK(l) });
    const res = await placeBid(api, l, "150");
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
    await placeBid(api, l, "250");
    expect(calls).toEqual([{ name: "bid", args: ["classic:weapon/42", 250] }]);
  });

  it("buy confirm explains the tax and only buys buyout listings", async () => {
    const l = listing({ buyout: 1000 });
    expect(buyConfirmText(l)).toContain("1,000 coin");
    expect(buyConfirmText(l)).toContain("5 %");
    const { api, calls } = recorder<MarketApi>({ buy: OK(l) });
    expect((await buyListing(api, listing({ buyout: null }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
    await buyListing(api, l);
    expect(calls).toEqual([{ name: "buy", args: ["classic:weapon/42"] }]);
  });
});

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

describe("trade accept versions", () => {
  it("names the pair of versions the view shows", () => {
    expect(tradeVersions(trade())).toEqual([1, 2]);
  });

  it("an accept counts only for the versions it named", () => {
    const current = trade({ accepted: { a: [1, 2], b: null } });
    expect(tradeAccepts(current, "a")).toEqual({ mine: true, theirs: false });
    // The other side changed its offer after my accept: the stale pair no longer counts.
    const changed = trade({
      offers: { a: { coin: 50, items: [], version: 1 }, b: { coin: 9, items: [], version: 3 } },
      accepted: { a: [1, 2], b: null },
    });
    expect(tradeAccepts(changed, "a")).toEqual({ mine: false, theirs: false });
    expect(canAccept(changed, "a")).toBe(true);
    expect(canAccept(current, "a")).toBe(false);
  });

  it("accept sends the versions of the view", async () => {
    const view = trade({ accepted: { a: null, b: [1, 2] } });
    const { api, calls } = recorder<TradeApi>({ accept: OK(view) });
    await sendAccept(api, view);
    expect(calls).toEqual([{ name: "accept", args: [view.id, [1, 2]] }]);
  });

  it("an offer checks coin, the item cap and the balance before sending", async () => {
    const view = trade();
    const { api, calls } = recorder<TradeApi>({ offer: OK(view) });
    expect((await sendOffer(api, view, "51", [], 50)).ok).toBe(false);
    expect(calls).toHaveLength(0);
    const tooMany = Array.from({ length: 9 }, (_, i) => `u${i}`);
    expect(checkOffer("", tooMany, 0).ok).toBe(false);
    await sendOffer(api, view, "", ["u1"], 50);
    expect(calls).toEqual([{ name: "offer", args: [view.id, 0, ["u1"]] }]);
  });

  it("knows the side of the viewer and whether the trade is over", () => {
    expect(sideOf(trade(), "me")).toBe("a");
    expect(sideOf(trade(), "them")).toBe("b");
    expect(sideOf(trade(), "nobody")).toBeNull();
    expect(tradeIsOver(trade({ status: "done" }))).toBe(true);
    expect(tradeIsOver(trade({ status: "committing" }))).toBe(false);
  });

  it("status text follows the accepts and the outcome", () => {
    expect(tradeStatusText(trade(), { mine: false, theirs: false })).toContain("Set your offer");
    expect(tradeStatusText(trade(), { mine: true, theirs: false })).toContain("Waiting");
    expect(tradeStatusText(trade(), { mine: false, theirs: true })).toContain(
      "other side accepted",
    );
    expect(tradeStatusText(trade(), { mine: true, theirs: true })).toContain("Committing");
    expect(tradeStatusText(trade({ status: "done" }), null)).toBe("Trade complete.");
    expect(tradeStatusText(trade({ status: "cancelled", reason: "expired" }), null)).toBe(
      "Trade expired.",
    );
    expect(tradeStatusText(trade({ status: "failed", reason: "insufficient_funds" }), null)).toBe(
      "Trade failed: Not enough coin.",
    );
  });
});

// ---------------------------------------------------------------------------
// Plots and shops
// ---------------------------------------------------------------------------

describe("plots", () => {
  it("minimum bid is the first bid, then five percent above the top", () => {
    expect(plotMinBid(plot())).toBe(50);
    expect(
      plotMinBid(
        plot({
          auction: { startedAt: 0, endsAt: 1, minBid: 50, topBid: 100, topBidder: null, bids: 1 },
        }),
      ),
    ).toBe(105);
  });

  it("bids are checked before sending and only on plots for auction", async () => {
    expect(checkPlotBid(plot({ state: "leased", auction: null, lease: null }), "100").ok).toBe(
      false,
    );
    expect(checkPlotBid(plot(), "49").ok).toBe(false);
    const { api, calls } = recorder<ShopsApi>({ bidPlot: OK(plot()) });
    await bidPlot(api, "classic-town", plot(), "10");
    expect(calls).toHaveLength(0);
    await bidPlot(api, "classic-town", plot(), "60");
    expect(calls).toEqual([{ name: "bidPlot", args: ["classic-town", "p1", 60] }]);
    expect(plotStateLabel("grace")).toBe("Rent overdue");
  });
});

describe("shops", () => {
  it("validates the shop name", () => {
    expect(checkShopName("ab")).not.toBeNull();
    expect(checkShopName("Ember Forge_2")).toBeNull();
    expect(checkShopName("Bad/Name")).not.toBeNull();
    expect(checkShopName("x".repeat(25))).not.toBeNull();
  });

  it("configure sends the trimmed name and the open flag", async () => {
    const view = {} as ShopView;
    const { api, calls } = recorder<ShopsApi>({ configure: OK(view) });
    expect((await configureShop(api, "classic-town", "p1", "ok", true)).ok).toBe(false);
    await configureShop(api, "classic-town", "p1", "  Ember Forge  ", false);
    expect(calls).toEqual([
      { name: "configure", args: ["classic-town", "p1", { name: "Ember Forge", open: false }] },
    ]);
  });

  it("stock needs an item and a price, then sends both with the price as an integer", async () => {
    const view = {} as ShopView;
    const { api, calls } = recorder<ShopsApi>({ stock: OK(view) });
    expect((await stockItem(api, "classic-town", "p1", "", "10")).ok).toBe(false);
    expect((await stockItem(api, "classic-town", "p1", "u1", "0")).ok).toBe(false);
    expect(calls).toHaveLength(0);
    await stockItem(api, "classic-town", "p1", "u1", "120");
    expect(calls).toEqual([{ name: "stock", args: ["classic-town", "p1", "u1", 120] }]);
  });

  it("buy and confirm copy", async () => {
    const { api, calls } = recorder<ShopsApi>({ buy: OK({} as ShopView) });
    await buyFromShop(api, "classic-town", "p1", "e7");
    expect(calls).toEqual([{ name: "buy", args: ["classic-town", "p1", "e7"] }]);
    expect(shopBuyConfirmText("Ember Forge", 120)).toContain("120 coin");
  });
});

// ---------------------------------------------------------------------------
// Notices and vault loading
// ---------------------------------------------------------------------------

describe("notices", () => {
  it("links from kind and data", () => {
    expect(linkOf(notice("n1", { kind: "trade.invite", data: { tradeId: "t1" } }))).toEqual({
      kind: "trade",
      tradeId: "t1",
    });
    expect(
      linkOf(notice("n2", { kind: "market.sold", data: { listingId: "classic:weapon/3" } })),
    ).toEqual({
      kind: "market",
      listingId: "classic:weapon/3",
    });
    expect(
      linkOf(notice("n3", { kind: "shop.sold", data: { plotId: "p2", world: "classic-town" } })),
    ).toEqual({
      kind: "plot",
      world: "classic-town",
      plotId: "p2",
    });
    expect(linkOf(notice("n4", { kind: "arena.defended", data: { matchId: "m9" } }))).toEqual({
      kind: "arena",
      matchId: "m9",
    });
    expect(linkOf(notice("n5", { kind: "system", data: { tradeId: "t1" } }))).toBeNull();
    expect(linkOf(notice("n6", { kind: "trade.done", data: {} }))).toBeNull();
  });

  it("counts unread, sorts newest first and marks read up to the newest", async () => {
    const list = [
      notice("a", { at: 5, read: true }),
      notice("b", { at: 9 }),
      notice("c", { at: 7 }),
    ];
    expect(unreadCount(list)).toBe(2);
    expect(newestFirst(list).map((n) => n.id)).toEqual(["b", "c", "a"]);
    expect(newestNoticeId(list)).toBe("b");

    const { api, calls } = recorder<VaultApi>({ markRead: OK({ marked: 2 }) });
    await markAllRead(api, list);
    expect(calls).toEqual([{ name: "markRead", args: ["b"] }]);
    const none = recorder<VaultApi>();
    expect(await markAllRead(none.api, [])).toEqual({ ok: true, value: { marked: 0 } });
    expect(none.calls).toHaveLength(0);
  });
});

describe("loading and copy", () => {
  it("loadResult never rejects", async () => {
    const state = await loadResult(async (): Promise<ApiResult<number>> => {
      throw new Error("boom");
    });
    expect(state.status).toBe("error");
    expect(await loadResult(async () => OK(3))).toEqual({ status: "ready", value: 3 });
  });

  it("formats time left, coin, initials and error copy", () => {
    const now = 1_000_000_000;
    expect(formatTimeLeft(now - 1, now)).toBe("ended");
    expect(formatTimeLeft(now + 30_000, now)).toBe("<1m");
    expect(formatTimeLeft(now + 12 * 60_000, now)).toBe("12m");
    expect(formatTimeLeft(now + (3 * 60 + 10) * 60_000, now)).toBe("3h 10m");
    expect(formatTimeLeft(now + (50 * 60 + 5) * 60_000, now)).toBe("2d 2h");
    expect(formatCoin(1234)).toBe("1,234 coin");
    expect(initials("Iron Wolf Sword")).toBe("IW");
    expect(initials("Solo")).toBe("SO");
    expect(initials("")).toBe("?");
    expect(economyErrorText("vault_full")).toBe("Your vault is full.");
    expect(economyErrorText("weird", "Server says no")).toBe("Server says no");
    expect(economyErrorText("weird")).toBe("Something went wrong. Try again.");
    expect(rarityColor("unique")).not.toBe(rarityColor("rare"));
  });
});
