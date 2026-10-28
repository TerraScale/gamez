/**
 * Module "classic.items" — OWNER: loot+items builder (T5).
 * docs/design/classic.md §11, §4 (hero kit), §15.2 (auto queues), §20 (vendors).
 *
 * - setup: VendorState (empty stocks), StashState (empty).
 * - classic.items.heroInit (pre -900): starter kit for a hero without Inventory;
 *   restocks the town vendors when due (see vendor.ts).
 * - classic.items.commands (update 50): pickup, equip, unequip, drink, buy,
 *   sell, stashPut, drop, grantGold, grantItems.
 * - classic.items.drops (post 100): loot for hero kills (Bus.deaths).
 * - Actions: classic.equip, unequip, moveItem, dropItem, drinkPotion, buy,
 *   sell, stashPut, stashTake.
 * - rollItem() (generate.ts) is the item factory for every module.
 *
 * Wave A (docs/design/wave-A.md §5): set pieces, gems and dropped sockets,
 * durability on generated equipment; classic.items.wear (post 110);
 * gambling (gamble.ts, op + action classic.gamble), stash tabs (stash.ts,
 * classic.stashMove, stashPut {tab?}), the loot filter (lootFilter.ts,
 * classic.setLootFilter), set bonus events (sets.ts) and RunStats counters
 * (goldSpent, uniquesFound, setItemsFound, gambles).
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { RES, type StashState, type VendorState } from "../resources.ts";
import { commandsSystem } from "./commands.ts";
import { dropsSystem } from "./drops.ts";
import { heroInitSystem } from "./heroInit.ts";
import { itemActions } from "./actions.ts";
import { wearSystem } from "./wear.ts";

export const classicItems = defineModule({
  id: MODULE.items,
  version: "1.2.1",
  deps: [MODULE.core],
  optionalDeps: [MODULE.content],
  setup(world) {
    if (!world.getResource<VendorState>(RES.vendors)) {
      world.setResource(RES.vendors, { stocks: [] });
    }
    if (!world.getResource<StashState>(RES.stash)) {
      world.setResource(RES.stash, { items: [] });
    }
  },
  systems: [heroInitSystem, commandsSystem, dropsSystem, wearSystem],
  actions: itemActions,
});

export {
  baseCandidates,
  gemBaseFor,
  gemBaseOf,
  gemTierFor,
  makeGemItem,
  rollAffixes,
  rollDropSockets,
  rollItem,
  rollRarity,
  rollRarityFrom,
  type RolledAffixes,
  type RollItemOptions,
} from "./generate.ts";
export { findSpace, placeItem, removeItem, sortEntries, type GridBag } from "./inventory.ts";
export { beltAccept, execDrink, type BeltSlot } from "./belt.ts";
export { emptyEquipment, execEquip, execUnequip } from "./equip.ts";
export { execDrop, execGrantGold, execGrantItems, execMoveItem, execPickup } from "./ground.ts";
export {
  execBuy,
  execSell,
  npcInReach,
  restockVendors,
  stashInReach,
  townOnly,
  type BuyOrder,
} from "./vendor.ts";
export {
  execStashMove,
  execStashPut,
  execStashTake,
  firstTabWithRoom,
  stashAdd,
  tabCounts,
  tabOf,
} from "./stash.ts";
export { execGamble, GAMBLE_BASE_ILVL_BONUS } from "./gamble.ts";
export {
  execSetLootFilter,
  mergeLootFilter,
  parseLootFilterPatch,
  type LootFilterPatch,
} from "./lootFilter.ts";
export { applyWear, clearWarned, wearOf, WEAR_RES, type WearState } from "./wear.ts";
export { activeBonuses, emitSetChanges, equippedItems, setSnapshot } from "./sets.ts";
export {
  addRunStat,
  balanceOf,
  baseOf,
  economyOf,
  liveHero,
  noteFound,
  type RunCounter,
} from "./common.ts";
export { initHeroKit } from "./heroInit.ts";
export { freeSpot, potionFor } from "./drops.ts";
export { runItemCommand, ITEM_OPS } from "./commands.ts";
