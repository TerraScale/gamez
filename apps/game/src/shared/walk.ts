import type { EntityState, TilePos } from "@gamez/protocol";
import { findPath, isWalkable, type TileMap } from "@gamez/world";

/**
 * Walk maths shared by the ChunkDO (authority) and the client (prediction and
 * rendering). Pure: no Workers or DOM APIs.
 */

export type Walk = Pick<EntityState, "pos" | "path" | "pathStartedAt" | "speed">;

export interface WalkPoint {
  /** Fractional tile position. */
  x: number;
  y: number;
  /** Tile the walker last stood on (start of the current segment). */
  from: TilePos;
  /** Tile the walker is heading to, or null when standing still. */
  next: TilePos | null;
  /** Seconds already spent on the current segment. */
  segElapsed: number;
  done: boolean;
}

/** Where a walker is at server time `now` (epoch ms), including its current segment. */
export function walkAt(w: Walk, now: number): WalkPoint {
  let remaining = Math.max(0, (now - w.pathStartedAt) / 1000) * w.speed;
  let prev = w.pos;
  for (const p of w.path) {
    const seg = Math.hypot(p.x - prev.x, p.y - prev.y);
    if (remaining < seg) {
      const t = remaining / seg;
      return {
        x: prev.x + (p.x - prev.x) * t,
        y: prev.y + (p.y - prev.y) * t,
        from: prev,
        next: p,
        segElapsed: remaining / w.speed,
        done: false,
      };
    }
    remaining -= seg;
    prev = p;
  }
  return { x: prev.x, y: prev.y, from: prev, next: null, segElapsed: 0, done: true };
}

/** Last tile of a walk (where it ends up). */
export function walkEnd(w: Walk): TilePos {
  return w.path[w.path.length - 1] ?? w.pos;
}

/** Longest accepted path, in steps. Keeps A* and broadcast payloads bounded. */
export const MAX_PATH_STEPS = 96;

export type PlanResult =
  | { ok: true; walk: Pick<EntityState, "pos" | "path" | "pathStartedAt"> }
  | { ok: false; reason: "blocked" | "unreachable" | "too-far" };

/**
 * Plans a new walk to `target` that continues smoothly from where the walker is
 * at `now`: a walker mid-segment finishes that segment first, so the avatar
 * never snaps back. The returned walk starts at the segment's start tile with
 * `pathStartedAt` shifted into the past by the time already spent on it.
 */
export function planWalk(map: TileMap, w: Walk, target: TilePos, now: number): PlanResult {
  if (!Number.isInteger(target.x) || !Number.isInteger(target.y)) {
    return { ok: false, reason: "blocked" };
  }
  if (!isWalkable(map, target.x, target.y)) return { ok: false, reason: "blocked" };
  const at = walkAt(w, now);
  const tail = findPath(map, at.next ?? at.from, target);
  if (!tail) return { ok: false, reason: "unreachable" };
  const path = at.next ? [at.next, ...tail] : tail;
  if (path.length > MAX_PATH_STEPS) return { ok: false, reason: "too-far" };
  return {
    ok: true,
    walk: { pos: at.from, path, pathStartedAt: at.next ? now - at.segElapsed * 1000 : now },
  };
}
