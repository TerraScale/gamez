/**
 * classicSeasonTotal on real classic sims (wave-C.md §7.2): null without a
 * hero, the key from the world seed, the weighted formula, monotonic progress
 * while the hero plays, determinism and a pinned value for a fixed script.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";
import { classicSeasonTotal, SEASON_WEIGHTS } from "../src/platform/season.ts";
import { RES, type DungeonState, type GameState, type RunStats } from "../src/resources.ts";

const SEED = 4242;
const loaded = loadMode(mode, modules);
const registry = loaded.registry;

/** Heavy: each step is a real classic simulation, so the tests get a longer budget. */
const SLOW = 60_000;

function started(seed = SEED): Sim {
  const sim = createSim(loaded, { seed });
  expect(
    sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Seasoner" }, null).ok,
  ).toBe(true);
  expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
  return sim;
}

function worldSeedOf(sim: Sim): number {
  return sim.world.getResource<GameState>(RES.game)!.worldSeed;
}

/** Runs `steps` chunks of `chunk` ticks and returns the total after each chunk. */
function totalsOf(sim: Sim, steps: number, chunk: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    sim.step(chunk);
    out.push(classicSeasonTotal(sim.world, registry)?.total ?? -1);
  }
  return out;
}

describe("classicSeasonTotal", () => {
  it("is null before a hero exists", () => {
    const sim = createSim(loaded, { seed: SEED });
    expect(classicSeasonTotal(sim.world, registry)).toBeNull();
  });

  it("keys by the world seed the hero was generated with", () => {
    const sim = started();
    const seed = worldSeedOf(sim);
    expect(classicSeasonTotal(sim.world, registry)?.key).toBe(`classic:${seed}`);
  });

  it("starts at zero for a fresh hero", () => {
    const sim = started();
    expect(classicSeasonTotal(sim.world, registry)).toEqual({
      key: `classic:${worldSeedOf(sim)}`,
      total: 0,
    });
  });

  it("applies the weights to the run counters", () => {
    const sim = started();
    const seed = worldSeedOf(sim);
    const stats = sim.world.getResource<RunStats>(RES.stats)!;
    const dungeon = sim.world.getResource<DungeonState>(RES.dungeon)!;
    sim.world.setResource(RES.stats, { ...stats, kills: 7, riftsCompleted: 2 });
    sim.world.setResource(RES.dungeon, { ...dungeon, deepest: 3 });
    // Fresh hero: level 1 (0 levels gained), no quests done.
    // 7 kills + 2 rifts * 50 + depth 3 * 10 = 137.
    expect(classicSeasonTotal(sim.world, registry)).toEqual({
      key: `classic:${seed}`,
      total: 7 * SEASON_WEIGHTS.kill + 2 * SEASON_WEIGHTS.rift + 3 * SEASON_WEIGHTS.depth,
    });
    expect(classicSeasonTotal(sim.world, registry)?.total).toBe(137);
  });

  it(
    "never decreases while the hero plays on",
    () => {
      const sim = started();
      const totals = totalsOf(sim, 15, 200);
      expect(totals.every((t) => t >= 0)).toBe(true);
      for (let i = 1; i < totals.length; i++) {
        expect(totals[i]).toBeGreaterThanOrEqual(totals[i - 1]!);
      }
      // Auto play kills monsters, so the total must have grown.
      expect(totals[totals.length - 1]).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "is deterministic: the same seed and script give the same totals",
    () => {
      const a = totalsOf(started(), 8, 200);
      const b = totalsOf(started(), 8, 200);
      expect(a).toEqual(b);
    },
    SLOW,
  );

  it(
    "pins the total after a fixed script",
    () => {
      const totals = totalsOf(started(), 15, 200);
      expect(totals[totals.length - 1]).toBe(PINNED_TOTAL);
    },
    SLOW,
  );
});

/** classicSeasonTotal after 15 x 200 ticks of auto play from SEED (warrior). */
const PINNED_TOTAL = 219;
