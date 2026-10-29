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
import { createSim, loadMode, type GameEvent, type Sim, type SimSnapshot } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { AUTO_RATE_MIN_TICKS } from "../src/auto/rate.ts";
import { ACTION } from "../src/actions.ts";
import { Dead, Level, Life } from "../src/components.ts";
import { BALANCE } from "../src/content/balance.ts";
import type { ClassicEvent } from "../src/events.ts";
import { CLASSIC_HZ, mode, modules } from "../src/index.ts";
import { currentDepth, heroOf, RES, type AutoRate, type RunStats } from "../src/resources.ts";

const loaded = loadMode(mode, modules);
const SEED = 41;
const WARM_TICKS = 9_000;
/** The online kill XP is measured over the last 6 000 ticks (5 min at x1). */
const MEASURE_TICKS = 6_000;
const TWENTY_MIN = 20 * 60_000;
const MINUTE = 60_000;
const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer"] as const;

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

/** A sim restored from a snapshot: same state, independent world. */
function restore(snap: SimSnapshot): Sim {
  return createSim(loaded, { seed: SEED, from: snap });
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

/**
 * Pinned 20-minute grants after the 9 000-tick warm-up (seed 41), integration
 * pass (offline-idle.md §4.2, §4.3). `base` is the XP before the factor
 * (xpPct 100): the measured rate extrapolated to 20 minutes, with no model
 * floor (the second pass's floor paid 12 880 / 5 760 / 13 800 here). Gold is
 * ground + junk minus the measured upkeep, floored at 0 (the warrior's upkeep
 * exceeds its ground gold in its first 7.5 minutes).
 */
const PINNED: Record<
  (typeof CLASSES)[number],
  { base: number; depth: number; kills: number; gold: number; upkeep: number; items: number }
> = {
  "classic.warrior": { base: 3672, depth: 3, kills: 336, gold: 0, upkeep: 1946, items: 6 },
  "classic.rogue": { base: 2946, depth: 1, kills: 392, gold: 285, upkeep: 880, items: 7 },
  "classic.sorcerer": { base: 4202, depth: 3, kills: 410, gold: 1040, upkeep: 1093, items: 8 },
};

interface Warm {
  snap: SimSnapshot;
  onlineXp: number;
  onlineKills: number;
}
const warmed = new Map<string, Warm>();

/** A hero that has idled 9 000 ticks: its rate is measured. Memoised per class. */
function warm(classId: string): Warm {
  const cached = warmed.get(classId);
  if (cached) return cached;
  const sim = newIdleSim(classId);
  let onlineXp = 0;
  let onlineKills = 0;
  for (let i = 0; i < WARM_TICKS; i++) {
    const events = sim.step(1) as ClassicEvent[];
    if (i < WARM_TICKS - MEASURE_TICKS) continue;
    for (const e of events) {
      if (e.type === "classic.xp" && e.reason === "kill") onlineXp += e.amount;
      if (e.type === "classic.death" && !e.isHero) onlineKills++;
    }
  }
  const out = { snap: sim.snapshot(), onlineXp, onlineKills };
  warmed.set(classId, out);
  return out;
}

describe("offline rates per class (20 % XP, 100 % gold and items)", () => {
  for (const classId of CLASSES) {
    it(`${classId}: the grant follows the measured rate and stays in the online band`, () => {
      const w = warm(classId);
      const sim = restore(w.snap);
      const rate = sim.world.getResource<AutoRate>(RES.autoRate);
      expect(rate, "classic.autoRate after 9 000 ticks").toBeDefined();
      expect(rate!.ticks).toBeGreaterThanOrEqual(AUTO_RATE_MIN_TICKS);

      const pin = PINNED[classId];
      const { summary } = offline(sim, TWENTY_MIN);
      expect(summary.source).toBe("rate");
      expect(summary.xpPct).toBe(20);
      expect(summary).toMatchObject({
        depth: pin.depth,
        kills: pin.kills,
        gold: pin.gold,
        upkeep: pin.upkeep,
        items: pin.items,
      });
      // 20 % of the pinned base.
      expect(summary.xp).toBe(Math.floor(pin.base / 5));

      // Online kill XP per minute over the last 6 000 ticks vs offline per minute.
      expect(w.onlineXp).toBeGreaterThan(0);
      const onlinePerMin = w.onlineXp / (MEASURE_TICKS / CLASSIC_HZ / 60);
      const offlinePerMin = summary.xp / 20;
      const ratio = offlinePerMin / onlinePerMin;
      console.log(
        `[offline.rates] ${classId}: online ${onlinePerMin.toFixed(1)} XP/min ` +
          `(${w.onlineKills} kills in 5 min), offline ${offlinePerMin.toFixed(1)} XP/min ` +
          `(${summary.kills} kills in 20 min), ratio ${(ratio * 100).toFixed(1)} %`,
      );
      // 20 % of the measured rate. The rate covers all 9 000 ticks and the
      // reference only the last 6 000, so the ratio sits a little under 20 %.
      expect(ratio).toBeGreaterThanOrEqual(0.12);
      expect(ratio).toBeLessThanOrEqual(0.22);
    }, 120_000);
  }
});

describe("the offline factor changes XP only", () => {
  it("xpPct 50 pays half of the 20 % grant's base; xpPct 0 pays no XP", () => {
    const w = warm("classic.warrior");
    const dflt = offline(restore(w.snap), TWENTY_MIN).summary;
    expect(dflt.xp).toBe(734);

    const half = restore(w.snap);
    const h = offline(half, TWENTY_MIN, 50).summary;
    // Half of the pinned base 3 672.
    expect(h.xp).toBe(1836);
    expect(h.xpPct).toBe(50);
    expect(h.kills).toBe(dflt.kills);
    expect(h.gold).toBe(dflt.gold);
    expect(h.items).toBe(dflt.items);

    const none = restore(w.snap);
    const z = offline(none, TWENTY_MIN, 0).summary;
    expect(z.xp).toBe(0);
    expect(z.xpPct).toBe(0);
    expect(z.kills).toBe(dflt.kills);
    expect(z.gold).toBe(dflt.gold);
    expect(z.items).toBe(dflt.items);
    expect(z.levels).toBe(0);
  }, 120_000);
});

describe("caps and rounding", () => {
  it("7 days and 8 hours give the same summary except awayMs", () => {
    const w = warm("classic.warrior");
    const a = offline(restore(w.snap), 7 * 24 * 3600 * 1000).summary;
    const b = offline(restore(w.snap), 8 * 3600 * 1000).summary;
    expect(a.awayMs).toBe(7 * 24 * 3600 * 1000);
    expect(b.awayMs).toBe(8 * 3600 * 1000);
    const { awayMs: _a, ...restA } = a;
    const { awayMs: _b, ...restB } = b;
    expect(restA).toEqual(restB);
    expect(a.ms).toBe(8 * 3600 * 1000);
    expect(a.capMs).toBe(BALANCE.offlineCapMs);
  }, 120_000);

  it("minutes are floored: 2 min 59 s grants what 2 min grants", () => {
    const w = warm("classic.warrior");
    const two = offline(restore(w.snap), 2 * MINUTE).summary;
    const almost = offline(restore(w.snap), 2 * MINUTE + 59_000).summary;
    expect(almost.kills).toBe(two.kills);
    expect(almost.xp).toBe(two.xp);
    expect(almost.gold).toBe(two.gold);
    expect(almost.items).toBe(two.items);
    expect(almost.levels).toBe(two.levels);
  }, 120_000);

  it("8 h + 59 s gives 8 h (the cap wins over the extra minutes)", () => {
    const w = warm("classic.warrior");
    const eight = offline(restore(w.snap), 8 * 3600 * 1000).summary;
    const plus = offline(restore(w.snap), 8 * 3600 * 1000 + 59_000).summary;
    const { awayMs: _a, ...rest8 } = eight;
    const { awayMs: _b, ...restPlus } = plus;
    expect(restPlus).toEqual(rest8);
    expect(plus.awayMs).toBe(8 * 3600 * 1000 + 59_000);
  }, 120_000);

  it("59 999 ms grants nothing (zero minutes) and no XP reaches the hero", () => {
    const w = warm("classic.warrior");
    const sim = restore(w.snap);
    const hero = heroOf(sim.world);
    const xpBefore = sim.world.read(hero, Level).xp;
    const { summary, events } = offline(sim, MINUTE - 1);
    expect(summary.kills).toBe(0);
    expect(summary.xp).toBe(0);
    expect(summary.gold).toBe(0);
    expect(summary.items).toBe(0);
    expect(summary.levels).toBe(0);
    const after = sim.step(1) as GameEvent[];
    const granted = [...events, ...after].filter(
      (e) =>
        e.type === "classic.xp" && (e as ClassicEvent & { reason: string }).reason === "offline",
    );
    expect(granted).toEqual([]);
    expect(sim.world.read(hero, Level).xp).toBeGreaterThanOrEqual(xpBefore);
  }, 120_000);
});

describe("fallback model (no measured rate)", () => {
  it("a brand-new hero uses the model, XP scaled by offlineModelXpPct then the factor", () => {
    const sim = newIdleSim("classic.rogue", 43);
    expect(sim.world.getResource<AutoRate>(RES.autoRate)).toBeUndefined();
    const { summary } = offline(sim, TWENTY_MIN);
    // Pinned: 9 kills a minute at depth 1 (180), 9 XP each = 1 620, x 200 % = 3 240,
    // x 20 % = 648. Model gold x offlineModelGoldPct (100), no upkeep.
    expect(summary).toMatchObject({
      source: "model",
      depth: 1,
      kills: 180,
      xp: 648,
      gold: 603,
      upkeep: 0,
      items: 3,
    });
  }, 120_000);
});

describe("a dead hero", () => {
  it("the grant respawns it in town with full life and the XP lands", () => {
    // A warmed hero, down in the dungeon (so "back in town" is a real change).
    const sim = restore(warm("classic.warrior").snap);
    for (let i = 0; i < 6_000 && currentDepth(sim.world) === 0; i++) sim.step(1);
    expect(currentDepth(sim.world), "the hero is in the dungeon").toBeGreaterThan(0);
    const hero = heroOf(sim.world);
    // Die just now: the death is recorded like a real one (respawn delay not elapsed).
    sim.world.add(hero, Dead, { at: sim.tick, killer: 0 });
    const xpBefore = sim.world.read(hero, Level).xp;
    const { summary, events } = offline(sim, TWENTY_MIN);
    const stepped = sim.step(1) as GameEvent[];
    const all = [...events, ...stepped];
    expect(sim.world.has(hero, Dead)).toBe(false);
    expect(currentDepth(sim.world)).toBe(0);
    const life = sim.world.read(hero, Life);
    expect(life.hp).toBe(life.max);
    expect(all.some((e) => e.type === "classic.hero.respawned")).toBe(true);
    expect(summary.xp).toBeGreaterThan(0);
    expect(sim.world.read(hero, Level).xp).toBeGreaterThanOrEqual(xpBefore + summary.xp);
  }, 120_000);
});

describe("no double grant", () => {
  it("the same grant on the same restored snapshot gives the same summary and state", () => {
    const w = warm("classic.warrior");
    const a = restore(w.snap);
    const b = restore(w.snap);
    const ra = offline(a, TWENTY_MIN).summary;
    const rb = offline(b, TWENTY_MIN).summary;
    expect(rb).toEqual(ra);
    a.step(1);
    b.step(1);
    expect(b.hash()).toBe(a.hash());
  }, 120_000);

  it("RunStats.offlineMs accumulates exactly across grants", () => {
    const sim = newIdleSim("classic.rogue", 45);
    const before = sim.world.getResource<RunStats>(RES.stats)!.offlineMs;
    offline(sim, TWENTY_MIN);
    // A second grant needs a later tick (the same-tick guard, offline_twice).
    sim.step(1);
    offline(sim, 5 * MINUTE);
    expect(sim.world.getResource<RunStats>(RES.stats)!.offlineMs).toBe(
      before + TWENTY_MIN + 5 * MINUTE,
    );
  });
});

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
    expect(a.hash()).toBe("6c04cfd58a9fd5e7");
  }, 120_000);
});
