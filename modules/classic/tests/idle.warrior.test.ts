/**
 * Idle descent regressions (QA major #1, docs/design/wave-A.md §0.1 and §8)
 * for the Warrior, on the real content with every classic module: Full
 * Idle from a fresh hero takes the stairs (exploration grows toward them,
 * no trips near them, no second explorePct on the way back), and never
 * stands in a fight with an idle intent (casting, dashing or stunned is
 * acting, not standing) for more than STALL_LIMIT ticks.
 *
 * Thresholds are minimums with a margin: content lands in parallel (skills,
 * monsters, bosses), and the measured numbers live in wave-A.md §14.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { AutoState, Casting, Dash, Intent, Statuses } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { currentDepth, dungeonOf, heroOf } from "../src/resources.ts";
import { KIND, type StatusProto } from "../src/types.ts";

const CLASS = "classic.warrior";
const loaded = loadMode(mode, modules);
/** Longest tolerated run of plan "fight" with an idle intent while able to act. */
const STALL_LIMIT = 40;

interface IdleRun {
  /** First tick at each depth reached (index = depth). */
  reached: number[];
  /** Longest idle-intent fight streak (ticks). */
  stall: number;
  sim: Sim;
}

function stunned(sim: Sim, hero: number): boolean {
  const list = sim.world.get(hero, Statuses)?.list ?? [];
  return list.some(
    (s) =>
      s.until > sim.tick &&
      sim.loaded.registry.get<StatusProto>(KIND.status, s.id)?.kind === "stun",
  );
}

function idle(seed: number, ticks: number): IdleRun {
  const sim = createSim(loaded, { seed });
  expect(sim.dispatch("classic.newHero", { classId: CLASS, name: "Idler" }, null).ok).toBe(true);
  expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
  const hero = heroOf(sim.world);
  const reached: number[] = [0];
  let streak = 0;
  let stall = 0;
  for (let i = 0; i < ticks; i++) {
    sim.step(1);
    const d = currentDepth(sim.world);
    if (d < 1000 && reached[d] === undefined)
      for (let k = reached.length; k <= d; k++) reached[k] ??= sim.tick;
    const st = sim.world.read(hero, AutoState);
    const acting = sim.world.has(hero, Casting) || sim.world.has(hero, Dash) || stunned(sim, hero);
    if (st.plan === "fight" && sim.world.read(hero, Intent).kind === "idle" && !acting) {
      streak++;
      stall = Math.max(stall, streak);
    } else streak = 0;
  }
  return { reached, stall, sim };
}

describe(`Idle descent (${CLASS})`, () => {
  it("seed 2026: takes the stairs level after level for 30 sim minutes, no fight stalls", () => {
    const run = idle(2026, 36_000);
    expect(run.stall).toBeLessThanOrEqual(STALL_LIMIT);
    expect(run.reached[2], "depth 2").toBeLessThanOrEqual(12000);
    expect(dungeonOf(run.sim.world).deepest).toBeGreaterThanOrEqual(3);
  }, 300_000);

  for (const seed of [4242, 7]) {
    it(`seed ${seed}: reaches depth 2 within 12000 ticks, no fight stalls`, () => {
      const run = idle(seed, 12000);
      expect(run.stall).toBeLessThanOrEqual(STALL_LIMIT);
      expect(run.reached[2], "depth 2").toBeDefined();
    }, 300_000);
  }
});
