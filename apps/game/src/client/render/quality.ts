import type { GraphicsQualityLevel } from "@gamez/ui-host";

/**
 * Graphics quality presets (wave A, docs/design/wave-A.md §10.4). Pure: the
 * renderer and the effect layers read these tables, nothing here touches Pixi.
 */

/** Live particle caps per quality (low draws none). */
export const PARTICLE_CAP: Readonly<Record<GraphicsQualityLevel, number>> = {
  low: 0,
  medium: 250,
  high: 600,
};

/** Share of an effect's particle count kept at each quality. */
export function particleFactor(q: GraphicsQualityLevel): number {
  if (q === "high") return 1;
  if (q === "medium") return 0.5;
  return 0;
}

export function particleCap(q: GraphicsQualityLevel): number {
  return PARTICLE_CAP[q];
}

/** Share of the segments of a procedural shape (rings, arcs) kept at each quality. */
export function segmentFactor(q: GraphicsQualityLevel): number {
  return q === "low" ? 0.5 : 1;
}

/** Glow halos and the extra glow strokes of effects: off on low. */
export function glowEnabled(q: GraphicsQualityLevel): boolean {
  return q !== "low";
}

/** Camera shake: off on low. */
export function shakeEnabled(q: GraphicsQualityLevel): boolean {
  return q !== "low";
}

/** Darkness overlay texture size in px (the overlay is smooth, so low uses half). */
export function lightTextureSize(q: GraphicsQualityLevel): number {
  return q === "low" ? 128 : 256;
}

/**
 * Renderer resolution for a device pixel ratio: low 1, medium at most 1.5,
 * high at most 2. Never below 1, never above the device ratio.
 */
export function qualityResolution(q: GraphicsQualityLevel, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (q === "low") return 1;
  const cap = q === "medium" ? 1.5 : 2;
  return Math.max(1, Math.min(dpr, cap));
}

/** Parses a stored quality value; anything unknown is "high" (the default). */
export function parseQuality(v: unknown): GraphicsQualityLevel {
  return v === "low" || v === "medium" || v === "high" ? v : "high";
}
