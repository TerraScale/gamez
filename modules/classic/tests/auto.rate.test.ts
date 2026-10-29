/**
 * The online Auto/Idle rate (classic.auto.rate, offline-idle.md §4.1) and the
 * offline grant that extrapolates it (§4.2), on the real classic catalog.
 *
 * Measurement cases run the real sim: a hero that idles fights real monsters,
 * so the rate is checked against the classic.xp events and RunStats. Formula
 * cases call offlineGrant directly with a rate resource set by the test.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { pushCommand } from "../src/bus.ts";
import { computeOffline, offlineGrant } from "../src/auto/offline.ts";
import { AUTO_RATE_MIN_TICKS, AUTO_RATE_WINDOW_TICKS } from "../src/auto/rate.ts";
import { AreaTag, Dead, Level, Loot, Pos, Wallet } from "../src/components.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { currentDepth, heroOf, RES, type AutoRate, type RunStats } from "../src/resources.ts";

const loaded = loadMode(mode, modules);
const HOUR = 3_600_000;
const SEED = 2027;

/** A new warrior, in town, in the given control mode. */
function newHero(seed: number, control: "manual" | "idle" | "auto"): Sim {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Rater" }, null);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const ctl = sim.dispatch(ACTION.setControl, { mode: control }, null);
  expect(ctl.ok, JSON.stringify(ctl.error)).toBe(true);
  return sim;
}

function rateOf(sim: Sim): AutoRate | undefined {
  return sim.world.getResource<AutoRate>(RES.autoRate);
}

/** Steps `n` ticks and returns every event. */
function run(sim: Sim, n: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...sim.step(1));
  return out;
}

/** Sets the rate resource, as if it had been measured earlier. */
function setRate(sim: Sim, r: AutoRate): void {
  sim.world.setResource<AutoRate>(RES.autoRate, r);
}

/** Puts a gold pile of `amount` on the hero's cell (a ground pickup target). */
function dropGoldAtHero(sim: Sim, amount: number): number {
  const h = heroOf(sim.world);
  const gold = sim.world.create();
  sim.world.add(gold, Loot, { kind: "gold", item: null, gold: amount, potion: "", droppedAt: 0 });
  sim.world.add(gold, Pos, sim.world.read(h, Pos));
  sim.world.add(gold, AreaTag, { depth: currentDepth(sim.world) });
  return gold;
}

/** A fixed idle script: 1500 ticks of play, an offline hour, 100 ticks. */
function rateScript(): Sim {
  const sim = newHero(SEED, "idle");
  run(sim, 1500);
  expect(sim.dispatch(ACTION.offlineProgress, { elapsedMs: HOUR }, null).ok).toBe(true);
  run(sim, 100);
  return sim;
}

describe("classic.auto.rate: measurement", () => {
  it("is absent in a manual-only game", () => {
    const sim = newHero(SEED, "manual");
    run(sim, 3000);
    expect(rateOf(sim)).toBeUndefined();
  });

  it("is created on the first idle tick", () => {
    const sim = newHero(SEED, "idle");
    expect(rateOf(sim)).toBeUndefined();
    sim.step(1);
    expect(rateOf(sim)).toEqual({
      ticks: 1,
      kills: 0,
      xp: 0,
      pool: 0,
      gold: 0,
      loot: 0,
      upkeep: 0,
      spent: 0,
    });
  });

  it("counts the kills and XP of the hero's own kills (matches the kill XP events)", () => {
    const sim = newHero(SEED, "idle");
    const events = run(sim, 3000);
    const r = rateOf(sim)!;
    const stats = sim.world.getResource<RunStats>(RES.stats)!;
    expect(r.ticks).toBe(3000);
    expect(stats.kills).toBeGreaterThan(0);
    // No halving in 3000 ticks, so every kill is in the rate.
    expect(r.kills).toBe(stats.kills);
    const killXp = (events as ClassicEvent[]).reduce(
      (sum, e) => (e.type === "classic.xp" && e.reason === "kill" ? sum + e.amount : sum),
      0,
    );
    expect(killXp).toBeGreaterThan(0);
    expect(r.xp).toBe(killXp);
    // The raw pool (before the over-level penalty) is at least the hero's own XP.
    expect(r.pool).toBeGreaterThanOrEqual(r.xp);
  }, 120_000);

  it("ignores manual pickups: the loot is dropped on the next manual tick", () => {
    const sim = newHero(SEED, "idle");
    sim.step(1);
    expect(sim.dispatch(ACTION.setControl, { mode: "manual" }, null).ok).toBe(true);
    const h = heroOf(sim.world);
    const walletBefore = sim.world.read(h, Wallet).gold;
    const gold = dropGoldAtHero(sim, 50);
    expect(sim.dispatch(ACTION.pickup, { target: gold }, null).ok).toBe(true);
    // The pickup is an intent: the command runs on the following tick.
    run(sim, 2);
    expect(sim.world.read(h, Wallet).gold).toBe(walletBefore + 50);
    expect(rateOf(sim)).toMatchObject({ loot: 0, gold: 0 });
  });

  it("counts a ground gold pickup in Idle", () => {
    const sim = newHero(SEED, "idle");
    sim.step(1);
    const gold = dropGoldAtHero(sim, 50);
    expect(sim.dispatch(ACTION.pickup, { target: gold }, null).ok).toBe(true);
    run(sim, 2);
    expect(rateOf(sim)).toMatchObject({ gold: 50, loot: 0 });
  });

  it("never counts quest, bank or offline grants", () => {
    const sim = newHero(SEED, "idle");
    sim.step(1);
    const before = { ...rateOf(sim)! };
    pushCommand(sim.world, { op: "grantXp", amount: 1000, reason: "quest" });
    pushCommand(sim.world, { op: "grantGold", amount: 500, reason: "quest" });
    pushCommand(sim.world, { op: "grantGold", amount: 300, reason: "bank" });
    sim.step(1);
    expect(rateOf(sim)).toMatchObject({ kills: before.kills, xp: before.xp, gold: before.gold });
    const off = sim.dispatch(ACTION.offlineProgress, { elapsedMs: HOUR }, null);
    expect(off.ok, JSON.stringify(off.error)).toBe(true);
    sim.step(1);
    expect(rateOf(sim)).toMatchObject({ kills: before.kills, xp: before.xp, gold: before.gold });
  });

  it("halves everything (upkeep included) once ticks exceed the window, and not before", () => {
    const sim = newHero(SEED, "idle");
    setRate(sim, {
      ticks: AUTO_RATE_WINDOW_TICKS - 1,
      kills: 101,
      xp: 1001,
      gold: 401,
      loot: 0,
      upkeep: 301,
      spent: 0,
    });
    sim.step(1);
    expect(rateOf(sim)).toEqual({
      ticks: 36_000,
      kills: 101,
      xp: 1001,
      gold: 401,
      loot: 0,
      upkeep: 301,
      spent: 0,
    });
    sim.step(1);
    expect(rateOf(sim)).toEqual({
      ticks: 18_000,
      kills: 50,
      xp: 500,
      gold: 200,
      loot: 0,
      upkeep: 150,
      spent: 0,
    });
  });

  it("reads a rate saved before the upkeep fields as upkeep 0 and writes them", () => {
    const sim = newHero(SEED, "idle");
    setRate(sim, { ticks: 100, kills: 3, xp: 30, gold: 12, loot: 0 });
    sim.step(1);
    expect(rateOf(sim)).toMatchObject({ ticks: 101, upkeep: 0, spent: 0 });
  });

  it("is deterministic: the same seed and script give the same hash", () => {
    expect(rateScript().hash()).toBe(rateScript().hash());
  }, 120_000);

  it("pins the hash after a fixed script", () => {
    expect(rateScript().hash()).toBe("bca52c4e7875dc05");
  }, 120_000);
});

describe("classic.auto.rate: the offline grant (§4.2)", () => {
  it("uses the rate path from AUTO_RATE_MIN_TICKS and the fallback model below it", () => {
    const sim = newHero(SEED, "idle");
    const reg = sim.loaded.registry;
    const h = heroOf(sim.world);
    expect(offlineGrant(sim.world, reg, h, HOUR).source).toBe("model");
    setRate(sim, { ticks: AUTO_RATE_MIN_TICKS - 1, kills: 500, xp: 9000, gold: 900, loot: 0 });
    expect(offlineGrant(sim.world, reg, h, HOUR).source).toBe("model");
    setRate(sim, { ticks: AUTO_RATE_MIN_TICKS, kills: 500, xp: 9000, gold: 900, loot: 0 });
    expect(offlineGrant(sim.world, reg, h, HOUR).source).toBe("rate");
  });

  it("caps the rate at 3x the model for kills, XP and gold, and 120 kills a minute", () => {
    const sim = newHero(SEED, "idle");
    const reg = sim.loaded.registry;
    const h = heroOf(sim.world);
    // Pinned model of this fresh warrior for an hour (depth 1, 9 kills a minute).
    expect(computeOffline(sim.world, reg, h, HOUR)).toMatchObject({
      depth: 1,
      kills: 540,
      xp: 4860,
      gold: 1809,
      items: 10,
    });
    setRate(sim, { ticks: AUTO_RATE_MIN_TICKS, kills: 1e9, xp: 1e9, gold: 1e9, loot: 0 });
    const g = offlineGrant(sim.world, reg, h, HOUR, 100);
    expect(g.source).toBe("rate");
    // kills: 3 x 540; XP: 3 x (4860 x 200 %); gold: 3 x 1809.
    expect(g).toMatchObject({ kills: 1620, xp: 29_160, gold: 5427, upkeep: 0, items: 20 });
  });

  it("pays the measured rate's XP with no model floor (a slow window pays the slow rate)", () => {
    const sim = newHero(SEED, "idle");
    const reg = sim.loaded.registry;
    const h = heroOf(sim.world);
    // 10 XP in 6 000 ticks extrapolates to 120 XP an hour; the model's 9 720 is not a floor.
    setRate(sim, { ticks: AUTO_RATE_MIN_TICKS, kills: 2, xp: 10, gold: 0, loot: 0 });
    const g = offlineGrant(sim.world, reg, h, HOUR, 100);
    // Gold: no ground gold; 24 kills drop 2 normal items, none kept, sold at 2 each.
    expect(g).toMatchObject({ source: "rate", kills: 24, xp: 120, gold: 4, upkeep: 0 });
  });

  it("scales only XP by xpPct (0, 20, 50, 100); kills, gold and items are unchanged", () => {
    const sim = newHero(SEED, "idle");
    const reg = sim.loaded.registry;
    const h = heroOf(sim.world);
    setRate(sim, { ticks: 12_000, kills: 300, xp: 9000, gold: 800, loot: 0 });
    const at = (pct: number) => offlineGrant(sim.world, reg, h, HOUR, pct);
    const full = at(100);
    const zero = at(0);
    const twenty = at(20);
    const half = at(50);
    expect(full.source).toBe("rate");
    expect(full.xp).toBeGreaterThan(0);
    for (const g of [zero, twenty, half]) {
      expect(g.kills).toBe(full.kills);
      expect(g.gold).toBe(full.gold);
      expect(g.items).toBe(full.items);
      expect(g.depth).toBe(full.depth);
    }
    // Pinned: the rate's 54 000 XP an hour is capped at 3 x the model's 9 720.
    expect(full.xp).toBe(29_160);
    expect(zero.xp).toBe(0);
    expect(twenty.xp).toBe(5832);
    expect(half.xp).toBe(14_580);
    expect(zero.levels).toBe(0);
    // Undefined xpPct means the balance default (20).
    expect(offlineGrant(sim.world, reg, h, HOUR)).toEqual({ ...twenty, xpPct: 20 });
    expect(twenty).toMatchObject({ xpPct: 20, goldPct: 100, itemPct: 100 });
  });

  it("gives nothing for less than a minute", () => {
    const sim = newHero(SEED, "idle");
    setRate(sim, { ticks: 12_000, kills: 300, xp: 9000, gold: 800, loot: 0 });
    const g = offlineGrant(sim.world, sim.loaded.registry, heroOf(sim.world), 59_000);
    expect(g).toMatchObject({ minutes: 0, kills: 0, xp: 0, gold: 0, items: 0, levels: 0 });
  });

  it("clamps the levels gained to maxLevel", () => {
    const sim = newHero(SEED, "idle");
    const h = heroOf(sim.world);
    setRate(sim, { ticks: AUTO_RATE_MIN_TICKS, kills: 1e9, xp: 1e9, gold: 0, loot: 0 });
    const g = offlineGrant(sim.world, sim.loaded.registry, h, HOUR, 100);
    expect(g.levels).toBeGreaterThanOrEqual(0);
    expect(sim.world.read(h, Level).level + g.levels).toBeLessThanOrEqual(60);
  });
});

describe("classic.auto.rate: the grant applied to a real hero", () => {
  it("respawns a dead hero before the grants, and the XP lands", () => {
    const sim = newHero(SEED, "manual");
    const h = heroOf(sim.world);
    sim.world.add(h, Dead, { at: 0, killer: 0 });
    const r = sim.dispatch(ACTION.offlineProgress, { elapsedMs: HOUR }, null);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const summary = r.events.find((e) => e.type === "classic.offline.summary") as
      | { xp: number }
      | undefined;
    expect(summary).toBeDefined();
    const xpBefore = sim.world.read(h, Level).xp;
    const events = sim.step(1);
    // The respawn ran (Dead is gone), no command failed, and the XP landed.
    expect(sim.world.has(h, Dead)).toBe(false);
    expect(events.filter((e) => e.type === "classic.command.failed")).toEqual([]);
    expect(sim.world.read(h, Level).xp).toBe(xpBefore + (summary?.xp ?? 0));
  });
});
