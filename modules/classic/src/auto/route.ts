/**
 * Routing for the auto controller: a bounded 4-neighbour BFS over walkable
 * tiles (frontier search, long walks) and "legs": far targets are walked in
 * steps of at most LEG_TILES along the BFS route, so classic.core.intent's
 * A* (bounded node budget) only ever plans short paths on big levels.
 * Scratch arrays are allocated per call (no module state).
 */
import type { TilePos } from "../fixed.ts";
import { walkableAt, type ClassicMap } from "../world/maps.ts";
import { currentIntent, moveTo, stopIntent, type AutoCtx } from "./util.ts";

/** BFS node budget per search. */
export const BFS_MAX_NODES = 8000;
/** Longest walk handed to the intent executor in one go (tiles along the route). */
export const LEG_TILES = 16;
/** A leg (or a frontier walk) older than this is re-planned. */
export const LEG_TICKS = 40;

export interface BfsHit {
  /** The goal tile. */
  x: number;
  y: number;
  /** BFS steps from the start. */
  steps: number;
  /** Tile at most LEG_TILES steps along the route (the goal itself when closer). */
  next: TilePos;
}

export interface BfsOutcome {
  hit: BfsHit | null;
  /** True when every reachable tile was visited (no hit = unreachable). */
  complete: boolean;
  visited: number;
}

/** Goal test: 2 = take it and stop, 1 = remember as a fallback (the first one only), 0 = no. */
export type GoalFn = (x: number, y: number, steps: number) => 0 | 1 | 2;

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

/** BFS from (sx, sy) until `goal` accepts a tile or `maxNodes` tiles were queued. */
export function bfs(
  map: ClassicMap,
  sx: number,
  sy: number,
  goal: GoalFn,
  maxNodes = BFS_MAX_NODES,
  leg = LEG_TILES,
): BfsOutcome {
  const w = map.width;
  const h = map.height;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { hit: null, complete: true, visited: 0 };
  const parent = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(maxNodes);
  const steps = new Int32Array(maxNodes);
  const start = sy * w + sx;
  parent[start] = start;
  queue[0] = start;
  let head = 0;
  let tail = 1;
  let fallback = -1;
  let fallbackSteps = 0;
  const hitAt = (i: number, d: number): BfsHit => {
    // Walk back from the goal to the tile `min(leg, d)` steps from the start.
    let n = i;
    for (let k = d - Math.min(leg, d); k > 0; k--) n = parent[n]!;
    return { x: i % w, y: Math.floor(i / w), steps: d, next: { x: n % w, y: Math.floor(n / w) } };
  };
  let capped = false;
  while (head < tail) {
    const i = queue[head]!;
    const d = steps[head++]!;
    const x = i % w;
    const y = (i - x) / w;
    const g = goal(x, y, d);
    if (g === 2) return { hit: hitAt(i, d), complete: false, visited: tail };
    if (g === 1 && fallback < 0) {
      fallback = i;
      fallbackSteps = d;
    }
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k]!;
      const ny = y + DY[k]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (parent[ni] !== -1 || !walkableAt(map, nx, ny)) continue;
      if (tail >= maxNodes) {
        capped = true;
        continue;
      }
      parent[ni] = i;
      queue[tail] = ni;
      steps[tail++] = d + 1;
    }
  }
  return {
    hit: fallback >= 0 ? hitAt(fallback, fallbackSteps) : null,
    complete: !capped,
    visited: tail,
  };
}

/** Chebyshev distance in tiles. */
export function tileDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** True while the hero follows a recent auto move (a leg or a frontier walk). */
export function onRecentMove(c: AutoCtx): boolean {
  const cur = currentIntent(c);
  return (
    cur !== undefined && cur.kind === "move" && cur.source === "auto" && c.tick - cur.at < LEG_TICKS
  );
}

/** Starts a fresh move intent to (x, y) (a new `at`, even when the target is unchanged). */
export function freshMove(c: AutoCtx, x: number, y: number): void {
  const cur = currentIntent(c);
  if (cur && cur.kind === "move" && cur.source === "auto" && cur.x === x && cur.y === y)
    stopIntent(c);
  moveTo(c, x, y);
}

/**
 * Walks toward tile (gx, gy). Within LEG_TILES `near()` takes over (an
 * interact intent or a direct move); farther away the hero follows the BFS
 * route leg by leg. `sameGoal` keeps a recent leg instead of re-routing.
 * When no route is found `near()` runs anyway (the executor may still path).
 */
export function walkTo(
  c: AutoCtx,
  gx: number,
  gy: number,
  near: () => void,
  sameGoal: boolean,
): void {
  if (tileDist(c.tx, c.ty, gx, gy) <= LEG_TILES) {
    near();
    return;
  }
  if (sameGoal && onRecentMove(c)) return;
  const r = bfs(c.map, c.tx, c.ty, (x, y) => (tileDist(x, y, gx, gy) <= 1 ? 2 : 0));
  if (!r.hit) {
    near();
    return;
  }
  freshMove(c, r.hit.next.x, r.hit.next.y);
}
