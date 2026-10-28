/**
 * Seed sources of the arena ladder (wave-C.md §6.3). Production uses the Web
 * Crypto generator; tests inject a fixed sequence. Values are uint32.
 */
export type SeedSource = () => number;

/** A uniform uint32 from the platform CSPRNG. */
export const cryptoSeed: SeedSource = () => crypto.getRandomValues(new Uint32Array(1))[0]!;

/** `words` uint32 values as lowercase hex (8 hex digits each). */
export function hexId(seeds: SeedSource, words: number): string {
  let out = "";
  for (let i = 0; i < words; i++) out += (seeds() >>> 0).toString(16).padStart(8, "0");
  return out;
}
