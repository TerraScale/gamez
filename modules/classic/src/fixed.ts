/**
 * Fixed-point maths for the classic sim (CONTRACT, implemented). Everything
 * that feeds back into the state is an integer:
 *
 * - Positions are in SUB units: 1 tile = 256 sub. Tile of a position = x >> 8.
 *   The centre of tile (tx, ty) is (tx * 256 + 128, ty * 256 + 128).
 * - Speeds are sub per tick. Durations and cooldowns are ticks (20 Hz).
 * - Angles are integer steps 0..63 (64 per turn); angle 0 points to +x in
 *   tile space, 16 to +y. Directions come from the integer COS/SIN tables
 *   (scaled by 1024), never from Math.sin/cos/atan2 (not bit-identical
 *   across engines).
 *
 * Allowed Math in sim code: + - * / %, Math.floor/ceil/round/trunc/abs/min/
 * max/sign/imul/sqrt (sqrt is correctly rounded by IEEE 754). Forbidden for
 * state: Math.sin/cos/tan/atan2/pow/exp/log/hypot.
 */
import type { Facing } from "@gamez/ui-host";

export type { Facing };

export const SUB = 256;
export const SUB_SHIFT = 8;
export const HALF_TILE = 128;
export const TICK_HZ = 20;
export const TICK_MS = 50;
export const ANGLE_STEPS = 64;
/** Fixed-point scale of COS/SIN. */
export const TRIG_ONE = 1024;

export interface TilePos {
  x: number;
  y: number;
}

/** A position in sub units. */
export interface SubPos {
  x: number;
  y: number;
}

// prettier-ignore
export const COS64: readonly number[] = [1024,1019,1004,980,946,903,851,792,724,650,569,483,392,297,200,100,0,-100,-200,-297,-392,-483,-569,-650,-724,-792,-851,-903,-946,-980,-1004,-1019,-1024,-1019,-1004,-980,-946,-903,-851,-792,-724,-650,-569,-483,-392,-297,-200,-100,0,100,200,297,392,483,569,650,724,792,851,903,946,980,1004,1019];
// prettier-ignore
export const SIN64: readonly number[] = [0,100,200,297,392,483,569,650,724,792,851,903,946,980,1004,1019,1024,1019,1004,980,946,903,851,792,724,650,569,483,392,297,200,100,0,-100,-200,-297,-392,-483,-569,-650,-724,-792,-851,-903,-946,-980,-1004,-1019,-1024,-1019,-1004,-980,-946,-903,-851,-792,-724,-650,-569,-483,-392,-297,-200,-100];

/** Tile coordinate of a sub coordinate. */
export function toTile(sub: number): number {
  return sub >> SUB_SHIFT;
}

/** Sub coordinate of a tile's centre. */
export function tileCenter(tile: number): number {
  return (tile << SUB_SHIFT) + HALF_TILE;
}

/** Tiles to sub units (integer). Use for ranges written in tiles in content data. */
export function tiles(n: number): number {
  return Math.round(n * SUB);
}

/** Squared distance in sub units (exact integer while coordinates stay below 2^26). */
export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Integer square root (floor). */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  return Math.floor(Math.sqrt(n));
}

/** Distance in sub units, floored. */
export function dist(ax: number, ay: number, bx: number, by: number): number {
  return isqrt(dist2(ax, ay, bx, by));
}

/** True when (a) and (b) are within r sub units (inclusive). */
export function within(ax: number, ay: number, bx: number, by: number, r: number): boolean {
  return dist2(ax, ay, bx, by) <= r * r;
}

/** Chebyshev distance in tiles between two tile positions. */
export function chebyshev(a: TilePos, b: TilePos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Integer unit-ish vector of length `len` from (dx, dy). Returns [0, 0] for a
 * zero delta. Components are truncated toward zero.
 */
export function scaleTo(dx: number, dy: number, len: number): [number, number] {
  const d = isqrt(dx * dx + dy * dy);
  if (d === 0) return [0, 0];
  return [Math.trunc((dx * len) / d), Math.trunc((dy * len) / d)];
}

/** Closest of the 64 angle steps to the direction (dx, dy) (max dot product, ties -> lower step). */
export function angleOf(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < ANGLE_STEPS; i++) {
    const dot = dx * COS64[i]! + dy * SIN64[i]!;
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }
  return best;
}

/** Normalises any integer angle into 0..63. */
export function wrapAngle(a: number): number {
  return ((a % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS;
}

/** Vector of length `len` along angle step `a`, truncated toward zero. */
export function angleVec(a: number, len: number): [number, number] {
  const i = wrapAngle(a);
  return [Math.trunc((COS64[i]! * len) / TRIG_ONE), Math.trunc((SIN64[i]! * len) / TRIG_ONE)];
}

/** Smallest absolute difference between two angle steps (0..32). */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(wrapAngle(a) - wrapAngle(b));
  return d > ANGLE_STEPS / 2 ? ANGLE_STEPS - d : d;
}

/**
 * The 8 iso facings for a tile-space delta, matching the client's
 * facingFromDelta: screen X = 2 * (dx - dy), screen Y = dx + dy. A zero
 * delta returns `fallback`. Pure integer comparisons.
 */
export function facingOf(dx: number, dy: number, fallback: Facing = "s"): Facing {
  if (dx === 0 && dy === 0) return fallback;
  const sx = 2 * (dx - dy);
  const sy = dx + dy;
  const ax = Math.abs(sx);
  const ay = Math.abs(sy);
  // tan(22.5 deg) ~= 0.41421 -> 41421 / 100000
  if (ay * 100000 <= ax * 41421) return sx > 0 ? "e" : "w";
  if (ax * 100000 <= ay * 41421) return sy > 0 ? "s" : "n";
  if (sx > 0) return sy > 0 ? "se" : "ne";
  return sy > 0 ? "sw" : "nw";
}

/** Integer percentage of `value` (floor). pct(250, 40) === 100. */
export function pct(value: number, percent: number): number {
  return Math.floor((value * percent) / 100);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 32-bit integer hash of a list of integers (deterministic, engine
 * independent). Used to derive level seeds: mix(worldSeed, depth).
 */
export function mix(...parts: number[]): number {
  let h = 0x811c9dc5 | 0;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return h >>> 0;
}
