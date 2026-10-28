import { tileToScreen } from "@gamez/world";

/**
 * Pure animation math for entity views (no Pixi, unit-tested directly):
 * manual clip frames, projectile heading, hit flash, walk rate and float
 * staggering.
 */

/**
 * Frame of an n-frame clip at progress p (0..1): min(n - 1, floor(p * n)).
 * Non-finite or negative progress shows the first frame.
 */
export function frameFromProgress(progress: number, frames: number): number {
  if (frames <= 1) return 0;
  const p = Number.isFinite(progress) ? progress : 0;
  if (p <= 0) return 0;
  const f = Math.floor(p * frames);
  return f >= frames ? frames - 1 : f;
}

/**
 * Screen rotation (radians, Pixi convention: clockwise from screen-right) of a
 * tile-space travel vector. tileToScreen is linear, so the vector's screen
 * projection is (vx - vy) * halfTileW, (vx + vy) * halfTileH. 0 for a zero vector.
 */
export function projectileAngle(vx: number, vy: number): number {
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || (vx === 0 && vy === 0)) return 0;
  const s = tileToScreen(vx, vy);
  return Math.atan2(s.sy, s.sx);
}

/** Red the body is pushed towards at full hit flash. */
export const HIT_FLASH_TINT = 0xff4a4a;
/** Share of the flash colour mixed in at hitFlash = 1. */
export const HIT_FLASH_MIX = 0.75;

/**
 * Knockback offset in px for a hit flash 0..1: 2 px for the first half of the
 * flash, 1 px after, 0 when over. Pushed against the facing (`left` = the unit
 * looks screen-left, so it is knocked to the right).
 */
export function hitKnockback(flash: number, left: boolean): number {
  if (!(flash > 0)) return 0;
  const px = flash > 0.5 ? 2 : 1;
  return left ? px : -px;
}

/** Clamp range of animRate (clip speed multiplier). */
export const ANIM_RATE_MIN = 0.6;
export const ANIM_RATE_MAX = 1.8;

/** A safe clip speed multiplier: 1 for missing/invalid values, else clamped to 0.6..1.8. */
export function clampAnimRate(rate: number | undefined): number {
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return 1;
  return rate < ANIM_RATE_MIN ? ANIM_RATE_MIN : rate > ANIM_RATE_MAX ? ANIM_RATE_MAX : rate;
}

/** Fresh float texts spawned within this many px of each other are staggered. */
export const FLOAT_STAGGER_NEAR_PX = 14;
const STAGGER_X_PX = 12;
const STAGGER_Y_PX = 15;
const STAGGER_MAX_STEPS = 4;

/**
 * Offset for a float spawned while k others are still fresh at (nearly) the
 * same spot: 0 for the first, then alternating right/left and stacked
 * upwards. Steps cycle through 1..4 (the older floats have risen by then), so
 * a burst never leaves the unit's head area. Deterministic.
 */
export function floatStagger(k: number): { dx: number; dy: number } {
  if (k <= 0) return { dx: 0, dy: 0 };
  const step = ((k - 1) % STAGGER_MAX_STEPS) + 1;
  const side = k % 2 === 1 ? 1 : -1;
  const reach = Math.min(2, Math.ceil(step / 2));
  return { dx: side * reach * STAGGER_X_PX, dy: -step * STAGGER_Y_PX };
}

/**
 * Height (px) from the anchor point (the feet) to the top of the visible
 * pixels of a frame: anchorY x untrimmed height - transparent rows trimmed off
 * the top. Atlas frames are trimmed, so the untrimmed height alone would put
 * names and bars far above short sprites. Never below `min`.
 */
export function visibleHeight(
  anchorY: number,
  origHeight: number,
  trimTop: number,
  min = 8,
): number {
  const h = anchorY * origHeight - trimTop;
  return Number.isFinite(h) && h > min ? h : min;
}
