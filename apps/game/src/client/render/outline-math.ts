import type { EntityHighlight, GraphicsQualityLevel } from "@gamez/ui-host";
import { clamp01, type FlashMatrix } from "./fx-math.ts";

/**
 * Identity outline ("ink") of a unit: which hero is the player's, which are
 * party members and other players. Pure: entity-view.ts draws it.
 *
 * Technique: stamping. A few copies of the current frame, offset around the
 * sprite, are drawn behind it. The coloured copies sit in one container whose
 * colour-matrix filter turns them into a solid silhouette of the outline
 * colour; on medium and high a second ring of copies, tinted black (a multiply
 * tint of 0 needs no filter), adds a thin dark rim so the outline reads on
 * light floors too. All copies share the frame texture, so they batch.
 */

export interface OutlineStyle {
  /** Outline colour (0xRRGGBB). */
  colour: number;
  /** Opacity of the coloured outline. */
  alpha: number;
  /** Opacity of each dark rim copy (0 = no rim). */
  rimAlpha: number;
  /** Ground ring colour and its opacity range (pulses between min and max). */
  ringColour: number;
  ringMin: number;
  ringMax: number;
}

/** Self is bright warm gold-white; party (cyan) and ally (green) are dimmer. */
export const OUTLINE_STYLE: Readonly<Record<EntityHighlight, OutlineStyle>> = {
  self: {
    colour: 0xffe27a,
    alpha: 1,
    rimAlpha: 0.7,
    ringColour: 0xffd75e,
    ringMin: 0.45,
    ringMax: 0.9,
  },
  party: {
    colour: 0x5fd4ff,
    alpha: 0.85,
    rimAlpha: 0.4,
    ringColour: 0x5fd4ff,
    ringMin: 0.3,
    ringMax: 0.6,
  },
  ally: {
    colour: 0x8fdc8a,
    alpha: 0.7,
    rimAlpha: 0.3,
    ringColour: 0x8fdc8a,
    ringMin: 0.22,
    ringMax: 0.45,
  },
};

export function outlineStyle(kind: EntityHighlight): OutlineStyle {
  return OUTLINE_STYLE[kind];
}

/**
 * The identity outline an entity asks for: a string kind wins; `true` is the
 * hover channel (no identity outline); `false`/`null` mean none; omitted means
 * "self" for isSelf entities.
 */
export function resolveHighlight(
  highlight: boolean | EntityHighlight | null | undefined,
  isSelf: boolean,
): EntityHighlight | null {
  if (highlight === "self" || highlight === "party" || highlight === "ally") return highlight;
  if (highlight === undefined) return isSelf ? "self" : null;
  return null;
}

/** Outline width (CSS px on screen, independent of zoom and unit scale). */
export const OUTLINE_PX = 2;
/** The dark rim reaches this much further out (CSS px). */
export const RIM_EXTRA_PX = 1;
/** Number of stamp directions created per ring (low quality shows every other one). */
export const OUTLINE_TAPS = 8;

/** Stamp copies shown per quality: 8 directions, or the 4 cardinal ones on low. */
export function outlineTaps(q: GraphicsQualityLevel): number {
  return q === "low" ? 4 : OUTLINE_TAPS;
}

/** The dark rim ring is drawn on medium and high only. */
export function outlineRim(q: GraphicsQualityLevel): boolean {
  return q !== "low";
}

/** True when the stamp at `index` (0..OUTLINE_TAPS-1) is shown at `taps` copies. */
export function tapShown(index: number, taps: number): boolean {
  if (taps >= OUTLINE_TAPS) return true;
  const step = Math.max(1, Math.round(OUTLINE_TAPS / Math.max(1, taps)));
  return index % step === 0;
}

/**
 * Offsets of the OUTLINE_TAPS stamps on a circle of `radius` (E, SE, S, SW,
 * W, NW, N, NE), written in place into `out` as x0, y0, x1, y1, ... (no
 * allocation). Even indexes are the cardinal directions.
 */
export function outlineOffsets(radius: number, out: Float32Array | number[]): void {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  for (let i = 0; i < OUTLINE_TAPS; i++) {
    // `+ 0` turns -0 into 0.
    out[i * 2] = (UNIT_X[i] ?? 0) * r + 0;
    out[i * 2 + 1] = (UNIT_Y[i] ?? 0) * r + 0;
  }
}

const D = Math.SQRT1_2;
const UNIT_X: readonly number[] = [1, D, 0, -D, -1, -D, 0, D];
const UNIT_Y: readonly number[] = [0, D, 1, D, 0, -D, -1, -D];

/**
 * Stamp radius in the body's local px for `screenPx` CSS px on screen: the
 * world is scaled by the camera zoom and the body by the unit scale. Rounded
 * to 1/8 px so tiny zoom jitter does not move every stamp.
 */
export function localRadius(screenPx: number, zoom: number, scale: number): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.round((screenPx / (z * s)) * 8) / 8;
}

/** Ground ring pulse period (ms). */
export const RING_PERIOD_MS = 1600;

/** Smooth 0..1 pulse of the ground ring (0 at t = 0, 1 at half a period). */
export function ringPulse(timeMs: number): number {
  const t = Number.isFinite(timeMs) ? timeMs : 0;
  return 0.5 - 0.5 * Math.cos((t / RING_PERIOD_MS) * Math.PI * 2);
}

/** Ring opacity for a pulse value. */
export function ringAlpha(style: OutlineStyle, pulse01: number): number {
  return style.ringMin + (style.ringMax - style.ringMin) * clamp01(pulse01);
}

/** Ring scale: breathes 0.92..1.08 with the pulse. */
export function ringScale(pulse01: number): number {
  return 0.92 + 0.16 * clamp01(pulse01);
}

/** Outline fade time on death (and back on revive), ms. */
export const OUTLINE_FADE_MS = 500;

/**
 * Outline strength of a downed hero: the controlled hero ("self") and party
 * members ("party") stay marked, dimmer, while they lie down (the player must
 * still find their own hero and the allies to revive); "ally" fades out.
 */
export const DOWNED_OUTLINE_ALPHA = 0.45;

/** The fade an outline of `kind` heads for: 1 standing, DOWNED_OUTLINE_ALPHA or 0 when dead. */
export function outlineTarget(kind: EntityHighlight, dead: boolean): number {
  if (!dead) return 1;
  return kind === "ally" ? 0 : DOWNED_OUTLINE_ALPHA;
}

/** Moves `current` towards `target` (both 0..1) by dt / OUTLINE_FADE_MS. */
export function fadeToward(current: number, target: number, dtMs: number): number {
  const step = Number.isFinite(dtMs) && dtMs > 0 ? dtMs / OUTLINE_FADE_MS : 0;
  if (current < target) return Math.min(target, current + step);
  if (current > target) return Math.max(target, current - step);
  return current;
}

/**
 * Colour matrix that paints everything solid `colour` at `alpha` times the
 * source alpha (the shader multiplies rgb by the output alpha).
 */
export function solidMatrix(colour: number, alpha: number): FlashMatrix {
  const r = ((colour >> 16) & 0xff) / 255;
  const g = ((colour >> 8) & 0xff) / 255;
  const b = (colour & 0xff) / 255;
  return [0, 0, 0, 0, r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, clamp01(alpha), 0];
}
