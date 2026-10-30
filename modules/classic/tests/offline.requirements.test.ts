/**
 * Requirement-level tests for classic offline/idle progress
 * (docs/design/offline-idle.md §2-§5). Real classic catalog. Each test name
 * reads as the user requirement it proves.
 *
 * Not pinned here (T2-sim owns them): gold amounts, the fallback-model
 * numbers and sim.hash() values. Determinism is checked by comparing two sims
 * built from the same seed and script. XP is asserted only on the measured
 * rate path (a hero with at least 10 minutes of Idle x1), and it is asserted
 * relationally, from values the test measures.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { Dead } from "../src/components.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { heroOf } from "../src/resources.ts";
const loaded = loadMode(mode, modules);
const SEED = 51;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
type Summary = Extract<ClassicEvent, { type: "classic.offline.summary" }>;

/** A fresh Idle hero of `classId`, not stepped. */
function newIdleSim(classId: string, seed = SEED): Sim {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch(ACTION.newHero, { classId, name: "Idler" }, null);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const set = sim.dispatch(ACTION.setControl, { mode: "idle" }, null);
  expect(set.ok, JSON.stringify(set.error)).toBe(true);
  return sim;
}

/** Dispatches the offline grant (optionally with xpPct) and returns its summary and events. */
function grant(sim: Sim, elapsedMs: number, xpPct?: number) {
  const payload = xpPct === undefined ? { elapsedMs } : { elapsedMs, xpPct };
  const res = sim.dispatch(ACTION.offlineProgress, payload, null);
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  const events = res.events as GameEvent[];
  const summary = events.find((e): e is Summary => e.type === "classic.offline.summary");
  expect(summary, "classic.offline.summary").toBeDefined();
  return { sim, summary: summary!, events };
}

describe("requirement: a grant is deterministic", () => {
  it("two sims with the same seed and the same script (grant included) hash the same", () => {
    const run = (): string => {
      const sim = newIdleSim("classic.rogue", 61);
      sim.step(7_000);
      grant(sim, HOUR);
      sim.step(100);
      return sim.hash();
    };
    expect(run()).toBe(run());
  }, 120_000);

  it("a dead hero is respawned by the grant in both replays the same way", () => {
    const run = (): string => {
      const sim = newIdleSim("classic.warrior", 62);
      sim.step(1_000);
      const hero = heroOf(sim.world);
      sim.world.add(hero, Dead, { at: sim.tick, killer: 0 });
      grant(sim, HOUR);
      sim.step(10);
      expect(sim.world.has(hero, Dead)).toBe(false);
      return sim.hash();
    };
    expect(run()).toBe(run());
  }, 60_000);
});
