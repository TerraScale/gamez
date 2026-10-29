/**
 * Validation and sanitising of client-reported poses (wave-B.md §7). Pure:
 * no Workers or DOM APIs. The ChunkDO is the only caller; the client's own
 * sim is trusted for *where* the hero is, the server only enforces shape,
 * bounds, rate and cosmetic limits.
 */
import {
  MAX_COMPANIONS,
  type CompanionPose,
  type EntityState,
  type TilePos,
} from "@gamez/protocol";
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

/** Control characters (C0, DEL, C1) removed from operator tags. */
const CONTROL = /\p{Cc}/gu;
/**
 * The shape of a client-reported tag (R11): "Lv <level> <word>", plain ASCII,
 * level 1..9999. The word must also be in the world's `tagWords` vocabulary
 * (game data, e.g. the classic class names), so a tag carries no free text.
 */
export const LEVEL_TAG_PATTERN = /^Lv ([1-9][0-9]{0,3}) ([A-Za-z][A-Za-z' -]{0,30})$/;
/**
 * The load-test swarm's latency tag, "lt-<epoch ms>" (tools/loadtest/src/tag.ts):
 * digits only, so it carries no text either.
 */
export const LATENCY_TAG_PATTERN = /^lt-[0-9]{1,16}$/;

/** Longest companion name (party.md §11.3); names are game-data words (R11). */
export const MAX_COMPANION_NAME = 24;
/** Companion offsets are whole tiles in -MAX_OFFSET..MAX_OFFSET from the avatar. */
export const MAX_COMPANION_OFFSET = 4;

export type PoseReason = "bad-pose" | "out-of-bounds" | "path-too-long";

export interface PoseBounds {
  width: number;
  height: number;
  /**
   * The words a "Lv <n> <word>" tag may carry in this world (R11). Absent or
   * empty: only the latency tag is relayed.
   */
  tagWords?: readonly string[];
}

export interface CleanPose {
  pos: TilePos;
  path: TilePos[];
  speed: number;
  appearance: string;
  /** Absent when the reported tag is missing or empty after sanitising. */
  tag?: string;
  /**
   * Present when the report carried a companions array (possibly []: clear the
   * list). Absent = the avatar keeps its previous list.
   */
  companions?: CompanionPose[];
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

/** The appearance when it is a string that matches the pattern and length limit, else undefined. */
export function validAppearance(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (v.length > MAX_APPEARANCE || !APPEARANCE_PATTERN.test(v)) return undefined;
  return v;
}

/** Appearance id if it matches the pattern and length limit, else "unit.hero". */
export function sanitiseAppearance(v: unknown): string {
  return validAppearance(v) ?? DEFAULT_APPEARANCE;
}

/**
 * Tag without control characters, at most MAX_TAG code points; undefined when
 * nothing is left. Operator-authored tags (town fixtures) use this lenient
 * form; client-reported pose tags use sanitisePoseTag (R11).
 */
export function sanitiseTag(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const clean = Array.from(v.replace(CONTROL, "")).slice(0, MAX_TAG).join("");
  return clean.length > 0 ? clean : undefined;
}

/**
 * A client-reported tag, shown above every avatar in town (R11). It is not
 * free text: only "Lv <1..9999> <word>" with `word` exactly one of
 * `tagWords` (the world's game-data vocabulary), or the load test's
 * "lt-<digits>", is relayed. Matching is exact and ASCII, so look-alike
 * letters, fullwidth forms, links and insults are all dropped. Undefined for
 * anything else (the avatar then shows no tag).
 */
export function sanitisePoseTag(v: unknown, tagWords: readonly string[] = []): string | undefined {
  if (typeof v !== "string" || v.length > MAX_TAG) return undefined;
  if (LATENCY_TAG_PATTERN.test(v)) return v;
  const m = LEVEL_TAG_PATTERN.exec(v);
  if (!m || !tagWords.includes(m[2]!)) return undefined;
  return v;
}

/**
 * A companion's name, shown next to it to every player in town. Like the
 * pose tag (R11) it is not free text: only a word of the world's game-data
 * vocabulary (`tagWords`: the classic class names and "Hero") is relayed, so
 * the client reports the companion's class name, never the player-chosen hero
 * name. Exact match (look-alike letters, links and insults are dropped);
 * undefined for anything else, which drops the companion.
 */
export function sanitiseCompanionName(
  v: unknown,
  tagWords: readonly string[] = [],
): string | undefined {
  if (typeof v !== "string" || v.length > MAX_COMPANION_NAME) return undefined;
  return tagWords.includes(v) ? v : undefined;
}

/** An offset rounded to a whole tile and clamped to -4..4; undefined for a non-number. */
function companionOffset(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const r = Math.round(v);
  return Math.min(MAX_COMPANION_OFFSET, Math.max(-MAX_COMPANION_OFFSET, r));
}

/**
 * Companion list from a raw report. Entries with a bad appearance (the same rule
 * as the avatar's), a name outside `tagWords` (sanitiseCompanionName, R11) or a
 * non-number offset are dropped; offsets are rounded and clamped to -4..4; the
 * result keeps at most MAX_COMPANIONS valid entries, in report order. A
 * non-array gives [].
 */
export function sanitiseCompanions(v: unknown, tagWords: readonly string[] = []): CompanionPose[] {
  if (!Array.isArray(v)) return [];
  const out: CompanionPose[] = [];
  for (const raw of v) {
    if (out.length >= MAX_COMPANIONS) break;
    if (!isRecord(raw)) continue;
    const appearance = validAppearance(raw.appearance);
    const name = sanitiseCompanionName(raw.name, tagWords);
    const dx = companionOffset(raw.dx);
    const dy = companionOffset(raw.dy);
    if (appearance === undefined || name === undefined || dx === undefined || dy === undefined) {
      continue;
    }
    out.push({ appearance, name, dx, dy });
  }
  return out;
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
  const tag = sanitisePoseTag(raw.tag, bounds.tagWords);
  const pose: CleanPose = {
    pos,
    path,
    speed,
    appearance: sanitiseAppearance(raw.appearance),
  };
  if (tag !== undefined) pose.tag = tag;
  if (Array.isArray(raw.companions)) {
    pose.companions = sanitiseCompanions(raw.companions, bounds.tagWords);
  }
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

/**
 * The avatar state a checked pose turns `old` into at `now` (chunk.ts #pose):
 * the walk continues (continueWalk), the look and tag are replaced, and the
 * companions are replaced only when the report carried a list. Otherwise the
 * previous list is kept.
 */
export function poseState(old: EntityState, pose: CleanPose, now: number): EntityState {
  const state: EntityState = {
    ...old,
    ...continueWalk(old, pose, now),
    appearance: pose.appearance,
  };
  delete state.tag;
  if (pose.tag !== undefined) state.tag = pose.tag;
  if (pose.companions !== undefined) state.companions = pose.companions;
  return state;
}

/** Same companions to draw; an absent list and an empty one draw alike. */
function sameCompanions(a: CompanionPose[] | undefined, b: CompanionPose[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i]!;
    const q = y[i]!;
    if (p.appearance !== q.appearance || p.name !== q.name || p.dx !== q.dx || p.dy !== q.dy) {
      return false;
    }
  }
  return true;
}

/**
 * True when `next` (the state a pose turns into) would draw exactly like `old`
 * at `now`: both standing on the same tile with the same look and companions.
 * Keepalive poses of a hero standing still are answered without a delta (no fan-out cost).
 */
export function sameStanding(old: EntityState, next: EntityState, now: number): boolean {
  if (next.path.length > 0) return false;
  if (old.appearance !== next.appearance || old.tag !== next.tag || old.name !== next.name)
    return false;
  if (!sameCompanions(old.companions, next.companions)) return false;
  const at = walkAt(old, now);
  return !at.next && sameTile(at.from, next.pos);
}
