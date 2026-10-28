/**
 * Module "classic.rift" (wave A) — OWNER: T-rift. docs/design/wave-A.md §7.
 *
 * - RiftState (RES.rift), created lazily (riftStateOf; old saves never have it).
 * - classic.rift.commands (update 55, SYSTEM.riftCommands): ops openRift (town,
 *   rift obelisk in reach, unlocked, level 1..maxCompleted+1, fee paid ->
 *   transition to riftDepth(level, run) via "rift") and leaveRift (failed
 *   "left" run, transition via "riftExit").
 * - classic.rift.track (post 160, SYSTEM.riftTrack): unlock when the unlock boss
 *   is dead; progress from hero-credited kills; guardian at the goal; completion
 *   (record, rewards, riftExit) or failure (hero death).
 * - Actions: classic.openRift, classic.leaveRift.
 * The rift MAP and the transition mechanics are classic.world's (world/riftMap.ts,
 * world/transition.ts). The town obelisk is placed by classic.world too.
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { leaveRiftAction, openRiftAction, riftCommandsSystem } from "./ops.ts";
import { riftTrackSystem } from "./track.ts";

export const classicRift = defineModule({
  id: MODULE.rift,
  version: "1.0.0",
  deps: [MODULE.core, MODULE.world],
  optionalDeps: [MODULE.content, MODULE.monsters, MODULE.items, MODULE.progression],
  systems: [riftCommandsSystem, riftTrackSystem],
  actions: [openRiftAction, leaveRiftAction],
});
