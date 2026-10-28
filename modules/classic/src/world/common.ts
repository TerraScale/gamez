/**
 * Shared helpers of the classic.world builder (pure functions, no world
 * state): balance and theme lookup, tile arithmetic, breadth-first distances
 * and the free-tile search used to place the hero and units.
 */
import type { FrozenRegistry } from "@gamez/kernel";
import type { TilePos } from "../fixed.ts";
import { tierOf } from "../rules.ts";
import { BALANCE_ID, KIND, type BalanceProto, type Rect, type ThemeProto } from "../types.ts";
import type { ClassicMap } from "./maps.ts";

/** Theme id of the town (never picked for dungeon levels). */
export const TOWN_THEME = "classic.theme.town";

/** Level size and room rules used when the balance proto is missing (design §9.2). */
export const DEFAULT_LEVEL: {
  width: number;
  height: number;
  rooms: [number, number];
  roomSize: [number, number];
} = {
  width: 128,
  height: 128,
  rooms: [18, 26],
  roomSize: [6, 16],
};

/** The balance proto, or undefined when no content defines it. */
export function balanceOf(registry: FrozenRegistry): Readonly<BalanceProto> | undefined {
  return registry.get<BalanceProto>(KIND.balance, BALANCE_ID);
}

export interface ThemePick {
  id: string;
  name: string;
  proto: Readonly<ThemeProto> | null;
}

/**
 * The dungeon theme of a depth: the first theme whose tier matches
 * tierOf(depth) (the town theme excluded), else the first theme, else a
 * bare fallback (no theme prototype at all).
 */
export function pickTheme(registry: FrozenRegistry, depth: number): ThemePick {
  const tier = tierOf(depth);
  const themes = registry.all<ThemeProto>(KIND.theme).filter(([id]) => id !== TOWN_THEME);
  const match = themes.find(([, t]) => t.tier === tier) ?? themes[0];
  if (!match) return { id: "classic.theme.dungeon", name: "Dungeon", proto: null };
  return { id: match[0], name: match[1].name, proto: match[1] };
}

/** Logical tile ids a dungeon level is painted with. */
export interface ThemeLooks {
  floor: string[];
  wall: string;
  door: string;
  stairsDown: string;
  stairsUp: string;
  waypoint: string;
  decor: string[];
}

export function looksOf(proto: Readonly<ThemeProto> | null): ThemeLooks {
  return {
    floor: proto && proto.floor.length > 0 ? [...proto.floor] : ["tile.dungeon.floor"],
    wall: proto?.wall ?? "wall.dungeon",
    door: proto?.door ?? "prop.door",
    stairsDown: proto?.stairsDown ?? "prop.stairs.down",
    stairsUp: proto?.stairsUp ?? "prop.stairs.up",
    waypoint: proto?.waypoint ?? "prop.waypoint",
    decor: proto ? [...proto.decor] : [],
  };
}

/** An array of `n` copies of `value`. */
export function filled<T>(n: number, value: T): T[] {
  return Array.from({ length: n }, () => value);
}

/** Row-major index of a tile. */
export function tileKey(width: number, x: number, y: number): number {
  return y * width + x;
}

/** Centre tile of a rectangle (integer). */
export function centreOf(r: Rect): TilePos {
  return { x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) };
}

/** Breadth-first distances in tiles from `start` over tiles with walk[i] === 1; -1 = unreachable. */
export function distancesFrom(
  width: number,
  height: number,
  walk: Uint8Array,
  start: number,
): Int32Array {
  const n = width * height;
  const dist = new Int32Array(n).fill(-1);
  if (start < 0 || start >= n || walk[start] !== 1) return dist;
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  dist[start] = 0;
  while (head < tail) {
    const i = queue[head++] ?? 0;
    const d = (dist[i] ?? 0) + 1;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0 && walk[i - 1] === 1 && dist[i - 1] === -1) {
      dist[i - 1] = d;
      queue[tail++] = i - 1;
    }
    if (x < width - 1 && walk[i + 1] === 1 && dist[i + 1] === -1) {
      dist[i + 1] = d;
      queue[tail++] = i + 1;
    }
    if (y > 0 && walk[i - width] === 1 && dist[i - width] === -1) {
      dist[i - width] = d;
      queue[tail++] = i - width;
    }
    if (y < height - 1 && walk[i + width] === 1 && dist[i + width] === -1) {
      dist[i + width] = d;
      queue[tail++] = i + width;
    }
  }
  return dist;
}

/** Distance of a tile in a distancesFrom() result (-1 = unreachable). */
export function distAt(dist: Int32Array, width: number, p: TilePos): number {
  return dist[tileKey(width, p.x, p.y)] ?? -1;
}

/**
 * Nearest walkable tile to `anchor` that is not in `occupied`, searching
 * square rings outward from `minRadius` (ring order: top row first, then
 * left to right). Null when nothing qualifies.
 */
export function findFreeNear(
  map: ClassicMap,
  anchor: TilePos,
  minRadius: number,
  occupied: ReadonlySet<number>,
): TilePos | null {
  const maxR = Math.max(map.width, map.height);
  for (let r = Math.max(0, minRadius); r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = anchor.x + dx;
        const y = anchor.y + dy;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        const i = tileKey(map.width, x, y);
        if (map.walkable[i] !== 1 || occupied.has(i)) continue;
        return { x, y };
      }
    }
  }
  return null;
}
