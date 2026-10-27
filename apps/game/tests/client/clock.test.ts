import { describe, expect, it } from "vite-plus/test";
import { ClockSync, median } from "../../src/client/clock.ts";

describe("median", () => {
  it("handles empty, odd and even inputs", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("ClockSync", () => {
  it("defaults to zero offset and no rtt", () => {
    const c = new ClockSync();
    expect(c.offset).toBe(0);
    expect(c.rtt).toBeNull();
    expect(c.serverNow(1000)).toBe(1000);
  });

  it("uses the seed until the first pong", () => {
    const c = new ClockSync();
    c.seed(5000, 1000);
    expect(c.offset).toBe(4000);
    // Server is 10 s ahead, symmetric 100 ms round trip.
    c.addSample(1000, 11_050, 1100);
    expect(c.offset).toBe(10_000);
    expect(c.rtt).toBe(100);
  });

  it("takes the median so one slow round trip doesn't skew the estimate", () => {
    const c = new ClockSync();
    c.addSample(0, 10_050, 100); // offset 10000, rtt 100
    c.addSample(200, 10_250, 300); // offset 10000, rtt 100
    c.addSample(400, 12_000, 2400); // asymmetric spike: offset 10600, rtt 2000
    expect(c.offset).toBe(10_000);
    expect(c.rtt).toBe(100);
  });

  it("keeps only the most recent samples", () => {
    const c = new ClockSync(3);
    for (let i = 0; i < 3; i++) c.addSample(i * 100, 50 + i * 100, i * 100 + 100); // offset 0
    for (let i = 0; i < 3; i++) c.addSample(i * 100, 550 + i * 100, i * 100 + 100); // offset 500
    expect(c.offset).toBe(500);
  });

  it("ignores negative round trips", () => {
    const c = new ClockSync();
    c.addSample(200, 1000, 100);
    expect(c.rtt).toBeNull();
  });
});
