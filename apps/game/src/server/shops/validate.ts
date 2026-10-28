/**
 * Pure rules of the shop logic (wave-C.md §5.3): shop names and looks, the
 * shopkeeper fixture tag and the economy_sale scope. No Workers or DOM APIs.
 */
import type { VaultItem } from "@gamez/protocol";

/** 3-24 chars of letters, digits, space, apostrophe, underscore, dash. */
const NAME_RE = /^[A-Za-z0-9 '_-]{3,24}$/;
const APPEARANCE_RE = /^unit\.hero(\.[a-z0-9_]+)*$/;

export const SHOP_DEFAULT_APPEARANCE = "unit.hero";
export const SHOP_MAX_ENTRY_ID = 64;

export function validShopName(name: string): boolean {
  return NAME_RE.test(name);
}

export function validAppearance(appearance: string): boolean {
  return appearance.length <= 64 && APPEARANCE_RE.test(appearance);
}

/** Default name of a fresh shop ("Shop P1"): valid by construction. */
export function defaultShopName(plotId: string): string {
  return `Shop ${plotId.toUpperCase()}`;
}

/** Fixture tag "<owner> · Open|Closed", at most 40 chars (the owner name is cut, never the state). */
export function fixtureTag(ownerName: string, open: boolean): string {
  const suffix = open ? " · Open" : " · Closed";
  return `${ownerName.slice(0, 40 - suffix.length)}${suffix}`;
}

/** Scope of a sale: "universal" for universal items, else the origin mode. */
export function saleScope(item: Pick<VaultItem, "universal" | "origin">): string {
  return item.universal || item.origin === "" ? "universal" : item.origin;
}

/** A vault item without its uid, ready for AccountGateway.vaultPut (keeps data). */
export function withoutUid(item: VaultItem): Omit<VaultItem, "uid"> {
  const { uid: _uid, ...rest } = item;
  return rest;
}
