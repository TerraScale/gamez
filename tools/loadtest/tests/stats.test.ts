import { describe, expect, it } from "vite-plus/test";
import { Histogram, percentilesOf } from "../src/stats.ts";

describe("Histogram", () => {
  it("gives 1 ms percentiles and merges across threads", () => {
    const a = new Histogram();
    const b = new Histogram();
    for (let i = 0; i < 100; i++) (i < 50 ? a : b).add(i + 0.5);
    a.merge(b.toData());
    const s = a.summary();
    expect(s.n).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
    expect(s.max).toBe(99.5);
    expect(s.mean).toBeCloseTo(50, 5);
  });

  it("clamps negatives to 0, overflows into the last bin and ignores NaN", () => {
    const h = new Histogram();
    h.add(-3);
    h.add(Number.NaN);
    h.add(120_000);
    expect(h.total).toBe(2);
    expect(h.quantile(0.5)).toBe(1);
    expect(h.max).toBe(120_000);
    expect(h.quantile(1)).toBe(60_001);
    h.reset();
    expect(Number.isNaN(h.quantile(0.5))).toBe(true);
  });

  it("toData is sparse and round-trips", () => {
    const h = new Histogram();
    h.add(3);
    const d = h.toData();
    expect(d.counts).toHaveLength(4);
    const g = new Histogram();
    g.merge(d);
    expect(g.summary()).toEqual(h.summary());
  });
});

describe("percentilesOf", () => {
  it("is exact on small samples", () => {
    expect(percentilesOf([5, 1, 3, 2, 4])).toMatchObject({ n: 5, p50: 3, p95: 5, max: 5, mean: 3 });
    expect(percentilesOf([]).n).toBe(0);
  });
});
