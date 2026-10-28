import type { EffectKind } from "@gamez/ui-host";

/** Clamps to [0, 1]. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Float text motion: rises 40 px with ease-out and fades over the last 40% of its life. */
export const FLOAT_RISE_PX = 40;
export function floatPose(elapsedMs: number, lifeMs: number): { dy: number; alpha: number } {
  const p = clamp01(lifeMs > 0 ? elapsedMs / lifeMs : 1);
  const eased = 1 - (1 - p) * (1 - p);
  const alpha = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
  const dy = -FLOAT_RISE_PX * eased;
  return { dy: dy === 0 ? 0 : dy, alpha: clamp01(alpha) };
}

export function floatFontSize(size: "s" | "m" | "l" | undefined): number {
  if (size === "s") return 13;
  if (size === "l") return 24;
  return 17;
}

const DEFAULT_EFFECT_MS: Record<EffectKind, number> = {
  nova: 600,
  explosion: 500,
  chain: 450,
  beam: 400,
  heal: 700,
  blink: 400,
  hit: 400,
  cast: 400,
  levelup: 700,
  portal: 700,
  aoe: 600,
  slash: 400,
  telegraph: 1500,
  aura: 1200,
  burst: 600,
};

/** Effect lifetime: the spec's value clamped to 150..3000 ms, or the kind's default. */
export function effectDuration(kind: EffectKind, requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_EFFECT_MS[kind];
  return Math.min(3000, Math.max(150, Math.round(requested)));
}

/** Slow 0..1 pulse used for status tints (about 1.1 s period). */
export function pulseAmount(timeMs: number): number {
  return 0.5 + 0.5 * Math.sin(timeMs / 180);
}

/** Per-channel integer blend of two 0xRRGGBB colours; k = 0 gives a, 1 gives b. */
export function mixTint(a: number, b: number, k: number): number {
  const t = clamp01(k);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Tint of an entity body: the base multiply tint, brightened when highlighted,
 * then pulsed towards the status colour (0 = no status).
 */
export function entityTint(
  base: number,
  highlight: boolean,
  statusTint: number,
  pulse01: number,
): number {
  let t = highlight ? mixTint(base, 0xffffff, 0.35) : base;
  if (statusTint !== 0) t = mixTint(t, statusTint, 0.2 + 0.25 * clamp01(pulse01));
  return t;
}

/** Health bar fill fraction, 0..1 (NaN counts as 0). */
export function barFill(bar: number): number {
  return Number.isFinite(bar) ? clamp01(bar) : 0;
}

/** Deterministic hash of two integers to [0, 1). Used for jitter, never for sim. */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface LightRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LightLayout {
  /** Sprite scale: the transparent circle of the overlay texture has radius lightPx. */
  scale: number;
  /** Solid darkness rectangles outside the overlay sprite's square, in stage px. */
  rects: LightRect[];
}

/** Overlay texture: transparent to 32 px, opaque from 64 px, solid beyond (half-size 128 px). */
export const LIGHT_TEXTURE_INNER_PX = 32;
export const LIGHT_TEXTURE_HALF_PX = 128;

/**
 * Layout of the darkness overlay for a light of radius `lightPx` centred on
 * (cx, cy) in a `sw` x `sh` stage. The sprite covers the square around the
 * light; four rectangles cover what lies outside that square on screen.
 */
export function lightLayout(
  lightPx: number,
  cx: number,
  cy: number,
  sw: number,
  sh: number,
): LightLayout {
  const scale = Math.max(1e-3, lightPx / LIGHT_TEXTURE_INNER_PX);
  const h = LIGHT_TEXTURE_HALF_PX * scale;
  const top = Math.min(sh, Math.max(0, cy - h));
  const bottom = Math.min(sh, Math.max(0, cy + h));
  const left = Math.min(sw, Math.max(0, cx - h));
  const right = Math.min(sw, Math.max(0, cx + h));
  const rects: LightRect[] = [];
  const push = (x: number, y: number, w: number, hh: number) => {
    if (w > 0 && hh > 0) rects.push({ x, y, w, h: hh });
  };
  push(0, 0, sw, top);
  push(0, bottom, sw, sh - bottom);
  push(0, top, left, bottom - top);
  push(right, top, sw - right, bottom - top);
  return { scale, rects };
}

/** Largest frame step used by the simulation and visuals (ms). Matches the classic FixedLoop clamp (MAX_FRAME_MS); slow frames still lose time past this. */
export const FRAME_DELTA_MAX_MS = 1000;

/**
 * Wall-clock frame step (ms) between two ticker callbacks. Pixi's deltaMS is
 * clamped at 100 ms, which makes a slow frame lose sim time (Full Idle x8).
 * `lastMs` and `nowMs` are performance.now() readings; `fallbackMs` (Pixi's
 * deltaMS) is used for the first frame. Clamped to 0..FRAME_DELTA_MAX_MS.
 */
export function frameDeltaMs(nowMs: number, lastMs: number, fallbackMs: number): number {
  const fallback = Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : 0;
  if (!(lastMs > 0) || !Number.isFinite(nowMs)) return Math.min(FRAME_DELTA_MAX_MS, fallback);
  const dt = nowMs - lastMs;
  if (!(dt > 0)) return 0;
  return Math.min(FRAME_DELTA_MAX_MS, dt);
}

/** Largest camera shake offset (px) at full strength. */
export const SHAKE_MAX_PX = 14;

/**
 * Camera offset (px) of a shake that decays over `durationMs`. Quadratic
 * decay, a fast oscillation whose direction turns with elapsed time, and
 * zero once the duration has passed. Pure and deterministic.
 */
export function shakeOffset(
  strength: number,
  durationMs: number,
  elapsedMs: number,
): { dx: number; dy: number } {
  if (!(strength > 0) || !(durationMs > 0) || !(elapsedMs >= 0) || elapsedMs >= durationMs) {
    return { dx: 0, dy: 0 };
  }
  const left = 1 - elapsedMs / durationMs;
  const amp = Math.min(SHAKE_MAX_PX, strength) * left * left;
  const phase = elapsedMs * 0.09;
  return { dx: amp * Math.cos(phase * 1.3), dy: amp * Math.sin(phase) };
}

/** A 5x4 colour matrix (row-major), the shape ColorMatrixFilter takes. */
export type FlashMatrix = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * ColorMatrixFilter matrix (5x4, row-major) that mixes an entity towards
 * `colour` by `k` (0 = untouched, 1 = solid colour) and keeps its alpha. Used
 * for the white hit flash in place of the old red multiply tint.
 */
export function flashMatrix(colour: number, k: number): FlashMatrix {
  const t = clamp01(k);
  const r = (((colour >> 16) & 0xff) / 255) * t;
  const g = (((colour >> 8) & 0xff) / 255) * t;
  const b = ((colour & 0xff) / 255) * t;
  const keep = 1 - t;
  return [keep, 0, 0, 0, r, 0, keep, 0, 0, g, 0, 0, keep, 0, b, 0, 0, 0, 1, 0];
}

/**
 * Hit flash mix (0..1) of the white flash for a flash strength 0..1: it peaks
 * at 0.7 and is zero when there is no flash.
 */
export const FLASH_PEAK = 0.7;
export function flashMix(flash: number): number {
  return clamp01(flash) * FLASH_PEAK;
}

/** Procedural and burst art uses 64 px per tile of radius (wave-A.md §10.1). */
export const BURST_ART_PX_PER_TILE = 64;

/**
 * Scale of a `<sprite>.burst` animation for an effect of `radiusTiles` (a
 * radius of one tile is half a tile width on screen, tileWidth / 2 px).
 */
export function burstScale(radiusTiles: number, tileWidthPx: number): number {
  const r = Number.isFinite(radiusTiles) && radiusTiles > 0 ? radiusTiles : 1;
  return (r * (tileWidthPx / 2)) / BURST_ART_PX_PER_TILE;
}

/** Suffix of the one-shot burst animation of an effect sprite (`<sprite>.burst`). */
export const BURST_SUFFIX = ".burst";

/**
 * Manifest key of an effect's burst animation, or null for an effect without a
 * sprite. The caller checks the manifest: a missing key means procedural art only.
 */
export function burstKey(sprite: string | undefined): string | null {
  return sprite ? `${sprite}${BURST_SUFFIX}` : null;
}

/** The burst key of a sprite when `has` (the manifest's exact animation lookup) knows it, else null. */
export function burstKeyIn(
  sprite: string | undefined,
  has: (key: string) => boolean,
): string | null {
  const key = burstKey(sprite);
  return key !== null && has(key) ? key : null;
}
