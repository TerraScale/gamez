/**
 * Loot filter checks (CONTRACT, implemented; wave A). Pure: shared by the
 * auto controller (never picks up hidden loot), the client scene (no ground
 * label for hidden loot) and the HUD (filter panel preview).
 */
import type { FrozenRegistry } from "@gamez/kernel";
import type { LootFilter } from "./resources.ts";
import { rarityRank } from "./rules.ts";
import { KIND, type ItemBaseProto, type ItemInstance } from "./types.ts";

/** True when an item passes the filter (shown, and auto may pick it up). Sets and uniques always pass. */
export function itemVisible(
  filter: LootFilter,
  registry: FrozenRegistry,
  item: ItemInstance,
): boolean {
  if (item.rarity === "unique" || item.rarity === "set") return true;
  const base = registry.get<ItemBaseProto>(KIND.itemBase, item.base);
  if (!base) return true;
  const min = filter.minRarity[base.category];
  if (min === undefined) return true;
  if (min === "none") return false;
  return rarityRank(item.rarity) >= rarityRank(min);
}

/** Loot.kind-level check for ground loot (gold piles, potions, items). */
export function lootVisible(
  filter: LootFilter,
  registry: FrozenRegistry,
  loot: { kind: "item" | "gold" | "potion"; item: ItemInstance | null; gold: number },
): boolean {
  if (loot.kind === "gold") return filter.showGold && loot.gold >= filter.minGold;
  if (loot.kind === "potion") return filter.showPotions;
  return loot.item ? itemVisible(filter, registry, loot.item) : true;
}
