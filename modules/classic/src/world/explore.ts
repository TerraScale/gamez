/**
 * Exploration (classic.world, design §9.3 and §15.2). ExploreState keeps one
 * bitset per level: the town (always fully revealed) and the live dungeon
 * level. classic.world.explore (post 500) reveals every tile within the
 * hero's light radius and counts the newly revealed walkable tiles.
 */
import type { SystemDef, World } from "@gamez/kernel";
import { HeroStats, Pos } from "../components.ts";
import { clamp } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { heroOf, RES, type ExploreArea, type ExploreState } from "../resources.ts";
import { balanceOf, filled, tileKey } from "./common.ts";
import { getAreaMap, type ClassicMap } from "./maps.ts";

/** Light radius fallback when neither the hero nor the balance defines one (tiles). */
const FALLBACK_LIGHT_RADIUS = 8;

/** A fresh exploration bitset for `map`; the town is revealed in full. */
export function freshExploreArea(map: ClassicMap, revealAll: boolean): ExploreArea {
  const n = map.width * map.height;
  const bits: number[] = filled(Math.ceil(n / 32), 0);
  if (revealAll) {
    for (let i = 0; i < n; i++) bits[i >> 5] = (bits[i >> 5] ?? 0) | (1 << (i & 31));
  }
  return {
    depth: map.depth,
    width: map.width,
    bits,
    revealed: revealAll ? map.walkableCount : 0,
    total: map.walkableCount,
  };
}

/** The ExploreState resource, created empty when missing. */
export function exploreStateOf(world: World): ExploreState {
  let state = world.getResource<ExploreState>(RES.explore);
  if (!state) {
    world.setResource<ExploreState>(RES.explore, { areas: [] });
    state = world.getResource<ExploreState>(RES.explore);
  }
  if (!state) throw new Error("classic.world: could not create the explore state");
  return state;
}

/**
 * The exploration bitset matching `map`. A missing or differently sized
 * entry (for example a test map) is replaced by a fresh one.
 */
export function exploreAreaFor(world: World, map: ClassicMap): ExploreArea {
  const state = exploreStateOf(world);
  const words = Math.ceil((map.width * map.height) / 32);
  const at = state.areas.findIndex((a) => a.depth === map.depth);
  const current = at >= 0 ? state.areas[at] : undefined;
  if (current && current.width === map.width && current.bits.length === words) return current;
  const fresh = freshExploreArea(map, map.depth === 0);
  if (at >= 0) state.areas[at] = fresh;
  else state.areas.push(fresh);
  return fresh;
}

/** Reveals the tiles within `radius` (tiles, circle) of (tx, ty). Returns the newly revealed walkable tiles. */
export function revealAround(
  area: ExploreArea,
  map: ClassicMap,
  tx: number,
  ty: number,
  radius: number,
): number {
  let added = 0;
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = ty + dy;
    if (y < 0 || y >= map.height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = tx + dx;
      if (x < 0 || x >= map.width) continue;
      const i = tileKey(map.width, x, y);
      const word = i >> 5;
      const bit = 1 << (i & 31);
      const cur = area.bits[word] ?? 0;
      if ((cur & bit) !== 0) continue;
      area.bits[word] = cur | bit;
      if (map.walkable[i] === 1) added++;
    }
  }
  area.revealed += added;
  return added;
}

export const exploreSystem: SystemDef = {
  ...SYSTEM.worldExplore,
  run(world, ctx) {
    const hero = heroOf(world);
    if (hero === 0 || !world.has(hero, Pos)) return;
    const map = getAreaMap(world, ctx.registry);
    const area = exploreAreaFor(world, map);
    const p = world.read(hero, Pos);
    const sheet = world.get(hero, HeroStats);
    const bal = balanceOf(ctx.registry);
    const radius = clamp(sheet?.lightRadius ?? bal?.lightRadius ?? FALLBACK_LIGHT_RADIUS, 1, 24);
    revealAround(area, map, p.x >> 8, p.y >> 8, radius);
  },
};
