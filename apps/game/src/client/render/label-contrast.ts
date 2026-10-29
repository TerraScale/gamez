/**
 * Label colours and their contrast (pure, no Pixi, unit-tested). Every world
 * label is drawn on a dark backing: the name plate (PLATE_COLOUR at
 * PLATE_ALPHA) where the entity has one, else the black text stroke. The
 * helpers here make sure the fill reads on that backing (WCAG 4.5:1 for text)
 * without the content having to pick colours that happen to work.
 */

/** Dark name/subtitle plate behind a label (labelPlate and NPC subtitles). */
export const PLATE_COLOUR = 0x05070b;
export const PLATE_ALPHA = 0.62;
/** Black text stroke: the backing of a label without a plate. */
export const LABEL_STROKE_COLOUR = 0x000000;
/** Role subtitles ('Smith', 'Rag Buyer'): quieter than names, still legible on a plate. */
export const SUBTITLE_COLOUR = 0xb3b9c6;

/** WCAG AA minimum for text. */
export const MIN_LABEL_CONTRAST = 4.5;

function channelLinear(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0..1) of a 0xRRGGBB colour. */
export function relativeLuminance(c: number): number {
  return (
    0.2126 * channelLinear((c >> 16) & 255) +
    0.7152 * channelLinear((c >> 8) & 255) +
    0.0722 * channelLinear(c & 255)
  );
}

/** WCAG contrast ratio of two 0xRRGGBB colours (1..21). */
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * `fg` drawn at `alpha` over an opaque `bg` (sRGB mix, the way Pixi blends a
 * translucent plate over the ground). Used to get the real backing colour.
 */
export function compositeOver(fg: number, bg: number, alpha: number): number {
  const a = Math.min(1, Math.max(0, alpha));
  const mix = (shift: number): number => {
    const f = (fg >> shift) & 255;
    const b = (bg >> shift) & 255;
    return Math.round(f * a + b * (1 - a));
  };
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/** Mixes `c` towards white by `t` (0 keeps it, 1 is white). */
export function lightenTowardsWhite(c: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const mix = (shift: number): number => {
    const v = (c >> shift) & 255;
    return Math.round(v + (255 - v) * k);
  };
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/**
 * The fill to draw a label with on `backing`: `fill` itself when it reaches
 * `min` contrast, else the nearest lighter tint that does (steps of 5%). Dark
 * tints of a hue (a deep blue or red) are lifted, the hue stays recognisable.
 * Pure and cheap (at most 20 steps); called when a label's colour is set,
 * not per frame.
 */
export function readableLabelColour(
  fill: number,
  backing: number,
  min = MIN_LABEL_CONTRAST,
): number {
  if (contrastRatio(fill, backing) >= min) return fill;
  for (let step = 1; step <= 20; step++) {
    const tinted = lightenTowardsWhite(fill, step * 0.05);
    if (contrastRatio(tinted, backing) >= min) return tinted;
  }
  return 0xffffff;
}

/** The backing a label with (plated) or without a plate is read against. */
export function labelBacking(plated: boolean): number {
  if (!plated) return LABEL_STROKE_COLOUR;
  return compositeOver(PLATE_COLOUR, LABEL_STROKE_COLOUR, PLATE_ALPHA);
}
