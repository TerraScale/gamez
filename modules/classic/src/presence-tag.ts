/**
 * The tag drawn over a classic hero in the shared town (wave-B.md §7, ADR
 * 0007 R11): "Lv <level> <class name>". It is built from game data only, so
 * the presence server relays nothing but tags of this vocabulary: no free
 * text reaches other players, whatever the client sends.
 *
 * Pure data and string helpers (not run by the kernel).
 */
import { CLASSES } from "./content/classes.ts";

/** Class name shown when the hero's class is unknown. */
export const PRESENCE_TAG_FALLBACK = "Hero";

/** Highest level a presence tag may show (4 digits). */
export const PRESENCE_TAG_MAX_LEVEL = 9999;

/** Every class word a classic presence tag may carry, sorted. */
export const PRESENCE_TAG_WORDS: readonly string[] = Object.freeze(
  [
    ...new Set([
      ...Object.keys(CLASSES)
        .sort()
        .map((id) => CLASSES[id]!.name),
      PRESENCE_TAG_FALLBACK,
    ]),
  ].sort(),
);

/** The tag of a hero of `level` and class `className` (fallback "Hero"). */
export function presenceTag(level: number, className: string | undefined): string {
  return `Lv ${level} ${className ?? PRESENCE_TAG_FALLBACK}`;
}
