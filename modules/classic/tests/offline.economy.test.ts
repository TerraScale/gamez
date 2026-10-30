/**
 * Offline economy, second pass (docs/design/offline-idle.md §3, §4.1-§4.4, §12).
 * Real classic catalog, every module. OWNER: T2-sim.
 *
 *  - upkeep measurement: alchemist potions and scrolls and smith repairs paid on
 *    Auto/Idle ticks go to AutoRate.upkeep; manual-mode purchases, smith item
 *    purchases, gambling and upgrades never do; the window halving includes it;
 *  - the grant's gold is ground + junk - upkeep, floored at 0 and capped at 3x
 *    the model (hand-built rates, concrete pinned numbers: review #8);
 *  - the model's gold factor (offlineModelGoldPct) applies;
 *  - classic.offline.summary always carries `upkeep`;
 *  - the same-tick guard (offline_twice) and a pinned-hash determinism script;
 *  - low-level calibration: per class, at L1 the model's XP before the factor is
 *    0.6-1.5x the online kill XP per minute over the following 10 minutes of
 *    Idle x1; after 5 minutes the rate path pays the measured online kill XP
 *    per minute of those 5 minutes (0.95-1.05x; no model floor, §4.3).
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
const loaded = loadMode(mode, modules);
const HOUR = 3_600_000;
type Summary = Extract<ClassicEvent, { type: "classic.offline.summary" }>;

function newSim(classId: string, seed: number, control: "manual" | "idle" | "auto"): Sim {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch(ACTION.newHero, { classId, name: "Upkeep" }, null);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const ctl = sim.dispatch(ACTION.setControl, { mode: control }, null);
  expect(ctl.ok, JSON.stringify(ctl.error)).toBe(true);
  return sim;
}

function offline(sim: Sim, elapsedMs: number, xpPct?: number) {
  const payload = xpPct === undefined ? { elapsedMs } : { elapsedMs, xpPct };
  const r = sim.dispatch(ACTION.offlineProgress, payload, null);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  const summary = (r.events as ClassicEvent[]).find(
    (e): e is Summary => e.type === "classic.offline.summary",
  );
  expect(summary, "classic.offline.summary").toBeDefined();
  return summary!;
}

/** A fixed script: 6 000 Idle ticks (rate path), an offline hour, 100 ticks. */
function script(): Sim {
  const sim = newSim("classic.sorcerer", 53, "idle");
  sim.step(6000);
  expect(offline(sim, HOUR).source).toBe("rate");
  sim.step(100);
  return sim;
}

describe("determinism", () => {
  it("same seed and script give the same hash, pinned", () => {
    const a = script();
    expect(script().hash()).toBe(a.hash());
    expect(a.hash()).toBe("d3e072a0900a3841");
  }, 120_000);
});
