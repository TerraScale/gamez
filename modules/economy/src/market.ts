/**
 * Auction house rules (wave-C.md §4). CONTRACT (architect, implemented).
 */
import type { ItemCategory, ItemSummary, VaultItem } from "@gamez/protocol";

/** "high-level items" (plan §5): equipment needs item level >= 10; gems, materials, cosmetics always. */
export const MARKET_MIN_LEVEL = 10;
export const MARKET_MAX_ACTIVE_PER_ACCOUNT = 20;
export const MARKET_DURATIONS_H = [12, 24, 48] as const;
export const MARKET_MAX_PRICE = 1_000_000_000;

const ALWAYS: readonly ItemCategory[] = ["gem", "material", "cosmetic"];

export function marketEligible(summary: ItemSummary): boolean {
  return ALWAYS.includes(summary.category) || summary.level >= MARKET_MIN_LEVEL;
}

/** Scope of an item: "universal" or its origin mode. */
export function marketScope(item: Pick<VaultItem, "universal" | "origin">): string {
  return item.universal || item.origin === "" ? "universal" : item.origin;
}

/** MarketDO name for an item: "<scope>:<category>", e.g. "classic:weapon". */
export function marketShard(item: Pick<VaultItem, "universal" | "origin" | "summary">): string {
  return `${marketScope(item)}:${item.summary.category}`;
}

/** Splits "<shard>/<seq>" (listing id) into its shard; null when malformed. */
export function shardOfListing(listingId: string): string | null {
  const i = listingId.lastIndexOf("/");
  if (i <= 0) return null;
  const shard = listingId.slice(0, i);
  return /^[a-z0-9_-]{1,32}:[a-z]{1,16}$/.test(shard) && /^\d{1,12}$/.test(listingId.slice(i + 1))
    ? shard
    : null;
}
