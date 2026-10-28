/**
 * Validation and sanitising of client-reported poses (wave-B.md §7). Pure:
 * no Workers or DOM APIs. The ChunkDO is the only caller; the client's own
 * sim is trusted for *where* the hero is, the server only enforces shape,
 * bounds, rate and cosmetic limits.
 */
import type { EntityState, TilePos } from "@gamez/protocol";
import { walkAt } from "@gamez/world";

/** Longest path a pose may report, in tiles. */
export const MAX_POSE_PATH = 8;
export const POSE_SPEED_MIN = 1;
export const POSE_SPEED_MAX = 12;
export const MAX_APPEARANCE = 64;
export const MAX_TAG = 40;
export const DEFAULT_APPEARANCE = "unit.hero";

/** "unit.hero" or "unit.hero.<x>" with lowercase segments; anything else falls back to the default. */
export const APPEARANCE_PATTERN = /^unit\.hero(\.[a-z0-9_]+)*$/;

/** Control characters (C0, DEL, C1) removed from tags. */
const CONTROL = /\p{Cc}/gu;

export type PoseReason = "bad-pose" | "out-of-bounds" | "path-too-long";

export interface PoseBounds {
  width: number;
  height: number;
}

export interface CleanPose {
  pos: TilePos;
  path: TilePos[];
  speed: number;
  appearance: string;
  /** Absent when the reported tag is missing or empty after sanitising. */
  tag?: string;
}

export type PoseCheck = { ok: true; pose: CleanPose } | { ok: false; reason: PoseReason };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** A tile with integer coordinates (any size), or null when the shape is wrong. */
function tileShape(v: unknown): TilePos | null {
  if (!isRecord(v) || !isInt(v.x) || !isInt(v.y)) return null;
  return { x: v.x, y: v.y };
}

function inBounds(t: TilePos, bounds: PoseBounds): boolean {
  return t.x >= 0 && t.y >= 0 && t.x < bounds.width && t.y < bounds.height;
}

/** Appearance id if it matches the pattern and length limit, else "unit.hero". */
export function sanitiseAppearance(v: unknown): string {
  if (typeof v !== "string") return DEFAULT_APPEARANCE;
  if (v.length > MAX_APPEARANCE || !APPEARANCE_PATTERN.test(v)) return DEFAULT_APPEARANCE;
  return v;
}

/** Tag without control characters, at most MAX_TAG code points; undefined when nothing is left. */
export function sanitiseTag(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const clean = Array.from(v.replace(CONTROL, "")).slice(0, MAX_TAG).join("");
  return clean.length > 0 ? clean : undefined;
}

/**
 * Checks a raw pose (from a JSON frame, so its shape is unknown) and returns
 * the sanitised version. Positions and path tiles must be integers inside the
 * world bounds, the path at most MAX_POSE_PATH tiles. Speed is clamped to
 * 1..12 tiles/s. Bad appearance or tag values are dropped, not rejected.
 */
export function sanitisePose(raw: unknown, bounds: PoseBounds): PoseCheck {
  if (!isRecord(raw)) return { ok: false, reason: "bad-pose" };
  if (typeof raw.speed !== "number" || !Number.isFinite(raw.speed)) {
    return { ok: false, reason: "bad-pose" };
  }
  if (!Array.isArray(raw.path)) return { ok: false, reason: "bad-pose" };
  if (raw.path.length > MAX_POSE_PATH) return { ok: false, reason: "path-too-long" };

  const pos = tileShape(raw.pos);
  if (!pos) return { ok: false, reason: "bad-pose" };
  if (!inBounds(pos, bounds)) return { ok: false, reason: "out-of-bounds" };

  const path: TilePos[] = [];
  for (const step of raw.path) {
    const tile = tileShape(step);
    if (!tile) return { ok: false, reason: "bad-pose" };
    if (!inBounds(tile, bounds)) return { ok: false, reason: "out-of-bounds" };
    path.push(tile);
  }

  const speed = Math.min(POSE_SPEED_MAX, Math.max(POSE_SPEED_MIN, raw.speed));
  const tag = sanitiseTag(raw.tag);
  const pose: CleanPose = {
    pos,
    path,
    speed,
    appearance: sanitiseAppearance(raw.appearance),
  };
  if (tag !== undefined) pose.tag = tag;
  return { ok: true, pose };
}

/** Furthest the drawn avatar may be from the reported tile before a pose snaps instead of blending (tiles). */
export const MAX_CONTINUE_DRIFT = 2;

type PoseWalk = Pick<EntityState, "pos" | "path" | "pathStartedAt" | "speed">;

function sameTile(a: TilePos, b: TilePos): boolean {
  return a.x === b.x && a.y === b.y;
}

function adjacent(a: TilePos, b: TilePos): boolean {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;
}

/**
 * The walk a new pose turns into, continuing the avatar's current walk so the
 * drawn position never jumps (QA wave B: remote avatars snapped up to a tile
 * at every pose). Clients report the tile they stand on (floored) plus the
 * tiles ahead; restarting from that tile at receipt time moved the avatar back
 * to the tile's corner four times a second. Instead:
 *
 * - mid-segment and the segment's end tile is on the reported route: finish
 *   the segment, then follow the route from there (timeline kept);
 * - mid-segment and the route starts at the segment's start tile (the walker
 *   turned back): reverse on the spot;
 * - mid-segment otherwise: finish the segment, then step onto the route;
 * - standing next to the route start: walk onto it from where it stands;
 * - anything further than MAX_CONTINUE_DRIFT tiles away (teleport, rejoin,
 *   long lag): snap to the reported pose, as before.
 *
 * Pure; `now` is the receipt time in epoch ms. The result's tiles are all
 * integer tiles from either the old walk or the pose.
 */
export function continueWalk(
  old: PoseWalk,
  pose: Pick<CleanPose, "pos" | "path" | "speed">,
  now: number,
): Pick<EntityState, "pos" | "path" | "pathStartedAt" | "speed"> {
  const speed = pose.speed;
  const route: TilePos[] = [pose.pos];
  for (const t of pose.path) {
    if (!sameTile(t, route[route.length - 1]!)) route.push(t);
  }
  const snap = { pos: pose.pos, path: route.slice(1), pathStartedAt: now, speed };
  const at = walkAt(old, now);
  if (Math.hypot(at.x - pose.pos.x, at.y - pose.pos.y) > MAX_CONTINUE_DRIFT) return snap;

  if (!at.next) {
    if (sameTile(at.from, pose.pos) || !adjacent(at.from, pose.pos)) return snap;
    return { pos: at.from, path: route, pathStartedAt: now, speed };
  }

  const segLen = Math.hypot(at.next.x - at.from.x, at.next.y - at.from.y);
  const covered = Math.min(segLen, at.segElapsed * old.speed);
  const ahead = route.findIndex((t) => sameTile(t, at.next!));
  if (ahead >= 0) {
    return {
      pos: at.from,
      path: [at.next, ...route.slice(ahead + 1)],
      pathStartedAt: now - (covered / speed) * 1000,
      speed,
    };
  }
  if (sameTile(route[0]!, at.from)) {
    // Turned back: walk the rest of the way back to the segment's start tile, then on.
    return {
      pos: at.next,
      path: route,
      pathStartedAt: now - ((segLen - covered) / speed) * 1000,
      speed,
    };
  }
  if (!adjacent(at.next, route[0]!)) return snap;
  return {
    pos: at.from,
    path: [at.next, ...route],
    pathStartedAt: now - (covered / speed) * 1000,
    speed,
  };
}
