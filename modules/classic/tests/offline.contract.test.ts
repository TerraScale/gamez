/**
 * Offline/idle contract (docs/design/offline-idle.md §3, §5.4, §8): the admin
 * tunable, the server's payload builder, the eligibility rule and the action's
 * parse rules. Fast: no long sims. OWNER: T-tests.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { TUNABLES } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { Dead } from "../src/components.ts";
import { BALANCE } from "../src/content/balance.ts";
import { ACTION } from "../src/actions.ts";
import { mode, modules } from "../src/index.ts";
import { heroOf } from "../src/resources.ts";
import {
  OFFLINE_XP_TUNABLE,
  classicClientDriven,
  classicOfflineEligible,
  classicOfflinePayload,
} from "../src/platform/policy.ts";

const loaded = loadMode(mode, modules);
const DAY = 24 * 3600 * 1000;
const ms = 3_600_000;

/** A sim with a fresh hero in the given control mode (or still in the choose phase). */
function simWith(control: "auto" | "idle" | "manual" | null, seed = 5): Sim {
  const sim = createSim(loaded, { seed });
  if (control === null) return sim;
  const created = sim.dispatch(
    "classic.newHero",
    { classId: "classic.warrior", name: "Contract" },
    null,
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const set = sim.dispatch("classic.setControl", { mode: control }, null);
  expect(set.ok, JSON.stringify(set.error)).toBe(true);
  return sim;
}

describe("offline XP tunable (admin.ts TUNABLES)", () => {
  it("classic.offlineXpPct defaults to BALANCE.offlineXpPct (20) and spans 0..100", () => {
    const spec = TUNABLES.find((t) => t.key === OFFLINE_XP_TUNABLE);
    expect(spec).toBeDefined();
    expect(BALANCE.offlineXpPct).toBe(20);
    expect(spec!.default).toBe(BALANCE.offlineXpPct);
    expect(spec!.min).toBe(0);
    expect(spec!.max).toBe(100);
  });
});

describe("classicOfflinePayload (server-side payload builder)", () => {
  it("without the tunable the payload is just {elapsedMs}", () => {
    expect(classicOfflinePayload(ms, {})).toEqual({ elapsedMs: ms });
  });

  it("rounds a fractional tunable to an integer percent", () => {
    expect(classicOfflinePayload(ms, { [OFFLINE_XP_TUNABLE]: 35.4 })).toEqual({
      elapsedMs: ms,
      xpPct: 35,
    });
  });

  it("clamps above 100 to 100", () => {
    expect(classicOfflinePayload(ms, { [OFFLINE_XP_TUNABLE]: 150 })).toEqual({
      elapsedMs: ms,
      xpPct: 100,
    });
  });

  it("clamps below 0 to 0", () => {
    expect(classicOfflinePayload(ms, { [OFFLINE_XP_TUNABLE]: -5 })).toEqual({
      elapsedMs: ms,
      xpPct: 0,
    });
  });

  it("drops xpPct for NaN and Infinity (the sim default applies)", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const p = classicOfflinePayload(ms, { [OFFLINE_XP_TUNABLE]: bad });
      expect(p).toEqual({ elapsedMs: ms });
      expect("xpPct" in p).toBe(false);
    }
  });

  it("is wired as the client-driven policy's offline.payload", () => {
    const tunables = { [OFFLINE_XP_TUNABLE]: 35 };
    const payload = classicClientDriven.offline?.payload?.(ms, tunables);
    expect(payload).toEqual(classicOfflinePayload(ms, tunables));
    expect(payload).toEqual({ elapsedMs: ms, xpPct: 35 });
    expect(classicClientDriven.offline?.payload?.(ms, {})).toEqual({ elapsedMs: ms });
  });

  it("the offline action is server-only (replays never carry a client grant)", () => {
    expect(classicClientDriven.offline?.action).toBe(ACTION.offlineProgress);
    expect(classicClientDriven.serverOnlyActions).toContain(ACTION.offlineProgress);
    // The server grants an absence of one minute or more (the e2e waits 61 s on it).
    expect(classicClientDriven.offline?.minMs).toBe(60_000);
  });
});

describe("classicOfflineEligible", () => {
  it("is true for Auto and Idle", () => {
    expect(classicOfflineEligible(simWith("auto").world)).toBe(true);
    expect(classicOfflineEligible(simWith("idle").world)).toBe(true);
  });

  it("is true for a Dead hero (the grant respawns it)", () => {
    const sim = simWith("idle");
    sim.world.add(heroOf(sim.world), Dead, { at: sim.tick, killer: 0 });
    expect(classicOfflineEligible(sim.world)).toBe(true);
  });

  it("is false for Manual and in the choose phase (no hero yet)", () => {
    expect(classicOfflineEligible(simWith("manual").world)).toBe(false);
    expect(classicOfflineEligible(simWith(null).world)).toBe(false);
  });
});

describe("classic.offlineProgress parse rejection", () => {
  it("rejects bad payloads and leaves the hash unchanged", () => {
    const sim = simWith("idle");
    const hash = sim.hash();
    const bad: unknown[] = [
      { elapsedMs: 3_600_000, xpPct: 101 },
      { elapsedMs: 3_600_000, xpPct: -1 },
      { elapsedMs: 3_600_000, xpPct: 1.5 },
      { elapsedMs: 3_600_000, xpPct: "20" },
      { elapsedMs: 3_600_000, extra: 1 },
      { elapsedMs: 0 },
      { elapsedMs: DAY * 7 + 1 },
    ];
    for (const p of bad) {
      const r = sim.dispatch(ACTION.offlineProgress, p, null);
      expect(r.ok, JSON.stringify(p)).toBe(false);
    }
    expect(sim.hash()).toBe(hash);
  });

  it("accepts the boundary values 0 and 100 for xpPct", () => {
    for (const pct of [0, 100]) {
      const sim = simWith("idle");
      const r = sim.dispatch(ACTION.offlineProgress, { elapsedMs: 60_000, xpPct: pct }, null);
      expect(r.ok, `xpPct ${pct}`).toBe(true);
    }
  });
});
