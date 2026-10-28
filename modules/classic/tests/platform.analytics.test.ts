/**
 * classic.analytics (docs/design/admin-dashboard.md §5): the ModeAnalytics
 * hooks fold verified classic events into the §3 "sim.tally" counters. Covers
 * dims and the level/depth band edges, a real accept of a quest, a short real
 * auto run folded per step, the kill / death / gold / quest / cast mapping,
 * the offline summary, and that the fold never changes the world.
 */
import { createSim, loadMode, type Entity, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Level, Monster, Npc, Pos } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { classicAnalytics, depthBand, levelBand } from "../src/platform/analytics.ts";
import { heroOf } from "../src/resources.ts";

const loaded = loadMode(mode, modules);
const GIVER = "classic.npc.captain_hale";
const RATS = "classic.quest.rats_in_the_cellar";

/** Counts every (metric, k1, k2) the fold adds. */
function collector() {
  const counts = new Map<string, number>();
  const add = (metric: string, k1: string, k2: string, amount: number): void => {
    const key = `${metric}|${k1}|${k2}`;
    counts.set(key, (counts.get(key) ?? 0) + amount);
  };
  return {
    add,
    get: (metric: string, k1: string, k2 = ""): number => counts.get(`${metric}|${k1}|${k2}`) ?? 0,
    keys: (): string[] => [...counts.keys()].sort(),
  };
}

/** A warrior in town, standing next to the quest giver. */
function townSim(seed = 1): { sim: Sim; hero: Entity } {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch(
    "classic.newHero",
    { classId: "classic.warrior", name: "Analyst" },
    "tester",
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  sim.step(2);
  const hero = heroOf(sim.world);
  expect(hero).toBeGreaterThan(0);
  for (const e of sim.world.query(Npc, Pos)) {
    if (sim.world.read(e, Npc).proto !== GIVER) continue;
    const p = sim.world.read(e, Pos);
    sim.world.update(hero, Pos, { x: p.x, y: p.y });
    break;
  }
  return { sim, hero };
}

const ev = (type: string, extra: Record<string, unknown> = {}): GameEvent => ({ type, ...extra });

describe("levelBand and depthBand edges", () => {
  it("levelBand groups by ten and caps at 90+", () => {
    expect(levelBand(0)).toBe("1-9");
    expect(levelBand(1)).toBe("1-9");
    expect(levelBand(9)).toBe("1-9");
    expect(levelBand(9.7)).toBe("1-9");
    expect(levelBand(10)).toBe("10-19");
    expect(levelBand(19)).toBe("10-19");
    expect(levelBand(20)).toBe("20-29");
    expect(levelBand(89)).toBe("80-89");
    expect(levelBand(90)).toBe("90+");
    expect(levelBand(500)).toBe("90+");
    expect(levelBand(Number.NaN)).toBe("1-9");
  });

  it("depthBand is town, 1..20, then 21+", () => {
    expect(depthBand(0)).toBe("town");
    expect(depthBand(-3)).toBe("town");
    expect(depthBand(1)).toBe("1");
    expect(depthBand(20)).toBe("20");
    expect(depthBand(21)).toBe("21+");
    expect(depthBand(99)).toBe("21+");
  });
});

describe("dims", () => {
  it("reads the control mode and the hero level band", () => {
    const { sim, hero } = townSim();
    expect(sim.dispatch("classic.setControl", { mode: "manual" }, null).ok).toBe(true);
    expect(classicAnalytics.dims(sim.world)).toEqual({ control: "manual", levelBand: "1-9" });

    sim.world.update(hero, Level, { level: 25 });
    expect(classicAnalytics.dims(sim.world)).toEqual({ control: "manual", levelBand: "20-29" });

    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    expect(classicAnalytics.dims(sim.world).control).toBe("idle");
  });

  it("uses the 1-9 band when there is no hero yet", () => {
    const sim = createSim(loaded, { seed: 3 });
    expect(classicAnalytics.dims(sim.world).levelBand).toBe("1-9");
  });
});

describe("real sim: quest accept", () => {
  it("counts quest.accepted for a quest accepted through a real dispatch, and the fold leaves the hash unchanged", () => {
    const { sim } = townSim();
    const accepted = sim.dispatch("classic.acceptQuest", { quest: RATS }, "tester");
    expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);

    const hashBefore = sim.hash();
    const c = collector();
    classicAnalytics.fold(accepted.events, sim.world, c.add);
    expect(c.get("quest.accepted", RATS)).toBe(1);
    expect(sim.hash()).toBe(hashBefore);
  });
});

describe("real sim: folding a short auto run", () => {
  it("folds per step and reports auto play, xp and gold without changing the world", () => {
    const sim = createSim(loaded, { seed: 2026 });
    expect(
      sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Auto" }, null).ok,
    ).toBe(true);
    expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);

    const c = collector();
    for (let i = 0; i < 2400; i++) {
      const events = sim.step(1);
      classicAnalytics.fold(events, sim.world, c.add);
    }
    expect(classicAnalytics.dims(sim.world).control).toBe("auto");
    // The auto controller earns XP in this window, so the xp counter moves in band 1-9.
    const xp = c.keys().filter((k) => k.startsWith("xp|1-9|"));
    expect(xp.length).toBeGreaterThan(0);
    for (const k of c.keys()) {
      const [metric] = k.split("|");
      expect([
        "xp",
        "gold",
        "kill",
        "drop",
        "quest.accepted",
        "quest.done",
        "quest.completed",
        "level",
        "achievement",
        "cast",
        "talent",
        "rift",
        "gem",
        "death",
        "boss.spawned",
        "boss.killed",
      ]).toContain(metric);
    }
  }, 60_000);
});

describe("fold mapping (synthetic events on a real world)", () => {
  it("kill counts non-hero deaths with a monster id, and skips hero deaths and empty ids", () => {
    const { sim } = townSim();
    const c = collector();
    classicAnalytics.fold(
      [
        ev("classic.death", { isHero: false, monster: "classic.mob_x", rarity: "elite" }),
        ev("classic.death", { isHero: false, monster: "classic.mob_x", rarity: "elite" }),
        ev("classic.death", { isHero: false, monster: "", rarity: "normal" }),
        ev("classic.death", { isHero: true, monster: "", rarity: "hero" }),
      ],
      sim.world,
      c.add,
    );
    expect(c.get("kill", "classic.mob_x", "elite")).toBe(2);
    expect(c.keys().filter((k) => k.startsWith("kill|"))).toHaveLength(1);
  });

  it("death uses the depth of the last area change before it, else the world depth, and an unknown killer", () => {
    const { sim } = townSim();

    const c1 = collector();
    classicAnalytics.fold(
      [
        ev("classic.area.changed", { depth: 3, theme: "x", via: "stairs", name: "d3" }),
        ev("classic.hero.died", { goldLost: 1, xpLost: 1, killer: "Skeleton" }),
      ],
      sim.world,
      c1.add,
    );
    expect(c1.get("death", "3", "unknown")).toBe(1);

    // No area change in the batch: the world is in town (depth 0).
    const c2 = collector();
    classicAnalytics.fold(
      [ev("classic.hero.died", { goldLost: 0, xpLost: 0, killer: "" })],
      sim.world,
      c2.add,
    );
    expect(c2.get("death", "town", "unknown")).toBe(1);
  });

  it("death takes the killer proto from the hero's classic.death when that killer is a live monster", () => {
    const { sim } = townSim();
    const killer = sim.world.create();
    sim.world.add(killer, Monster, {
      proto: "classic.mob_x",
      level: 1,
      rarity: "normal",
      mods: [],
      pack: 0,
      name: "Mob",
    } as never);
    const c = collector();
    classicAnalytics.fold(
      [
        ev("classic.death", { isHero: true, killer, monster: "", rarity: "hero" }),
        ev("classic.hero.died", { goldLost: 0, xpLost: 0, killer: "Mob" }),
      ],
      sim.world,
      c.add,
    );
    expect(c.get("death", "town", "classic.mob_x")).toBe(1);
  });

  it("gold counts positive pickups by reason and skips debug, negative and zero amounts", () => {
    const { sim } = townSim();
    const c = collector();
    classicAnalytics.fold(
      [
        ev("classic.gold", { amount: 7, total: 7, reason: "pickup" }),
        ev("classic.gold", { amount: -5, total: 2, reason: "pickup" }),
        ev("classic.gold", { amount: 0, total: 2, reason: "pickup" }),
        ev("classic.gold", { amount: 9, total: 9, reason: "debug" }),
        ev("classic.gold", { amount: 4, total: 6, reason: "pickup: overflow sold" }),
        ev("classic.gold", { amount: 3, total: 9, reason: "a free text reason" }),
      ],
      sim.world,
      c.add,
    );
    expect(c.get("gold", "1-9", "pickup")).toBe(11);
    expect(c.get("gold", "1-9", "other")).toBe(3);
    expect(c.keys().filter((k) => k.startsWith("gold|"))).toHaveLength(2);
  });

  it("xp counts positive amounts by band and reason, and skips debug", () => {
    const { sim } = townSim();
    const c = collector();
    classicAnalytics.fold(
      [
        ev("classic.xp", { amount: 12, total: 12, reason: "kill" }),
        ev("classic.xp", { amount: 5, total: 17, reason: "quest" }),
        ev("classic.xp", { amount: 99, total: 116, reason: "debug" }),
      ],
      sim.world,
      c.add,
    );
    expect(c.get("xp", "1-9", "kill")).toBe(12);
    expect(c.get("xp", "1-9", "quest")).toBe(5);
    expect(c.keys().filter((k) => k.startsWith("xp|"))).toHaveLength(2);
  });

  it("quest.completed counts the quest but adds no gold or xp (those come as classic.gold / classic.xp)", () => {
    const { sim } = townSim();
    const c = collector();
    classicAnalytics.fold(
      [ev("classic.quest.completed", { quest: RATS, gold: 100, xp: 50 })],
      sim.world,
      c.add,
    );
    expect(c.get("quest.completed", RATS)).toBe(1);
    expect(c.keys().filter((k) => k.startsWith("gold|") || k.startsWith("xp|"))).toHaveLength(0);
  });

  it("cast counts only the hero's casts, not monsters'", () => {
    const { sim, hero } = townSim();
    const monster = sim.world.create();
    const c = collector();
    classicAnalytics.fold(
      [
        ev("classic.cast", {
          caster: hero,
          skill: "classic.skill.cleave",
          effect: "",
          x: 0,
          y: 0,
          tx: 0,
          ty: 0,
        }),
        ev("classic.cast", {
          caster: monster,
          skill: "classic.skill.fireball",
          effect: "",
          x: 0,
          y: 0,
          tx: 0,
          ty: 0,
        }),
      ],
      sim.world,
      c.add,
    );
    expect(c.get("cast", "classic.skill.cleave")).toBe(1);
    expect(c.get("cast", "classic.skill.fireball")).toBe(0);
  });

  it("drop, level, boss, achievement, talent, rift and gem map to their keys", () => {
    const { sim } = townSim();
    const c = collector();
    classicAnalytics.fold(
      [
        ev("classic.loot.dropped", {
          entity: 0,
          kind: "item",
          name: "x",
          rarity: "rare",
          x: 0,
          y: 0,
        }),
        ev("classic.levelUp", { level: 10, statPoints: 5, skillPoints: 1 }),
        ev("classic.boss.spawned", { entity: 0, monster: "classic.boss_a", depth: 5 }),
        ev("classic.boss.killed", { monster: "classic.boss_a", depth: 25 }),
        ev("classic.achievement.unlocked", { id: "ach.first", name: "", gold: 0, title: null }),
        ev("classic.talent.learned", { node: "talent.bash", rank: 1 }),
        ev("classic.gem.socketed", { uid: 1, gem: "gem.ruby", slot: 0 }),
        ev("classic.gems.combined", { from: "a", to: "b", cost: 1 }),
      ],
      sim.world,
      c.add,
    );
    expect(c.get("drop", "rare", "item")).toBe(1);
    expect(c.get("level", "10-19", "classic.warrior")).toBe(1);
    expect(c.get("boss.spawned", "classic.boss_a", "5")).toBe(1);
    expect(c.get("boss.killed", "classic.boss_a", "21+")).toBe(1);
    expect(c.get("achievement", "ach.first")).toBe(1);
    expect(c.get("talent", "talent.bash")).toBe(1);
    expect(c.get("gem", "socketed")).toBe(1);
    expect(c.get("gem", "combined")).toBe(1);
  });

  it("rift completed and failed use the level band of the record", () => {
    const { sim } = townSim();
    const record = {
      level: 12,
      ticks: 1,
      score: 1,
      deaths: 0,
      completed: true,
      reason: "",
      heroLevel: 1,
      classId: "classic.warrior",
      heroName: "x",
      worldSeed: 1,
      endTick: 1,
      run: 1,
    };
    const c = collector();
    classicAnalytics.fold(
      [
        ev("classic.rift.completed", { record, gold: 0, items: 0 }),
        ev("classic.rift.failed", { record: { ...record, completed: false, reason: "death" } }),
      ],
      sim.world,
      c.add,
    );
    expect(c.get("rift", "completed", "10-19")).toBe(1);
    expect(c.get("rift", "failed", "10-19")).toBe(1);
  });
});

describe("offline", () => {
  it("returns the offline summary of a grant, or null when it granted nothing", () => {
    const summary = ev("classic.offline.summary", {
      ms: 3_600_000,
      depth: 2,
      kills: 40,
      xp: 300,
      gold: 90,
      items: 2,
      levels: 1,
    });
    expect(
      classicAnalytics.offline!(
        [ev("classic.xp", { amount: 1 }), summary],
        createSim(loaded, { seed: 1 }).world,
      ),
    ).toEqual({
      kills: 40,
      xp: 300,
      gold: 90,
      items: 2,
      levels: 1,
    });

    const world = createSim(loaded, { seed: 1 }).world;
    expect(classicAnalytics.offline!([], world)).toBeNull();
    expect(
      classicAnalytics.offline!(
        [
          ev("classic.offline.summary", {
            ms: 0,
            depth: 0,
            kills: 0,
            xp: 0,
            gold: 0,
            items: 0,
            levels: 0,
          }),
        ],
        world,
      ),
    ).toBeNull();
  });
});

describe("pure", () => {
  it("never changes the world: the hash is the same before and after a fold", () => {
    const { sim } = townSim();
    const before = sim.hash();
    classicAnalytics.fold(
      [ev("classic.death", { isHero: false, monster: "classic.mob_x", rarity: "normal" })],
      sim.world,
      collector().add,
    );
    classicAnalytics.dims(sim.world);
    expect(sim.hash()).toBe(before);
  });
});
