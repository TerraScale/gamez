/**
 * Module "classic.achievements" (wave A) — OWNER: T-achievements.
 * docs/design/wave-A.md §9.
 *
 * - AchievementState (RES.achievements), created lazily (old saves never ran setup).
 * - classic.achievements.check (post 900): every 20 ticks in phase "play" with a
 *   hero, unlocks every AchievementProto whose metric (metrics.ts) reached its
 *   target, sorted by id; emits classic.achievement.unlocked and queues
 *   {op: "grantGold", reason: "achievement"} for gold rewards.
 * - No actions: the chosen title is display-only and client-side in wave A.
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { achievementsCheck } from "./check.ts";

export { ACHIEVEMENT_CHECK_EVERY, achievementsCheck } from "./check.ts";
export { metricValue, TICKS_PER_MINUTE } from "./metrics.ts";

export const classicAchievements = defineModule({
  id: MODULE.achievements,
  version: "0.1.0",
  deps: [MODULE.core],
  optionalDeps: [
    MODULE.content,
    MODULE.progression,
    MODULE.items,
    MODULE.world,
    MODULE.talents,
    MODULE.crafting,
    MODULE.rift,
  ],
  systems: [achievementsCheck],
  actions: [],
});
