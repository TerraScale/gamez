/**
 * Module "classic.world" — OWNER: world builder (T2). ./maps.ts is
 * architect-owned (read-only). docs/design/classic.md §9.
 *
 * - setup (./setup.ts): AreaState (town), DungeonState, ExploreState (town
 *   fully revealed), town NPC entities, town Interactables (waypoint, stash,
 *   dungeon entrance).
 * - classic.world.transition (pre -1100, ./transition.ts): drains
 *   Bus.transitions; switches the area; enters a new dungeon level (destroys
 *   the old live level, queues population and stairs/waypoint Interactables);
 *   places the hero; emits classic.area.changed.
 * - classic.world.commands (update 51, ./travel.ts): townPortal, usePortal,
 *   stairs, waypoint.
 * - classic.world.levelState (post 150, ./levelState.ts): kills, boss,
 *   level cleared.
 * - classic.world.explore (post 500, ./explore.ts): light-radius reveal.
 * - Actions (./travel.ts): classic.townPortal, classic.usePortal,
 *   classic.useStairs, classic.useWaypoint.
 * - Generation (./generate.ts, ./town.ts, ./dungeon.ts) and population
 *   planning (./populate.ts) are pure functions of their inputs.
 * - Wave A: rift levels (./riftMap.ts, RiftProto shape, no stairs), the town
 *   Rift obelisk (./riftObelisk.ts, placed by setup and lazily by the
 *   transition system), depth 16 without a staircase down, and rift guards on
 *   the travel ops (no town portal, waypoint or portal use inside a rift).
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { levelStateSystem } from "./levelState.ts";
import { exploreSystem } from "./explore.ts";
import { setupWorld } from "./setup.ts";
import { transitionSystem } from "./transition.ts";
import {
  townPortalAction,
  usePortalAction,
  useStairsAction,
  useWaypointAction,
  worldCommandsSystem,
} from "./travel.ts";

export const classicWorld = defineModule({
  id: MODULE.world,
  version: "0.4.1",
  deps: [MODULE.core],
  optionalDeps: [MODULE.content],
  setup: setupWorld,
  systems: [transitionSystem, worldCommandsSystem, levelStateSystem, exploreSystem],
  actions: [townPortalAction, usePortalAction, useStairsAction, useWaypointAction],
});
