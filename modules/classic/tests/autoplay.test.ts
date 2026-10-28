/**
 * Phase 2a acceptance: the full classic mode (real content, every module)
 * plays itself. Each class runs 20 minutes of sim time (24,000 ticks at
 * 20 Hz) headless in Auto mode from a fresh hero and must show the whole
 * loop: kills of at least 5 monster types, XP and levels, at least 3 skills,
 * potions, loot picked up and equipped, a town trip that sells and buys, and
 * two dungeon levels. Average tick time is logged.
 *
 * Determinism and snapshot restore over the same 20-minute run live in
 * autoplay.replay.test.ts (a separate file, so the two run in parallel).
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Equipment, Level, Wallet } from "../src/components.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { heroOf, RES, stashOf, type RunStats } from "../src/resources.ts";

export const AUTOPLAY_SEED = 2026;
export const AUTOPLAY_TICKS = 24_000;
const loaded = loadMode(mode, modules);

/** A new sim with a fresh hero of `classId` in Auto mode. */
export function startAutoplay(classId: string, seed = AUTOPLAY_SEED): Sim {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch("classic.newHero", { classId, name: "Tester" }, null);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const control = sim.dispatch("classic.setControl", { mode: "auto" }, null);
  expect(control.ok, JSON.stringify(control.error)).toBe(true);
  return sim;
}

interface Tally {
  killsByType: Map<string, number>;
  skillsCast: Set<string>;
  potions: number;
  itemsPicked: number;
  goldPicked: number;
  equipped: number;
  sold: number;
  bought: number;
  townReturns: number;
  maxDepth: number;
  levelUps: number;
  heroDeaths: number;
  unhandled: string[];
  ms: number;
  worstMs: number;
  ticks: number;
}

function newTally(): Tally {
  return {
    killsByType: new Map(),
    skillsCast: new Set(),
    potions: 0,
    itemsPicked: 0,
    goldPicked: 0,
    equipped: 0,
    sold: 0,
    bought: 0,
    townReturns: 0,
    maxDepth: 0,
    levelUps: 0,
    heroDeaths: 0,
    unhandled: [],
    ms: 0,
    worstMs: 0,
    ticks: 0,
  };
}

function record(t: Tally, sim: Sim, events: GameEvent[]): void {
  const hero = heroOf(sim.world);
  for (const raw of events) {
    const e = raw as ClassicEvent;
    switch (e.type) {
      case "classic.death":
        if (!e.isHero) t.killsByType.set(e.monster, (t.killsByType.get(e.monster) ?? 0) + 1);
        break;
      case "classic.cast":
        if (e.caster === hero) t.skillsCast.add(e.skill);
        break;
      case "classic.potion":
        t.potions++;
        break;
      case "classic.loot.picked":
        if (e.kind === "item") t.itemsPicked++;
        if (e.kind === "gold") t.goldPicked += e.gold;
        break;
      case "classic.item.equipped":
        t.equipped++;
        break;
      case "classic.vendor.sold":
        t.sold++;
        break;
      case "classic.vendor.bought":
        t.bought++;
        break;
      case "classic.area.changed":
        if (e.depth === 0 && t.maxDepth > 0) t.townReturns++;
        t.maxDepth = Math.max(t.maxDepth, e.depth);
        break;
      case "classic.levelUp":
        t.levelUps++;
        break;
      case "classic.hero.died":
        t.heroDeaths++;
        break;
      case "classic.command.failed":
        if (e.code === "unhandled") t.unhandled.push(e.op);
        break;
    }
  }
}

/** Steps `n` ticks one at a time (like the client at 1x), tallying events and timing. */
function play(sim: Sim, n: number, t: Tally): void {
  for (let i = 0; i < n; i++) {
    const started = performance.now();
    const events = sim.step(1);
    const ms = performance.now() - started;
    t.ms += ms;
    t.ticks++;
    if (ms > t.worstMs) t.worstMs = ms;
    record(t, sim, events);
  }
}

const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer"] as const;

describe("classic autoplay (20 sim minutes per class, Auto mode)", () => {
  for (const classId of CLASSES) {
    it(`${classId} plays the whole loop by itself`, () => {
      const sim = startAutoplay(classId);
      const t = newTally();
      // No exceptions: any throw inside a system fails the test here.
      play(sim, AUTOPLAY_TICKS, t);

      const hero = heroOf(sim.world);
      expect(hero).not.toBe(0);
      const level = sim.world.read(hero, Level);
      const stats = sim.world.getResource<RunStats>(RES.stats)!;
      const avg = t.ms / t.ticks;
      const kinds = [...t.killsByType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `${id.replace("classic.monster.", "")} ${n}`);
      console.log(
        `[autoplay] ${classId}: level ${level.level} (xp ${level.xp}), kills ${stats.kills} ` +
          `(${kinds.join(", ")}), skills [${[...t.skillsCast].join(", ")}], potions ${t.potions}, ` +
          `items picked ${t.itemsPicked}, equipped ${t.equipped}, sold ${t.sold}, bought ${t.bought}, ` +
          `town returns ${t.townReturns}, max depth ${t.maxDepth}, deaths ${t.heroDeaths}, ` +
          `gold ${sim.world.read(hero, Wallet).gold}, stash ${stashOf(sim.world).items.length}, ` +
          `avg tick ${avg.toFixed(3)} ms (worst ${t.worstMs.toFixed(1)} ms)`,
      );

      // Monsters were killed: at least 5 distinct types.
      expect(stats.kills).toBeGreaterThanOrEqual(50);
      expect(t.killsByType.size).toBeGreaterThanOrEqual(5);
      // XP and levels.
      expect(level.xp).toBeGreaterThan(0);
      expect(level.level).toBeGreaterThanOrEqual(5);
      expect(t.levelUps).toBe(level.level - 1);
      // Spells: at least 3 distinct skills used by the hero.
      expect(t.skillsCast.size).toBeGreaterThanOrEqual(3);
      // Potions, loot, gear.
      expect(t.potions).toBeGreaterThan(0);
      expect(stats.potionsUsed).toBe(t.potions);
      expect(t.itemsPicked).toBeGreaterThan(0);
      expect(t.goldPicked).toBeGreaterThan(0);
      expect(t.equipped).toBeGreaterThan(0);
      const equipment = sim.world.read(hero, Equipment);
      expect(Object.values(equipment).filter((v) => v !== null).length).toBeGreaterThan(0);
      // A town trip that sells and buys, then goes back down.
      expect(t.townReturns).toBeGreaterThanOrEqual(1);
      expect(t.sold).toBeGreaterThan(0);
      expect(t.bought).toBeGreaterThan(0);
      // Two dungeon levels (depth 1 and depth 2) reached.
      expect(t.maxDepth).toBeGreaterThanOrEqual(2);
      // Every queued command had an owner.
      expect(t.unhandled).toEqual([]);
      // Target is < 2 ms per tick (logged above); the assertion allows 2x so a
      // loaded shared machine does not flake the suite.
      expect(avg).toBeLessThan(4);
    }, 600_000);
  }
});

describe("classic Full Idle offline progress", () => {
  function idleHero(seed: number): Sim {
    const sim = startAutoplay("classic.warrior", seed);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    // Play a little so the hero has a deepest depth and some gear.
    sim.step(1200);
    return sim;
  }

  it("grants XP, gold and stash items for time away, capped and deterministic", () => {
    const sim = idleHero(11);
    const hero = heroOf(sim.world);
    const before = {
      xp: sim.world.read(hero, Level).xp,
      gold: sim.world.read(hero, Wallet).gold,
      stash: stashOf(sim.world).items.length,
      hash: sim.hash(),
    };
    const twoHours = 2 * 3600 * 1000;
    const res = sim.dispatch("classic.offlineProgress", { elapsedMs: twoHours }, null);
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const summary = res.events.find((e) => e.type === "classic.offline.summary") as
      | Extract<ClassicEvent, { type: "classic.offline.summary" }>
      | undefined;
    expect(summary).toBeDefined();
    expect(summary!.ms).toBe(twoHours);
    expect(summary!.kills).toBeGreaterThan(0);
    expect(summary!.xp).toBeGreaterThan(0);
    expect(summary!.gold).toBeGreaterThan(0);
    // The grants are commands: their owners apply them on the next tick.
    const events = sim.step(1);
    expect(
      events.filter((e) => e.type === "classic.command.failed").map((e) => JSON.stringify(e)),
    ).toEqual([]);
    const after = {
      xp: sim.world.read(hero, Level).xp,
      gold: sim.world.read(hero, Wallet).gold,
      stash: stashOf(sim.world).items.length,
      level: sim.world.read(hero, Level).level,
    };
    expect(after.xp).toBeGreaterThanOrEqual(before.xp + summary!.xp);
    expect(after.gold).toBeGreaterThanOrEqual(before.gold + summary!.gold);
    expect(after.stash).toBe(before.stash + summary!.items);
    expect(sim.world.getResource<RunStats>(RES.stats)!.offlineMs).toBe(twoHours);

    // Same seed and script -> same result.
    const twin = idleHero(11);
    expect(twin.hash()).toBe(before.hash);
    twin.dispatch("classic.offlineProgress", { elapsedMs: twoHours }, null);
    twin.step(1);
    expect(twin.hash()).toBe(sim.hash());

    // Time away is capped (balance offlineCapMs = 8 h).
    const a = idleHero(12);
    const b = idleHero(12);
    const capped = a.dispatch("classic.offlineProgress", { elapsedMs: 24 * 3600 * 1000 }, null);
    const eight = b.dispatch("classic.offlineProgress", { elapsedMs: 8 * 3600 * 1000 }, null);
    const sum = (r: typeof capped) => r.events.find((e) => e.type === "classic.offline.summary");
    expect(sum(capped)).toEqual(sum(eight));

    // Bad payloads are rejected without touching the world.
    const h = sim.hash();
    expect(sim.dispatch("classic.offlineProgress", { elapsedMs: -5 }, null).ok).toBe(false);
    expect(sim.dispatch("classic.offlineProgress", { elapsedMs: 1.5 }, null).ok).toBe(false);
    expect(sim.dispatch("classic.offlineProgress", { ms: 1000 }, null).ok).toBe(false);
    expect(sim.hash()).toBe(h);

    // The hero keeps playing afterwards.
    sim.step(200);
    expect(heroOf(sim.world)).toBe(hero);
  }, 120_000);
});
