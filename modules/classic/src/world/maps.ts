/**
 * Area maps (CONTRACT, implemented; owned by the architect, read-only for
 * builders). A map is a pure function of (registry, worldSeed, depth): it is
 * NEVER stored in the world (128x128 tiles would be cloned on every step).
 * getAreaMap() memoises generateArea() outside the world, keyed by registry
 * hash, seed and depth, so the client renderer, every system and the server
 * replay all see the identical map.
 *
 * Tests can inject a hand-built map for a world with setTestMap().
 */
import type { FrozenRegistry, World } from "@gamez/kernel";
import type { TileMap } from "@gamez/world";
import type { TilePos } from "../fixed.ts";
import { RES, type AreaState, type GameState } from "../resources.ts";
import type { Rect } from "../types.ts";
import { generateArea } from "./generate.ts";

export interface ClassicMap extends TileMap {
  /** 0 = town. */
  depth: number;
  /** ThemeProto id ("classic.theme.town" for the town). */
  theme: string;
  /** Display name ("Town", "Crypt - Level 3"). */
  name: string;
  /** Dungeon rooms (town: plazas), in generation order; rooms[0] holds the arrival point. */
  rooms: Rect[];
  /** Where the hero arrives from above (dungeon) or by default (town) = TileMap.spawn. */
  stairsDown: TilePos | null;
  stairsUp: TilePos | null;
  /** Waypoint tile (town always; dungeon when depth % 4 === 1). */
  waypoint: TilePos | null;
  /** Town: NPC standing tiles by NpcProto id; dungeon: []. */
  npcSpots: { npc: string; x: number; y: number }[];
  /** Town: where the town end of a portal appears. Dungeon: unused (= spawn). */
  portalSpot: TilePos;
  /** Town: stash chest tile. Dungeon: null. */
  stash: TilePos | null;
  /** Dungeon: boss arena centre on boss levels (depth % 4 === 0), else null. */
  bossSpot: TilePos | null;
  /** Number of walkable tiles (exploration denominator). */
  walkableCount: number;
}

const cache = new Map<string, ClassicMap>();
const CACHE_MAX = 6;
const overrides = new WeakMap<World, Map<number, ClassicMap>>();

/** The map of the last mapFor() call: every system asks for the same one many times a tick. */
let last: { registry: FrozenRegistry; worldSeed: number; depth: number; map: ClassicMap } | null =
  null;

/** Memoised map for (seed, depth). Pure and shared across sims. */
export function mapFor(registry: FrozenRegistry, worldSeed: number, depth: number): ClassicMap {
  if (
    last !== null &&
    last.registry === registry &&
    last.worldSeed === worldSeed &&
    last.depth === depth
  ) {
    return last.map;
  }
  const map = cachedMap(registry, worldSeed, depth);
  last = { registry, worldSeed, depth, map };
  return map;
}

function cachedMap(registry: FrozenRegistry, worldSeed: number, depth: number): ClassicMap {
  const key = `${registry.hash}:${worldSeed}:${depth}`;
  const hit = cache.get(key);
  if (hit) {
    // LRU refresh.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const map = generateArea(registry, worldSeed, depth);
  cache.set(key, map);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
  return map;
}

/** Map of `depth` for this world (test override first). Do not mutate the result. */
export function getMap(world: World, registry: FrozenRegistry, depth: number): ClassicMap {
  const o = overrides.get(world)?.get(depth);
  if (o) return o;
  const game = world.peekResource<GameState>(RES.game);
  if (game === undefined)
    throw new Error(`classic: resource "${RES.game}" missing (module not loaded?)`);
  return mapFor(registry, game.worldSeed, depth);
}

/** Map of the current area. */
export function getAreaMap(world: World, registry: FrozenRegistry): ClassicMap {
  const depth = world.peekResource<AreaState>(RES.area)?.depth ?? 0;
  return getMap(world, registry, depth);
}

/** Tests only: use `map` for `depth` in this world instead of generating it. */
export function setTestMap(world: World, depth: number, map: ClassicMap): void {
  let m = overrides.get(world);
  if (!m) {
    m = new Map();
    overrides.set(world, m);
  }
  m.set(depth, map);
}

/** Walkability in tile coordinates (out of bounds = blocked). */
export function walkableAt(map: ClassicMap, tx: number, ty: number): boolean {
  return (
    tx >= 0 &&
    ty >= 0 &&
    tx < map.width &&
    ty < map.height &&
    map.walkable[ty * map.width + tx] === 1
  );
}

/** Walkability of the tile containing a sub-unit position. */
export function walkableSub(map: ClassicMap, x: number, y: number): boolean {
  return walkableAt(map, x >> 8, y >> 8);
}

/**
 * Line of sight between two sub positions: samples the segment every
 * quarter tile and fails on the first blocked tile. Integer maths only.
 */
export function lineOfSight(
  map: ClassicMap,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 64));
  // walkableSub() inlined (scans test hundreds of segments per tick). About four samples
  // fall in each tile: a tile already found walkable is not looked up again.
  const w = map.width;
  const h = map.height;
  const walkable = map.walkable;
  let open = -1;
  for (let i = 1; i < steps; i++) {
    const tx = (ax + Math.trunc((dx * i) / steps)) >> 8;
    const ty = (ay + Math.trunc((dy * i) / steps)) >> 8;
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
    const t = ty * w + tx;
    if (t === open) continue;
    if (walkable[t] !== 1) return false;
    open = t;
  }
  return true;
}

/**
 * Builds a rectangular open test map (walls on the border) — for unit tests
 * of other modules that must not depend on the generator.
 */
export function openTestMap(width: number, height: number, depth = 1): ClassicMap {
  const n = width * height;
  const ground: string[] = Array.from({ length: n }, () => "tile.dungeon.floor");
  const objects: (string | null)[] = Array.from({ length: n }, () => null);
  const walkable: number[] = Array.from({ length: n }, () => 1);
  let count = n;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        const i = y * width + x;
        objects[i] = "wall.dungeon";
        walkable[i] = 0;
        count--;
      }
    }
  }
  const mid = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  return {
    id: `test.${depth}`,
    width,
    height,
    ground,
    objects,
    walkable,
    spawn: { x: 2, y: 2 },
    depth,
    theme: depth === 0 ? "classic.theme.town" : "test.theme",
    name: depth === 0 ? "Town" : `Test ${depth}`,
    rooms: [{ x: 1, y: 1, w: width - 2, h: height - 2 }],
    stairsDown: depth === 0 ? null : { x: width - 3, y: height - 3 },
    stairsUp: depth === 0 ? null : { x: 2, y: 2 },
    waypoint: depth === 0 || depth % 4 === 1 ? { x: 3, y: 2 } : null,
    npcSpots: [],
    portalSpot: mid,
    stash: depth === 0 ? { x: 4, y: 2 } : null,
    bossSpot: depth > 0 && depth % 4 === 0 ? mid : null,
    walkableCount: count,
  };
}
