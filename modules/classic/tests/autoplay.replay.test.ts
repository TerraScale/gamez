/**
 * Determinism of a full 20-minute autoplay run (real content, every module):
 * the server must be able to replay what the client simulated.
 * - Same seed and actions -> the same final hash, whatever the step batch
 *   size (the client steps 1..n ticks per frame).
 * - A snapshot taken mid-run, sent through JSON (as it is persisted), restores
 *   to the same hash and continues identically to the end.
 */
import { createSim, loadMode, type Sim, type SimSnapshot } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";

const SEED = 2026;
const TICKS = 24_000;
const HALF = TICKS / 2;
const loaded = loadMode(mode, modules);

function start(): Sim {
  const sim = createSim(loaded, { seed: SEED });
  expect(
    sim.dispatch("classic.newHero", { classId: "classic.rogue", name: "Tester" }, null).ok,
  ).toBe(true);
  expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
  return sim;
}

function stepBy(sim: Sim, ticks: number, batch: number): void {
  for (let done = 0; done < ticks; done += batch) sim.step(Math.min(batch, ticks - done));
}

describe("classic autoplay determinism (20 sim minutes)", () => {
  it("replays to the same hash and continues identically from a mid-run snapshot", () => {
    // Run A: one tick per step, snapshot at the half.
    const a = start();
    stepBy(a, HALF, 1);
    const mid: SimSnapshot = JSON.parse(JSON.stringify(a.snapshot()));
    const midHash = a.hash();
    stepBy(a, TICKS - HALF, 1);
    const finalHash = a.hash();
    expect(a.tick).toBe(TICKS);

    // Run B: same seed and actions, stepped in 20-tick batches.
    const b = start();
    stepBy(b, TICKS, 20);
    expect(b.hash()).toBe(finalHash);

    // Run C: restored from the JSON snapshot, stepped in 50-tick batches.
    const c = createSim(loaded, { seed: SEED, from: mid });
    expect(c.tick).toBe(mid.tick);
    expect(c.hash()).toBe(midHash);
    stepBy(c, TICKS - HALF, 50);
    expect(c.hash()).toBe(finalHash);
  }, 600_000);
});
