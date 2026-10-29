/**
 * Gold policy of the auto controller (wave A, docs/design/wave-A.md §8):
 * the EconomyProto, the smith and gambler lookups, and the reserves every
 * spending step keeps. Prices only come from the rules.ts helpers.
 *
 * Spending order on a town visit: potions and scrolls (always), repairs
 * (gear that works), smith items that are real upgrades, crafting (gems,
 * sockets, upgrades), gambling. Each later step only spends what is above
 * its reserve, and the reserves grow with the hero level, so a rich hero
 * turns most of its gold into power (the hoarding target: <= 35 % of the
 * gold earned kept after an hour).
 */
import type { Entity, FrozenRegistry } from "@gamez/kernel";
import { Level, Npc } from "../components.ts";
import { ECONOMY_ID, KIND, type EconomyProto, type NpcProto } from "../types.ts";
import { npcsByRole, purseGold, type AutoCtx } from "./util.ts";

export function econOf(reg: FrozenRegistry): EconomyProto | undefined {
  return reg.get<EconomyProto>(KIND.economy, ECONOMY_ID);
}

export function goldOf(c: AutoCtx): number {
  return purseGold(c);
}

export function heroLevel(c: AutoCtx): number {
  return c.world.get(c.hero, Level)?.level ?? 1;
}

/** The smith that crafts (NpcProto.crafts) in the current area, or 0. */
export function craftingSmith(c: AutoCtx): Entity {
  for (const e of npcsByRole(c, "smith")) {
    if (c.reg.get<NpcProto>(KIND.npc, c.world.read(e, Npc).proto)?.crafts) return e;
  }
  return 0;
}

/** True when some NPC prototype crafts (callable from the dungeon). */
export function hasCraftingSmith(reg: FrozenRegistry): boolean {
  for (const [, npc] of reg.all<NpcProto>(KIND.npc)) if (npc.crafts) return true;
  return false;
}

/** The gambler of the current area (role gambler with an offer), or 0. */
export function gambler(c: AutoCtx): Entity {
  for (const e of npcsByRole(c, "gambler")) {
    const g = c.reg.get<NpcProto>(KIND.npc, c.world.read(e, Npc).proto)?.gamble;
    if (g && g.categories.length > 0) return e;
  }
  return 0;
}

/**
 * Gold the crafting step keeps (on top of the potion reserve): 40 per hero
 * level. Low on purpose: upgrades and sockets are the main sink (up to
 * CRAFT_SHARE_PCT of what is above it per visit).
 */
export function craftReserve(c: AutoCtx, potionReserve: number): number {
  return potionReserve + CRAFT_RESERVE_PER_LEVEL * heroLevel(c);
}
export const CRAFT_RESERVE_PER_LEVEL = 40;

/**
 * Share of the gold above the craft reserve that one visit's crafting may
 * spend; the rest is the gambler's (the gamble step runs after the craft
 * step and keeps the same reserve).
 */
export const CRAFT_SHARE_PCT = 70;

/**
 * Gold the gamble step keeps: the potion reserve plus 40 per hero level
 * (the craft reserve), so gambling eats what crafting left of the surplus.
 */
export function gambleReserve(c: AutoCtx, potionReserve: number): number {
  return potionReserve + GAMBLE_RESERVE_PER_LEVEL * heroLevel(c);
}
export const GAMBLE_RESERVE_PER_LEVEL = 40;

/** Gambles per town visit at most (each is one bag item to judge, equip or sell). */
export const MAX_GAMBLES_PER_VISIT = 4;
