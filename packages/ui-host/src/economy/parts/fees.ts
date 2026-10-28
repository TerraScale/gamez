/**
 * Fee, tax and eligibility previews for the economy UI (wave-C.md §4, §5).
 * COPIED from modules/economy/src/fees.ts and market.ts, which stay the source
 * of truth (the server applies them). ui-host may not depend on @gamez/economy,
 * so these formulas live here; tests/economy.fees.test.tsx pins them against the
 * source. Change both files together.
 */
import type { ItemCategory } from "@gamez/protocol";

/** Auction house listing fee: 2 % of the buyout (or of the start bid), min 1. Never refunded. */
export const LISTING_FEE_PCT = 2;
/** Auction house sales tax on the final price: 5 %, deducted from the seller's proceeds. */
export const SALES_TAX_PCT = 5;
/** Player shop sales tax: 3 %. */
export const SHOP_TAX_PCT = 3;
/** Direct trade fee on coin sent: 2 %, paid by the sender on top of the amount. */
export const TRADE_FEE_PCT = 2;
/** A new bid must beat the top bid by at least 5 % (and at least 1 coin). */
export const MIN_BID_STEP_PCT = 5;

/** Equipment needs item level >= 10 to be listed; gems, materials and cosmetics always qualify. */
export const MARKET_MIN_LEVEL = 10;
export const MARKET_MAX_ACTIVE_PER_ACCOUNT = 20;
export const MARKET_DURATIONS_H = [12, 24, 48] as const;
export type MarketDuration = (typeof MARKET_DURATIONS_H)[number];
export const MARKET_MAX_PRICE = 1_000_000_000;

const ALWAYS_ELIGIBLE: readonly ItemCategory[] = ["gem", "material", "cosmetic"];

const pct = (amount: number, p: number): number => Math.floor((amount * p) / 100);

export function listingFee(buyout: number | null, startBid: number | null): number {
  const base = buyout ?? startBid ?? 0;
  return Math.max(1, pct(base, LISTING_FEE_PCT));
}

export function salesTax(price: number): number {
  return price <= 0 ? 0 : Math.max(1, pct(price, SALES_TAX_PCT));
}

export function shopTax(price: number): number {
  return price <= 0 ? 0 : Math.max(1, pct(price, SHOP_TAX_PCT));
}

export function tradeFee(coinSent: number): number {
  return coinSent <= 0 ? 0 : Math.max(1, pct(coinSent, TRADE_FEE_PCT));
}

/** Lowest acceptable next bid given the current top bid (null = none yet) and the start bid. */
export function minNextBid(topBid: number | null, startBid: number): number {
  if (topBid === null) return Math.max(1, startBid);
  return topBid + Math.max(1, pct(topBid, MIN_BID_STEP_PCT));
}

/** Mirrors marketEligible(summary) of modules/economy/src/market.ts. */
export function marketEligible(item: { category: ItemCategory; level: number }): boolean {
  return ALWAYS_ELIGIBLE.includes(item.category) || item.level >= MARKET_MIN_LEVEL;
}
