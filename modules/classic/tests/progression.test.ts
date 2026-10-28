/**
 * classic.progression behaviour: hero creation, XP and level ups, regen,
 * death and respawn, allocation and skills, quests, the command path,
 * determinism with a pinned hash, and action rejections.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type GameEvent,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf, pushCommand, type DeathRecord } from "../src/bus.ts";
import {
  Attributes,
  CombatStats,
  Dead,
  Equipment,
  Hero,
  HeroStats,
  Intent,
  Level,
  Life,
  Mana,
  Monster,
  Mover,
  Npc,
  Pos,
  SkillBar,
  SkillBook,
  Statuses,
  Wallet,
  AreaTag,
} from "../src/components.ts";
import { modules as classicModules } from "../src/index.ts";
import { tileCenter } from "../src/fixed.ts";
import { gameOf, heroOf, questsOf, RES, runStatsOf } from "../src/resources.ts";
import { type ClassProto, KIND, type QuestProto } from "../src/types.ts";
import { TEST_SKILLS, testContent, TEST_BALANCE, TEST_CLASS } from "./support/content.ts";
import {
  ensureResources,
  spawnTestHero,
  spawnTestMonster,
  testSim,
  useOpenMap,
} from "./support/harness.ts";

const CLASS = "test.class.fighter";

/** A fresh sim in the "choose" phase, on an open town map. */
function freshSim(seed = 1): Sim {
  const sim = testSim(["classic.core", "classic.progression"], { seed });
  useOpenMap(sim, 0);
  return sim;
}

/** A fresh sim with a spawned hero in town. */
function heroSim(over: Parameters<typeof spawnTestHero>[1] = {}): { sim: Sim; hero: number } {
  const sim = freshSim();
  const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0, ...over });
  return { sim, hero };
}

function deathOf(over: Partial<DeathRecord> = {}): DeathRecord {
  return {
    entity: 0,
    killer: 0,
    creditTeam: "hero",
    team: "monster",
    isHero: false,
    x: 0,
    y: 0,
    depth: 1,
    monster: "test.monster.dummy",
    rarity: "normal",
    level: 1,
    xp: 100,
    pack: 0,
    ...over,
  };
}

function pushDeath(sim: Sim, over: Partial<DeathRecord> = {}): void {
  busOf(sim.world).deaths.push(deathOf(over));
}

function eventsOf<T = GameEvent>(events: GameEvent[], type: string): T[] {
  return events.filter((e) => e.type === type) as unknown as T[];
}

/** Asserts that the action is rejected with `code`, leaving the hash unchanged. */
function rejects(sim: Sim, name: string, payload: unknown, code: string): void {
  const before = sim.hash();
  const res = sim.dispatch(name, payload, "tester");
  expect(res.ok).toBe(false);
  expect(res.error?.code).toBe(code);
  expect(res.events).toEqual([]);
  expect(sim.hash()).toBe(before);
}

describe("classic.newHero", () => {
  it("creates the hero, enters play and queues the transition to town", () => {
    const sim = freshSim();
    const res = sim.dispatch("classic.newHero", { classId: CLASS, name: "  Grim_Fang 2 " }, "p1");
    expect(res.ok).toBe(true);
    const g = gameOf(sim.world);
    expect(g.phase).toBe("play");
    const hero = g.hero;
    expect(hero).toBeGreaterThan(0);
    expect(sim.world.read(hero, Hero)).toEqual({
      classId: CLASS,
      name: "Grim_Fang 2",
      createdTick: 0,
    });
    expect(sim.world.read(hero, Level)).toEqual({ level: 1, xp: 0, statPoints: 0, skillPoints: 0 });
    expect(sim.world.read(hero, Attributes)).toEqual(TEST_CLASS.base);
    expect(sim.world.read(hero, SkillBook).ranks).toEqual([
      { skill: "test.skill.bolt", rank: 1 },
      { skill: "test.skill.strike", rank: 1 },
    ]);
    expect(sim.world.read(hero, SkillBar).slots).toEqual(TEST_CLASS.defaultBar);
    expect(sim.world.read(hero, Life)).toEqual({ hp: 80, max: 80, acc: 0 });
    expect(sim.world.read(hero, Mana)).toEqual({ mp: 30, max: 30, acc: 0 });
    expect(sim.world.read(hero, HeroStats).lifeMax).toBe(80);
    expect(sim.world.read(hero, Mover).speed).toBe(TEST_CLASS.moveSpeed);
    expect(sim.world.read(hero, Statuses).list).toEqual([]);
    expect(sim.world.read(hero, Intent).kind).toBe("idle");
    expect(busOf(sim.world).transitions).toEqual([{ to: 0, via: "new" }]);
    expect(eventsOf(res.events, "classic.hero.created")).toEqual([
      { type: "classic.hero.created", hero, classId: CLASS, name: "Grim_Fang 2" },
    ]);
  });

  it("rejects a second hero", () => {
    const sim = freshSim();
    sim.dispatch("classic.newHero", { classId: CLASS, name: "Ada" }, "p1");
    rejects(sim, "classic.newHero", { classId: CLASS, name: "Bob" }, "hero_exists");
  });

  it("rejects bad names, unknown classes and malformed payloads", () => {
    const bad: [unknown, string][] = [
      [{ classId: CLASS, name: "" }, "bad_payload"],
      [{ classId: CLASS, name: "    " }, "bad_payload"],
      [{ classId: CLASS, name: "x".repeat(17) }, "bad_payload"],
      [{ classId: CLASS, name: "bad!name" }, "bad_payload"],
      [{ classId: CLASS, name: "tab\tname" }, "bad_payload"],
      [{ classId: CLASS, name: 42 }, "bad_payload"],
      [{ classId: "test.class.ghost", name: "Ada" }, "unknown_id"],
      [{ classId: CLASS, name: "Ada", extra: 1 }, "bad_payload"],
      [null, "bad_payload"],
      ["Ada", "bad_payload"],
    ];
    for (const [payload, code] of bad) {
      const sim = freshSim();
      rejects(sim, "classic.newHero", payload, code);
      expect(gameOf(sim.world).phase).toBe("choose");
    }
  });

  it("accepts a 16-character name and unicode letters", () => {
    const a = freshSim();
    expect(
      a.dispatch("classic.newHero", { classId: CLASS, name: "abcdefghijklmnop" }, null).ok,
    ).toBe(true);
    const b = freshSim();
    expect(b.dispatch("classic.newHero", { classId: CLASS, name: "Ärger Döm" }, null).ok).toBe(
      true,
    );
  });
});

describe("experience and levels", () => {
  it("grants XP from a credited kill and levels up along the curve", () => {
    const { sim, hero } = heroSim();
    pushDeath(sim, { xp: 100 });
    const events = sim.step(1);
    const level = sim.world.read(hero, Level);
    expect(level.xp).toBe(100);
    expect(level.level).toBe(2);
    expect(level.statPoints).toBe(TEST_BALANCE.statPointsPerLevel);
    expect(level.skillPoints).toBe(TEST_BALANCE.skillPointsPerLevel);
    expect(eventsOf(events, "classic.xp")).toEqual([
      { type: "classic.xp", amount: 100, total: 100, reason: "kill" },
    ]);
    expect(eventsOf(events, "classic.levelUp")).toEqual([
      {
        type: "classic.levelUp",
        level: 2,
        statPoints: TEST_BALANCE.statPointsPerLevel,
        skillPoints: TEST_BALANCE.skillPointsPerLevel,
      },
    ]);
    expect(runStatsOf(sim.world).kills).toBe(1);
  });

  it("applies the level-difference penalty to XP", () => {
    const { sim, hero } = heroSim({ level: 20 });
    pushDeath(sim, { level: 10, xp: 100 });
    const events = sim.step(1);
    // diff = 20 - 10 - 5 = 5 -> keep max(5, 100 - 5*15) = 25
    expect(sim.world.read(hero, Level).xp).toBe(25);
    expect(eventsOf(events, "classic.xp")[0]?.amount).toBe(25);
  });

  it("grants no XP for uncredited or summon deaths", () => {
    const { sim, hero } = heroSim();
    pushDeath(sim, { creditTeam: "monster", xp: 100 });
    pushDeath(sim, { rarity: "summon", xp: 100 });
    pushDeath(sim, { isHero: true, xp: 100 });
    sim.step(1);
    expect(sim.world.read(hero, Level).xp).toBe(0);
    expect(runStatsOf(sim.world).kills).toBe(0);
  });

  it("levels up several times in one kill and heals to full", () => {
    const { sim, hero } = heroSim();
    sim.world.update(hero, Life, { hp: 5 });
    pushDeath(sim, { xp: 500 });
    const events = sim.step(1);
    const level = sim.world.read(hero, Level);
    expect(level.level).toBe(3); // 400 <= 500 < 1000
    expect(level.statPoints).toBe(2 * TEST_BALANCE.statPointsPerLevel);
    expect(level.skillPoints).toBe(2 * TEST_BALANCE.skillPointsPerLevel);
    expect(eventsOf(events, "classic.levelUp").map((e) => e.level)).toEqual([2, 3]);
    const life = sim.world.read(hero, Life);
    expect(life.max).toBe(40 + 20 * 2 + 2 * 2); // vit 20, level 3
    expect(life.hp).toBe(life.max);
  });

  it("counts champion, unique and boss kills", () => {
    const { sim } = heroSim();
    pushDeath(sim, { rarity: "champion" });
    pushDeath(sim, { rarity: "unique" });
    pushDeath(sim, { rarity: "boss" });
    pushDeath(sim, { rarity: "minion" });
    sim.step(1);
    const s = runStatsOf(sim.world);
    expect(s.kills).toBe(4);
    expect(s.championKills).toBe(1);
    expect(s.uniqueKills).toBe(1);
    expect(s.bossKills).toBe(1);
  });

  it("restores life and mana on kill from HeroStats", () => {
    const { sim, hero } = heroSim();
    sim.world.add(hero, Equipment, {
      weapon: null,
      offhand: null,
      helm: {
        uid: 9,
        base: "test.item.cap",
        rarity: "magic",
        ilvl: 1,
        name: "Cap of Leech",
        mods: [{ stat: "lifeOnKill", value: 5 }],
        affixes: [],
        value: 10,
      },
      armor: null,
      gloves: null,
      boots: null,
      amulet: null,
      ring1: null,
      ring2: null,
    });
    sim.step(1);
    expect(sim.world.read(hero, HeroStats).lifeOnKill).toBe(5);
    sim.world.update(hero, Life, { hp: 10 });
    pushDeath(sim, { xp: 10 });
    sim.step(1);
    expect(sim.world.read(hero, Life).hp).toBe(15);
  });
});

describe("regeneration", () => {
  it("accumulates life and mana regen in thousandths of a point", () => {
    const { sim, hero } = heroSim();
    sim.step(1);
    const sheet = sim.world.read(hero, HeroStats);
    sim.world.update(hero, Life, { hp: 1, acc: 0 });
    sim.world.update(hero, Mana, { mp: 1, acc: 0 });
    sim.step(100);
    const lifeTotal = 100 * sheet.lifeRegen * 5;
    const manaTotal = 100 * sheet.manaRegen * 5;
    expect(sim.world.read(hero, Life).hp).toBe(1 + Math.floor(lifeTotal / 1000));
    expect(sim.world.read(hero, Life).acc).toBe(lifeTotal % 1000);
    expect(sim.world.read(hero, Mana).mp).toBe(1 + Math.floor(manaTotal / 1000));
    expect(sim.world.read(hero, Mana).acc).toBe(manaTotal % 1000);
  });

  it("does not regenerate while dead and resets the accumulator at max", () => {
    const { sim, hero } = heroSim();
    sim.step(1);
    sim.world.update(hero, Life, { hp: 80, acc: 500 });
    sim.step(1);
    expect(sim.world.read(hero, Life).acc).toBe(0);

    sim.world.update(hero, Life, { hp: 1, acc: 0 });
    sim.world.add(hero, Dead, { at: 100000, killer: 0 });
    sim.step(50);
    expect(sim.world.read(hero, Life).hp).toBe(1);
  });
});

describe("death and respawn", () => {
  it("applies the death penalty once, on the tick of death", () => {
    const { sim, hero } = heroSim({ gold: 1000 });
    sim.world.update(hero, Level, { level: 2, xp: 150 });
    sim.world.update(hero, Intent, { kind: "move", source: "manual", at: 0, x: 1, y: 1 });
    const killer = spawnTestMonster(sim.world, { x: 6, y: 5 });
    sim.world.add(hero, Dead, { at: sim.tick, killer });
    const events = sim.step(1);
    // 10% of 1000 gold; 5% of the 50 XP earned in level 2 (2 points, floored).
    expect(eventsOf(events, "classic.hero.died")).toEqual([
      { type: "classic.hero.died", goldLost: 100, xpLost: 2, killer: "Dummy" },
    ]);
    expect(sim.world.read(hero, Wallet).gold).toBe(900);
    expect(sim.world.read(hero, Level).xp).toBe(148);
    expect(sim.world.read(hero, Intent).kind).toBe("idle");
    expect(runStatsOf(sim.world).deaths).toBe(1);

    const again = sim.step(1);
    expect(eventsOf(again, "classic.hero.died")).toEqual([]);
    expect(sim.world.read(hero, Wallet).gold).toBe(900);
    expect(runStatsOf(sim.world).deaths).toBe(1);
  });

  it("never takes XP below the level start", () => {
    const { sim, hero } = heroSim();
    sim.world.update(hero, Level, { level: 2, xp: 100 });
    sim.world.add(hero, Dead, { at: sim.tick, killer: 0 });
    const events = sim.step(1);
    expect(sim.world.read(hero, Level).xp).toBe(100);
    expect(eventsOf(events, "classic.hero.died")[0]?.xpLost).toBe(0);
  });

  it("respawns only after the delay, with a transition to town", () => {
    const { sim, hero } = heroSim();
    sim.step(1);
    sim.world.update(hero, Life, { hp: 1 });
    sim.world.update(hero, Statuses, {
      list: [
        { id: "test.status.chill", until: 100000, power: 40, source: 0, nextAt: 0, remaining: 0 },
      ],
    });
    sim.world.add(hero, Dead, { at: sim.tick, killer: 0 });
    rejects(sim, "classic.respawn", {}, "cooldown");
    sim.step(TEST_BALANCE.respawnDelay - 1);
    rejects(sim, "classic.respawn", {}, "cooldown");
    sim.step(1);
    const res = sim.dispatch("classic.respawn", {}, "p1");
    expect(res.ok).toBe(true);
    expect(sim.world.has(hero, Dead)).toBe(false);
    expect(sim.world.read(hero, Life).hp).toBe(sim.world.read(hero, Life).max);
    expect(sim.world.read(hero, Mana).mp).toBe(sim.world.read(hero, Mana).max);
    expect(sim.world.read(hero, Statuses).list).toEqual([]);
    expect(busOf(sim.world).transitions).toEqual([{ to: 0, via: "respawn" }]);
    expect(res.events.map((e) => e.type)).toContain("classic.hero.respawned");
  });

  it("rejects respawn when alive and other actions while dead", () => {
    const { sim, hero } = heroSim();
    rejects(sim, "classic.respawn", {}, "not_dead");
    sim.world.add(hero, Dead, { at: 0, killer: 0 });
    rejects(sim, "classic.allocateStat", { attr: "str", points: 1 }, "dead");
    rejects(sim, "classic.learnSkill", { skill: "test.skill.nova" }, "dead");
  });
});

describe("attributes and skills", () => {
  it("allocates stat points and validates them", () => {
    const { sim, hero } = heroSim();
    rejects(sim, "classic.allocateStat", { attr: "str", points: 1 }, "no_points");
    sim.world.update(hero, Level, { statPoints: 5 });
    rejects(sim, "classic.allocateStat", { attr: "luck", points: 1 }, "bad_payload");
    rejects(sim, "classic.allocateStat", { attr: "str", points: 0 }, "bad_payload");
    rejects(sim, "classic.allocateStat", { attr: "str", points: 6 }, "no_points");
    const res = sim.dispatch("classic.allocateStat", { attr: "dex", points: 3 }, "p1");
    expect(res.ok).toBe(true);
    expect(sim.world.read(hero, Attributes).dex).toBe(23);
    expect(sim.world.read(hero, Level).statPoints).toBe(2);
    expect(res.events.map((e) => e.type)).toContain("classic.statAllocated");
    sim.step(1);
    expect(sim.world.read(hero, HeroStats).attrs.dex).toBe(23);
  });

  it("learns skills within the class, with skill points, and fills an empty bar slot", () => {
    const { sim, hero } = heroSim();
    rejects(sim, "classic.learnSkill", { skill: "test.skill.nova" }, "no_points");
    sim.world.update(hero, Level, { skillPoints: 2 });
    rejects(sim, "classic.learnSkill", { skill: "test.mskill.bite" }, "not_known");
    rejects(sim, "classic.learnSkill", { skill: "test.skill.ghost" }, "unknown_id");

    const first = sim.dispatch("classic.learnSkill", { skill: "test.skill.nova" }, "p1");
    expect(first.ok).toBe(true);
    expect(sim.world.read(hero, SkillBook).ranks).toEqual([
      { skill: "test.skill.bolt", rank: 1 },
      { skill: "test.skill.nova", rank: 1 },
      { skill: "test.skill.strike", rank: 1 },
    ]);
    expect(sim.world.read(hero, SkillBar).slots).toEqual([
      "test.skill.strike",
      "test.skill.bolt",
      "test.skill.nova",
      null,
      null,
      null,
    ]);
    expect(sim.world.read(hero, Level).skillPoints).toBe(1);

    const second = sim.dispatch("classic.learnSkill", { skill: "test.skill.nova" }, "p1");
    expect(second.ok).toBe(true);
    expect(
      sim.world.read(hero, SkillBook).ranks.find((r) => r.skill === "test.skill.nova")?.rank,
    ).toBe(2);
    expect(
      sim.world.read(hero, SkillBar).slots.filter((s) => s === "test.skill.nova"),
    ).toHaveLength(1);
  });

  it("sets bar slots only to learned skills (or null)", () => {
    const { sim, hero } = heroSim();
    rejects(sim, "classic.setSkillBar", { slot: 6, skill: null }, "bad_payload");
    rejects(sim, "classic.setSkillBar", { slot: -1, skill: null }, "bad_payload");
    rejects(sim, "classic.setSkillBar", { slot: 1.5, skill: null }, "bad_payload");
    rejects(sim, "classic.setSkillBar", { slot: 0, skill: "test.skill.ghost" }, "unknown_id");
    rejects(sim, "classic.setSkillBar", { slot: 0, skill: "test.skill.nova" }, "not_known");

    expect(sim.dispatch("classic.setSkillBar", { slot: 0, skill: null }, "p1").ok).toBe(true);
    expect(sim.world.read(hero, SkillBar).slots[0]).toBe(null);
    expect(
      sim.dispatch("classic.setSkillBar", { slot: 3, skill: "test.skill.bolt" }, "p1").ok,
    ).toBe(true);
    expect(sim.world.read(hero, SkillBar).slots[3]).toBe("test.skill.bolt");
  });

  it("rejects unknown fields in allocation and learn payloads", () => {
    const { sim } = heroSim();
    rejects(sim, "classic.learnSkill", { skill: "test.skill.bolt", x: 1 }, "bad_payload");
    rejects(sim, "classic.allocateStat", "str", "bad_payload");
  });
});

describe("quests", () => {
  /**
   * Test content plus two quests (a reward item quest and a chained one) and
   * a gated skill (reqLevel 5, maxRank 1) added to the fighter's skill list.
   */
  const questModule = defineModule({
    id: "test.progression.quests",
    version: "0.0.1",
    deps: ["test.content"],
    dataUpdates(reg) {
      reg.patch<ClassProto>(KIND.class, CLASS, (c) => {
        c.skills = [...c.skills, "test.skill.capped"];
      });
    },
    data(reg) {
      reg.define(KIND.skill, "test.skill.capped", {
        ...TEST_SKILLS["test.skill.strike"]!,
        name: "Capped",
        reqLevel: 5,
        maxRank: 1,
      });
      const reward: QuestProto = {
        name: "Reward",
        description: "Any kill.",
        giver: "test.npc.quest",
        kind: "killMonsters",
        target: "*",
        count: 1,
        reqLevel: 1,
        after: "",
        reward: { gold: 0, xp: 0, item: "magic" },
      };
      const chain: QuestProto = {
        ...reward,
        name: "Chain",
        kind: "killMonsters",
        target: "*",
        count: 1,
        reqLevel: 3,
        after: "test.quest.hunt",
        reward: { gold: 5, xp: 1, item: null },
      };
      reg.define(KIND.quest, "test.quest.reward", reward);
      reg.define(KIND.quest, "test.quest.chain", chain);
    },
  });

  function questSim(): Sim {
    const loaded = loadMode(
      defineMode({
        id: "classic",
        name: "Quests",
        description: "test",
        world: null,
        modules: ["classic.core", "classic.progression", "test.content", "test.progression.quests"],
        tick: { kind: "fixed", hz: 20 },
      }),
      [...classicModules, testContent, questModule],
    );
    const sim = createSim(loaded, { seed: 3 });
    ensureResources(sim.world);
    useOpenMap(sim, 0);
    return sim;
  }

  it("gates skill learning by level and max rank", () => {
    const sim = questSim();
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0 });
    sim.world.update(hero, Level, { skillPoints: 3 });
    rejects(sim, "classic.learnSkill", { skill: "test.skill.capped" }, "level_too_low");
    sim.world.update(hero, Level, { level: 5 });
    expect(sim.dispatch("classic.learnSkill", { skill: "test.skill.capped" }, "p1").ok).toBe(true);
    rejects(sim, "classic.learnSkill", { skill: "test.skill.capped" }, "max_rank");
  });

  it("accepts quests in town when the requirements hold", () => {
    const sim = questSim();
    spawnTestHero(sim.world, { x: 5, y: 5, depth: 0 });
    const res = sim.dispatch("classic.acceptQuest", { quest: "test.quest.hunt" }, "p1");
    expect(res.ok).toBe(true);
    expect(questsOf(sim.world).active).toEqual([
      { id: "test.quest.hunt", progress: 0, done: false },
    ]);
    expect(eventsOf(res.events, "classic.quest.accepted")).toEqual([
      { type: "classic.quest.accepted", quest: "test.quest.hunt" },
    ]);
    rejects(sim, "classic.acceptQuest", { quest: "test.quest.hunt" }, "quest_state");
    rejects(sim, "classic.acceptQuest", { quest: "test.quest.nope" }, "unknown_id");
    rejects(sim, "classic.acceptQuest", { quest: "test.quest.chain" }, "level_too_low");
  });

  it("requires the chain quest to be completed first and the level to be met", () => {
    const sim = questSim();
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0 });
    sim.world.update(hero, Level, { level: 3 });
    rejects(sim, "classic.acceptQuest", { quest: "test.quest.chain" }, "quest_state");
  });

  it("rejects quest actions outside town", () => {
    const sim = questSim();
    useOpenMap(sim, 1);
    spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    rejects(sim, "classic.acceptQuest", { quest: "test.quest.hunt" }, "not_in_town");
  });

  it("progresses kill quests from credited deaths and completes them for rewards", () => {
    const sim = questSim();
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0 });
    sim.dispatch("classic.acceptQuest", { quest: "test.quest.hunt" }, "p1");
    rejects(sim, "classic.completeQuest", { quest: "test.quest.hunt" }, "quest_state");

    for (let i = 0; i < 3; i++) pushDeath(sim, { monster: "test.monster.dummy", xp: 0 });
    pushDeath(sim, { monster: "test.monster.archer", xp: 0 });
    const events = sim.step(1);
    expect(questsOf(sim.world).active).toEqual([
      { id: "test.quest.hunt", progress: 3, done: true },
    ]);
    expect(eventsOf(events, "classic.quest.done")).toEqual([
      { type: "classic.quest.done", quest: "test.quest.hunt" },
    ]);

    const res = sim.dispatch("classic.completeQuest", { quest: "test.quest.hunt" }, "p1");
    expect(res.ok).toBe(true);
    expect(questsOf(sim.world)).toEqual({ active: [], completed: ["test.quest.hunt"] });
    expect(busOf(sim.world).commands).toEqual([{ op: "grantGold", amount: 100, reason: "quest" }]);
    expect(sim.world.read(hero, Level).xp).toBe(50);
    expect(eventsOf(res.events, "classic.quest.completed")).toEqual([
      { type: "classic.quest.completed", quest: "test.quest.hunt", gold: 100, xp: 50 },
    ]);
    rejects(sim, "classic.completeQuest", { quest: "test.quest.hunt" }, "quest_state");
  });

  it("queues an item grant for an item reward and no gold grant when gold is zero", () => {
    const sim = questSim();
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0 });
    sim.dispatch("classic.acceptQuest", { quest: "test.quest.reward" }, "p1");
    rejects(sim, "classic.completeQuest", { quest: "test.quest.reward" }, "quest_state");
    pushDeath(sim, { monster: "test.monster.archer", xp: 0 });
    sim.step(1);
    expect(questsOf(sim.world).active[0]?.done).toBe(true);
    const res = sim.dispatch("classic.completeQuest", { quest: "test.quest.reward" }, "p1");
    expect(res.ok).toBe(true);
    expect(busOf(sim.world).commands).toEqual([
      {
        op: "grantItems",
        count: 1,
        ilvl: sim.world.read(hero, Level).level,
        minRarity: "magic",
        toStash: false,
        reason: "quest",
      },
    ]);
  });
});

describe("command path (update 52)", () => {
  it("runs queued progression ops and reports failures", () => {
    const { sim, hero } = heroSim();
    sim.world.update(hero, Level, { statPoints: 1 });
    pushCommand(sim.world, { op: "allocate", attr: "str", points: 1 });
    pushCommand(sim.world, { op: "learn", skill: "test.skill.mend" });
    pushCommand(sim.world, { op: "respawn" });
    pushCommand(sim.world, { op: "grantXp", amount: 30, reason: "auto" });
    const events = sim.step(1);
    expect(sim.world.read(hero, Attributes).str).toBe(21);
    expect(sim.world.read(hero, Level).xp).toBe(30);
    const failed = eventsOf<{ type: string; op: string; code: string }>(
      events,
      "classic.command.failed",
    );
    expect(failed.map((e) => [e.op, e.code])).toEqual([
      ["learn", "no_points"],
      ["respawn", "not_dead"],
    ]);
  });

  it("heals at a healer in reach and rejects other NPCs", () => {
    const { sim, hero } = heroSim();
    const healer = sim.world.create();
    sim.world.add(healer, Npc, { proto: "test.npc.healer" });
    sim.world.add(healer, Pos, { x: tileCenter(5), y: tileCenter(6) });
    sim.world.add(healer, AreaTag, { depth: 0 });
    const smith = sim.world.create();
    sim.world.add(smith, Npc, { proto: "test.npc.smith" });
    sim.world.add(smith, Pos, { x: tileCenter(5), y: tileCenter(6) });
    sim.world.add(smith, AreaTag, { depth: 0 });
    sim.step(1);
    sim.world.update(hero, Life, { hp: 3 });
    pushCommand(sim.world, { op: "heal", npc: smith });
    const bad = sim.step(1);
    expect(eventsOf<{ code: string }>(bad, "classic.command.failed")[0]?.code).toBe("bad_target");
    expect(sim.world.read(hero, Life).hp).toBe(3);
    pushCommand(sim.world, { op: "heal", npc: healer });
    const ok = sim.step(1);
    expect(eventsOf(ok, "classic.heal")[0]).toMatchObject({ target: hero, amount: 77 });
    expect(sim.world.read(hero, Life).hp).toBe(sim.world.read(hero, Life).max);
  });
});

describe("determinism and pinned hash", () => {
  /** A fixed script covering creation, kills, levels, skills, a quest and death. */
  function play(seed: number): Sim {
    const sim = createSim(
      loadMode(
        defineMode({
          id: "classic",
          name: "Pinned",
          description: "test",
          world: null,
          modules: ["classic.core", "classic.progression", "test.content"],
          tick: { kind: "fixed", hz: 20 },
        }),
        [...classicModules, testContent],
      ),
      { seed },
    );
    ensureResources(sim.world);
    useOpenMap(sim, 0);
    sim.dispatch("classic.newHero", { classId: CLASS, name: "Ada" }, "p1");
    sim.step(5);
    const hero = heroOf(sim.world);
    pushDeath(sim, { xp: 500 });
    sim.step(2);
    sim.dispatch("classic.allocateStat", { attr: "vit", points: 4 }, "p1");
    sim.dispatch("classic.learnSkill", { skill: "test.skill.nova" }, "p1");
    sim.dispatch("classic.setSkillBar", { slot: 2, skill: "test.skill.nova" }, "p1");
    sim.dispatch("classic.acceptQuest", { quest: "test.quest.hunt" }, "p1");
    for (let i = 0; i < 3; i++) pushDeath(sim, { xp: 25 });
    sim.step(3);
    sim.dispatch("classic.completeQuest", { quest: "test.quest.hunt" }, "p1");
    sim.world.add(hero, Dead, { at: sim.tick, killer: 0 });
    sim.step(1);
    sim.step(60);
    sim.dispatch("classic.respawn", {}, "p1");
    sim.step(20);
    return sim;
  }

  it("gives the same hash for the same seed and script", () => {
    expect(play(7).hash()).toBe(play(7).hash());
  });

  it("pins the hash after the fixed script", () => {
    const sim = play(7);
    // The script must do what it says before its hash means anything.
    const hero = heroOf(sim.world);
    expect(sim.world.read(hero, Level).level).toBe(3);
    expect(questsOf(sim.world).completed).toEqual(["test.quest.hunt"]);
    expect(runStatsOf(sim.world)).toMatchObject({ kills: 4, deaths: 1 });
    expect(sim.world.has(hero, Dead)).toBe(false);
    expect(sim.hash()).toBe("d5dc2da21fc54e6c");
  });
});

describe("hero stats effects", () => {
  it("clamps Life and Mana to the maxima and keeps max in sync", () => {
    const { sim, hero } = heroSim({ life: 500, mana: 500 });
    sim.step(1);
    expect(sim.world.read(hero, Life).max).toBe(80);
    expect(sim.world.read(hero, Life).hp).toBe(80);
    expect(sim.world.read(hero, Mana).max).toBe(30);
    expect(sim.world.read(hero, Mana).mp).toBe(30);
    expect(sim.world.read(hero, CombatStats).level).toBe(1);
    expect(sim.world.read(hero, Mover).speed).toBe(51);
  });

  it("finds the hero through GameState and the hero resource", () => {
    const { sim, hero } = heroSim();
    expect(heroOf(sim.world)).toBe(hero);
    expect(sim.world.getResource(RES.quests)).toEqual({ active: [], completed: [] });
    expect(sim.world.has(hero, Monster)).toBe(false);
    expect(sim.world.has(hero, Pos)).toBe(true);
  });
});
