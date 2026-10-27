/**
 * Duel mode: menu-driven creature battles. Turn-based, no movement. Runs in
 * the generic InstanceDO with one player per instance.
 */
import type { ModeSpec, ModuleSpec } from "@gamez/kernel";
import ai from "./ai.ts";
import battle from "./battle.ts";
import creatures from "./creatures.ts";
import team from "./team.ts";

export const modules: ModuleSpec[] = [creatures, team, battle, ai];

export const mode: ModeSpec = {
  id: "duel",
  name: "Duel",
  description:
    "Turn-based creature battles. Pick moves, catch wild creatures, heal between fights.",
  world: null,
  modules: ["duel.*"],
  tick: { kind: "event" },
  instance: { maxPlayers: 1 },
};

export * from "./schema.ts";
export { damageFor, effectiveness, maxHpAt, statAt, xpToNext } from "./combat.ts";
export { aliveTeam, boxCount, teamOf } from "./team.ts";
