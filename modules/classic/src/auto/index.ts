/**
 * Module "classic.auto" — OWNER: auto/idle builder (T7).
 * docs/design/classic.md §15.
 *
 * - setup: ControlState (manual, speed 1, DEFAULT_AUTO_CONFIG).
 * - classic.auto.think (pre 0, ./think.ts): when autoActive(): the
 *   deterministic controller (dead -> potions -> retreat -> fight -> loot ->
 *   equip -> go to town -> town routine -> descend -> explore), writing the
 *   hero Intent (source "auto"), AutoState and Bus.commands.
 * - classic.auto.allocate (pre 10, ./allocate.ts): stat/skill points by class
 *   autoAlloc / autoSkillOrder, new skills into empty bar slots.
 * - Actions (./actions.ts, ./offline.ts): classic.setControl,
 *   classic.setSpeed, classic.setAutoConfig, classic.offlineProgress.
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { RES } from "../resources.ts";
import {
  defaultControl,
  setAutoConfigAction,
  setControlAction,
  setSpeedAction,
} from "./actions.ts";
import { allocateSystem } from "./allocate.ts";
import { offlineAction } from "./offline.ts";
import { thinkSystem } from "./think.ts";

export const classicAuto = defineModule({
  id: MODULE.auto,
  version: "0.2.0",
  deps: [MODULE.core],
  optionalDeps: [
    MODULE.content,
    MODULE.world,
    MODULE.combat,
    MODULE.monsters,
    MODULE.items,
    MODULE.progression,
  ],
  setup(world) {
    world.setResource(RES.control, defaultControl());
  },
  systems: [thinkSystem, allocateSystem],
  actions: [setControlAction, setSpeedAction, setAutoConfigAction, offlineAction],
});

export { itemScore } from "./score.ts";
export { computeOffline, type OfflineResult } from "./offline.ts";
