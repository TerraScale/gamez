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
import { createSim, loadMode, type GameEvent, type Sim, type SimSnapshot } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { Level } from "../src/components.ts";
import { BALANCE } from "../src/content/balance.ts";
import type { ClassicEvent } from "../src/events.ts";
import { CLASSIC_HZ, mode, modules } from "../src/index.ts";
import { classicOfflineEligible } from "../src/platform/policy.ts";
import { controlOf, heroOf, RES, stashOf, type QuestState } from "../src/resources.ts";
const loaded = loadMode(mode, modules);
const SEED = 51;
/** 10 minutes of Idle at x1: the online rate is measured (rate path). */
const WARM_TICKS = 12_000;
/** The online kill XP is measured over the last 5 minutes of the warm-up. */
const MEASURE_TICKS = 6_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const CAP_MS = 8 * HOUR;
const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer"] as const;

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

/** A sim restored from a snapshot: same state, independent world. */
function restore(snap: SimSnapshot): Sim {
  return createSim(loaded, { seed: SEED, from: snap });
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

/** Quest progress as a comparable string (credit, not gold). */
function questProgress(sim: Sim): string {
  const qs = sim.world.getResource<QuestState>(RES.quests);
  return (qs?.active ?? []).map((q) => `${q.id}:${q.progress}:${q.done}`).join("|");
}

interface Warm {
  snap: SimSnapshot;
  /** Online kill XP gained in the last 5 minutes (reason "kill"). */
  onlineXp: number;
  onlineKills: number;
}
const warmed = new Map<string, Warm>();

/** A hero that has idled 10 minutes at x1. Memoised per class, so the warm-up runs once. */
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

/** Online kill XP per minute over the measured window (the 5 minutes before the close). */
function onlineXpPerMin(w: Warm): number {
  return w.onlineXp / (MEASURE_TICKS / CLASSIC_HZ / 60);
}

describe("requirement: offline XP is 20 % of the online Idle rate", () => {
  it("the default offline XP factor is 20 %", () => {
    expect(BALANCE.offlineXpPct).toBe(20);
  });

  // The rate path pays xpPct of the measured online rate (no model floor since the
  // integration pass; the floor paid 0.38-0.75 here, offline-idle.md §4.3).
  for (const classId of CLASSES) {
    it(`${classId}: a 60-minute absence pays 10-40 % of the online kill XP per minute`, () => {
      const w = warm(classId);
      expect(w.onlineXp, "online kill XP in the last 5 minutes").toBeGreaterThan(0);
      const { summary } = grant(restore(w.snap), HOUR);
      expect(summary.source).toBe("rate");
      expect(summary.xpPct).toBe(BALANCE.offlineXpPct);
      const ratio = summary.xp / 60 / onlineXpPerMin(w);
      expect(ratio, `offline/online XP per minute`).toBeGreaterThanOrEqual(0.1);
      expect(ratio).toBeLessThanOrEqual(0.4);
    }, 120_000);
  }
});

describe("requirement: the offline factor scales XP and nothing else", () => {
  for (const classId of CLASSES) {
    it(`${classId}: xpPct 40 pays twice the 20 % XP (+-1); xpPct 0 pays no XP; kills and quest credit stay`, () => {
      const w = warm(classId);
      const d20 = grant(restore(w.snap), HOUR);
      const x40 = grant(restore(w.snap), HOUR, 40);
      const x0 = grant(restore(w.snap), HOUR, 0);
      expect(d20.summary.kills).toBeGreaterThan(0);
      expect(Math.abs(x40.summary.xp - 2 * d20.summary.xp)).toBeLessThanOrEqual(1);
      expect(x40.summary.kills).toBe(d20.summary.kills);
      expect(x0.summary.xpPct).toBe(0);
      expect(x0.summary.xp).toBe(0);
      expect(x0.summary.kills).toBe(d20.summary.kills);
      expect(questProgress(x0.sim)).toBe(questProgress(d20.sim));
      expect(x40.summary.kills).toBe(d20.summary.kills);
    }, 120_000);
  }
});

describe("requirement: the server caps the credited time at 8 hours", () => {
  for (const classId of CLASSES) {
    it(`${classId}: 8 h, 24 h and 7 d absences credit the same time, kills, XP and levels`, () => {
      const w = warm(classId);
      const a = grant(restore(w.snap), 8 * HOUR).summary;
      const b = grant(restore(w.snap), DAY).summary;
      const c = grant(restore(w.snap), WEEK).summary;
      expect(a.ms).toBe(CAP_MS);
      expect(b.ms).toBe(CAP_MS);
      expect(c.ms).toBe(CAP_MS);
      expect(b.awayMs).toBe(DAY);
      expect(c.awayMs).toBe(WEEK);
      expect(a.xp).toBeGreaterThan(0);
      for (const other of [b, c]) {
        expect(other.kills).toBe(a.kills);
        expect(other.xp).toBe(a.xp);
        expect(other.levels).toBe(a.levels);
      }
    }, 120_000);
  }
});

describe("requirement: the applied state matches the summary", () => {
  for (const classId of CLASSES) {
    it(`${classId}: after the queued grants run, XP, level and stash move by the summary`, () => {
      const w = warm(classId);
      const sim = restore(w.snap);
      const hero = heroOf(sim.world);
      // Plain numbers: world.read returns the live component, which the grant mutates.
      const xp0 = sim.world.read(hero, Level).xp;
      const level0 = sim.world.read(hero, Level).level;
      const stash0 = stashOf(sim.world).items.length;

      const { summary, events } = grant(sim, HOUR);
      // Grants are queued and run on the next tick (1 to 2 ticks is enough).
      const stepped = sim.step(2) as ClassicEvent[];
      const window = [...(events as ClassicEvent[]), ...stepped];

      const xpEvents = window.filter(
        (e): e is Extract<ClassicEvent, { type: "classic.xp" }> => e.type === "classic.xp",
      );
      const offlineXp = xpEvents
        .filter((e) => e.reason === "offline")
        .reduce((sum, e) => sum + e.amount, 0);
      expect(offlineXp, "classic.xp (reason offline) in the window").toBe(summary.xp);

      // Level.xp is cumulative. Every XP change in the window is a classic.xp event,
      // minus the XP a death costs.
      const xpLost = window
        .filter(
          (e): e is Extract<ClassicEvent, { type: "classic.hero.died" }> =>
            e.type === "classic.hero.died",
        )
        .reduce((sum, e) => sum + e.xpLost, 0);
      const allXp = xpEvents.reduce((sum, e) => sum + e.amount, 0);
      const after = sim.world.read(hero, Level);
      expect(after.xp - xp0).toBe(allXp - xpLost);

      expect(after.level - level0).toBe(summary.levels);
      expect(stashOf(sim.world).items.length - stash0).toBe(summary.items);
    }, 120_000);
  }
});

describe("requirement: a grant never changes the control mode or speed", () => {
  it("idle at speed 4 stays idle at speed 4 after a grant", () => {
    const w = warm("classic.warrior");
    const sim = restore(w.snap);
    expect(sim.dispatch(ACTION.setSpeed, { speed: 4 }, null).ok).toBe(true);
    const before = controlOf(sim.world);
    expect(before.mode).toBe("idle");
    expect(before.speed).toBe(4);
    grant(sim, HOUR);
    sim.step(1);
    const after = controlOf(sim.world);
    expect(after.mode).toBe("idle");
    expect(after.speed).toBe(4);
  }, 60_000);
});

describe("requirement: only Auto and Idle heroes are eligible for offline progress", () => {
  it("a Manual hero is not eligible; Auto and Idle are; no hero is not eligible", () => {
    const none = createSim(loaded, { seed: SEED });
    expect(classicOfflineEligible(none.world)).toBe(false);
    for (const control of ["manual", "auto", "idle"] as const) {
      const sim = createSim(loaded, { seed: SEED });
      expect(
        sim.dispatch(ACTION.newHero, { classId: "classic.rogue", name: "Mode" }, null).ok,
      ).toBe(true);
      expect(sim.dispatch(ACTION.setControl, { mode: control }, null).ok).toBe(true);
      expect(classicOfflineEligible(sim.world), control).toBe(control !== "manual");
    }
  });
});

describe("requirement: a rejected grant changes nothing", () => {
  it("bad payloads are refused and leave the hash unchanged", () => {
    const w = warm("classic.sorcerer");
    const sim = restore(w.snap);
    const before = sim.hash();
    const bad: unknown[] = [
      null,
      {},
      { elapsedMs: 0 },
      { elapsedMs: 1.5 },
      { elapsedMs: WEEK + 1 },
      { elapsedMs: HOUR, xpPct: 101 },
      { elapsedMs: HOUR, xpPct: -1 },
      { elapsedMs: HOUR, xpPct: 1.5 },
      { elapsedMs: HOUR, clock: 1 },
    ];
    for (const payload of bad) {
      const res = sim.dispatch(ACTION.offlineProgress, payload, null);
      expect(res.ok, JSON.stringify(payload)).toBe(false);
      expect(sim.hash(), JSON.stringify(payload)).toBe(before);
    }
  }, 60_000);

  it("a grant for a hero that is not there is refused and changes nothing", () => {
    const sim = createSim(loaded, { seed: SEED });
    const before = sim.hash();
    const res = sim.dispatch(ACTION.offlineProgress, { elapsedMs: HOUR }, null);
    expect(res.ok).toBe(false);
    expect(sim.hash()).toBe(before);
  });
});

/**
 * A hero that is still growing (offline-idle.md §4.3): its online XP per
 * minute rises with every level, so the measured rate must follow recent play.
 * With the old 30-minute window an L12 hero measured about 0.6x of its last 10
 * minutes online, and "20 %" paid 11-14 % of the XP the player saw.
 */
interface Grown {
  snap: SimSnapshot;
  minute: number;
  level: number;
  /** Online kill XP per minute over the last 10 minutes before the snapshot. */
  last10: number;
}

/** Idle at x1 until the hero is at least `level` (and 20 minutes in), at most 70 minutes. */
function growTo(classId: string, seed: number, level: number): Grown {
  const sim = newIdleSim(classId, seed);
  const perMin: number[] = [];
  for (let minute = 1; minute <= 70; minute++) {
    let xp = 0;
    for (const e of sim.step(60 * CLASSIC_HZ) as ClassicEvent[])
      if (e.type === "classic.xp" && e.reason === "kill") xp += e.amount;
    perMin.push(xp);
    const lvl = sim.world.read(heroOf(sim.world), Level).level;
    if (lvl >= level && minute >= 20) {
      const last10 = perMin.slice(-10).reduce((a, b) => a + b, 0) / 10;
      return { snap: sim.snapshot(), minute, level: lvl, last10 };
    }
  }
  throw new Error(`${classId} seed ${seed} did not reach L${level} in 70 minutes`);
}

describe("requirement: offline XP is 20 % of the recent online Idle rate at L12+", () => {
  for (const [classId, seed] of [
    ["classic.warrior", 7],
    ["classic.rogue", 2026],
    ["classic.sorcerer", 11],
  ] as const) {
    it(`${classId} (seed ${seed}): 10 min, 1 h and 8 h pay 15-27 % of the last 10 minutes online`, () => {
      const g = growTo(classId, seed, 12);
      for (const ms of [10 * MINUTE, HOUR, CAP_MS]) {
        const d = grant(restore(g.snap), ms).summary;
        expect(d.source).toBe("rate");
        const ratio = d.xp / (ms / MINUTE) / g.last10;
        const at = `L${g.level} minute ${g.minute}, ${ms / MINUTE} min away`;
        expect(ratio, at).toBeGreaterThanOrEqual(0.15);
        expect(ratio, at).toBeLessThanOrEqual(0.27);
      }
      const d20 = grant(restore(g.snap), HOUR).summary;
      const d50 = grant(restore(g.snap), HOUR, 50).summary;
      const d0 = grant(restore(g.snap), HOUR, 0).summary;
      // 50 % pays 2.5x the 20 % grant (floors aside); 0 % pays no XP, the kills stay.
      expect(Math.abs(d50.xp * 2 - d20.xp * 5)).toBeLessThanOrEqual(5);
      expect(d0.xp).toBe(0);
      expect(d0.kills).toBe(d20.kills);
    }, 240_000);
  }
});
