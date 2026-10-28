/**
 * Shell screens (wave C, docs/design/wave-C.md §10.4): what the picker bar and
 * the running modes can open as sheets, the stack rules, and the feature-flag
 * gating. Pure: no React, no DOM, so it is unit-tested under node.
 */
import type { FeatureFlag, ItemCategory, Notice as InboxNotice } from "@gamez/protocol";
import type { PlatformScreen, PlatformServices } from "@gamez/ui-host";

/** The classic town: the world with the shop plots and the shopkeeper ghosts. */
export const TOWN_WORLD = "classic-town";
/** The arena ladder shown from the picker (the classic mode's ladder). */
export const ARENA_MODE = "classic";

/** Market with the one extra field the vault's "Sell" row passes on. */
export interface MarketItem {
  id: "market";
  category?: ItemCategory;
  q?: string;
  sellUid?: string;
}

/** The account-level sheets that predate wave C (wave B). */
export type SocialItem = { id: "account" } | { id: "leaderboards" } | { id: "guild" };

/** Anything the shell stacks as a sheet. Every PlatformScreen is one. */
export type ShellItem = Exclude<PlatformScreen, { id: "market" }> | MarketItem | SocialItem;

/** Picker bar entries (the notices bell included). */
export type EntryId =
  | "market"
  | "vault"
  | "trade"
  | "shops"
  | "arena"
  | "pass"
  | "store"
  | "notices";

/** Feature flags as the config endpoint returns them. null = not loaded or failed (fail open). */
export type FlagMap = Partial<Record<FeatureFlag, boolean>>;

export const ENTRY_ORDER: readonly EntryId[] = [
  "market",
  "vault",
  "trade",
  "shops",
  "arena",
  "pass",
  "store",
  "notices",
];

const ENTRY_LABEL: Readonly<Record<EntryId, string>> = {
  market: "Market",
  vault: "Vault",
  trade: "Trade",
  shops: "Shops",
  arena: "Arena",
  pass: "Battle Pass",
  store: "Store",
  notices: "Notices",
};

/** The flag that switches an entry off (absent = always on). */
const ENTRY_FLAG: Partial<Record<EntryId, FeatureFlag>> = {
  market: "market",
  trade: "trade",
  shops: "shops",
  arena: "arena",
  pass: "pass",
  store: "store",
};

export function entryLabel(id: EntryId): string {
  return ENTRY_LABEL[id];
}

/** A flag is on unless the config says otherwise; no config means every feature is on. */
export function flagOn(flags: FlagMap | null, flag: FeatureFlag | undefined): boolean {
  if (flag === undefined || flags === null) return true;
  return flags[flag] !== false;
}

/** Whether the platform has the API an entry needs (an absent API hides its button). */
function hasApi(platform: PlatformServices, id: EntryId): boolean {
  switch (id) {
    case "market":
      return platform.market !== undefined;
    case "vault":
    case "notices":
      return platform.vault !== undefined;
    case "trade":
      return platform.trade !== undefined;
    case "shops":
      return platform.shops !== undefined;
    case "arena":
      return platform.arena !== undefined;
    case "pass":
      return platform.pass !== undefined;
    case "store":
      return platform.store !== undefined;
  }
}

/** The picker bar entries to show, in bar order. Offline (no platform) shows none. */
export function visibleEntries(
  platform: PlatformServices | undefined,
  flags: FlagMap | null,
): EntryId[] {
  if (!platform) return [];
  return ENTRY_ORDER.filter((id) => hasApi(platform, id) && flagOn(flags, ENTRY_FLAG[id]));
}

/** The sheet an entry opens. */
export function entryItem(id: EntryId): ShellItem {
  switch (id) {
    case "market":
      return { id: "market" };
    case "vault":
      return { id: "vault" };
    case "trade":
      return { id: "trade" };
    case "shops":
      return { id: "plots", world: TOWN_WORLD };
    case "arena":
      return { id: "arena", mode: ARENA_MODE };
    case "pass":
      return { id: "pass" };
    case "store":
      return { id: "store" };
    case "notices":
      return { id: "notices" };
  }
}

/** The feature flag a sheet depends on (absent = none). */
export function screenFlag(item: ShellItem): FeatureFlag | undefined {
  switch (item.id) {
    case "market":
      return "market";
    case "trade":
      return "trade";
    case "plots":
    case "shop":
      return "shops";
    case "arena":
      return "arena";
    case "pass":
      return "pass";
    case "store":
      return "store";
    default:
      return undefined;
  }
}

/**
 * Pushes a sheet. A sheet already in the stack is replaced in place and
 * everything above it is dropped, so the back path never shows a duplicate.
 */
export function pushItem(stack: readonly ShellItem[], item: ShellItem): ShellItem[] {
  const at = stack.findIndex((s) => s.id === item.id);
  return at < 0 ? [...stack, item] : [...stack.slice(0, at), item];
}

/** Title shown in the sheet header. */
export function itemTitle(item: ShellItem): string {
  switch (item.id) {
    case "market":
      return "Market";
    case "vault":
      return "Vault";
    case "trade":
      return "Trade";
    case "plots":
      return "Shops";
    case "shop":
      return "Shop";
    case "arena":
      return "Arena";
    case "pass":
      return "Battle Pass";
    case "store":
      return "Store";
    case "notices":
      return "Notices";
    case "account":
      return "Account";
    case "leaderboards":
      return "Leaderboards";
    case "guild":
      return "Guild";
  }
}

/** Where a notice leads when the player opens it (null = nothing to open). */
export function noticeTarget(n: Pick<InboxNotice, "kind" | "data">): ShellItem | null {
  if (n.kind.startsWith("trade.")) {
    const tradeId = n.data["tradeId"];
    return typeof tradeId === "string" && tradeId.length > 0
      ? { id: "trade", tradeId }
      : { id: "trade" };
  }
  if (n.kind.startsWith("market.")) return { id: "market" };
  if (n.kind.startsWith("shop.") || n.kind.startsWith("plot.")) {
    return { id: "plots", world: TOWN_WORLD };
  }
  return null;
}
