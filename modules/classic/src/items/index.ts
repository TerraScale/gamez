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
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { RES, type StashState, type VendorState } from "../resources.ts";
import { commandsSystem } from "./commands.ts";
import { dropsSystem } from "./drops.ts";
import { heroInitSystem } from "./heroInit.ts";
import { itemActions } from "./actions.ts";

export const classicItems = defineModule({
  id: MODULE.items,
  version: "1.1.0",
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
  systems: [heroInitSystem, commandsSystem, dropsSystem],
  actions: itemActions,
});

export { rollItem, rollRarity, type RollItemOptions } from "./generate.ts";
export { findSpace, placeItem, removeItem, sortEntries, type GridBag } from "./inventory.ts";
export { beltAccept, execDrink, type BeltSlot } from "./belt.ts";
export { emptyEquipment, execEquip, execUnequip } from "./equip.ts";
export { execDrop, execGrantGold, execGrantItems, execMoveItem, execPickup } from "./ground.ts";
export {
  execBuy,
  execSell,
  execStashPut,
  execStashTake,
  restockVendors,
  stashInReach,
  type BuyOrder,
} from "./vendor.ts";
export { initHeroKit } from "./heroInit.ts";
export { freeSpot, potionFor } from "./drops.ts";
export { runItemCommand, ITEM_OPS } from "./commands.ts";
