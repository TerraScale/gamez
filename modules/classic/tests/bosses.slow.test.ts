/**
 * Wave A boss encounters (T-bosses, docs/design/wave-A.md §6): telegraphs
 * (placement, event fields, fire timing, dodging, cone/line geometry,
 * count > 1, dead casters, area teardown), skill modifiers on hero casts
 * (every SkillModField), boss phases (order, skipping, once each, summons,
 * enrage on monster damage and attack speed), a scripted fight against a
 * phased test boss, the real boss/guardian content, and determinism.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type Entity,
  type GameEvent,
  type LoadedMode,
  type Sim,
  type World,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { setBonusSource } from "../src/bonus.ts";
import { pushSpawn, pushTransition } from "../src/bus.ts";
import {
  Ai,
  AreaTag,
  Attributes,
  CastOrder,
  Casting,
  Dash,
  Dead,
  Equipment,
  Faction,
  GroundEffect,
  Intent,
  Life,
  Mana,
  Monster,
  Mover,
  Pos,
  Projectile,
  SkillBook,
  Statuses,
  Summoned,
} from "../src/components.ts";
import { angleDiff, angleOf, angleVec, tileCenter, tiles } from "../src/fixed.ts";
import { modules as classicModules } from "../src/index.ts";
import { RES, type AreaState } from "../src/resources.ts";
import { monsterLevel } from "../src/rules.ts";
import { gridOf } from "../src/spatial.ts";
import {
  KIND,
  type EquipSlot,
  type ItemBaseProto,
  type MonsterModProto,
  type MonsterProto,
  type SkillModifier,
  type SkillProto,
  type StatMod,
  type StatusProto,
} from "../src/types.ts";
import { nearSegment, TELEGRAPH_SCATTER } from "../src/combat/telegraphs.ts";
import { ENRAGE_STATUS } from "../src/content/boss.ts";
import { getAreaMap, walkableAt } from "../src/world/maps.ts";
import { rotationSkills } from "../src/monsters/boss.ts";
import { testContent } from "./support/content.ts";
import {
  emptyEquipment,
  ensureResources,
  spawnTestHero,
  spawnTestMonster,
  testLoaded,
  useOpenMap,
  type TestHeroOptions,
  type TestMonsterOptions,
} from "./support/harness.ts";
const sk = (
  p: Partial<SkillProto> & Pick<SkillProto, "name" | "shape" | "target">,
): SkillProto => ({
  description: p.name,
  icon: "icon.skill.test",
  users: "monster",
  reqLevel: 1,
  maxRank: 20,
  range: 0,
  manaCost: 0,
  manaPerRank: 0,
  cooldown: 0,
  castTicks: 10,
  hitTick: 5,
  speedStat: "attack",
  weaponPct: 0,
  weaponPctPerRank: 0,
  damage: null,
  scaling: null,
  canMiss: false,
  effect: "fx.test",
  ai: { tags: ["aoe"], priority: 5 },
  ...p,
});

const flat = (element: "fire" | "cold" | "lightning" | "poison" | "phys", n: number) => ({
  element,
  min: n,
  max: n,
  minPerRank: 0,
  maxPerRank: 0,
});

const STUN = { id: "test.status.stun", chancePct: 100, duration: 12, power: 0, powerPerRank: 0 };

const SKILLS: Record<string, SkillProto> = {
  // ---- monster telegraphs
  "test.mskill.tquake": sk({
    name: "TQuake",
    shape: "aoeTarget",
    target: "enemy",
    range: tiles(8),
    radius: tiles(2),
    damage: flat("fire", 10),
    status: STUN,
    telegraph: { ticks: 30, shape: "circle" },
    effect: "fx.tquake",
    cooldown: 60,
    ai: { tags: ["aoe"], priority: 7 },
  }),
  "test.mskill.tmeteor": sk({
    name: "TMeteor",
    shape: "aoeTarget",
    target: "enemy",
    range: tiles(10),
    radius: tiles(1),
    damage: flat("fire", 10),
    telegraph: { ticks: 36, shape: "circle", count: 3 },
  }),
  "test.mskill.tcleave": sk({
    name: "TCleave",
    shape: "arc",
    target: "enemy",
    range: tiles(3),
    arc: 8,
    damage: flat("fire", 10),
    telegraph: { ticks: 24, shape: "cone" },
    cooldown: 50,
    ai: { tags: ["aoe", "melee"], priority: 6 },
  }),
  "test.mskill.trush": sk({
    name: "TRush",
    shape: "dash",
    target: "enemy",
    range: tiles(8),
    dash: { speed: 140, maxRange: tiles(6) },
    damage: flat("fire", 10),
    telegraph: { ticks: 20, shape: "line", width: 256 },
    cooldown: 90,
    ai: { tags: ["mobility"], priority: 5 },
  }),
  "test.mskill.tnova": sk({
    name: "TNova",
    shape: "nova",
    target: "self",
    radius: tiles(3),
    damage: flat("fire", 10),
    telegraph: { ticks: 30, shape: "circle" },
  }),
  "test.mskill.tconvert": sk({
    name: "TConvert",
    shape: "nova",
    target: "self",
    radius: tiles(3),
    weaponPct: 100,
    damage: { element: "cold", min: 0, max: 0, minPerRank: 0, maxPerRank: 0 },
  }),
  // ---- hero skills for the skill-modifier tests
  "test.bskill.zap": sk({
    name: "Zap",
    users: "hero",
    shape: "melee",
    target: "enemy",
    range: tiles(2),
    manaCost: 10,
    cooldown: 100,
    castTicks: 10,
    hitTick: 5,
    speedStat: "cast",
    damage: flat("fire", 20),
    status: { id: "test.status.chill", chancePct: 100, duration: 60, power: 30, powerPerRank: 0 },
  }),
  "test.bskill.nova": sk({
    name: "BNova",
    users: "hero",
    shape: "nova",
    target: "self",
    radius: tiles(2),
    damage: flat("fire", 10),
  }),
  "test.bskill.arc": sk({
    name: "BArc",
    users: "hero",
    shape: "arc",
    target: "enemy",
    range: tiles(2),
    arc: 10,
    damage: flat("fire", 10),
  }),
  "test.bskill.fan": sk({
    name: "Fan",
    users: "hero",
    shape: "projectile",
    target: "point",
    range: tiles(10),
    damage: flat("fire", 10),
    projectile: {
      speed: 64,
      count: 3,
      spread: 3,
      pierce: 1,
      radius: 64,
      maxRange: tiles(10),
      sprite: "fx.arrow",
    },
  }),
  "test.bskill.chain": sk({
    name: "BChain",
    users: "hero",
    shape: "chain",
    target: "enemy",
    range: tiles(9),
    damage: flat("lightning", 10),
    chain: { bounces: 1, range: tiles(4), falloffPct: 0 },
  }),
  "test.bskill.summon": sk({
    name: "BSummon",
    users: "hero",
    shape: "summon",
    target: "point",
    range: tiles(6),
    summon: { monster: "test.monster.dummy", count: 1, max: 1, duration: 100 },
  }),
  "test.bskill.rally": sk({
    name: "BRally",
    users: "hero",
    shape: "self",
    target: "self",
    radius: tiles(2),
    buff: { status: "test.status.rally", duration: 100, power: 10, powerPerRank: 0 },
  }),
};

const STATUSES: Record<string, StatusProto> = {
  // Same id as the real content (combat applies ENRAGE_STATUS by id).
  [ENRAGE_STATUS]: {
    name: "Enraged",
    kind: "buff",
    mods: [
      { stat: "dmgPct", perPower: 1 },
      { stat: "attackSpeed", perPower: 1 },
      { stat: "castSpeed", perPower: 1 },
    ],
    stacks: false,
    icon: "icon.status.enrage",
    tint: 0,
  },
};

const PHASE_BOSS: MonsterProto = {
  name: "Phase Dummy",
  family: "test",
  description: "phases",
  appearance: "unit.monster.test",
  fallbackAppearance: "unit.hero",
  tint: 0,
  scale: 150,
  behaviour: "boss",
  life: 1000,
  armor: 0,
  toHit: 40,
  dmgMin: 4,
  dmgMax: 6,
  element: "phys",
  resist: { fire: 0, cold: 0, lightning: 0, poison: 0 },
  xp: 100,
  moveSpeed: 30,
  radius: 140,
  skills: ["test.mskill.bite", "test.mskill.tquake", "test.mskill.tcleave"],
  aggroRange: tiles(12),
  keepDistance: 0,
  packSize: [1, 1],
  themes: [],
  minDepth: 4,
  weight: 1,
  boss: { depth: 4, title: "the Phased", minions: "test.monster.dummy", minionCount: 2 },
  phases: [
    { atPct: 75, message: "one", skills: [], summon: true, enragePct: 0 },
    { atPct: 50, message: "two", skills: ["test.mskill.trush"], summon: false, enragePct: 30 },
    { atPct: 25, message: "three", skills: [], summon: false, enragePct: 60 },
  ],
};

const bossExtras = defineModule({
  id: "test.bossExtras",
  version: "0.0.1",
  data(reg) {
    for (const id of Object.keys(SKILLS).sort()) reg.define(KIND.skill, id, SKILLS[id]!);
    for (const id of Object.keys(STATUSES).sort()) reg.define(KIND.status, id, STATUSES[id]!);
    reg.define(KIND.monster, "test.monster.phaseboss", PHASE_BOSS);
  },
});

const cache = new Map<string, LoadedMode>();
function loaded(withMonsters: boolean): LoadedMode {
  const key = withMonsters ? "full" : "combat";
  let l = cache.get(key);
  if (!l) {
    const mods = ["classic.core", "classic.combat", "test.content", "test.bossExtras"];
    if (withMonsters) mods.push("classic.monsters");
    l = loadMode(
      defineMode({
        id: "classic",
        name: "Classic (boss test)",
        description: "test",
        world: null,
        modules: mods,
        tick: { kind: "fixed", hz: 20 },
      }),
      [...classicModules, testContent, bossExtras],
    );
    cache.set(key, l);
  }
  return l;
}

function newSim(o: { seed?: number; monsters?: boolean } = {}): Sim {
  const sim = createSim(loaded(o.monsters ?? false), { seed: o.seed ?? 1 });
  ensureResources(sim.world);
  useOpenMap(sim, 1, 40);
  return sim;
}

const HERO_SKILLS = Object.keys(SKILLS)
  .filter((s) => s.startsWith("test.bskill."))
  .concat(["test.skill.strike"])
  .sort();

function hero(sim: Sim, o: TestHeroOptions = {}): Entity {
  return spawnTestHero(sim.world, {
    skills: HERO_SKILLS.map((skill) => ({ skill, rank: 1 })),
    mana: 200,
    life: 500,
    ...o,
    stats: { critPct: 0, ...o.stats },
  });
}

function monster(sim: Sim, o: TestMonsterOptions = {}): Entity {
  return spawnTestMonster(sim.world, {
    life: 500,
    skills: Object.keys(SKILLS).filter((s) => s.startsWith("test.mskill.")),
    ...o,
    stats: { critPct: 0, ...o.stats },
  });
}

/** A hero-team dummy (a target for monster telegraphs besides the hero). */
function ally(sim: Sim, x: number, y: number): Entity {
  const e = spawnTestMonster(sim.world, { x, y, life: 500, stats: { critPct: 0 } });
  sim.world.update(e, Faction, { team: "hero" });
  return e;
}

function order(sim: Sim, caster: Entity, skill: string, target: Entity = 0, at?: [number, number]) {
  let x = 0;
  let y = 0;
  if (at) [x, y] = at;
  else if (target !== 0) ({ x, y } = sim.world.read(target, Pos));
  else ({ x, y } = sim.world.read(caster, Pos));
  sim.world.add(caster, CastOrder, { skill, target, x, y });
}

function place(sim: Sim, e: Entity, x: number, y: number): void {
  sim.world.update(e, Pos, { x, y });
  gridOf(sim.world).move(e, x, y);
}

type Ev = GameEvent & Record<string, any>;

/** Writes measured numbers to the test output (no node typings in this package). */
function report(line: string): void {
  (globalThis as { process?: { stdout?: { write(s: string): void } } }).process?.stdout?.write(
    line,
  );
}
const of = (events: GameEvent[], type: string) => events.filter((e) => e.type === type) as Ev[];
const sub = (tile: number) => tileCenter(tile);
const hp = (sim: Sim, e: Entity) => sim.world.read(e, Life).hp;
const telegraphs = (w: World) => w.query(GroundEffect).filter((g) => w.read(g, GroundEffect).once);

/** Steps one tick at a time; returns [tick, events] pairs. */
function stepTicks(sim: Sim, n: number): [number, Ev[]][] {
  const out: [number, Ev[]][] = [];
  for (let i = 0; i < n; i++) {
    const t = sim.tick;
    out.push([t, sim.step(1) as Ev[]]);
  }
  return out;
}
const flatten = (rows: [number, Ev[]][]) => rows.flatMap(([, e]) => e);

// ---------------------------------------------------------------------------
// Telegraphs
// ---------------------------------------------------------------------------

describe("telegraphs", () => {
  it("places a circle at the target point instead of hitting, with every event field", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 8 });
    const m = monster(sim, { x: 9, y: 8 });
    order(sim, m, "test.mskill.tquake", h);
    const rows = stepTicks(sim, 10);
    const ev = flatten(rows);
    expect(of(ev, "classic.hit")).toHaveLength(0);
    const tg = of(ev, "classic.telegraph");
    expect(tg).toHaveLength(1);
    const placedAt = rows.find(([, e]) => of(e, "classic.telegraph").length > 0)![0];
    const t = tg[0]!;
    expect(t).toEqual({
      type: "classic.telegraph",
      entity: t.entity,
      caster: m,
      skill: "test.mskill.tquake",
      effect: "fx.tquake",
      shape: "circle",
      x: sub(5),
      y: sub(8),
      radius: tiles(2),
      angle: 0,
      arc: 0,
      length: 0,
      width: 0,
      ticks: 30,
      fireAt: placedAt + 30,
    });
    const g = sim.world.read(t.entity, GroundEffect);
    expect(g).toMatchObject({
      once: true,
      shape: "circle",
      radius: tiles(2),
      nextAt: placedAt + 30,
      until: placedAt + 30,
      placedAt,
      team: "monster",
      owner: m,
      skill: "test.mskill.tquake",
      effect: "fx.tquake",
      damage: { phys: 0, fire: 10, cold: 0, lightning: 0, poison: 0 },
    });
    expect(sim.world.read(t.entity, Pos)).toEqual({ x: sub(5), y: sub(8) });
    expect(sim.world.read(t.entity, AreaTag)).toEqual({ depth: 1 });
    // The cast itself ended normally.
    expect(sim.world.has(m, Casting)).toBe(false);
  });

  it("fires exactly at fireAt: hits, applies the status, emits the effect, then disappears", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 8 });
    const m = monster(sim, { x: 9, y: 8 });
    order(sim, m, "test.mskill.tquake", h);
    const rows = stepTicks(sim, 60);
    const tg = of(flatten(rows), "classic.telegraph")[0]!;
    const hitRow = rows.find(([, e]) => of(e, "classic.hit").length > 0)!;
    expect(hitRow[0]).toBe(tg.fireAt);
    expect(of(hitRow[1], "classic.hit")[0]).toMatchObject({ target: h, amount: 10, crit: false });
    expect(of(hitRow[1], "classic.effect")).toEqual([
      expect.objectContaining({ effect: "fx.tquake", x: sub(5), y: sub(8), radius: tiles(2) }),
    ]);
    expect(of(hitRow[1], "classic.status")[0]).toMatchObject({
      target: h,
      status: "test.status.stun",
    });
    expect(hp(sim, h)).toBe(490);
    expect(sim.world.exists(tg.entity)).toBe(false);
  });

  it("misses a hero that walked out of the zone before it fired", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 8 });
    const m = monster(sim, { x: 9, y: 8 });
    order(sim, m, "test.mskill.tquake", h);
    sim.step(10);
    expect(telegraphs(sim.world)).toHaveLength(1);
    // Edge: radius 2 tiles + body 80 -> 592 sub; stand just outside it.
    place(sim, h, sub(5) - tiles(2) - 80 - 1, sub(8));
    const ev = sim.step(40);
    expect(of(ev, "classic.hit")).toHaveLength(0);
    expect(hp(sim, h)).toBe(500);
    expect(telegraphs(sim.world)).toHaveLength(0);
  });

  it("cone: hits within length and arc of the aim only", () => {
    const sim = newSim();
    const m = monster(sim, { x: 10, y: 10 });
    const h = hero(sim, { x: 12, y: 10 }); // straight along the aim (+x = angle 0)
    const side = ally(sim, 10, 12); // 90 degrees off the aim
    const far = ally(sim, 15, 10); // beyond the length (3 tiles + body)
    const edge = ally(sim, 12, 11); // ~26.6 degrees ~ 4.7 steps: inside arc 8
    order(sim, m, "test.mskill.tcleave", h);
    const ev = flatten(stepTicks(sim, 40));
    const t = of(ev, "classic.telegraph")[0]!;
    expect(t).toMatchObject({
      shape: "cone",
      angle: 0,
      arc: 8,
      length: tiles(3),
      radius: tiles(3),
    });
    expect(
      of(ev, "classic.hit")
        .map((x) => x.target)
        .sort((a, b) => a - b),
    ).toEqual([h, edge].sort((a, b) => a - b));
    expect(hp(sim, side)).toBe(500);
    expect(hp(sim, far)).toBe(500);
    const fx = of(ev, "classic.effect").find((e) => e.effect === "fx.test")!;
    expect(fx.points).toEqual([{ x: sub(10) + tiles(3), y: sub(10) }]);
  });

  it("line: hits along the lane (width/2 + body), then dashes the caster along it", () => {
    const sim = newSim();
    const m = monster(sim, { x: 10, y: 10 });
    const h = hero(sim, { x: 13, y: 10 });
    const lane = ally(sim, 15, 10); // on the line, 5 tiles out (length 6)
    const wide = ally(sim, 12, 11); // 1 tile off the line: 256 > 128 + 80
    const beyond = ally(sim, 18, 10); // beyond the end
    sim.world.update(lane, Pos, { x: sub(15), y: sub(10) + 200 }); // 200 <= 128 + 80
    gridOf(sim.world).move(lane, sub(15), sub(10) + 200);
    order(sim, m, "test.mskill.trush", h);
    const rows = stepTicks(sim, 30);
    const ev = flatten(rows);
    const t = of(ev, "classic.telegraph")[0]!;
    expect(t).toMatchObject({ shape: "line", angle: 0, length: tiles(6), width: 256, radius: 0 });
    const fireRow = rows.find(([tick]) => tick === t.fireAt)!;
    expect(
      of(fireRow[1], "classic.hit")
        .map((x) => x.target)
        .sort((a, b) => a - b),
    ).toEqual([h, lane].sort((a, b) => a - b));
    expect(hp(sim, wide)).toBe(500);
    expect(hp(sim, beyond)).toBe(500);
    // The rush starts on the firing tick and carries the caster down the lane.
    expect(sim.world.has(m, Dash) || sim.world.read(m, Pos).x > sub(10)).toBe(true);
    sim.step(20);
    expect(sim.world.read(m, Pos).x).toBeGreaterThan(sub(12));
    // No second hit on arrival (the line already hit).
    const later = of(flatten(rows.filter(([tick]) => tick > t.fireAt)), "classic.hit");
    expect(later).toHaveLength(0);
  });

  it("count 3: three circles, the extras within 3 tiles of the target", () => {
    const sim = newSim({ seed: 5 });
    const h = hero(sim, { x: 15, y: 15 });
    const m = monster(sim, { x: 20, y: 15 });
    order(sim, m, "test.mskill.tmeteor", h);
    const ev = flatten(stepTicks(sim, 12));
    const tg = of(ev, "classic.telegraph");
    expect(tg).toHaveLength(3);
    expect(telegraphs(sim.world)).toHaveLength(3);
    expect(tg[0]).toMatchObject({ x: sub(15), y: sub(15), ticks: 36 });
    for (const t of tg.slice(1)) {
      const dx = t.x - sub(15);
      const dy = t.y - sub(15);
      expect(dx * dx + dy * dy).toBeLessThanOrEqual((TELEGRAPH_SCATTER + 2) ** 2);
      expect(t.fireAt).toBe(tg[0]!.fireAt);
    }
    const after = sim.step(40);
    expect(of(after, "classic.effect").filter((e) => e.effect === "fx.test")).toHaveLength(3);
    expect(telegraphs(sim.world)).toHaveLength(0);
  });

  it("a dead caster's telegraphs still fire", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 8 });
    const m = monster(sim, { x: 9, y: 8 });
    order(sim, m, "test.mskill.tquake", h);
    sim.step(10);
    sim.world.update(m, Life, { hp: 1 });
    sim.world.add(m, Dead, { at: sim.tick, killer: h });
    const ev = sim.step(40);
    expect(of(ev, "classic.hit").map((e) => e.target)).toEqual([h]);
  });

  it("nova telegraphs sit on the caster and do not follow it", () => {
    const sim = newSim();
    const m = monster(sim, { x: 10, y: 10 });
    const h = hero(sim, { x: 11, y: 10 });
    order(sim, m, "test.mskill.tnova");
    sim.step(10);
    const g = telegraphs(sim.world)[0]!;
    expect(sim.world.read(g, Pos)).toEqual({ x: sub(10), y: sub(10) });
    place(sim, m, sub(20), sub(20));
    const ev = sim.step(40);
    expect(of(ev, "classic.hit").map((e) => e.target)).toEqual([h]);
  });

  it("is destroyed with its area when the hero leaves (classic.world teardown)", () => {
    const sim = testSim2();
    const depth = sim.world.getResource<AreaState>(RES.area)!.depth;
    expect(depth).toBe(1);
    const e = sim.world.create();
    sim.world.add(e, GroundEffect, {
      skill: "test.mskill.tquake",
      rank: 1,
      owner: 0,
      team: "monster",
      radius: 256,
      until: sim.tick + 100,
      nextAt: sim.tick + 100,
      every: 1,
      damage: { phys: 0, fire: 1, cold: 0, lightning: 0, poison: 0 },
      effect: "fx.tquake",
      once: true,
      shape: "circle",
      angle: 0,
      arc: 0,
      length: 0,
      width: 0,
      placedAt: sim.tick,
    });
    sim.world.add(e, Pos, { x: sub(5), y: sub(5) });
    sim.world.add(e, AreaTag, { depth: 1 });
    pushTransition(sim.world, { to: 0, via: "townPortal" });
    sim.step(2);
    expect(sim.world.getResource<AreaState>(RES.area)!.depth).toBe(0);
    expect(sim.world.exists(e)).toBe(false);
  });

  it("segment distance helper", () => {
    expect(nearSegment(5, 3, 0, 0, 10, 0, 3)).toBe(true);
    expect(nearSegment(5, 4, 0, 0, 10, 0, 3)).toBe(false);
    expect(nearSegment(-3, 0, 0, 0, 10, 0, 3)).toBe(true);
    expect(nearSegment(-4, 0, 0, 0, 10, 0, 3)).toBe(false);
    expect(nearSegment(13, 0, 0, 0, 10, 0, 3)).toBe(true);
    expect(nearSegment(14, 0, 0, 0, 10, 0, 3)).toBe(false);
  });
});

/** A sim with classic.world (test content) whose hero has entered dungeon level 1. */
function testSim2(): Sim {
  const sim = createSim(testLoaded(["classic.core", "classic.world", "classic.combat"]), {
    seed: 3,
  });
  ensureResources(sim.world);
  sim.step(1);
  const h = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0 });
  expect(h).toBeGreaterThan(0);
  pushTransition(sim.world, { to: 1, via: "stairsDown" });
  sim.step(2);
  return sim;
}

// ---------------------------------------------------------------------------
// Skill modifiers (hero casts)
// ---------------------------------------------------------------------------

function withMods(sim: Sim, h: Entity, mods: SkillModifier[]): void {
  setBonusSource(sim.world, h, "test.mods", [], mods);
}

describe("skill modifiers on hero casts", () => {
  /** Runs `fn` with and without the modifier and returns both results. */
  function compare<T>(mods: SkillModifier[], fn: (sim: Sim, h: Entity) => T): [T, T] {
    const run = (on: boolean): T => {
      const sim = newSim();
      const h = hero(sim, { x: 10, y: 10 });
      if (on) withMods(sim, h, mods);
      return fn(sim, h);
    };
    return [run(false), run(true)];
  }

  it("damagePct scales every damage packet (melee, area, projectile, chain)", () => {
    const mod = (skill: string): SkillModifier[] => [{ skill, field: "damagePct", value: 50 }];
    const melee = compare(mod("test.bskill.zap"), (sim, h) => {
      const m = monster(sim, { x: 11, y: 10 });
      order(sim, h, "test.bskill.zap", m);
      return of(sim.step(10), "classic.hit")[0]!.amount;
    });
    expect(melee).toEqual([20, 30]);
    const nova = compare(mod("*"), (sim, h) => {
      monster(sim, { x: 11, y: 10 });
      order(sim, h, "test.bskill.nova");
      return of(sim.step(10), "classic.hit")[0]!.amount;
    });
    expect(nova).toEqual([10, 15]);
    const proj = compare(mod("test.bskill.fan"), (sim, h) => {
      order(sim, h, "test.bskill.fan", 0, [sub(20), sub(10)]);
      sim.step(6);
      return sim.world.read(sim.world.query(Projectile)[0]!, Projectile).damage.fire;
    });
    expect(proj).toEqual([10, 15]);
    const chain = compare(mod("test.bskill.chain"), (sim, h) => {
      const a = monster(sim, { x: 12, y: 10 });
      monster(sim, { x: 14, y: 10 });
      order(sim, h, "test.bskill.chain", a);
      return of(sim.step(10), "classic.hit").map((e) => e.amount);
    });
    expect(chain).toEqual([
      [10, 10],
      [15, 15],
    ]);
  });

  it("manaCostPct, cooldownPct and speedPct change the order numbers", () => {
    const r = compare(
      [
        { skill: "test.bskill.zap", field: "manaCostPct", value: -50 },
        { skill: "test.bskill.zap", field: "cooldownPct", value: -40 },
        { skill: "test.bskill.zap", field: "speedPct", value: 100 },
      ],
      (sim, h) => {
        const m = monster(sim, { x: 11, y: 10 });
        const t0 = sim.tick;
        order(sim, h, "test.bskill.zap", m);
        sim.step(1);
        const c = sim.world.read(h, Casting);
        return {
          spent: 200 - sim.world.read(h, Mana).mp,
          readyAt: sim.world.read(h, SkillBook).cooldowns[0]!.readyAt - t0,
          dur: c.endAt - c.startedAt,
        };
      },
    );
    expect(r[0]).toEqual({ spent: 10, readyAt: 100, dur: 10 });
    expect(r[1]).toEqual({ spent: 5, readyAt: 60, dur: 5 });
  });

  it("radiusPct grows nova, self and arc reach", () => {
    const mods: SkillModifier[] = [{ skill: "*", field: "radiusPct", value: 50 }];
    // 2.6 tiles away: outside 2 tiles + body, inside 3 tiles + body.
    const nova = compare(mods, (sim, h) => {
      const m = monster(sim, { x: 10, y: 10 });
      place(sim, m, sub(10) + 666, sub(10));
      order(sim, h, "test.bskill.nova");
      const ev = sim.step(10);
      return [of(ev, "classic.hit").length, of(ev, "classic.effect")[0]!.radius];
    });
    expect(nova).toEqual([
      [0, tiles(2)],
      [1, tiles(3)],
    ]);
    const arc = compare(mods, (sim, h) => {
      const near = monster(sim, { x: 11, y: 10 });
      const m = monster(sim, { x: 10, y: 10 });
      place(sim, m, sub(10) + 666, sub(10));
      order(sim, h, "test.bskill.arc", near);
      return of(sim.step(10), "classic.hit").length;
    });
    expect(arc).toEqual([1, 2]);
    const rally = compare(mods, (sim, h) => {
      const a = ally(sim, 10, 10);
      place(sim, a, sub(10) + 666, sub(10));
      order(sim, h, "test.bskill.rally");
      sim.step(10);
      return sim.world.read(a, Statuses).list.length;
    });
    expect(rally).toEqual([0, 1]);
  });

  it("extraProjectiles and extraPierce", () => {
    const r = compare(
      [
        { skill: "test.bskill.fan", field: "extraProjectiles", value: 2 },
        { skill: "test.bskill.fan", field: "extraPierce", value: 1 },
      ],
      (sim, h) => {
        order(sim, h, "test.bskill.fan", 0, [sub(20), sub(10)]);
        sim.step(6);
        const ps = sim.world.query(Projectile);
        return [ps.length, sim.world.read(ps[0]!, Projectile).pierceLeft];
      },
    );
    expect(r).toEqual([
      [3, 1],
      [5, 2],
    ]);
  });

  it("extraBounces", () => {
    const r = compare([{ skill: "tag:aoe", field: "extraBounces", value: 2 }], (sim, h) => {
      const a = monster(sim, { x: 12, y: 10 });
      monster(sim, { x: 14, y: 10 });
      monster(sim, { x: 16, y: 10 });
      monster(sim, { x: 18, y: 10 });
      order(sim, h, "test.bskill.chain", a);
      return of(sim.step(10), "classic.hit").length;
    });
    expect(r).toEqual([2, 4]);
  });

  it("durationPct lengthens applied statuses and buffs", () => {
    const mods: SkillModifier[] = [{ skill: "*", field: "durationPct", value: 50 }];
    const status = compare(mods, (sim, h) => {
      const m = monster(sim, { x: 11, y: 10 });
      order(sim, h, "test.bskill.zap", m);
      const ev = sim.step(10);
      const s = of(ev, "classic.status")[0]!;
      const hitTick = sim.world.read(m, Statuses).list[0]!.until - s.until; // 0
      return s.until - (sim.tick - 10) + hitTick;
    });
    expect(status[1]! - status[0]!).toBe(30);
    const buff = compare(mods, (sim, h) => {
      order(sim, h, "test.bskill.rally");
      sim.step(10);
      return sim.world.read(h, Statuses).list[0]!.until;
    });
    expect(buff[1]! - buff[0]!).toBe(50);
  });

  it("extraSummons raises count and max; durationPct lengthens the summons", () => {
    const run = (mods: SkillModifier[]) => {
      const sim = newSim({ monsters: true });
      const h = hero(sim, { x: 10, y: 10 });
      if (mods.length > 0) withMods(sim, h, mods);
      const t0 = sim.tick;
      order(sim, h, "test.bskill.summon", 0, [sub(12), sub(10)]);
      sim.step(10);
      const mine = sim.world.query(Summoned).filter((e) => sim.world.read(e, Summoned).owner === h);
      return [mine.length, sim.world.read(mine[0]!, Summoned).until - t0];
    };
    const base = run([]);
    const more = run([
      { skill: "test.bskill.summon", field: "extraSummons", value: 1 },
      { skill: "test.bskill.summon", field: "durationPct", value: 100 },
    ]);
    expect(base[0]).toBe(1);
    expect(more[0]).toBe(2);
    expect(more[1]! - base[1]!).toBe(100);
  });

  it("monsters (no BonusStats) cast unmodified", () => {
    const sim = newSim();
    const h = hero(sim, { x: 10, y: 10 });
    const m = monster(sim, { x: 11, y: 10 });
    expect(sim.world.has(m, SkillBook)).toBe(true);
    order(sim, m, "test.mskill.tconvert");
    const hits = of(sim.step(10), "classic.hit");
    expect(hits[0]).toMatchObject({ target: h });
  });
});

// ---------------------------------------------------------------------------
// Monster buffs (enrage) and element conversion
// ---------------------------------------------------------------------------

describe("enrage and monster skill elements", () => {
  function cast(enrage: number) {
    const sim = newSim();
    const h = hero(sim, { x: 10, y: 10 });
    const m = monster(sim, { x: 11, y: 10, stats: { dmgMin: 10, dmgMax: 10 } });
    if (enrage > 0) {
      sim.world.update(m, Statuses, {
        list: [
          {
            id: ENRAGE_STATUS,
            until: 100000,
            power: enrage,
            source: m,
            nextAt: 100000,
            remaining: 0,
          },
        ],
      });
    }
    order(sim, m, "test.mskill.tconvert");
    sim.step(1);
    const c = sim.world.read(m, Casting);
    const hit = of(sim.step(10), "classic.hit")[0]!;
    expect(hit.target).toBe(h);
    return { amount: hit.amount, element: hit.element, dur: c.endAt - c.startedAt };
  }

  it("converts a zero-damage-block monster skill to its element", () => {
    expect(cast(0)).toEqual({ amount: 10, element: "cold", dur: 10 });
  });

  it("enrage raises monster damage and attack speed", () => {
    expect(cast(50)).toEqual({ amount: 15, element: "cold", dur: 7 });
  });
});

// ---------------------------------------------------------------------------
// Boss phases
// ---------------------------------------------------------------------------

function phaseBoss(sim: Sim, x = 20, y = 20): Entity {
  return spawnTestMonster(sim.world, {
    proto: "test.monster.phaseboss",
    x,
    y,
    life: 1000,
    rarity: "boss",
    level: 6,
    skills: ["test.mskill.bite", "test.mskill.tquake", "test.mskill.tcleave"],
    stats: { critPct: 0 },
  });
}

describe("boss phases", () => {
  it("enters each phase once, in order, also when a hit skips one", () => {
    const sim = newSim({ monsters: true });
    hero(sim, { x: 8, y: 20, life: 100000 });
    const b = phaseBoss(sim);
    let ev = sim.step(8);
    expect(of(ev, "classic.boss.phase")).toHaveLength(0);
    sim.world.update(b, Life, { hp: 740 });
    ev = sim.step(8);
    expect(of(ev, "classic.boss.phase")).toEqual([
      {
        type: "classic.boss.phase",
        entity: b,
        monster: "test.monster.phaseboss",
        phase: 1,
        message: "one",
        enraged: false,
      },
    ]);
    expect(sim.world.read(b, Ai).count).toBe(1);
    // Skip straight past phases 2 and 3.
    sim.world.update(b, Life, { hp: 200 });
    ev = sim.step(8);
    expect(of(ev, "classic.boss.phase").map((e) => [e.phase, e.message, e.enraged])).toEqual([
      [2, "two", true],
      [3, "three", true],
    ]);
    expect(sim.world.read(b, Ai).count).toBe(3);
    // Phase 2 taught its skill; enrage holds the highest power.
    expect(sim.world.read(b, SkillBook).ranks.map((r) => r.skill)).toContain("test.mskill.trush");
    const enrage = sim.world.read(b, Statuses).list.find((s) => s.id === ENRAGE_STATUS)!;
    expect(enrage.power).toBe(60);
    // Healing back up never re-enters a phase.
    sim.world.update(b, Life, { hp: 1000 });
    sim.step(8);
    sim.world.update(b, Life, { hp: 100 });
    expect(of(sim.step(8), "classic.boss.phase")).toHaveLength(0);
  });

  it("summons minions on a summon phase", () => {
    const sim = newSim({ monsters: true });
    hero(sim, { x: 8, y: 20, life: 100000 });
    const b = phaseBoss(sim);
    sim.world.update(b, Life, { hp: 700 });
    sim.step(8);
    const minions = sim.world
      .query(Summoned, Monster)
      .filter((e) => sim.world.read(e, Summoned).owner === b);
    expect(minions).toHaveLength(3);
    for (const e of minions) {
      expect(sim.world.read(e, Monster).proto).toBe("test.monster.dummy");
      expect(sim.world.read(e, Faction).team).toBe("monster");
    }
  });

  it("phase skills join the rotation", () => {
    expect(rotationSkills(PHASE_BOSS, 0)).toEqual(["test.mskill.tquake", "test.mskill.tcleave"]);
    expect(rotationSkills(PHASE_BOSS, 2)).toEqual([
      "test.mskill.tquake",
      "test.mskill.tcleave",
      "test.mskill.trush",
    ]);
  });

  it("never places a telegraph while one of its own is pending", () => {
    const sim = newSim({ monsters: true, seed: 9 });
    const h = hero(sim, { x: 18, y: 20, life: 100000 });
    const b = phaseBoss(sim, 20, 20);
    sim.world.update(b, Life, { hp: 400 }); // phases 1-2: rush joins the rotation
    const placed: number[] = [];
    const fired: number[] = [];
    for (const [tick, ev] of stepTicks(sim, 800)) {
      for (const t of of(ev, "classic.telegraph")) {
        if (t.caster === b) {
          placed.push(tick);
          fired.push(t.fireAt);
        }
      }
      // Keep the hero standing next to the boss.
      if (sim.world.has(h, Dead)) break;
    }
    expect(placed.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < placed.length; i++) {
      expect(placed[i]!, `telegraph ${i}`).toBeGreaterThanOrEqual(fired[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// A scripted fight
// ---------------------------------------------------------------------------

/** True when the monster telegraph zone `g` (team monster) contains the point with a body. */
function inTelegraph(w: World, g: Entity, x: number, y: number, body: number): boolean {
  const v = w.get(g, GroundEffect);
  if (!v || !v.once || v.team !== "monster") return false;
  const p = w.read(g, Pos);
  const dx = x - p.x;
  const dy = y - p.y;
  const shape = v.shape ?? "circle";
  if (shape === "circle") {
    const r = v.radius + body;
    return dx * dx + dy * dy <= r * r;
  }
  if (shape === "cone") {
    const r = (v.length ?? 0) + body;
    return (
      dx * dx + dy * dy <= r * r &&
      (dx === 0 && dy === 0 ? true : angleDiff(angleOf(dx, dy), v.angle ?? 0) <= (v.arc ?? 8))
    );
  }
  const [lx, ly] = angleVec(v.angle ?? 0, v.length ?? 0);
  return nearSegment(x, y, p.x, p.y, lx, ly, Math.floor((v.width ?? 256) / 2) + body);
}

/** Every live monster telegraph zone (team monster) containing the point with a body. */
function inZone(w: World, x: number, y: number, body: number): boolean {
  for (const g of telegraphs(w)) if (inTelegraph(w, g, x, y, body)) return true;
  return false;
}

/**
 * Drives the hero: steps out of any monster telegraph zone, else attacks the
 * target with a repeating skill intent. Returns ticks to kill (or -1), the
 * hero's deaths (0/1), hits taken from telegraphs, the telegraphs aimed at
 * the hero (zone over the hero, body 80, when placed) and the longest
 * stretch without acting (moving or casting).
 */
function scriptedFight(
  sim: Sim,
  h: Entity,
  target: Entity,
  maxTicks: number,
  skill = "test.skill.strike",
  o: { dodge?: boolean; lives?: number; potions?: number; freeMana?: boolean } = {},
): {
  ticks: number;
  died: boolean;
  deaths: number;
  telegraphHits: number;
  telegraphs: number;
  maxIdle: number;
  phases: number;
} {
  const w = sim.world;
  const start = sim.tick;
  let lastActive = sim.tick;
  let maxIdle = 0;
  let telegraphHits = 0;
  let aimed = 0;
  let phases = 0;
  let deaths = 0;
  const dodge = o.dodge ?? true;
  const lives = o.lives ?? 1;
  // Stand-ins for the belt: `potions` heals of 40 % below 40 % life (60-tick cooldown),
  // refilled on every death; `freeMana` keeps the mana full (mana potions and regen).
  let potions = o.potions ?? 0;
  let potionAt = 0;
  const tgSkills = new Set(
    sim.loaded.registry
      .all<SkillProto>(KIND.skill)
      .filter(([, s]) => s.telegraph !== undefined)
      .map(([id]) => id),
  );
  for (let i = 0; i < maxTicks; i++) {
    if (w.has(h, Dead)) {
      deaths++;
      if (deaths >= lives) {
        return { ticks: -1, died: true, deaths, telegraphHits, telegraphs: aimed, maxIdle, phases };
      }
      // Stand back up in place (stands in for respawn + walking back; the boss keeps its life).
      w.remove(h, Dead);
      const life = w.read(h, Life);
      w.update(h, Life, { hp: life.max });
      const hp0 = w.read(h, Pos);
      gridOf(w).insert(h, hp0.x, hp0.y);
      w.update(h, Intent, { kind: "idle", source: "manual", at: sim.tick });
      lastActive = sim.tick;
      potions = o.potions ?? 0;
    }
    const life = w.read(h, Life);
    if (potions > 0 && sim.tick >= potionAt && life.hp * 100 < life.max * 40) {
      w.update(h, Life, { hp: Math.min(life.max, life.hp + Math.floor((life.max * 40) / 100)) });
      potions--;
      potionAt = sim.tick + 60;
    }
    if (o.freeMana) {
      const mana = w.read(h, Mana);
      if (mana.mp < mana.max) w.update(h, Mana, { mp: mana.max });
    }
    if (!w.exists(target) || w.has(target, Dead)) {
      return {
        ticks: sim.tick - start,
        died: false,
        deaths,
        telegraphHits,
        telegraphs: aimed,
        maxIdle,
        phases,
      };
    }
    const p = w.read(h, Pos);
    const map = getAreaMap(w, sim.loaded.registry);
    if (dodge && inZone(w, p.x, p.y, 80)) {
      // Nearest safe point on rings of 2..6 tiles.
      // Nearest ring with a safe walkable tile; on it, the tile closest to the target.
      let best: [number, number] | null = null;
      const tp = w.read(target, Pos);
      for (let r = 2; r <= 6 && best === null; r++) {
        let bestD = Infinity;
        for (let a = 0; a < 64; a += 4) {
          const [dx, dy] = angleVec(a, tiles(r));
          // Move intents take tile coordinates; the hero walks to the tile centre.
          const tx = (p.x + dx) >> 8;
          const ty = (p.y + dy) >> 8;
          if (!walkableAt(map, tx, ty) || inZone(w, tileCenter(tx), tileCenter(ty), 120)) continue;
          const d = (tileCenter(tx) - tp.x) ** 2 + (tileCenter(ty) - tp.y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = [tx, ty];
          }
        }
      }
      if (best)
        w.update(h, Intent, {
          kind: "move",
          source: "manual",
          at: sim.tick,
          x: best[0],
          y: best[1],
        });
    } else {
      const it = w.read(h, Intent);
      if (it.kind !== "skill" || it.target !== target) {
        const tp = w.read(target, Pos);
        w.update(h, Intent, {
          kind: "skill",
          source: "manual",
          at: sim.tick,
          skill,
          target,
          x: tp.x,
          y: tp.y,
          repeat: true,
        });
      }
    }
    const ev = sim.step(1) as Ev[];
    for (const e of of(ev, "classic.hit")) {
      if (e.target === h && tgSkills.has(e.skill)) {
        telegraphHits++;
      }
    }
    if (w.exists(h)) {
      const hp = w.read(h, Pos);
      for (const e of of(ev, "classic.telegraph"))
        if (w.exists(e.entity) && inTelegraph(w, e.entity, hp.x, hp.y, 80)) aimed++;
    }
    phases += of(ev, "classic.boss.phase").length;
    if (w.has(h, Casting) || w.read(h, Mover).moving) lastActive = sim.tick;
    maxIdle = Math.max(maxIdle, sim.tick - lastActive);
  }
  return { ticks: -1, died: false, deaths, telegraphHits, telegraphs: aimed, maxIdle, phases };
}

describe("scripted boss fight", () => {
  it("a strong test hero kills a phased boss, dodging, never locked out for 40 ticks", () => {
    const sim = newSim({ monsters: true, seed: 4 });
    const h = hero(sim, { x: 10, y: 20, life: 2000, stats: { dmgMin: 40, dmgMax: 60, armor: 50 } });
    const b = phaseBoss(sim, 22, 20);
    const r = scriptedFight(sim, h, b, 4000);
    report(`T-bosses test boss fight: ${JSON.stringify(r)}\n`);
    expect(r.died).toBe(false);
    expect(r.ticks).toBeGreaterThan(0);
    expect(r.phases).toBe(3);
    expect(r.maxIdle).toBeLessThanOrEqual(40);
    expect(sim.world.has(b, Dead) || !sim.world.exists(b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real content
// ---------------------------------------------------------------------------

describe("real boss and guardian content", () => {
  const reg = testLoaded(["classic.core"], { content: "real" }).registry;
  const monsters = reg.all<MonsterProto>(KIND.monster);
  const bosses = monsters.filter(([, m]) => m.boss !== undefined);
  const telegraphed = (ids: string[]) =>
    ids.filter((id) => reg.get<SkillProto>(KIND.skill, id)?.telegraph !== undefined);
  const allSkills = (m: MonsterProto) => [
    ...m.skills,
    ...(m.phases ?? []).flatMap((p) => p.skills),
  ];

  it("each of the four bosses has 2-3 phases sorted by atPct and >= 2 telegraphed skills", () => {
    expect(bosses.map(([id]) => id).sort()).toEqual([
      "classic.monster.boss_hollow_king",
      "classic.monster.boss_ninth_flame",
      "classic.monster.boss_tunnel_mother",
      "classic.monster.boss_warden",
    ]);
    for (const [id, m] of bosses) {
      const phases = m.phases ?? [];
      expect(phases.length, id).toBeGreaterThanOrEqual(2);
      expect(phases.length, id).toBeLessThanOrEqual(3);
      const pcts = phases.map((p) => p.atPct);
      expect(pcts, id).toEqual([...pcts].sort((a, b) => b - a));
      expect(new Set(pcts).size, id).toBe(pcts.length);
      expect(telegraphed(m.skills.slice(1)).length, id).toBeGreaterThanOrEqual(2);
      for (const p of phases) expect(p.message.length, id).toBeGreaterThan(10);
      expect(
        phases.some((p) => p.enragePct > 0),
        id,
      ).toBe(true);
    }
  });

  it("has both rift guardians: guardian, boss behaviour, never placed, with phases", () => {
    for (const id of ["classic.monster.guardian_maw", "classic.monster.guardian_choir"]) {
      const m = reg.get<MonsterProto>(KIND.monster, id)!;
      expect(m, id).toBeDefined();
      expect(m.guardian, id).toBe(true);
      expect(m.behaviour, id).toBe("boss");
      expect(m.themes, id).toEqual([]);
      expect(m.boss, id).toBeUndefined();
      expect(m.appearance, id).toBe(`unit.monster.${id.slice("classic.monster.".length)}`);
      expect((m.phases ?? []).length, id).toBeGreaterThanOrEqual(2);
      expect(telegraphed(allSkills(m)).length, id).toBeGreaterThanOrEqual(2);
    }
    const maw = reg.get<MonsterProto>(KIND.monster, "classic.monster.guardian_maw")!;
    expect(telegraphed(allSkills(maw)).sort()).toEqual([
      "classic.mskill.boss_cleave",
      "classic.mskill.boss_quake",
      "classic.mskill.boss_rush",
      "classic.mskill.boss_slam",
    ]);
    const choir = reg.get<MonsterProto>(KIND.monster, "classic.monster.guardian_choir")!;
    expect(allSkills(choir)).toEqual(
      expect.arrayContaining([
        "classic.mskill.boss_meteor",
        "classic.mskill.boss_frost_nova",
        "classic.mskill.boss_volley",
        "classic.mskill.boss_nova",
      ]),
    );
  });

  it("every monster skill is used: by a monster, a boss or guardian phase, or a mod", () => {
    // QA round 1: Tremor, Pyre Nova and Call the Brood were defined but used by nobody.
    const used = new Set<string>();
    for (const [, m] of monsters) {
      for (const s of allSkills(m)) used.add(s);
      if (m.onDeathSkill) used.add(m.onDeathSkill);
    }
    for (const [, mod] of reg.all<MonsterModProto>(KIND.monsterMod)) {
      if (mod.onDeathSkill) used.add(mod.onDeathSkill);
    }
    const unused = reg
      .all<SkillProto>(KIND.skill)
      .map(([id]) => id)
      .filter((id) => id.startsWith("classic.mskill.") && !used.has(id));
    expect(unused).toEqual([]);
    // The three are wired where they fit: Skarn's brood, the Maw's stamp, the Choir's heat wave.
    const phaseSkills = (id: string) =>
      (reg.get<MonsterProto>(KIND.monster, id)?.phases ?? []).flatMap((p) => p.skills);
    expect(phaseSkills("classic.monster.boss_tunnel_mother")).toContain(
      "classic.mskill.boss_summon",
    );
    expect(phaseSkills("classic.monster.guardian_maw")).toContain("classic.mskill.boss_slam");
    expect(phaseSkills("classic.monster.guardian_choir")).toContain("classic.mskill.boss_nova");
  });

  it("every boss/guardian skill and the enrage status resolve; telegraph shapes match", () => {
    for (const [id, m] of monsters) {
      for (const s of allSkills(m)) expect(reg.get(KIND.skill, s), `${id} ${s}`).toBeDefined();
    }
    expect(reg.get<StatusProto>(KIND.status, ENRAGE_STATUS)?.kind).toBe("buff");
    const shapeOf: Record<string, string> = {
      nova: "circle",
      aoeTarget: "circle",
      arc: "cone",
      dash: "line",
    };
    for (const [id, s] of reg.all<SkillProto>(KIND.skill)) {
      if (!s.telegraph) continue;
      expect(s.users, id).toBe("monster");
      expect(s.telegraph.shape, id).toBe(shapeOf[s.shape]);
      expect(s.effect, id).toMatch(/^fx\.boss_/);
    }
    for (const n of ["boss_quake", "boss_cleave", "boss_rush", "boss_meteor", "boss_frost_nova"]) {
      const s = reg.get<SkillProto>(KIND.skill, `classic.mskill.${n}`)!;
      expect(s.effect).toBe(`fx.${n}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/**
 * A "level-appropriate" hero for a real boss fight, built with the real
 * classic.progression: class warrior at `level`, attributes from the class
 * autoAlloc ratio (5 points per level), the best normal base of each slot
 * with ilvl <= level plus magic-like mods (weapon +4 %/level damage and +level
 * max damage, armor
 * pieces +2 life/level and +level/2 all resistances, rings 3 % life steal),
 * Cleave at rank level/2 with free mana and 12 life "potions" per life
 * (see scriptedFight). Deaths are counted and the hero stands back up in place.
 */
function realHero(sim: Sim, level: number, x: number, y: number): Entity {
  const reg = sim.loaded.registry;
  const h = spawnTestHero(sim.world, {
    x,
    y,
    classId: "classic.warrior",
    level,
    skills: [
      { skill: "classic.skill.attack", rank: 1 },
      { skill: "classic.skill.cleave", rank: Math.max(1, Math.floor(level / 2)) },
    ],
    bar: ["classic.skill.attack", "classic.skill.cleave", null, null, null, null],
  });
  const cls = reg.get<{ base: Record<string, number>; autoAlloc: Record<string, number> }>(
    KIND.class,
    "classic.warrior",
  )!;
  const points = 5 * (level - 1);
  const ratio = cls.autoAlloc;
  const total = ratio.str! + ratio.dex! + ratio.mag! + ratio.vit!;
  const attrs = { str: 0, dex: 0, mag: 0, vit: 0 } as Record<string, number>;
  for (const k of ["str", "dex", "mag", "vit"]) {
    attrs[k] = cls.base[k]! + Math.floor((points * ratio[k]!) / total);
  }
  sim.world.update(h, Attributes, attrs as never);
  const eq = emptyEquipment();
  const bases = reg.all<ItemBaseProto>(KIND.itemBase);
  let uid = 1000;
  const slots: EquipSlot[] = [
    "weapon",
    "offhand",
    "helm",
    "armor",
    "gloves",
    "boots",
    "ring1",
    "ring2",
    "amulet",
  ];
  for (const slot of slots) {
    const ring = slot === "ring1" || slot === "ring2";
    const cands = bases.filter(
      ([, b]) =>
        b.slots.includes(ring ? "ring1" : slot) &&
        b.ilvl <= level &&
        b.category !== "gem" &&
        !(
          slot === "weapon" &&
          (b.twoHanded ||
            b.weaponClass === "bow" ||
            b.weaponClass === "staff" ||
            b.weaponClass === "wand")
        ),
    );
    const score = ([, b]: readonly [string, Readonly<ItemBaseProto>]) =>
      slot === "weapon" ? (b.dmgMin ?? 0) + (b.dmgMax ?? 0) : (b.armor ?? 0) * 100 + b.ilvl;
    cands.sort((a, b) => score(b) - score(a) || (a[0] < b[0] ? -1 : 1));
    const pick = cands[0];
    if (!pick) continue;
    const mods: StatMod[] =
      slot === "weapon"
        ? [
            { stat: "dmgPct", value: 4 * level },
            { stat: "dmgMax", value: level },
          ]
        : ring
          ? [{ stat: "lifeSteal", value: 3 }]
          : [
              { stat: "life", value: 2 * level },
              { stat: "resAll", value: Math.floor(level / 2) },
            ];
    eq[slot] = {
      uid: uid++,
      base: pick[0],
      rarity: "magic",
      ilvl: level,
      name: pick[1].name,
      mods,
      affixes: [],
      value: 1,
    };
  }
  sim.world.update(h, Equipment, eq);
  return h;
}

const REAL_BOSSES: [string, number][] = [
  ["classic.monster.boss_warden", 4],
  ["classic.monster.boss_tunnel_mother", 8],
  ["classic.monster.boss_ninth_flame", 12],
  ["classic.monster.boss_hollow_king", 16],
  ["classic.monster.guardian_maw", 104],
  ["classic.monster.guardian_choir", 104],
];

let realCache: LoadedMode | null = null;
function realLoaded(): LoadedMode {
  realCache ??= loadMode(
    defineMode({
      id: "classic",
      name: "Classic (boss evidence)",
      description: "test",
      world: null,
      modules: [
        "classic.core",
        "classic.combat",
        "classic.monsters",
        "classic.progression",
        "classic.content",
      ],
      tick: { kind: "fixed", hz: 20 },
    }),
    classicModules,
  );
  return realCache;
}

describe("evidence: real bosses vs a level-appropriate scripted hero", () => {
  function fight(id: string, depth: number, dodge: boolean, seed: number) {
    const sim = createSim(realLoaded(), { seed });
    ensureResources(sim.world);
    useOpenMap(sim, 1, 48);
    const reg = sim.loaded.registry;
    const proto = reg.get<MonsterProto>(KIND.monster, id)!;
    // World places bosses at monsterLevel(depth) + 3; a level-1 rift guardian is 24 + 2.
    const bossLevel = depth > 100 ? 26 : monsterLevel(depth) + 3;
    const heroLevel = bossLevel + 1;
    const h = realHero(sim, heroLevel, 12, 24);
    pushSpawn(sim.world, {
      monster: id,
      x: sub(26),
      y: sub(24),
      depth: 1,
      level: bossLevel,
      rarity: "boss",
      mods: [],
      pack: 1,
      name: "",
      owner: 0,
      team: "monster",
      until: 0,
      awake: true,
    });
    for (let i = 0; i < (proto.boss?.minionCount ?? 0); i++) {
      pushSpawn(sim.world, {
        monster: proto.boss!.minions,
        x: sub(27 + (i % 3)),
        y: sub(22 + Math.floor(i / 3) * 2),
        depth: 1,
        level: bossLevel - 3,
        rarity: "minion",
        mods: [],
        pack: 1,
        name: "",
        owner: 0,
        team: "monster",
        until: 0,
        awake: true,
      });
    }
    sim.step(2);
    // progression raised Life.max: start the fight at full life.
    sim.world.update(h, Life, { hp: sim.world.read(h, Life).max });
    const b = sim.world.query(Monster).find((e) => sim.world.read(e, Monster).proto === id)!;
    const life = sim.world.read(h, Life).max;
    const r = scriptedFight(sim, h, b, 20000, "classic.skill.cleave", {
      dodge,
      lives: 100,
      potions: 12,
      freeMana: true,
    });
    return { ...r, heroLevel, heroLife: life, bossLife: sim.world.read(b, Life).max };
  }

  const fmt = (r: ReturnType<typeof fight>) =>
    `${r.ticks > 0 ? `${(r.ticks / 20).toFixed(0)} s` : "no kill"} / ${r.deaths} deaths / ${r.telegraphHits}/${r.telegraphs} tg hits/aimed`;

  it("reports time-to-kill and hero deaths per boss (dodging and standing)", () => {
    const rows: string[] = [];
    const checks: (() => void)[] = [];
    for (const [id, depth] of REAL_BOSSES) {
      const d = fight(id, depth, true, 11);
      const s = fight(id, depth, false, 11);
      rows.push(
        `${id.slice(16)} (hero L${d.heroLevel}, life ${d.heroLife}; boss life ${d.bossLife}): ` +
          `dodging ${fmt(d)}, maxIdle ${d.maxIdle}, phases ${d.phases} | standing ${fmt(s)}`,
      );
      checks.push(() => {
        expect(d.ticks, id).toBeGreaterThan(0);
        expect(d.maxIdle, id).toBeLessThanOrEqual(40);
        expect(d.phases, id).toBe(proto(id).phases!.length);
        // Hits per telegraph aimed at the hero: dodging must take under 75 % of the
        // standing hero's rate. Fight lengths differ (the standing hero can kill
        // sooner), so neither the hit totals nor hits per tick compare dodging.
        // Cross-multiplied: d.hits / d.tg < 0.75 * s.hits / s.tg.
        expect(d.telegraphs, id).toBeGreaterThan(0);
        expect(s.telegraphs, id).toBeGreaterThan(0);
        expect(4 * d.telegraphHits * s.telegraphs, id).toBeLessThan(
          3 * s.telegraphHits * d.telegraphs,
        );
      });
    }
    // Logged on purpose: these are the numbers reported for the boss rework.
    report(`T-bosses evidence:\n${rows.join("\n")}\n`);
    for (const c of checks) c();
  }, 300000);

  const proto = (id: string) => realLoaded().registry.get<MonsterProto>(KIND.monster, id)!;
});
