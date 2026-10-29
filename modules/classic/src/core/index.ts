/**
 * Module "classic.core" — OWNER: core+combat builder (T3). Infrastructure in
 * ./infra.ts is architect-owned and read-only.
 *
 * docs/design/classic.md §3.3, §5:
 * - setup: GameState + bus (infra.ts).
 * - classic.core.spatial (pre -1000): grid rebuild (infra.ts).
 * - classic.core.intent (update 100, ./intent.ts): executes the hero Intent
 *   (paths, approach, CastOrder, pickup/interact commands and panel events).
 * - classic.core.movement (update 300, ./movement.ts): moves every awake Mover
 *   of the current area (paths, steering, wall sliding, separation, facing).
 * - classic.core.cleanup (post 1000): (infra.ts).
 * - Actions (./actions.ts): classic.moveTo, classic.useSkill, classic.stop,
 *   classic.pickup, classic.interact.
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { coreActions } from "./actions.ts";
import { cleanupSystem, setupCore, spatialSystem } from "./infra.ts";
import { intentSystem } from "./intent.ts";
import { movementSystem } from "./movement.ts";

export const classicCore = defineModule({
  id: MODULE.core,
  version: "0.4.0",
  optionalDeps: [MODULE.content],
  setup: setupCore,
  systems: [spatialSystem, intentSystem, movementSystem, cleanupSystem],
  actions: coreActions,
});
