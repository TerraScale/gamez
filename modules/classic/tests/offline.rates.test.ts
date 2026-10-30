/**
 * Offline/idle rates (docs/design/offline-idle.md §3, §4). Real classic
 * catalog, every module. OWNER: T-tests.
 *
 *  - per class (warrior, rogue, sorcerer): a new Idle hero plays 9 000 ticks
 *    so classic.autoRate is measured; the grant is pinned (concrete numbers,
 *    review #8: never recomputed with the production formula), its XP is 20 %
 *    of the pinned base, and its XP per minute sits in a loose band of the
 *    online kill XP per minute;
 *  - the factor changes only XP (50 %, 0 %); kills, gold and items do not move;
 *  - caps and rounding (8 h, minute floor, under one minute gives nothing);
 *  - the fallback model for a hero with no measured rate;
 *  - a Dead hero is respawned by the grant and the XP lands;
 *  - no double grant from a restored snapshot; RunStats.offlineMs accumulates;
 *  - determinism with a pinned hash.
 *
 * Runtime: the three warm-ups are shared (memoised); keep the file under ~90 s.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
const loaded = loadMode(mode, modules);
const SEED = 41;
const WARM_TICKS = 9_000;
const TWENTY_MIN = 20 * 60_000;
type Summary = Extract<ClassicEvent, { type: "classic.offline.summary" }>;

/** A fresh Idle hero of `classId`, not stepped. */
function newIdleSim(classId: string, seed = SEED): Sim {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch("classic.newHero", { classId, name: "Rater" }, null);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const set = sim.dispatch("classic.setControl", { mode: "idle" }, null);
  expect(set.ok, JSON.stringify(set.error)).toBe(true);
  return sim;
}

/** Dispatches the offline action (optionally with xpPct) and returns its summary. */
function offline(sim: Sim, elapsedMs: number, xpPct?: number) {
  const payload = xpPct === undefined ? { elapsedMs } : { elapsedMs, xpPct };
  const res = sim.dispatch(ACTION.offlineProgress, payload, null);
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  const summary = (res.events as ClassicEvent[]).find(
    (e): e is Summary => e.type === "classic.offline.summary",
  );
  expect(summary, "classic.offline.summary").toBeDefined();
  return { summary: summary!, events: res.events as GameEvent[] };
}

/** Two independent runs of the same script: a rate-measured grant, then play on. */
function script(classId: string): Sim {
  const sim = newIdleSim(classId, 46);
  sim.step(WARM_TICKS);
  expect(offline(sim, TWENTY_MIN).summary.source).toBe("rate");
  sim.step(100);
  return sim;
}

describe("determinism", () => {
  it("same seed and script give the same hash, pinned", () => {
    const a = script("classic.rogue");
    const b = script("classic.rogue");
    expect(b.hash()).toBe(a.hash());
    // Pin: re-pinned by the integrator when the behaviour changes.
    expect(a.hash()).toBe("b173e6443e51af96");
  }, 120_000);
});
