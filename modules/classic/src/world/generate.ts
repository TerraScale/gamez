/**
 * Area generation (classic.world, design §3.4 and §9). generateArea() is a
 * PURE function of (registry, worldSeed, depth): depth 0 is the town, depth
 * >= 1 a dungeon level of BalanceProto.levelWidth x levelHeight, and rift
 * depths (wave A) the RiftProto level. It draws from createRng(mix(worldSeed,
 * depth)) (never ctx.rng), so every sim, the renderer and the server get the
 * identical map. Called through the memo in ./maps.ts.
 */
import type { FrozenRegistry } from "@gamez/kernel";
import { isRiftDepth } from "../rules.ts";
import { buildDungeon } from "./dungeon.ts";
import type { ClassicMap } from "./maps.ts";
import { buildRiftLevel } from "./riftMap.ts";
import { buildTown } from "./town.ts";

export function generateArea(
  registry: FrozenRegistry,
  worldSeed: number,
  depth: number,
): ClassicMap {
  if (depth <= 0) return buildTown(registry, worldSeed);
  if (isRiftDepth(depth)) return buildRiftLevel(registry, worldSeed, depth);
  return buildDungeon(registry, worldSeed, depth);
}
