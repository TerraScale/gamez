/**
 * Module "classic.monsters" — OWNER: monster builder (T4).
 * docs/design/classic.md §8, §20.
 *
 * - classic.monsters.spawn (pre -1050, spawn.ts): drains Bus.spawns into
 *   monster entities (stats via rules.scaleMonster, names, Summoned, grid).
 * - classic.monsters.wake (pre -100, wake.ts): sleep and wake by distance to
 *   the hero (BalanceProto.sleepRange), staggered every 10 ticks; a chasing
 *   monster wakes its pack.
 * - classic.monsters.think (update 200, think.ts): the behaviours rusher,
 *   swarm, archer, caster, tank, charger, summoner, exploder, boss, totem and
 *   the blinking mod. Orders CastOrder and writes Mover goals/paths only.
 * - classic.monsters.onDeath (update 750, death.ts): on-death bursts.
 * - classic.monsters.corpses (post 200, death.ts): corpse removal and summon
 *   expiry.
 * No actions. Deterministic: no randomness outside ctx.rng, no timers.
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { AGGRO_KEY, type AggroState } from "./util.ts";
import { monstersOnDeathSystem, monstersCorpsesSystem } from "./death.ts";
import { monstersSpawnSystem } from "./spawn.ts";
import { monstersThinkSystem } from "./think.ts";
import { monstersWakeSystem } from "./wake.ts";

export const classicMonsters = defineModule({
  id: MODULE.monsters,
  version: "0.3.1",
  deps: [MODULE.core],
  optionalDeps: [MODULE.content, MODULE.combat],
  setup(world) {
    const aggro: AggroState = { last: {} };
    world.setResource(AGGRO_KEY, aggro);
  },
  systems: [
    monstersSpawnSystem,
    monstersWakeSystem,
    monstersThinkSystem,
    monstersOnDeathSystem,
    monstersCorpsesSystem,
  ],
});

export { monsterCombatStats, monsterName, placeNear } from "./spawn.ts";
export { FIELD_RADIUS, fieldDistance, heroField, nextStep, type DistanceField } from "./field.ts";
export { WAKE_EVERY, PACK_WAKE_RANGE } from "./wake.ts";
export { AGGRO_KEY, LOSE_CONTACT_TICKS, THINK_EVERY, type AggroState } from "./util.ts";
