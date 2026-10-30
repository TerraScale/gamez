/**
 * Pure flows behind the economy components (wave-C.md §3-§5, §10.2). Each
 * takes the platform interface it needs and returns a plain ApiResult, so the
 * React layer stays thin and the flows are unit-tested with fake services
 * (tests/economy.flows.test.tsx). Client-side checks are only a convenience:
 * the server stays authoritative.
 */
import {
  TRADE_MAX_ITEMS,
  type ItemCategory,
  type MarketListing,
  type MarketSearchQuery,
  type Notice,
  type PlotView,
  type ShopConfigureRequest,
  type ShopView,
  type TradeView,
  type VaultItem,
} from "@gamez/protocol";
import type { ApiResult, MarketApi, ShopsApi, TradeApi, VaultApi } from "../../platform.ts";
import { toLoadState, type LoadState } from "../../social/flows.ts";
import {
  MARKET_MAX_PRICE,
  listingFee,
  marketEligible,
  minNextBid,
  tradeFee,
  type MarketDuration,
} from "./fees.ts";
import { formatCoin } from "./text.ts";

export type { LoadState };

export type Fail = { ok: false; message: string };

/** Loads through a platform call; never rejects (network throws become an error state). */
export async function loadResult<T>(fn: () => Promise<ApiResult<T>>): Promise<LoadState<T>> {
  try {
    return toLoadState(await fn());
  } catch {
    return { status: "error", message: "Could not reach the server." };
  }
}

/** A whole number from user text: digits only, between min and max. null when invalid. */
export function parseWhole(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (!/^\d{1,12}$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

// ---------------------------------------------------------------------------
// Vault and bank
// ---------------------------------------------------------------------------

/** Coin to withdraw from the account: a whole number within the balance. */
export function checkCoinWithdraw(raw: string, balance: number): { ok: true; coin: number } | Fail {
  const coin = parseWhole(raw, 1, MARKET_MAX_PRICE);
  if (coin === null) return { ok: false, message: "Enter a whole number of coin." };
  if (coin > balance) return { ok: false, message: `You only have ${formatCoin(balance)}.` };
  return { ok: true, coin };
}

/** Items that may be listed on the auction house. */
export function sellableItems(items: readonly VaultItem[]): VaultItem[] {
  return items.filter((item) => item.tradable && marketEligible(item.summary));
}

/** Items that may be stocked in a shop or offered in a trade. */
export function tradableItems(items: readonly VaultItem[]): VaultItem[] {
  return items.filter((item) => item.tradable);
}

/** The bank answers {ok, message?}; this maps it onto ApiResult for the shared action state. */
export async function bankResult(
  call: () => Promise<{ ok: boolean; message?: string }>,
): Promise<ApiResult<null>> {
  const res = await call();
  return res.ok
    ? { ok: true, value: null }
    : { ok: false, code: "bank", message: res.message || "The bank could not do that." };
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

export type LinkTarget =
  | { kind: "trade"; tradeId: string }
  | { kind: "market"; listingId: string }
  | { kind: "plot"; world: string | null; plotId: string }
  | { kind: "arena"; matchId: string }
  | { kind: "vault" }
  | { kind: "store"; orderId: string | null };

function dataString(notice: Notice, key: string): string | null {
  const value = notice.data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Where a notice links, from its kind and data keys; null when it links nowhere. */
export function linkOf(notice: Notice): LinkTarget | null {
  if (notice.kind.startsWith("trade.")) {
    const tradeId = dataString(notice, "tradeId");
    return tradeId ? { kind: "trade", tradeId } : null;
  }
  if (notice.kind.startsWith("market.")) {
    const listingId = dataString(notice, "listingId");
    return listingId ? { kind: "market", listingId } : null;
  }
  if (notice.kind.startsWith("shop.") || notice.kind.startsWith("plot.")) {
    const plotId = dataString(notice, "plotId");
    return plotId ? { kind: "plot", world: dataString(notice, "world"), plotId } : null;
  }
  if (notice.kind.startsWith("arena.")) {
    const matchId = dataString(notice, "matchId");
    return matchId ? { kind: "arena", matchId } : null;
  }
  // A full vault holds deliveries: Open shows the vault (and its waiting banner).
  if (notice.kind === "vault.full") return { kind: "vault" };
  if (notice.kind.startsWith("store."))
    return { kind: "store", orderId: dataString(notice, "orderId") };
  return null;
}

export function unreadCount(notices: readonly Notice[]): number {
  return notices.reduce((n, notice) => (notice.read ? n : n + 1), 0);
}

/** Notices newest first (the API answers oldest first). */
export function newestFirst(notices: readonly Notice[]): Notice[] {
  return [...notices].sort((a, b) => b.at - a.at);
}

/** Id of the newest notice (by `at`), or null for an empty list. */
export function newestNoticeId(notices: readonly Notice[]): string | null {
  let best: Notice | null = null;
  for (const notice of notices) if (!best || notice.at >= best.at) best = notice;
  return best ? best.id : null;
}

/** Marks everything up to the newest notice read. Nothing to mark: ok with marked 0. */
export async function markAllRead(
  vault: VaultApi,
  notices: readonly Notice[],
): Promise<ApiResult<{ marked: number }>> {
  const upTo = newestNoticeId(notices);
  if (!upTo) return { ok: true, value: { marked: 0 } };
  return vault.markRead(upTo);
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export const BROWSE_SORTS = [
  { id: "newest", label: "Newest" },
  { id: "ending", label: "Ending soon" },
  { id: "price_asc", label: "Price: low to high" },
  { id: "price_desc", label: "Price: high to low" },
] as const;

export type BrowseSort = (typeof BROWSE_SORTS)[number]["id"];

/** Listings per page in the browse tab. */
export const MARKET_PAGE = 20;

export interface BrowseForm {
  category: ItemCategory | "";
  q: string;
  rarity: string;
  minLevel: string;
  maxLevel: string;
  sort: BrowseSort;
  offset: number;
}

export const EMPTY_BROWSE: BrowseForm = {
  category: "",
  q: "",
  rarity: "",
  minLevel: "",
  maxLevel: "",
  sort: "newest",
  offset: 0,
};

/** The search query a browse form means (display only: D1 search). */
export function browseQuery(
  form: BrowseForm,
  scope?: string,
): { ok: true; query: MarketSearchQuery } | Fail {
  const minLevel = form.minLevel.trim() ? parseWhole(form.minLevel, 0, 999) : undefined;
  const maxLevel = form.maxLevel.trim() ? parseWhole(form.maxLevel, 0, 999) : undefined;
  if (minLevel === null || maxLevel === null) {
    return { ok: false, message: "Levels are whole numbers from 0 to 999." };
  }
  const q = form.q.trim().slice(0, 40);
  return {
    ok: true,
    query: {
      scope,
      category: form.category || undefined,
      q: q || undefined,
      rarity: form.rarity || undefined,
      minLevel,
      maxLevel,
      sort: form.sort,
      limit: MARKET_PAGE,
      offset: form.offset,
    },
  };
}

export interface SellForm {
  uid: string;
  buyout: string;
  startBid: string;
  durationH: MarketDuration;
}

export const EMPTY_SELL: SellForm = { uid: "", buyout: "", startBid: "", durationH: 24 };

export type SellCheck =
  | {
      ok: true;
      req: {
        uid: string;
        buyout: number | null;
        startBid: number | null;
        durationH: MarketDuration;
      };
      fee: number;
    }
  | Fail;

/** An optional price: null when blank, undefined when present but invalid. */
function optionalPrice(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  return parseWhole(text, 1, MARKET_MAX_PRICE) ?? undefined;
}

/** Validates a sell form and computes the listing fee the server will charge. */
export function checkSell(form: SellForm): SellCheck {
  if (!form.uid) return { ok: false, message: "Pick an item from your vault." };
  const buyout = optionalPrice(form.buyout);
  const startBid = optionalPrice(form.startBid);
  if (buyout === undefined || startBid === undefined) {
    return { ok: false, message: "Prices are whole numbers of coin." };
  }
  if (buyout === null && startBid === null) {
    return { ok: false, message: "Set a buyout price, a start bid, or both." };
  }
  if (buyout !== null && startBid !== null && buyout < startBid) {
    return { ok: false, message: "The buyout must be at least the start bid." };
  }
  return {
    ok: true,
    req: { uid: form.uid, buyout, startBid, durationH: form.durationH },
    fee: listingFee(buyout, startBid),
  };
}

/** Listing fee for the form as typed (null while the form is not valid yet). */
export function sellFeePreview(form: SellForm): number | null {
  const check = checkSell(form);
  return check.ok ? check.fee : null;
}

export function listItem(market: MarketApi, form: SellForm): Promise<ApiResult<MarketListing>> {
  const check = checkSell(form);
  if (!check.ok) return Promise.resolve({ ok: false, code: "bad_request", message: check.message });
  return market.list(check.req);
}

/** Lowest bid the listing accepts, or null when it takes no bids (buyout only, or no longer active). */
export function bidFloor(listing: MarketListing): number | null {
  if (listing.status !== "active") return null;
  if (listing.startBid === null && listing.topBid === null) return null;
  return minNextBid(listing.topBid, listing.startBid ?? 1);
}

export function checkBid(listing: MarketListing, raw: string): { ok: true; amount: number } | Fail {
  const floor = bidFloor(listing);
  if (floor === null) return { ok: false, message: "This listing only sells at its buyout." };
  const amount = parseWhole(raw, 1, MARKET_MAX_PRICE);
  if (amount === null) return { ok: false, message: "Enter a whole number of coin." };
  if (amount < floor) return { ok: false, message: `Bid at least ${formatCoin(floor)}.` };
  return { ok: true, amount };
}

export function placeBid(
  market: MarketApi,
  listing: MarketListing,
  raw: string,
): Promise<ApiResult<MarketListing>> {
  const check = checkBid(listing, raw);
  if (!check.ok) return Promise.resolve({ ok: false, code: "too_low", message: check.message });
  return market.bid(listing.id, check.amount);
}

export function canBuyOut(listing: MarketListing): boolean {
  return listing.status === "active" && listing.buyout !== null;
}

/** Confirm text for a buyout: the buyer pays the price, the tax comes from the seller. */
export function buyConfirmText(listing: MarketListing): string {
  const price = listing.buyout ?? 0;
  return `Buy for ${formatCoin(price)}? Coin leaves your account now. The 5 % sales tax comes out of the seller's proceeds, not yours.`;
}

export function buyListing(
  market: MarketApi,
  listing: MarketListing,
): Promise<ApiResult<MarketListing>> {
  if (!canBuyOut(listing)) {
    return Promise.resolve({ ok: false, code: "closed", message: "This cannot be bought now." });
  }
  return market.buy(listing.id);
}

export function cancelListing(
  market: MarketApi,
  listingId: string,
): Promise<ApiResult<MarketListing>> {
  return market.cancel(listingId);
}

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

export type Side = "a" | "b";

export function sideOf(view: TradeView, selfId: string): Side | null {
  if (view.a.accountId === selfId) return "a";
  if (view.b.accountId === selfId) return "b";
  return null;
}

export function otherSide(side: Side): Side {
  return side === "a" ? "b" : "a";
}

/** The version pair both offers have right now (what an accept names). */
export function tradeVersions(view: TradeView): [number, number] {
  return [view.offers.a.version, view.offers.b.version];
}

/**
 * Who has accepted the CURRENT versions. An accept names the pair it saw, so
 * an accept made before an offer changed no longer counts.
 */
export function tradeAccepts(view: TradeView, side: Side): { mine: boolean; theirs: boolean } {
  const current = tradeVersions(view);
  const same = (pair: [number, number] | null) =>
    pair !== null && pair[0] === current[0] && pair[1] === current[1];
  return {
    mine: same(view.accepted[side]),
    theirs: same(view.accepted[otherSide(side)]),
  };
}

export function tradeIsOver(view: TradeView): boolean {
  return view.status === "done" || view.status === "cancelled" || view.status === "failed";
}

/** Accepting is allowed while open and when this side has not accepted the current versions. */
export function canAccept(view: TradeView, side: Side): boolean {
  return view.status === "open" && !tradeAccepts(view, side).mine;
}

export function canEditOffer(view: TradeView, side: Side | null): boolean {
  return view.status === "open" && side !== null;
}

/** Coin and item picks of the offer editor, checked before they are sent. */
export function checkOffer(
  coinRaw: string,
  uids: readonly string[],
  balance: number,
): { ok: true; coin: number; uids: string[] } | Fail {
  let coin = 0;
  if (coinRaw.trim()) {
    const parsed = parseWhole(coinRaw, 1, MARKET_MAX_PRICE);
    if (parsed === null) return { ok: false, message: "Coin is a whole number." };
    coin = parsed;
  }
  if (coin > balance) return { ok: false, message: `You only have ${formatCoin(balance)}.` };
  if (uids.length > TRADE_MAX_ITEMS) {
    return { ok: false, message: `Up to ${TRADE_MAX_ITEMS} items per trade.` };
  }
  return { ok: true, coin, uids: [...uids] };
}

/** Fee the server will take on the coin this side sends (preview; the view carries the server's figure). */
export function offerFeePreview(coinRaw: string): number {
  const coin = parseWhole(coinRaw || "0", 0, MARKET_MAX_PRICE) ?? 0;
  return tradeFee(coin);
}

export function sendOffer(
  trade: TradeApi,
  view: TradeView,
  coinRaw: string,
  uids: readonly string[],
  balance: number,
): Promise<ApiResult<TradeView>> {
  const check = checkOffer(coinRaw, uids, balance);
  if (!check.ok) return Promise.resolve({ ok: false, code: "bad_request", message: check.message });
  return trade.offer(view.id, check.coin, check.uids);
}

/** Accepts the offers exactly as this view shows them (versions are checked by the server). */
export function sendAccept(trade: TradeApi, view: TradeView): Promise<ApiResult<TradeView>> {
  return trade.accept(view.id, tradeVersions(view));
}

// ---------------------------------------------------------------------------
// Plots and shops
// ---------------------------------------------------------------------------

/** Lowest bid a plot accepts (the first bid is the minimum; later bids beat the top by 5 %). */
export function plotMinBid(plot: PlotView): number {
  if (!plot.auction) return 1;
  return minNextBid(plot.auction.topBid, plot.auction.minBid);
}

export function checkPlotBid(plot: PlotView, raw: string): { ok: true; amount: number } | Fail {
  if (plot.state !== "auction" || !plot.auction) {
    return { ok: false, message: "This plot is not for auction right now." };
  }
  const amount = parseWhole(raw, 1, MARKET_MAX_PRICE);
  if (amount === null) return { ok: false, message: "Enter a whole number of coin." };
  const floor = plotMinBid(plot);
  if (amount < floor) return { ok: false, message: `Bid at least ${formatCoin(floor)}.` };
  return { ok: true, amount };
}

export function bidPlot(
  shops: ShopsApi,
  world: string,
  plot: PlotView,
  raw: string,
): Promise<ApiResult<PlotView>> {
  const check = checkPlotBid(plot, raw);
  if (!check.ok) return Promise.resolve({ ok: false, code: "too_low", message: check.message });
  return shops.bidPlot(world, plot.id, check.amount);
}

/** Shop display name: 3 to 24 of letters, digits, space, apostrophe, underscore, hyphen. */
export const SHOP_NAME_RE = /^[A-Za-z0-9 '_-]{3,24}$/;

/** null when the name is fine, else the reason. */
export function checkShopName(name: string): string | null {
  const text = name.trim();
  if (SHOP_NAME_RE.test(text)) return null;
  return "Shop names are 3 to 24 letters, digits, spaces, apostrophes, _ or -.";
}

export function configureShop(
  shops: ShopsApi,
  world: string,
  plotId: string,
  name: string,
  open: boolean,
): Promise<ApiResult<ShopView>> {
  const problem = checkShopName(name);
  if (problem) return Promise.resolve({ ok: false, code: "bad_request", message: problem });
  const req: ShopConfigureRequest = { name: name.trim(), open };
  return shops.configure(world, plotId, req);
}

export function checkStockPrice(raw: string): { ok: true; price: number } | Fail {
  const price = parseWhole(raw, 1, MARKET_MAX_PRICE);
  if (price === null) return { ok: false, message: "Set a price in whole coin." };
  return { ok: true, price };
}

export function stockItem(
  shops: ShopsApi,
  world: string,
  plotId: string,
  uid: string,
  priceRaw: string,
): Promise<ApiResult<ShopView>> {
  if (!uid) return Promise.resolve({ ok: false, code: "bad_request", message: "Pick an item." });
  const check = checkStockPrice(priceRaw);
  if (!check.ok) return Promise.resolve({ ok: false, code: "bad_request", message: check.message });
  return shops.stock(world, plotId, uid, check.price);
}

export function unstockItem(
  shops: ShopsApi,
  world: string,
  plotId: string,
  entryId: string,
): Promise<ApiResult<ShopView>> {
  return shops.unstock(world, plotId, entryId);
}

export function buyFromShop(
  shops: ShopsApi,
  world: string,
  plotId: string,
  entryId: string,
): Promise<ApiResult<ShopView>> {
  return shops.buy(world, plotId, entryId);
}

export function claimEarnings(
  shops: ShopsApi,
  world: string,
  plotId: string,
): Promise<ApiResult<ShopView>> {
  return shops.claim(world, plotId);
}

/** Confirm text for buying a shop entry. */
export function shopBuyConfirmText(name: string, price: number): string {
  return `Buy ${name} for ${formatCoin(price)}? Coin leaves your account now. The 3 % shop tax comes out of the owner's earnings.`;
}
