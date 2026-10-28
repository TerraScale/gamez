/**
 * Shop plot leases (wave-C.md §5). CONTRACT (architect, implemented).
 * Times in ms. A dev host may scale them with PlotAuctionApi.devAdvance (clock offset), never by changing these.
 */
export const PLOT_AUCTION_MS = 30 * 60_000;
export const PLOT_LEASE_MS = 7 * 24 * 3600_000;
export const RENT_PERIOD_MS = 24 * 3600_000;
export const RENT_GRACE_MS = 24 * 3600_000;
/** While in grace, rent is retried this often. */
export const RENT_RETRY_MS = 3600_000;
export const PLOT_MIN_BID = 100;
/** Rent per period: 10 % of the winning bid, min 20. */
export function plotRent(winningBid: number): number {
  return Math.max(20, Math.floor(winningBid / 10));
}
/** One plot per account in wave C (plan §14 tunes it later). */
export const PLOTS_PER_ACCOUNT = 1;
