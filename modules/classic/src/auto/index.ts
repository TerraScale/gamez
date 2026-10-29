/**
 * Module "classic.auto" — OWNER: auto/idle builder (T7).
 * docs/design/classic.md §15.
 *
 * - setup: ControlState (manual, speed 1, DEFAULT_AUTO_CONFIG).
 * - classic.auto.think (pre 0, ./think.ts): when autoActive(): the
 *   deterministic controller (dead -> potions -> dodge telegraphs -> retreat
 *   -> fight -> loot -> equip -> go to town -> town routine -> descend or
 *   the rift loop -> explore), writing the hero Intent (source "auto"),
 *   AutoState and Bus.commands. Wave A (docs/design/wave-A.md §8): repair,
 *   craft and gamble town steps (./craft.ts), stash tabs and the loot
 *   filter (./town.ts, ./think.ts), telegraph dodging (./dodge.ts), the
 *   Rift (./riftLoop.ts), stairs-biased exploration (./dungeon.ts).
 *   Quests: chained quests accepted in the same visit (./town.ts questOps),
 *   clearLevel objectives hunted to the last monster (./dungeon.ts
 *   clearObjective, town.ts objectiveReturn), offline kills credited to
 *   "any monster" kill quests (./offline.ts).
 * - Party (docs/design/party.md §6; nothing of it runs for a party of one):
 *   classic.auto.think drives the acting leader (leader brain: party trip
 *   and retreat reasons, revive-before-descend, bounded waits, ./lead.ts);
 *   classic.auto.party (pre 5, ./follow.ts) is the follower brain of every
 *   other member (formation, leash/regroup, assist, protect, ally heals,
 *   revives, loot, its own town errands) plus gear distribution
 *   (./gear.ts); offline progress splits XP per member (./offline.ts).
 * - classic.auto.allocate (pre 10, ./allocate.ts): stat/skill points by class
 *   autoAlloc / autoSkillOrder, new skills into empty bar slots.
 * - classic.auto.rate (post 950, ./rate.ts): the online Auto/Idle rate that the
 *   offline grant extrapolates (docs/design/offline-idle.md §4.1).
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
import { partySystem } from "./follow.ts";
import { offlineAction } from "./offline.ts";
import { rateSystem } from "./rate.ts";
import { thinkSystem } from "./think.ts";

export const classicAuto = defineModule({
  id: MODULE.auto,
  version: "0.6.1",
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
  systems: [thinkSystem, partySystem, allocateSystem, rateSystem],
  actions: [setControlAction, setSpeedAction, setAutoConfigAction, offlineAction],
});

export { itemScore } from "./score.ts";
export { computeOffline, offlineGrant, type OfflineGrant, type OfflineResult } from "./offline.ts";
export { AUTO_RATE_MIN_TICKS, AUTO_RATE_WINDOW_TICKS, rateSystem } from "./rate.ts";
