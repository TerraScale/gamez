/**
 * Achievement metrics (wave A, docs/design/wave-A.md §9) — OWNER: T-achievements.
 * Pure reads of the world: every value is an integer, a missing module, resource
 * or component reads as 0 (never throws). Used by the check system and by the
 * client view (client/model/achievements.ts).
 */
import type { FrozenRegistry, World } from "@gamez/kernel";
import { Equipment, Level, Talents } from "../components.ts";
import {
  heroOf,
  riftOf,
  RES,
  type DungeonState,
  type QuestState,
  type RunStats,
} from "../resources.ts";
import { KIND, type AchievementMetric, type SetProto } from "../types.ts";

/** Ticks per sim minute (20 Hz). */
export const TICKS_PER_MINUTE = 1200;

/** 1 when, for some set, every piece id is the `set` of an equipped item; else 0. */
function setCompleteValue(world: World, registry: FrozenRegistry, hero: number): number {
  if (hero === 0) return 0;
  const equipment = world.get(hero, Equipment);
  if (!equipment) return 0;
  const worn: string[] = [];
  for (const item of Object.values(equipment)) {
    if (item && item.set) worn.push(item.set);
  }
  for (const [, set] of registry.all<SetProto>(KIND.set)) {
    if (set.pieces.length > 0 && set.pieces.every((p) => worn.includes(p))) return 1;
  }
  return 0;
}

/** Current value of one metric (integer, >= 0). */
export function metricValue(
  world: World,
  registry: FrozenRegistry,
  metric: AchievementMetric,
): number {
  const hero = heroOf(world);
  const stats = world.getResource<RunStats>(RES.stats);
  switch (metric) {
    case "kills":
      return stats?.kills ?? 0;
    case "championKills":
      return stats?.championKills ?? 0;
    case "uniqueKills":
      return stats?.uniqueKills ?? 0;
    case "bossKills":
      return stats?.bossKills ?? 0;
    case "goldEarned":
      return stats?.goldEarned ?? 0;
    case "goldSpent":
      return stats?.goldSpent ?? 0;
    case "itemsFound":
      return stats?.itemsFound ?? 0;
    case "uniquesFound":
      return stats?.uniquesFound ?? 0;
    case "setItemsFound":
      return stats?.setItemsFound ?? 0;
    case "potionsUsed":
      return stats?.potionsUsed ?? 0;
    case "itemsCrafted":
      return stats?.itemsCrafted ?? 0;
    case "gemsSocketed":
      return stats?.gemsSocketed ?? 0;
    case "gambles":
      return stats?.gambles ?? 0;
    case "riftsCompleted":
      return stats?.riftsCompleted ?? 0;
    case "playMinutes":
      return Math.floor((stats?.ticksPlayed ?? 0) / TICKS_PER_MINUTE);
    case "level":
      return hero === 0 ? 0 : (world.get(hero, Level)?.level ?? 0);
    case "talentPoints":
      return hero === 0 ? 0 : (world.get(hero, Talents)?.spent ?? 0);
    case "deepest":
      return world.getResource<DungeonState>(RES.dungeon)?.deepest ?? 0;
    case "questsCompleted":
      return world.getResource<QuestState>(RES.quests)?.completed.length ?? 0;
    case "riftLevel":
      return riftOf(world)?.maxCompleted ?? 0;
    case "setComplete":
      return setCompleteValue(world, registry, hero);
    default:
      return 0;
  }
}
