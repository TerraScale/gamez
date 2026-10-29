/**
 * classic.achievements tests (wave A, OWNER: T-achievements): every metric reads
 * the right state, unlock at the threshold (once, sorted by id), the gold grant
 * command, the 20-tick cadence, phase/hero gating, lazy state on an old world,
 * partial modules, determinism and a pinned hash.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type GameEvent,
  type ModuleSpec,
  type Sim,
  type World,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf } from "../src/bus.ts";
import { Equipment, Level, Talents } from "../src/components.ts";
import { modules as classicModules } from "../src/index.ts";
import { metricValue } from "../src/achievements/metrics.ts";
import {
  achievementsOf,
  RES,
  type DungeonState,
  type GameState,
  type RunStats,
} from "../src/resources.ts";
import {
  KIND,
  type AchievementMetric,
  type AchievementProto,
  type ItemInstance,
  type SetProto,
} from "../src/types.ts";
import { testContent } from "./support/content.ts";
import { ensureResources, spawnTestHero } from "./support/harness.ts";

// ---------------------------------------------------------------------------
// Test content: a few achievements over different metrics, plus one set.
// ---------------------------------------------------------------------------

function ach(
  name: string,
  metric: AchievementMetric,
  target: number,
  gold: number,
  order: number,
  over: Partial<AchievementProto> = {},
): AchievementProto {
  return {
    name,
    description: `test ${name}`,
    icon: `icon.achievement.${name}`,
    metric,
    target,
    reward: { gold, title: over.reward?.title ?? null },
    hidden: over.hidden ?? false,
    order,
  };
}

const testAchievements = defineModule({
  id: "test.achievements",
  version: "0.0.1",
  data(reg) {
    reg.define(KIND.achievement, "classic.achievement.t_kills", ach("t_kills", "kills", 5, 100, 1));
    reg.define(
      KIND.achievement,
      "classic.achievement.t_gold_spent",
      ach("t_gold_spent", "goldSpent", 10, 40, 2),
    );
    reg.define(
      KIND.achievement,
      "classic.achievement.t_hidden_boss",
      ach("t_hidden_boss", "bossKills", 1, 0, 3, { hidden: true }),
    );
    reg.define(
      KIND.achievement,
      "classic.achievement.t_panoply",
      ach("t_panoply", "setComplete", 1, 50, 4, { reward: { gold: 50, title: "Panoply" } }),
    );
    const set: SetProto = {
      name: "Test Set",
      classId: null,
      pieces: ["classic.setItem.a", "classic.setItem.b"],
      bonuses: [],
    };
    reg.define(KIND.set, "classic.set.test_set", set);
  },
});

/** A play-phase sim with core + achievements (+ the given extra modules), a hero and the test achievements. */
function makeSim(
  opts: { seed?: number; ids?: string[]; withContent?: boolean; hero?: boolean } = {},
): Sim {
  const ids = opts.ids ?? ["classic.core", "classic.achievements"];
  const withContent = opts.withContent ?? true;
  const modules = [...ids, "test.content", ...(withContent ? ["test.achievements"] : [])];
  const catalog: ModuleSpec[] = [...classicModules, testContent, testAchievements];
  const mode = defineMode({
    id: "classic",
    name: "Classic (achievements test)",
    description: "test",
    world: null,
    modules,
    tick: { kind: "fixed", hz: 20 },
  });
  const sim = createSim(loadMode(mode, catalog), { seed: opts.seed ?? 1 });
  ensureResources(sim.world);
  if (opts.hero !== false) spawnTestHero(sim.world, { level: 1 });
  return sim;
}

function setStats(world: World, over: Partial<RunStats>): void {
  const base = world.getResource<RunStats>(RES.stats) ?? {
    kills: 0,
    championKills: 0,
    uniqueKills: 0,
    bossKills: 0,
    deaths: 0,
    goldEarned: 0,
    itemsFound: 0,
    potionsUsed: 0,
    ticksPlayed: 0,
    offlineMs: 0,
  };
  world.setResource(RES.stats, { ...base, ...over });
}

function unlockedIds(sim: Sim): string[] {
  return (achievementsOf(sim.world)?.unlocked ?? []).map((u) => u.id);
}

function eventsOf(events: GameEvent[], type: string): GameEvent[] {
  return events.filter((e) => e.type === type);
}

function equipSet(world: World, hero: number, pieces: string[]): void {
  const slots = ["weapon", "helm"] as const;
  const eq: Record<string, unknown> = {};
  pieces.forEach((set, i) => {
    eq[slots[i] ?? "armor"] = {
      uid: i + 1,
      base: "classic.item.x",
      set,
    } as unknown as ItemInstance;
  });
  world.update(hero, Equipment, eq as never);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe("classic.achievements metrics", () => {
  it("reads each metric from the state it names", () => {
    const sim = makeSim();
    const w = sim.world;
    const reg = sim.loaded.registry;
    setStats(w, {
      kills: 11,
      championKills: 12,
      uniqueKills: 13,
      bossKills: 14,
      goldEarned: 15,
      goldSpent: 16,
      itemsFound: 17,
      uniquesFound: 18,
      setItemsFound: 19,
      potionsUsed: 20,
      itemsCrafted: 21,
      gemsSocketed: 22,
      gambles: 23,
      riftsCompleted: 24,
      ticksPlayed: 2500,
    });
    expect(metricValue(w, reg, "kills")).toBe(11);
    expect(metricValue(w, reg, "championKills")).toBe(12);
    expect(metricValue(w, reg, "uniqueKills")).toBe(13);
    expect(metricValue(w, reg, "bossKills")).toBe(14);
    expect(metricValue(w, reg, "goldEarned")).toBe(15);
    expect(metricValue(w, reg, "goldSpent")).toBe(16);
    expect(metricValue(w, reg, "itemsFound")).toBe(17);
    expect(metricValue(w, reg, "uniquesFound")).toBe(18);
    expect(metricValue(w, reg, "setItemsFound")).toBe(19);
    expect(metricValue(w, reg, "potionsUsed")).toBe(20);
    expect(metricValue(w, reg, "itemsCrafted")).toBe(21);
    expect(metricValue(w, reg, "gemsSocketed")).toBe(22);
    expect(metricValue(w, reg, "gambles")).toBe(23);
    expect(metricValue(w, reg, "riftsCompleted")).toBe(24);
    expect(metricValue(w, reg, "playMinutes")).toBe(2);
  });

  it("reads hero, dungeon, quests, talents and rift state", () => {
    const sim = makeSim();
    const w = sim.world;
    const reg = sim.loaded.registry;
    const hero = [...w.query(Level)][0]!;
    w.update(hero, Level, { level: 12 });
    w.add(hero, Talents, { points: 0, spent: 3, ranks: [], levelSeen: 12 });
    const dungeon = w.getResource<DungeonState>(RES.dungeon)!;
    w.setResource(RES.dungeon, { ...dungeon, deepest: 9 });
    w.setResource(RES.quests, { active: [], completed: ["a", "b", "c"] });
    w.setResource(RES.rift, { maxCompleted: 4 } as never);
    expect(metricValue(w, reg, "level")).toBe(12);
    expect(metricValue(w, reg, "talentPoints")).toBe(3);
    expect(metricValue(w, reg, "deepest")).toBe(9);
    expect(metricValue(w, reg, "questsCompleted")).toBe(3);
    expect(metricValue(w, reg, "riftLevel")).toBe(4);
  });

  it("setComplete is 1 only when every piece of a set is equipped", () => {
    const sim = makeSim();
    const w = sim.world;
    const reg = sim.loaded.registry;
    const hero = [...w.query(Level)][0]!;
    expect(metricValue(w, reg, "setComplete")).toBe(0);
    equipSet(w, hero, ["classic.setItem.a"]);
    expect(metricValue(w, reg, "setComplete")).toBe(0);
    equipSet(w, hero, ["classic.setItem.a", "classic.setItem.b"]);
    expect(metricValue(w, reg, "setComplete")).toBe(1);
  });

  it("missing modules and resources read as 0 and never throw", () => {
    const sim = makeSim({ ids: ["classic.core", "classic.achievements"], hero: false });
    const w = sim.world;
    const reg = sim.loaded.registry;
    for (const metric of [
      "kills",
      "level",
      "talentPoints",
      "riftLevel",
      "setComplete",
      "questsCompleted",
      "playMinutes",
    ] as AchievementMetric[]) {
      expect(metricValue(w, reg, metric)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Unlocks
// ---------------------------------------------------------------------------

describe("classic.achievements unlocks", () => {
  it("unlocks at the threshold, once, with an event, and never again", () => {
    const sim = makeSim();
    setStats(sim.world, { kills: 4 });
    sim.step(40);
    expect(unlockedIds(sim)).toEqual([]);

    setStats(sim.world, { kills: 5 });
    const first = sim.step(40);
    expect(unlockedIds(sim)).toEqual(["classic.achievement.t_kills"]);
    const unlockEvents = eventsOf(first, "classic.achievement.unlocked");
    expect(unlockEvents).toHaveLength(1);
    expect(unlockEvents[0]).toMatchObject({
      type: "classic.achievement.unlocked",
      id: "classic.achievement.t_kills",
      name: "t_kills",
      gold: 100,
      title: null,
    });

    const later = sim.step(60);
    expect(eventsOf(later, "classic.achievement.unlocked")).toHaveLength(0);
    expect(unlockedIds(sim)).toEqual(["classic.achievement.t_kills"]);
  });

  it("stores unlocks sorted by id with the tick, on the 20-tick cadence", () => {
    const sim = makeSim();
    setStats(sim.world, { kills: 9, goldSpent: 12 });
    sim.step(45);
    const unlocked = achievementsOf(sim.world)!.unlocked;
    expect(unlocked.map((u) => u.id)).toEqual([
      "classic.achievement.t_gold_spent",
      "classic.achievement.t_kills",
    ]);
    for (const u of unlocked) {
      expect(u.at % 20).toBe(0);
      expect(u.at).toBeLessThanOrEqual(sim.tick);
    }
    const ids = unlocked.map((u) => u.id);
    expect(ids).toEqual(ids.toSorted());
  });

  it("queues a grantGold command with reason achievement for gold rewards", () => {
    const sim = makeSim();
    setStats(sim.world, { kills: 5 });
    let seen = false;
    for (let i = 0; i < 60 && !seen; i++) {
      const ev = sim.step(1);
      if (eventsOf(ev, "classic.achievement.unlocked").length > 0) {
        const cmds = busOf(sim.world).commands;
        expect(cmds).toContainEqual(
          expect.objectContaining({ op: "grantGold", amount: 100, reason: "achievement" }),
        );
        seen = true;
      }
    }
    expect(seen).toBe(true);
  });

  it("a 0-gold reward emits the event but queues no gold command", () => {
    const sim = makeSim();
    setStats(sim.world, { bossKills: 1 });
    const ev = sim.step(40);
    expect(eventsOf(ev, "classic.achievement.unlocked")).toHaveLength(1);
    expect(busOf(sim.world).commands.filter((c) => c.op === "grantGold")).toHaveLength(0);
    expect(unlockedIds(sim)).toEqual(["classic.achievement.t_hidden_boss"]);
  });

  it("unlocks the set achievement when every piece is equipped and grants its title", () => {
    const sim = makeSim();
    const hero = [...sim.world.query(Level)][0]!;
    equipSet(sim.world, hero, ["classic.setItem.a", "classic.setItem.b"]);
    const ev = sim.step(40);
    const got = eventsOf(ev, "classic.achievement.unlocked");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      id: "classic.achievement.t_panoply",
      title: "Panoply",
      gold: 50,
    });
  });

  it("does nothing outside phase play or without a hero", () => {
    const sim = makeSim({ hero: false });
    setStats(sim.world, { kills: 50 });
    sim.step(40);
    expect(unlockedIds(sim)).toEqual([]);

    const play = makeSim();
    const game = play.world.getResource<GameState>(RES.game)!;
    play.world.setResource(RES.game, { ...game, phase: "choose" });
    setStats(play.world, { kills: 50 });
    play.step(40);
    expect(unlockedIds(play)).toEqual([]);
  });

  it("creates the state lazily on an old world and tolerates partial modules", () => {
    const sim = makeSim({ ids: ["classic.core", "classic.achievements"], withContent: false });
    expect(achievementsOf(sim.world)).toBeNull();
    setStats(sim.world, { kills: 1000 });
    expect(() => sim.step(60)).not.toThrow();
    expect(achievementsOf(sim.world)).toEqual({ unlocked: [], title: "" });

    sim.world.deleteResource(RES.achievements);
    expect(() => sim.step(20)).not.toThrow();
    expect(achievementsOf(sim.world)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

function script(sim: Sim): void {
  sim.step(10);
  setStats(sim.world, { kills: 5, goldSpent: 12, ticksPlayed: 1300 });
  sim.step(30);
  const hero = [...sim.world.query(Level)][0]!;
  equipSet(sim.world, hero, ["classic.setItem.a", "classic.setItem.b"]);
  sim.step(40);
  setStats(sim.world, { bossKills: 1, kills: 40 });
  sim.step(40);
}

describe("classic.achievements determinism", () => {
  it("the same seed and script give the same hash", () => {
    const a = makeSim({ seed: 77 });
    const b = makeSim({ seed: 77 });
    script(a);
    script(b);
    expect(a.hash()).toBe(b.hash());
  });

  it("the hash after the fixed script is pinned", () => {
    const sim = makeSim({ seed: 77 });
    script(sim);
    expect(sim.hash()).toBe("d1c2e9dc114ab22c");
  });
});
