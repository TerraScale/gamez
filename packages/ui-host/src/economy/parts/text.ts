/**
 * Plain-words copy and small formatters for the economy components. Pure
 * functions, unit-tested without React (tests/economy.text.test.tsx).
 */
import type { ItemCategory, PlotState, TradeView, VaultWaiting } from "@gamez/protocol";

/** Error code -> words. A server message wins when present (see useAction). */
export function economyErrorText(code: string, fallback?: string): string {
  switch (code) {
    case "bad_request":
      return "Check the values and try again.";
    case "unauthorized":
      return "Sign in to continue.";
    case "guest_forbidden":
      return "Create an account to trade.";
    case "disabled":
      return "This is turned off right now.";
    case "not_found":
      return "That no longer exists.";
    case "forbidden":
      return "You cannot do that.";
    case "insufficient_funds":
      return "Not enough coin.";
    case "not_tradable":
      return "That item cannot be traded.";
    case "not_eligible":
      return "That item cannot be listed on the market.";
    case "vault_full":
      return "Your vault is full.";
    case "no_room":
      return "There is no room for that.";
    case "too_many":
      return "Too many active items or listings.";
    case "too_low":
      return "That amount is too low.";
    case "expired":
      return "That has already expired.";
    case "closed":
      return "That is closed right now.";
    case "conflict":
      return "Something changed. Refresh and try again.";
    case "busy":
      return "Busy with another action. Try again in a moment.";
    case "not_in_town":
      return "Walk back to town first.";
    case "wrong_origin":
      return "That item can only go back to the mode it came from.";
    case "rate_limited":
      return "Slow down a little, then try again.";
    case "network":
      return "Network error, try again.";
    case "unavailable":
      return "Not available right now.";
    case "bad_response":
      return "Unexpected answer from the server.";
    case "internal":
      return "Something went wrong on our side. Try again.";
    default:
      return fallback || "Something went wrong. Try again.";
  }
}

/** Whole coin with a thousands separator: "1,250 coin". */
export function formatCoin(amount: number): string {
  return `${amount.toLocaleString("en-US")} coin`;
}

/** Time left until `endsAt` (epoch ms) from `now`: "2d 4h", "3h 10m", "12m", "<1m", or "ended". */
export function formatTimeLeft(endsAt: number, now: number): string {
  const ms = endsAt - now;
  if (ms <= 0) return "ended";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** UTC date and time, stable across time zones: "2026-10-28 14:05 UTC". */
export function formatWhen(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const RARITIES: readonly string[] = ["common", "normal", "magic", "rare", "set", "unique"];

export function rarityLabel(rarity: string): string {
  return rarity ? rarity.charAt(0).toUpperCase() + rarity.slice(1) : "Common";
}

/** Rarity colour (text and border). Classic ids plus the generic "common". */
export function rarityColor(rarity: string): string {
  switch (rarity) {
    case "magic":
      return "#7aa7ff";
    case "rare":
      return "#f2d45c";
    case "set":
      return "#7fbf6a";
    case "unique":
      return "#d68a4f";
    case "normal":
    case "common":
    default:
      return "#c9bfa9";
  }
}

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  weapon: "Weapons",
  armor: "Armor",
  jewelry: "Jewelry",
  gem: "Gems",
  material: "Materials",
  consumable: "Consumables",
  cosmetic: "Cosmetics",
  other: "Other",
};

export function categoryLabel(category: ItemCategory): string {
  return CATEGORY_LABELS[category];
}

/** Two letters for a badge from a display name: "Iron Wolf Sword" -> "IW". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.charAt(0) ?? "";
  const second = words.length > 1 ? (words[1]?.charAt(0) ?? "") : (words[0]?.charAt(1) ?? "");
  return (first + second).toUpperCase();
}

export function plotStateLabel(state: PlotState): string {
  switch (state) {
    case "auction":
      return "For auction";
    case "leased":
      return "Leased";
    case "grace":
      return "Rent overdue";
  }
}

/** Trade status banner text. `accepts` comes from tradeAccepts() in flows.ts (current versions only). */
export function tradeStatusText(
  view: TradeView,
  accepts: { mine: boolean; theirs: boolean } | null,
): string {
  switch (view.status) {
    case "open": {
      if (!accepts) return "Watching this trade.";
      if (accepts.mine && accepts.theirs) return "Both accepted. Committing…";
      if (accepts.mine) return "You accepted. Waiting for the other side.";
      if (accepts.theirs) return "The other side accepted. Check the offer, then accept.";
      return "Set your offer, then accept when both sides are ready.";
    }
    case "committing":
      return "Committing the trade…";
    case "done":
      return "Trade complete.";
    case "cancelled":
      return view.reason === "expired" ? "Trade expired." : "Trade cancelled.";
    case "failed":
      return view.reason
        ? `Trade failed: ${economyErrorText(view.reason, view.reason)}`
        : "Trade failed. Nothing changed hands.";
  }
}

/**
 * The vault banner for deliveries held because the vault was full (trade,
 * market, shop or bank). Null when nothing waits.
 */
export function vaultWaitingText(waiting: VaultWaiting | undefined): string | null {
  if (!waiting || waiting.count <= 0) return null;
  const what = waiting.count === 1 ? "1 delivery is" : `${waiting.count} deliveries are`;
  return `Your vault is full: ${what} waiting for a free slot. Withdraw or sell an item and they arrive on their own (within the hour).`;
}
