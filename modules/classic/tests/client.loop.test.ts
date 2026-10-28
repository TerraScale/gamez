/** Client fixed-step accumulator and perf window (docs/design/classic.md §12.2). */
import { describe, expect, it } from "vite-plus/test";
import { FixedLoop, PerfWindow, STEP_MS } from "../src/client/loop.ts";

describe("FixedLoop", () => {
  it("runs one tick per 50 ms at speed 1", () => {
    const loop = new FixedLoop();
    let ticks = 0;
    for (let i = 0; i < 10; i++) ticks += loop.advance(STEP_MS, 1).ticks;
    expect(ticks).toBe(10);
  });

  it("accumulates fractional frames and reports the render alpha", () => {
    const loop = new FixedLoop();
    const a = loop.advance(20, 1);
    expect(a.ticks).toBe(0);
    expect(a.alpha).toBeCloseTo(0.4);
    const b = loop.advance(20, 1);
    expect(b.ticks).toBe(0);
    expect(b.alpha).toBeCloseTo(0.8);
    const c = loop.advance(20, 1);
    expect(c.ticks).toBe(1);
    expect(c.alpha).toBeCloseTo(0.2);
    expect(c.dropped).toBe(false);
  });

  it("multiplies time by the idle speed", () => {
    const loop = new FixedLoop();
    expect(loop.advance(50, 2).ticks).toBe(2);
    expect(loop.advance(50, 4).ticks).toBe(4);
    expect(loop.advance(50, 8).ticks).toBe(8);
  });

  it("clamps long frames to 250 ms of simulated time", () => {
    const loop = new FixedLoop();
    expect(loop.advance(10_000, 1).ticks).toBe(5);
  });

  it("caps catch-up ticks per frame and drops the rest", () => {
    const loop = new FixedLoop(50, 250, 2);
    const out = loop.advance(250, 1);
    expect(out.ticks).toBe(2);
    expect(out.dropped).toBe(true);
    expect(loop.pendingMs).toBe(0);
  });

  it("treats bad input as no time and speed below 1 as 1", () => {
    const loop = new FixedLoop();
    expect(loop.advance(Number.NaN, 1).ticks).toBe(0);
    expect(loop.advance(50, 0).ticks).toBe(1);
  });

  it("reset forgets pending time", () => {
    const loop = new FixedLoop();
    loop.advance(30, 1);
    loop.reset();
    const after = loop.advance(20, 1);
    expect(after.ticks).toBe(0);
    expect(after.alpha).toBeCloseTo(0.4);
  });
});

describe("PerfWindow", () => {
  it("reports frames per second and sim ms per tick over one second", () => {
    const perf = new PerfWindow(1000);
    // 51 frames (t = 0..1000 every 20 ms) close the one-second window.
    for (let t = 0; t <= 1000; t += 20) perf.frame(t);
    expect(perf.fps).toBe(51);
    perf.addSteps(20, 10, 1000);
    perf.addSteps(20, 10, 1000);
    perf.frame(2000);
    expect(perf.ticksPerSecond).toBeGreaterThan(0);
  });

  it("keeps the last full window until the next one closes", () => {
    const perf = new PerfWindow(1000);
    perf.frame(0);
    perf.frame(1000);
    expect(perf.fps).toBe(2);
    perf.frame(1200);
    expect(perf.fps).toBe(2);
  });
});
