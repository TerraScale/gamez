/**
 * Classic season progress (wave-C.md §7.2). OWNER: T-pass. Pure, never throws.
 *
 * classicSeasonTotal(world, registry) -> { key: "classic:<worldSeed>", total }
 * where total is a MONOTONIC (never decreasing while the hero lives on)
 * integer of season points earned by this hero, from RunStats counters:
 *   total = kills + 25 * levelsGained + 100 * questsDone + 50 * riftsCompleted
 *           + 10 * deepestDepth   (exact weights: SEASON_WEIGHTS below)
 * levelsGained = founder level - 1 (levels are never lost; death costs xp only).
 * A party's season total is the founder's (party-wide counters, monotonic).
 * null without a hero. The account turns deltas into season xp
 * (AccountApi.seasonProgress), so the formula may change only with a new key.
 */
import type { FrozenRegistry, World } from "@gamez/kernel";
import { Level } from "../components.ts";
import { founderOf } from "../party/shared.ts";
import {
  RES,
  type DungeonState,
  type GameState,
  type QuestState,
  type RunStats,
} from "../resources.ts";

export const SEASON_WEIGHTS = { kill: 1, level: 25, quest: 100, rift: 50, depth: 10 } as const;

/** Non-negative safe integer (anything else counts as 0). */
function count(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;
}

export function classicSeasonTotal(
  world: World,
  _registry: FrozenRegistry,
): { key: string; total: number } | null {
  try {
    // The founder's level (docs/design/party.md §7.4): it never drops when a member is dismissed.
    const hero = founderOf(world);
    if (hero === 0) return null;
    const game = world.getResource<GameState>(RES.game);
    if (!game) return null;
    const stats = world.getResource<RunStats>(RES.stats);
    const quests = world.getResource<QuestState>(RES.quests);
    const dungeon = world.getResource<DungeonState>(RES.dungeon);
    const level = world.get(hero, Level)?.level ?? 1;

    const total =
      count(stats?.kills) * SEASON_WEIGHTS.kill +
      Math.max(0, count(level) - 1) * SEASON_WEIGHTS.level +
      count(quests?.completed.length) * SEASON_WEIGHTS.quest +
      count(stats?.riftsCompleted) * SEASON_WEIGHTS.rift +
      count(dungeon?.deepest) * SEASON_WEIGHTS.depth;
    if (!Number.isSafeInteger(total)) return null;
    const seed = Number.isSafeInteger(game.worldSeed) ? game.worldSeed : 0;
    return { key: `classic:${seed}`, total };
  } catch {
    return null;
  }
}
