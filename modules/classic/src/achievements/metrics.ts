/**
 * Achievement metrics (wave A, docs/design/wave-A.md §9) — OWNER: T-achievements.
 * Pure reads of the world: every value is an integer, a missing module, resource
 * or component reads as 0 (never throws). Used by the check system and by the
 * client view (client/model/achievements.ts).
 */
import type { Entity, FrozenRegistry, World } from "@gamez/kernel";
import { Equipment, Level, Talents } from "../components.ts";
import { partyMembers } from "../party/shared.ts";
import { riftOf, RES, type DungeonState, type QuestState, type RunStats } from "../resources.ts";
import { KIND, type AchievementMetric, type SetProto } from "../types.ts";

/** Ticks per sim minute (20 Hz). */
export const TICKS_PER_MINUTE = 1200;

/** 1 when, for some set, every piece id is the `set` of an item the hero has equipped; else 0. */
function setCompleteOf(world: World, registry: FrozenRegistry, hero: Entity): number {
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

/**
 * Highest value of `read` over the party members (solo: the hero, so the
 * same number as before). Party metrics that describe a hero use the best member.
 */
function highestOf(world: World, read: (e: Entity) => number): number {
  let best = 0;
  for (const e of partyMembers(world)) best = Math.max(best, read(e));
  return best;
}

/** 1 when any party member has a complete set equipped (solo: the hero). */
function setCompleteValue(world: World, registry: FrozenRegistry): number {
  for (const e of partyMembers(world)) if (setCompleteOf(world, registry, e) === 1) return 1;
  return 0;
}

/** Current value of one metric (integer, >= 0). */
export function metricValue(
  world: World,
  registry: FrozenRegistry,
  metric: AchievementMetric,
): number {
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
    // Party (docs/design/party.md §7.4): hero metrics use the highest member; counters stay party-wide.
    case "level":
      return highestOf(world, (e) => world.get(e, Level)?.level ?? 0);
    case "talentPoints":
      return highestOf(world, (e) => world.get(e, Talents)?.spent ?? 0);
    case "deepest":
      return world.getResource<DungeonState>(RES.dungeon)?.deepest ?? 0;
    case "questsCompleted":
      return world.getResource<QuestState>(RES.quests)?.completed.length ?? 0;
    case "riftLevel":
      return riftOf(world)?.maxCompleted ?? 0;
    case "setComplete":
      return setCompleteValue(world, registry);
    default:
      return 0;
  }
}
