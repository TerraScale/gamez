/**
 * Float text placement (pure, no Pixi, unit-tested). Damage numbers and pickup
 * texts rise from a unit's head. Three rules keep them readable:
 *  - the hero's own nameplate is never covered: a float whose box overlaps the
 *    nameplate horizontally stays above the plate's top edge for its whole
 *    life, even when the hero walks under it (floatRestY);
 *  - at most FLOAT_STACK_CAP floats share one spot: the oldest are dropped
 *    (floatsToDrop), the rest are spread by floatStagger;
 *  - pickup texts ("+10 gold") start above the sprite band of their tile and
 *    are told apart from damage numbers by their text (isPickupFloat).
 */

/** The box a float must stay above: the hero's visible nameplate stack. World-local px. */
export interface FloatBand {
  /** Horizontal centre. */
  x: number;
  /** Top edge (smaller y is higher on screen). */
  top: number;
  /** Width. */
  w: number;
}

/** Gap kept between a float's baseline and a band's top edge (px). */
export const FLOAT_BAND_GAP = 2;

/**
 * The float's baseline (its bottom edge: the text is bottom-anchored) must
 * stay at or above `band.top - FLOAT_BAND_GAP` while its box overlaps the band
 * horizontally. Floats only ever rise (their pose moves them up), so the clamp
 * only ever pushes them up, never down; a band that moves away releases them.
 * `halfW` is the float's half width (px).
 */
export function floatRestY(y: number, cx: number, halfW: number, band: FloatBand | null): number {
  if (band === null) return y;
  if (Math.abs(cx - band.x) * 2 >= halfW * 2 + band.w) return y;
  const limit = band.top - FLOAT_BAND_GAP;
  return y > limit ? limit : y;
}

/** Floats that share one spot at once (the nearest ones, all ages). */
export const FLOAT_STACK_CAP = 4;

/**
 * How many of the `nearAlive` floats on one spot to retire before a new float
 * joins them, so that at most `cap` stay (the oldest go first).
 */
export function floatsToDrop(nearAlive: number, cap: number = FLOAT_STACK_CAP): number {
  return Math.max(0, nearAlive - cap + 1);
}

/** Pickup texts start this much higher (px) than damage numbers: above the sprites of the tile. */
export const PICKUP_LIFT = 16;

/** Pickup texts: "+10 gold" (classic.gold) and anything worded the same way. */
export function isPickupFloat(text: string): boolean {
  return /\bgold$/.test(text);
}
