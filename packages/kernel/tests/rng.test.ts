import { describe, expect, it } from "vite-plus/test";
import { createRng } from "../src/index.ts";

describe("rng", () => {
  it("produces a pinned sequence for seed 42", () => {
    const rng = createRng(42);
    expect(Array.from({ length: 5 }, () => rng.next())).toEqual([
      0.8907801888417453, 0.4310670436825603, 0.3220651443116367, 0.2072944741230458,
      0.6512069271411747,
    ]);
  });

  it("differs between seeds and stays in range", () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.next()).not.toBe(b.next());
    for (let i = 0; i < 1000; i++) {
      const f = a.next();
      expect(f >= 0 && f < 1).toBe(true);
      const n = a.int(-2, 2);
      expect(Number.isInteger(n) && n >= -2 && n <= 2).toBe(true);
    }
  });

  it("restores state exactly", () => {
    const rng = createRng(7);
    rng.next();
    const state = rng.getState();
    expect(state.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)).toBe(true);
    const expected = [rng.next(), rng.int(1, 6), rng.next()];
    rng.setState(state);
    expect([rng.next(), rng.int(1, 6), rng.next()]).toEqual(expected);
    const other = createRng(999);
    other.setState(state);
    expect([other.next(), other.int(1, 6), other.next()]).toEqual(expected);
    expect(() => rng.setState([1, 2, 3] as never)).toThrow();
  });

  it("covers int bounds, chance, pick and shuffle", () => {
    const rng = createRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(rng.int(1, 3));
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(rng.int(5, 5)).toBe(5);
    expect(() => rng.int(3, 1)).toThrow(RangeError);
    expect(() => rng.int(0.5, 2)).toThrow(RangeError);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    expect(["a", "b", "c"]).toContain(rng.pick(["a", "b", "c"]));
    expect(() => rng.pick([])).toThrow(RangeError);
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = rng.shuffle(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shuffled].sort((x, y) => x - y)).toEqual(items);
    const again = createRng(3);
    for (let i = 0; i < 200; i++) again.int(1, 3);
    again.int(5, 5);
    again.chance(0);
    again.chance(1);
    again.pick(["a", "b", "c"]);
    expect(again.shuffle(items)).toEqual(shuffled);
  });
});
