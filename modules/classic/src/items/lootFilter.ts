/**
 * The loot filter (OWNER: T-items, wave-A.md §5.5): RES.lootFilter, created
 * lazily by the first classic.setLootFilter. The sim never hides anything:
 * the client (no ground label) and the auto controller (no auto pickup) read
 * it through loot.ts itemVisible / lootVisible.
 */
import { ActionError, type SimContext, type World } from "@gamez/kernel";
import { ERR } from "../actions.ts";
import { emit } from "../events.ts";
import { lootFilterOf, RES, type LootFilter } from "../resources.ts";
import { ITEM_CATEGORIES, ITEM_RARITIES, type ItemCategory, type ItemRarity } from "../types.ts";

export const LOOT_FILTER_MAX_GOLD = 1_000_000;

/** A validated patch: minRarity is itself partial. */
export interface LootFilterPatch {
  minRarity?: Partial<Record<ItemCategory, ItemRarity | "none">>;
  showGold?: boolean;
  minGold?: number;
  showPotions?: boolean;
}

const KEYS = ["minRarity", "showGold", "minGold", "showPotions"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(message: string): never {
  throw new ActionError(ERR.badPayload, message);
}

/** Strict validation of an untrusted filter patch (throws ActionError bad_payload). */
export function parseLootFilterPatch(raw: unknown): LootFilterPatch {
  if (!isPlainObject(raw)) bad("filter must be an object");
  const out: LootFilterPatch = {};
  for (const key of Object.keys(raw).sort()) {
    if (!(KEYS as readonly string[]).includes(key)) bad(`unknown filter key "${key}"`);
  }
  if (raw.minRarity !== undefined) {
    const mr = raw.minRarity;
    if (!isPlainObject(mr)) bad("minRarity must be an object");
    const patch: Partial<Record<ItemCategory, ItemRarity | "none">> = {};
    for (const cat of Object.keys(mr).sort()) {
      if (!(ITEM_CATEGORIES as readonly string[]).includes(cat)) bad(`unknown category "${cat}"`);
      const v = mr[cat];
      if (
        typeof v !== "string" ||
        (v !== "none" && !(ITEM_RARITIES as readonly string[]).includes(v))
      ) {
        bad(`minRarity.${cat} must be a rarity or "none"`);
      }
      patch[cat as ItemCategory] = v as ItemRarity | "none";
    }
    out.minRarity = patch;
  }
  for (const flag of ["showGold", "showPotions"] as const) {
    const v = raw[flag];
    if (v === undefined) continue;
    if (typeof v !== "boolean") bad(`${flag} must be a boolean`);
    out[flag] = v;
  }
  if (raw.minGold !== undefined) {
    const v = raw.minGold;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > LOOT_FILTER_MAX_GOLD) {
      bad(`minGold must be an integer 0..${LOOT_FILTER_MAX_GOLD}`);
    }
    out.minGold = v;
  }
  return out;
}

/** The filter after applying `patch` to `cur` (fresh objects). */
export function mergeLootFilter(cur: LootFilter, patch: LootFilterPatch): LootFilter {
  return {
    minRarity: { ...cur.minRarity, ...patch.minRarity },
    showGold: patch.showGold ?? cur.showGold,
    minGold: patch.minGold ?? cur.minGold,
    showPotions: patch.showPotions ?? cur.showPotions,
  };
}

/** Writes the merged filter (creating RES.lootFilter) and emits classic.lootFilter.changed. */
export function execSetLootFilter(world: World, ctx: SimContext, patch: LootFilterPatch): void {
  world.setResource(RES.lootFilter, mergeLootFilter(lootFilterOf(world), patch));
  emit(ctx, { type: "classic.lootFilter.changed" });
}
