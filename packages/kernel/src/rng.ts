/** Deterministic PRNG: sfc32 with its state seeded by splitmix32. */
import type { Rng, RngState } from "./types.ts";

/** splitmix32 stream; each call returns the next uint32. */
function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return z >>> 0;
  };
}

class Sfc32 implements Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  constructor(seed: number) {
    if (!Number.isFinite(seed))
      throw new RangeError(`Rng seed must be a finite number, got ${seed}`);
    const sm = splitmix32(seed);
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    // Standard warm-up so nearby seeds diverge immediately.
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  /** Next raw uint32. */
  private nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  next(): number {
    return this.nextUint32() / 4294967296;
  }

  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new RangeError(`rng.int(${min}, ${max}): need integers with min <= max`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("rng.pick() of an empty array");
    return items[this.int(0, items.length - 1)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  getState(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  setState(s: RngState): void {
    if (!Array.isArray(s) || s.length !== 4 || !s.every((n) => Number.isInteger(n))) {
      throw new TypeError("Rng state must be [number, number, number, number] of integers");
    }
    this.a = s[0] | 0;
    this.b = s[1] | 0;
    this.c = s[2] | 0;
    this.d = s[3] | 0;
  }
}

/** Seeded PRNG (sfc32 seeded via splitmix32 from `seed`). Same seed -> same sequence on every JS engine. */
export function createRng(seed: number): Rng {
  return new Sfc32(seed);
}
