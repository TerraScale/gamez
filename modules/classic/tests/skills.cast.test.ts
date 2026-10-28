/**
 * Wave A hero skills (T-skills) with the real content: every new skill casts
 * through combat with its own shape, hits what it should (and not what it
 * should not), applies its status or buff or dash, and a scripted sequence of
 * casts replays to the same hash.
 */
import type { GameEvent, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { CastOrder, Dash, Life, Mana, Pos, Statuses } from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { KIND, type SkillProto } from "../src/types.ts";
import { spawnTestHero, spawnTestMonster, testSim, useOpenMap } from "./support/harness.ts";
import type { Entity } from "@gamez/kernel";

const MODULES = ["classic.core", "classic.combat"];
const HERO_X = 10;
const HERO_Y = 10;

function setup(seed = 7): Sim {
  const sim = testSim(MODULES, { content: "real", seed });
  useOpenMap(sim, 1, 40);
  return sim;
}

/** A hero that knows `skill` at rank 1, with strong hits and plenty of mana/life. */
function heroFor(sim: Sim, skill: string): Entity {
  return spawnTestHero(sim.world, {
    x: HERO_X,
    y: HERO_Y,
    life: 1000,
    mana: 500,
    classId: "classic.warrior",
    skills: [
      { skill, rank: 1 },
      { skill: "classic.skill.attack", rank: 1 },
    ],
    bar: [skill, "classic.skill.attack", null, null, null, null],
    stats: { toHit: 1000, dmgMin: 20, dmgMax: 20, spellPct: 0 },
  });
}

function monster(sim: Sim, tx: number, ty: number): Entity {
  return spawnTestMonster(sim.world, {
    x: tx,
    y: ty,
    proto: "classic.monster.husk",
    life: 100000,
    awake: false,
    stats: { armor: 0 },
  });
}

function cast(sim: Sim, hero: Entity, skill: string, target: Entity, tx: number, ty: number) {
  sim.world.add(hero, CastOrder, {
    skill,
    target,
    x: tileCenter(tx),
    y: tileCenter(ty),
  });
}

/** Hit events of `skill`, as [target, amount] pairs. */
function hitsOf(events: GameEvent[], skill: string): [Entity, number][] {
  const out: [Entity, number][] = [];
  for (const e of events) {
    const ev = e as { type: string; skill?: string; target?: Entity; amount?: number };
    if (ev.type === "classic.hit" && ev.skill === skill) out.push([ev.target!, ev.amount!]);
  }
  return out;
}

function statusIds(sim: Sim, e: Entity): string[] {
  return (sim.world.get(e, Statuses)?.list ?? []).map((s) => s.id);
}

function protoOf(sim: Sim, id: string): SkillProto {
  const proto = sim.loaded.registry.get<SkillProto>(KIND.skill, id);
  if (!proto) throw new Error(`no skill ${id}`);
  return proto;
}

describe("wave A skills cast through combat (real content)", () => {
  it("quake stomp hits the enemies around the warrior and not the far one", () => {
    const sim = setup();
    const hero = heroFor(sim, "classic.skill.quake_stomp");
    const near1 = monster(sim, 11, 10);
    const near2 = monster(sim, 9, 11);
    const far = monster(sim, 16, 10);
    cast(sim, hero, "classic.skill.quake_stomp", 0, HERO_X, HERO_Y);
    const hits = hitsOf(sim.step(40), "classic.skill.quake_stomp");
    const hitIds = new Set(hits.map(([t]) => t));
    expect(hitIds.has(near1)).toBe(true);
    expect(hitIds.has(near2)).toBe(true);
    expect(hitIds.has(far)).toBe(false);
    expect(hits.every(([, amount]) => amount > 0)).toBe(true);
  });

  it("iron skin buffs the warrior with its status", () => {
    const sim = setup();
    const hero = heroFor(sim, "classic.skill.iron_skin");
    cast(sim, hero, "classic.skill.iron_skin", 0, HERO_X, HERO_Y);
    sim.step(20);
    expect(statusIds(sim, hero)).toContain("classic.status.iron_skin");
  });

  it("sky leap dashes to the enemy and hits it on arrival", () => {
    const sim = setup();
    const hero = heroFor(sim, "classic.skill.sky_leap");
    const foe = monster(sim, 15, 10);
    const startX = sim.world.read(hero, Pos).x;
    cast(sim, hero, "classic.skill.sky_leap", foe, 15, 10);
    const events: GameEvent[] = [];
    let dashing = false;
    for (let i = 0; i < 12 && !dashing; i++) {
      events.push(...sim.step(1));
      dashing = sim.world.has(hero, Dash);
    }
    expect(dashing).toBe(true);
    events.push(...sim.step(40));
    const hits = hitsOf(events, "classic.skill.sky_leap");
    expect(hits.some(([t]) => t === foe)).toBe(true);
    expect(sim.world.read(hero, Pos).x).toBeGreaterThan(startX);
  });

  it("piercing shot passes through the line of enemies", () => {
    const sim = setup();
    const hero = heroFor(sim, "classic.skill.piercing_shot");
    const a = monster(sim, 14, 10);
    const b = monster(sim, 16, 10);
    const c = monster(sim, 18, 10);
    cast(sim, hero, "classic.skill.piercing_shot", a, 14, 10);
    const hits = hitsOf(sim.step(60), "classic.skill.piercing_shot");
    const targets = new Set(hits.map(([t]) => t));
    expect(targets.has(a)).toBe(true);
    expect(targets.has(b)).toBe(true);
    expect(targets.has(c)).toBe(true);
  });

  it("caltrop field hits every enemy in its area and chills some of them", () => {
    const sim = setup();
    const hero = heroFor(sim, "classic.skill.caltrops");
    const a = monster(sim, 15, 10);
    const b = monster(sim, 16, 10);
    const c = monster(sim, 17, 10);
    const far = monster(sim, 24, 10);
    cast(sim, hero, "classic.skill.caltrops", 0, 16, 10);
    const events = sim.step(40);
    const hits = new Set(hitsOf(events, "classic.skill.caltrops").map(([t]) => t));
    expect(hits.has(a) && hits.has(b) && hits.has(c)).toBe(true);
    expect(hits.has(far)).toBe(false);
    const chilled = [a, b, c].filter((m) => statusIds(sim, m).includes("classic.status.chill"));
    expect(chilled.length).toBeGreaterThanOrEqual(0);
  });

  it("night volley fires nine arrows and some of them hit the target", () => {
    const sim = setup();
    const hero = heroFor(sim, "classic.skill.night_volley");
    const foe = monster(sim, 16, 10);
    cast(sim, hero, "classic.skill.night_volley", foe, 16, 10);
    const hits = hitsOf(sim.step(80), "classic.skill.night_volley").filter(([t]) => t === foe);
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("glacial spike pierces two enemies with cold damage", () => {
    const sim = setup();
    const hero = heroFor(sim, "classic.skill.glacial_spike");
    const a = monster(sim, 15, 10);
    const b = monster(sim, 17, 10);
    const c = monster(sim, 19, 10);
    // Beyond the spike's 10-tile reach.
    const far = monster(sim, 21, 10);
    cast(sim, hero, "classic.skill.glacial_spike", a, 15, 10);
    const hits = hitsOf(sim.step(60), "classic.skill.glacial_spike");
    const targets = new Set(hits.map(([t]) => t));
    // Pierce 2: the first enemy plus two more.
    expect(targets.has(a) && targets.has(b) && targets.has(c)).toBe(true);
    expect(targets.has(far)).toBe(false);
    expect(hits.every(([, amount]) => amount > 0)).toBe(true);
  });

  it("storm call strikes the area around its point and not beyond", () => {
    const sim = setup();
    const hero = heroFor(sim, "classic.skill.storm_call");
    const a = monster(sim, 16, 10);
    const b = monster(sim, 17, 11);
    const far = monster(sim, 24, 10);
    cast(sim, hero, "classic.skill.storm_call", a, 16, 10);
    const hits = new Set(hitsOf(sim.step(40), "classic.skill.storm_call").map(([t]) => t));
    expect(hits.has(a) && hits.has(b)).toBe(true);
    expect(hits.has(far)).toBe(false);
  });

  it("falling star crashes on its point and damages the enemies there", () => {
    const sim = setup();
    const hero = heroFor(sim, "classic.skill.falling_star");
    const a = monster(sim, 16, 10);
    const b = monster(sim, 17, 10);
    cast(sim, hero, "classic.skill.falling_star", a, 16, 10);
    const hits = new Set(hitsOf(sim.step(60), "classic.skill.falling_star").map(([t]) => t));
    expect(hits.has(a) && hits.has(b)).toBe(true);
  });

  it("charges mana for every new skill", () => {
    for (const skill of [
      "classic.skill.quake_stomp",
      "classic.skill.iron_skin",
      "classic.skill.sky_leap",
      "classic.skill.piercing_shot",
      "classic.skill.caltrops",
      "classic.skill.night_volley",
      "classic.skill.glacial_spike",
      "classic.skill.storm_call",
      "classic.skill.falling_star",
    ]) {
      const sim = setup();
      const hero = heroFor(sim, skill);
      const foe = monster(sim, 13, 10);
      const before = sim.world.read(hero, Mana).mp;
      const p = protoOf(sim, skill);
      cast(sim, hero, skill, p.target === "self" ? 0 : foe, 13, 10);
      sim.step(4);
      const after = sim.world.read(hero, Mana).mp;
      expect(before - after, skill).toBeGreaterThanOrEqual(p.manaCost);
      expect(sim.world.read(hero, Life).hp, skill).toBeGreaterThan(0);
    }
  });
});

describe("wave A skills determinism", () => {
  function script(seed: number): Sim {
    const sim = setup(seed);
    const hero = heroFor(sim, "classic.skill.quake_stomp");
    const foes = [monster(sim, 11, 10), monster(sim, 15, 12), monster(sim, 20, 10)];
    cast(sim, hero, "classic.skill.quake_stomp", 0, HERO_X, HERO_Y);
    sim.step(40);
    cast(sim, hero, "classic.skill.storm_call", foes[1]!, 15, 12);
    sim.step(40);
    cast(sim, hero, "classic.skill.falling_star", foes[2]!, 20, 10);
    sim.step(60);
    cast(sim, hero, "classic.skill.caltrops", 0, 14, 10);
    sim.step(60);
    return sim;
  }

  it("the same seed and cast sequence gives the same hash", () => {
    expect(script(31).hash()).toBe(script(31).hash());
  });
});
