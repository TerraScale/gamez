/**
 * classic.items.commands (update 50, OWNER: T5): drains the item ops of
 * Bus.commands (queued by classic.auto and other systems; wave A adds gamble
 * and stashMove) and runs them with
 * the same execX functions the actions use. Failures emit classic.command.failed.
 */
import type { SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, takeCommands } from "../bus.ts";
import { ERR, fail, type OpResult } from "../actions.ts";
import type { HeroCommand } from "../actions.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { execBuy, execSell } from "./vendor.ts";
import { execStashMove, execStashPut } from "./stash.ts";
import { execGamble } from "./gamble.ts";
import { execDrink } from "./belt.ts";
import { execEquip, execUnequip } from "./equip.ts";
import { execDrop, execGrantGold, execGrantItems, execPickup } from "./ground.ts";
import { commandActor } from "./common.ts";

export const ITEM_OPS = [
  "pickup",
  "equip",
  "unequip",
  "drink",
  "buy",
  "sell",
  "stashPut",
  "drop",
  "grantGold",
  "grantItems",
  // wave A
  "gamble",
  "stashMove",
] as const;

/**
 * Runs one item command for the hero it names (HeroCommand.hero, else the
 * controlled hero; not_member when `hero` is not in the party).
 */
export function runItemCommand(world: World, ctx: SimContext, c: HeroCommand): OpResult {
  const hero = commandActor(world, c);
  if (typeof hero !== "number") return hero;
  switch (c.op) {
    case "pickup":
      return execPickup(world, ctx, hero, c.target);
    case "equip":
      return execEquip(world, ctx, hero, c.uid, c.slot);
    case "unequip":
      return execUnequip(world, ctx, hero, c.slot);
    case "drink":
      return execDrink(world, ctx, hero, c.slot);
    case "buy":
      return execBuy(world, ctx, hero, c);
    case "sell":
      return execSell(world, ctx, hero, c.npc, c.uid);
    case "stashPut":
      return execStashPut(world, ctx, hero, c.uid, c.tab);
    case "stashMove":
      return execStashMove(world, ctx, hero, c.uid, c.tab);
    case "gamble":
      return execGamble(world, ctx, hero, c.npc, c.category);
    case "drop":
      return execDrop(world, ctx, hero, c.uid);
    case "grantGold":
      return execGrantGold(world, ctx, hero, c.amount, c.reason);
    case "grantItems":
      return execGrantItems(world, ctx, hero, c);
    default:
      return fail(ERR.badPayload, "not an item command");
  }
}

export const commandsSystem: SystemDef = {
  ...SYSTEM.itemsCommands,
  run(world, ctx) {
    if (busOf(world).commands.length === 0) return;
    for (const c of takeCommands(world, ITEM_OPS)) {
      const r = runItemCommand(world, ctx, c);
      if (!r.ok) {
        emit(ctx, {
          type: "classic.command.failed",
          op: c.op,
          code: r.code,
          message: r.message,
          ...(c.hero !== undefined ? { hero: c.hero } : {}),
        });
      }
    }
  },
};
