/**
 * Word lists for the chat filter (wave-B.md §5). Original, deliberately short.
 *
 * MASK_WORDS are replaced with `*` in the text. BLOCK_WORDS make the whole
 * message `filtered` (never delivered). Entries are lowercase letters only; the
 * filter matches them after normalisation (leetspeak, repeats, separators).
 * Operators extend these lists in a reviewed change, not at runtime.
 */
export const MASK_WORDS: readonly string[] = [
  "fuck",
  "shit",
  "bitch",
  "bastard",
  "damn",
  "dammit",
  "crap",
];

/** Whole words: a block word must stand alone (boundaries as for MASK_WORDS). */
export const BLOCK_WORDS: readonly string[] = ["kys"];

/** Phrases: matched without boundaries, spaces and separators ignored ("kill yourself"). */
export const BLOCK_PHRASES: readonly string[] = ["killyourself", "hangyourself"];
