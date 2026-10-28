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

export const modules: ModuleSpec[] = [
  classicContent,
  classicCore,
  classicWorld,
  classicCombat,
  classicMonsters,
  classicItems,
  classicProgression,
  classicAuto,
];

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
