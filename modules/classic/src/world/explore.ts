/**
 * Exploration (classic.world, design §9.3 and §15.2). ExploreState keeps one
 * bitset per level: the town (always fully revealed) and the live dungeon
 * level. classic.world.explore (post 500) reveals every tile within the
 * hero's light radius and counts the newly revealed walkable tiles.
 *
 * Party (docs/design/party.md §7.1): every STANDING member reveals around
 * itself with its own light radius, in slot order (solo: the hero, as before).
 */
import type { SystemDef, World } from "@gamez/kernel";
import { Dead, HeroStats, Pos } from "../components.ts";
import { clamp } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { partyMembers } from "../party/shared.ts";
import { RES, type ExploreArea, type ExploreState } from "../resources.ts";
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

/**
 * The stored bitset that exploreAreaFor() would return without changing
 * anything, read-only (no rollback copy of the whole ExploreState), or null
 * when exploreAreaFor() would create or replace one.
 */
function peekExploreArea(world: World, map: ClassicMap): Readonly<ExploreArea> | null {
  const state = world.peekResource<ExploreState>(RES.explore);
  if (state === undefined) return null;
  const words = Math.ceil((map.width * map.height) / 32);
  const current = state.areas.find((a) => a.depth === map.depth);
  return current && current.width === map.width && current.bits.length === words ? current : null;
}

/** True when revealAround() with the same arguments would set any bit. */
function revealsAny(
  area: Readonly<ExploreArea>,
  map: ClassicMap,
  tx: number,
  ty: number,
  radius: number,
): boolean {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = ty + dy;
    if (y < 0 || y >= map.height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = tx + dx;
      if (x < 0 || x >= map.width) continue;
      const i = tileKey(map.width, x, y);
      if (((area.bits[i >> 5] ?? 0) & (1 << (i & 31))) === 0) return true;
    }
  }
  return false;
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
    const members = partyMembers(world);
    // Solo keeps the single-hero rule (it also reveals while dead); a party skips downed members.
    const party = members.length > 1;
    let map: ClassicMap | null = null;
    let area: ExploreArea | null = null;
    for (const hero of members) {
      if (!world.has(hero, Pos) || (party && world.has(hero, Dead))) continue;
      if (map === null) map = getAreaMap(world, ctx.registry);
      const p = world.peek(hero, Pos)!;
      const sheet = world.peek(hero, HeroStats);
      const bal = balanceOf(ctx.registry);
      const radius = clamp(sheet?.lightRadius ?? bal?.lightRadius ?? FALLBACK_LIGHT_RADIUS, 1, 24);
      if (area === null) {
        // Most ticks reveal nothing new: check read-only first, so the whole ExploreState
        // (every level's bitset) is only taken live (rollback copy) when a bit changes.
        const seen = peekExploreArea(world, map);
        if (seen !== null && !revealsAny(seen, map, p.x >> 8, p.y >> 8, radius)) continue;
        area = exploreAreaFor(world, map);
      }
      revealAround(area, map, p.x >> 8, p.y >> 8, radius);
    }
  },
};
