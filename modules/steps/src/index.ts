/**
 * The "steps" test mode: a step-based roguelike where the world advances only
 * when the player acts. Modules are catalog entries; the mode loads "steps.*".
 */
import { defineMode, type ModeSpec, type ModuleSpec } from "@gamez/kernel";
import { stepsCombat } from "./combat.ts";
import { stepsCore } from "./core.ts";
import { stepsFloor } from "./floor.ts";
import { stepsMonsters } from "./monsters.ts";

export const modules: ModuleSpec[] = [stepsCore, stepsFloor, stepsCombat, stepsMonsters];

export const mode: ModeSpec = defineMode({
  id: "steps",
  name: "Steps",
  description: "Step-based roguelike: the world moves only when you do.",
  world: null,
  modules: ["steps.*"],
  tick: { kind: "event" },
  instance: { maxPlayers: 1 },
});

/** Components, resources and read helpers, for clients and tools that inspect a steps world. */
export * from "./components.ts";
