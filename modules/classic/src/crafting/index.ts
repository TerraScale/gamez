/**
 * Module "classic.crafting" (wave A) — OWNER: T-items.
 * docs/design/wave-A.md §5.2-5.4.
 *
 * Smith services (town, an NPC with NpcProto.crafts in INTERACT_RANGE):
 * repair, upgrade, reroll, add socket, socket gem, unsocket gems, combine
 * gems. Prices: rules.ts (repairCost, upgradeCost, rerollCost, socketCost)
 * from EconomyProto. Writes the hero's Inventory / Equipment / Wallet
 * (owned by classic.items; crafting is the documented second writer) and
 * RunStats.goldSpent / itemsCrafted / gemsSocketed.
 *
 * - classic.crafting.commands (update 54, SYSTEM.craftingCommands): ops
 *   repair, upgrade, reroll, addSocket, socketGem, unsocket, combineGems.
 * - Actions: classic.repair, classic.upgradeItem, classic.rerollItem,
 *   classic.addSocket, classic.socketGem, classic.unsocketGems,
 *   classic.combineGems.
 * No setup and no state of its own: old saves need nothing.
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { craftingActions, craftingCommandsSystem } from "./actions.ts";

export const classicCrafting = defineModule({
  id: MODULE.crafting,
  version: "1.1.1",
  deps: [MODULE.core, MODULE.items],
  optionalDeps: [MODULE.content],
  systems: [craftingCommandsSystem],
  actions: craftingActions,
});

export { CRAFTING_OPS, runCraftingCommand } from "./actions.ts";
export {
  baseName,
  execAddSocket,
  execCombineGems,
  execRepair,
  execReroll,
  execSocketGem,
  execUnsocket,
  execUpgrade,
  locate,
  smithFor,
  upgradedName,
  writeBack,
  type ItemLoc,
  type Located,
} from "./ops.ts";
