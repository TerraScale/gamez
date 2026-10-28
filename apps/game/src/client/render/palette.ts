/**
 * Fallback colours for art that is missing from the manifest. Pure data, so
 * tests and the renderer share one source. Unknown ground ids are dark.
 */

export function groundFallbackColour(id: string): number {
  if (id.includes("tile.void")) return 0x07080b;
  if (id.includes("crypt")) return 0x3a3646;
  if (id.includes("cave")) return 0x3f3428;
  if (id.includes("forge")) return 0x4a2a1c;
  if (id.includes("abyss")) return 0x1c1430;
  if (id.includes("stone")) return 0x7d8491;
  if (id.includes("grass")) return 0x4d7c3a;
  if (id.includes("dirt")) return 0x6b5b4b;
  return 0x1e1f26;
}

/** Tall box colour for a wall id without art, tinted by theme (crypt, cave, forge, abyss). */
export function wallColour(id: string): number {
  if (id.includes("crypt")) return 0x6e6a7a;
  if (id.includes("cave")) return 0x6b5844;
  if (id.includes("forge")) return 0x8a4a2a;
  if (id.includes("abyss")) return 0x3b2a63;
  return 0x5f6470;
}

export const DEFAULT_LABEL_COLOUR = 0xe8ecf4;
export const SELF_LABEL_COLOUR = 0xffd166;

export function labelColour(isSelf: boolean): number {
  return isSelf ? SELF_LABEL_COLOUR : DEFAULT_LABEL_COLOUR;
}
