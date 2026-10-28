/**
 * Fees and taxes: the sinks of the player economy (plan §5). CONTRACT
 * (architect, implemented). All inputs and outputs are non-negative integers
 * (coin). Change a number here and every DO applies it; tests pin them.
 */

/** Auction house listing fee: 2 % of the buyout (or of the start bid), min 1. Never refunded. */
export const LISTING_FEE_PCT = 2;
/** Auction house sales tax on the final price: 5 %, paid by the seller (deducted from proceeds). */
export const SALES_TAX_PCT = 5;
/** Player shop sales tax: 3 % (lower than the AH: the shop already pays rent). */
export const SHOP_TAX_PCT = 3;
/** Direct trade fee on coin sent: 2 %, paid by the sender on top of the amount (items are free). */
export const TRADE_FEE_PCT = 2;
/** A new bid must beat the top bid by at least 5 % (and at least 1 coin). */
export const MIN_BID_STEP_PCT = 5;

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

/** True for a positive safe integer not above `max`. */
export function isAmount(v: unknown, max = 1_000_000_000): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max;
}
