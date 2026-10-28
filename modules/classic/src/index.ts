/**
 * The "classic" mode: an idle Diablo-like ARPG that plays itself (Manual /
 * Auto / Full Idle). Design: docs/design/classic.md. Fixed 20 Hz tick; every
 * player input is a kernel action so the server can replay the sim.
 */
import { defineMode, type ModeSpec, type ModuleSpec } from "@gamez/kernel";
import { classicAuto } from "./auto/index.ts";
import { classicCombat } from "./combat/index.ts";
import { classicContent } from "./content/index.ts";
import { classicCore } from "./core/index.ts";
import { classicItems } from "./items/index.ts";
import { classicMonsters } from "./monsters/index.ts";
import { classicProgression } from "./progression/index.ts";
import { classicWorld } from "./world/index.ts";
import { classicAchievements } from "./achievements/index.ts";
import { classicCrafting } from "./crafting/index.ts";
import { classicDebug } from "./debug/index.ts";
import { classicRift } from "./rift/index.ts";
import { classicTalents } from "./talents/index.ts";

export const modules: ModuleSpec[] = [
  classicContent,
  classicCore,
  classicWorld,
  classicCombat,
  classicMonsters,
  classicItems,
  classicProgression,
  classicAuto,
  // wave A (docs/design/wave-A.md)
  classicTalents,
  classicCrafting,
  classicRift,
  classicAchievements,
];

/**
 * QA-only modules (never in `modules`): the cheat module behind
 * `?debug=1&cheats=1`. Load with loadMode({...mode, modules: [...mode.modules]},
 * [...modules, ...debugModules]) — mode "classic.*" picks it up, so the
 * contentHash differs from the real mode.
 */
export const debugModules: ModuleSpec[] = [classicDebug];

export const CLASSIC_HZ = 20;

export const mode: ModeSpec = defineMode({
  id: "classic",
  name: "Classic",
  description:
    "Idle isometric ARPG: dive a deep dungeon, slay monsters, loot, level up - by hand or on autopilot.",
  world: null,
  modules: ["classic.*"],
  tick: { kind: "fixed", hz: CLASSIC_HZ },
  instance: { maxPlayers: 1 },
});

export * from "./types.ts";
export * from "./components.ts";
export * from "./resources.ts";
export * from "./events.ts";
export * from "./actions.ts";
export * from "./ids.ts";
export * from "./fixed.ts";
export { busOf, type Bus, type DeathRecord, type HitRequest, type SpawnRequest } from "./bus.ts";
export { getAreaMap, getMap, mapFor, type ClassicMap } from "./world/maps.ts";
export * from "./bonus.ts";
export * from "./loot.ts";
