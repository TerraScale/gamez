/**
 * classic.combat behaviour: orders, every skill shape, projectiles, statuses,
 * damage resolution and deaths. Uses the minimal test content plus an extra
 * test-only module defining the shapes the test content lacks.
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
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf, type DeathRecord, type SpawnRequest } from "../src/bus.ts";
import {
  Ai,
  AreaTag,
  CastOrder,
  Casting,
  CombatStats,
  Dash,
  Dead,
  GroundEffect,
  Life,
  Mana,
  Mover,
  Pos,
  Projectile,
  SkillBook,
  Statuses,
} from "../src/components.ts";
import { tileCenter, tiles } from "../src/fixed.ts";
import { modules as classicModules } from "../src/index.ts";
import { gridOf } from "../src/spatial.ts";
import { KIND, type MonsterProto, type SkillProto } from "../src/types.ts";
import { castTiming } from "../src/combat/orders.ts";
import { spreadOffsets } from "../src/combat/projectiles.ts";
import { isMeleeHit } from "../src/combat/resolve.ts";
import { applyStatus } from "../src/combat/statuses.ts";
import { testContent, TEST_SKILLS } from "./support/content.ts";
import {
  baseCombatStats,
  ensureResources,
  spawnTestHero,
  spawnTestMonster,
  useOpenMap,
  type TestHeroOptions,
  type TestMonsterOptions,
} from "./support/harness.ts";

// ---------------------------------------------------------------------------
// Test-only content (shapes the minimal test content does not cover)
// ---------------------------------------------------------------------------

const sk = (
  p: Partial<SkillProto> & Pick<SkillProto, "name" | "shape" | "target">,
): SkillProto => ({
  description: p.name,
  icon: "icon.skill.test",
  users: "hero",
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
  ai: { tags: ["single"], priority: 1 },
  ...p,
});

const flat = (element: "fire" | "cold" | "lightning" | "poison" | "phys", n: number) => ({
  element,
  min: n,
  max: n,
  minPerRank: 0,
  maxPerRank: 0,
});

const EXTRA_SKILLS: Record<string, SkillProto> = {
  "test.skill.smash": sk({
    name: "Smash",
    shape: "melee",
    target: "enemy",
    range: 300,
    weaponPct: 100,
  }),
  "test.skill.zap": sk({
    name: "Zap",
    shape: "melee",
    target: "enemy",
    range: 300,
    damage: flat("fire", 10),
  }),
  "test.skill.ignite": sk({
    name: "Ignite",
    shape: "melee",
    target: "enemy",
    range: 300,
    damage: flat("fire", 1),
    status: { id: "test.status.burn", chancePct: 100, duration: 60, power: 30, powerPerRank: 0 },
  }),
  "test.skill.arc": sk({
    name: "Arc",
    shape: "arc",
    target: "enemy",
    range: tiles(2),
    arc: 10,
    damage: flat("phys", 10),
  }),
  "test.skill.chain": sk({
    name: "Chain",
    shape: "chain",
    target: "enemy",
    range: tiles(9),
    speedStat: "cast",
    damage: flat("lightning", 10),
    chain: { bounces: 3, range: tiles(4), falloffPct: 50 },
    effect: "fx.chain",
  }),
  "test.skill.charge": sk({
    name: "Charge",
    shape: "dash",
    target: "enemy",
    range: tiles(8),
    castTicks: 6,
    hitTick: 6,
    damage: flat("phys", 10),
    dash: { speed: 160, maxRange: tiles(8) },
  }),
  "test.skill.tumble": sk({
    name: "Tumble",
    shape: "dash",
    target: "point",
    range: tiles(6),
    castTicks: 4,
    hitTick: 4,
    dash: { speed: 140, maxRange: tiles(6) },
  }),
  "test.skill.blink": sk({ name: "Blink", shape: "blink", target: "point", range: tiles(8) }),
  "test.skill.summon": sk({
    name: "Summon",
    shape: "summon",
    target: "point",
    range: tiles(6),
    summon: { monster: "test.monster.dummy", count: 1, max: 2, duration: 300 },
  }),
  "test.skill.rally": sk({
    name: "Rally",
    shape: "self",
    target: "self",
    radius: tiles(4),
    buff: { status: "test.status.rally", duration: 200, power: 20, powerPerRank: 3 },
    status: { id: "test.status.stun", chancePct: 100, duration: 20, power: 1, powerPerRank: 0 },
  }),
  "test.skill.whirl": sk({
    name: "Whirl",
    shape: "pulse",
    target: "self",
    radius: tiles(2),
    castTicks: 12,
    hitTick: 2,
    damage: flat("phys", 5),
    pulse: { count: 3, every: 4 },
  }),
  "test.skill.meteor": sk({
    name: "Meteor",
    shape: "aoeTarget",
    target: "point",
    range: tiles(10),
    radius: tiles(2),
    damage: flat("fire", 10),
  }),
  "test.skill.orb": sk({
    name: "Orb",
    shape: "projectile",
    target: "point",
    range: tiles(10),
    damage: flat("fire", 10),
    projectile: {
      speed: 40,
      count: 1,
      spread: 0,
      pierce: 0,
      radius: 64,
      maxRange: tiles(10),
      sprite: "fx.orb",
      explodeRadius: tiles(2),
    },
  }),
  "test.skill.lance": sk({
    name: "Lance",
    shape: "projectile",
    target: "point",
    range: tiles(10),
    damage: flat("cold", 10),
    projectile: {
      speed: 64,
      count: 1,
      spread: 0,
      pierce: 1,
      radius: 64,
      maxRange: tiles(12),
      sprite: "fx.lance",
    },
  }),
  "test.skill.fan": sk({
    name: "Fan",
    shape: "projectile",
    target: "point",
    range: tiles(10),
    damage: flat("phys", 4),
    projectile: {
      speed: 64,
      count: 5,
      spread: 3,
      pierce: 0,
      radius: 64,
      maxRange: tiles(10),
      sprite: "fx.arrow",
    },
  }),
  "test.mskill.burst": sk({
    name: "Burst",
    users: "monster",
    shape: "nova",
    target: "self",
    radius: tiles(2),
    castTicks: 16,
    hitTick: 16,
    damage: flat("poison", 12),
  }),
};

const BLOAT: MonsterProto = {
  name: "Bloat",
  family: "test",
  description: "pops",
  appearance: "unit.monster.test",
  fallbackAppearance: "unit.hero",
  tint: 0,
  scale: 100,
  behaviour: "exploder",
  life: 16,
  armor: 0,
  toHit: 40,
  dmgMin: 6,
  dmgMax: 12,
  element: "poison",
  resist: { fire: 0, cold: 0, lightning: 0, poison: 0 },
  xp: 12,
  moveSpeed: 44,
  radius: 80,
  skills: ["test.mskill.burst"],
  aggroRange: tiles(8),
  keepDistance: 0,
  packSize: [2, 4],
  themes: [],
  minDepth: 1,
  weight: 0,
  onDeathSkill: "test.mskill.burst",
};

/** Death records seen during the post stage, kept in a test resource. */
const DEATHS = "test.deaths";

const combatExtras = defineModule({
  id: "test.combatExtras",
  version: "0.0.1",
  data(reg) {
    for (const id of Object.keys(EXTRA_SKILLS).sort())
      reg.define(KIND.skill, id, EXTRA_SKILLS[id]!);
    reg.define(KIND.monster, "test.monster.bloat", BLOAT);
  },
  systems: [
    {
      id: "test.combatExtras.deaths",
      stage: "post",
      order: 999,
      run(world) {
        const bus = busOf(world);
        if (bus.deaths.length === 0) return;
        const seen = world.getResource<DeathRecord[]>(DEATHS) ?? [];
        world.setResource(DEATHS, [...seen, ...bus.deaths]);
      },
    },
  ],
});

let loadedCache: LoadedMode | null = null;
function loaded(): LoadedMode {
  loadedCache ??= loadMode(
    defineMode({
      id: "classic",
      name: "Classic (combat test)",
      description: "test",
      world: null,
      modules: ["classic.core", "classic.combat", "test.content", "test.combatExtras"],
      tick: { kind: "fixed", hz: 20 },
    }),
    [...classicModules, testContent, combatExtras],
  );
  return loadedCache;
}

function newSim(seed = 1): Sim {
  const sim = createSim(loaded(), { seed });
  ensureResources(sim.world);
  useOpenMap(sim, 1, 32);
  return sim;
}

const ALL_SKILLS = [...Object.keys(TEST_SKILLS), ...Object.keys(EXTRA_SKILLS)]
  .filter((s) => s.startsWith("test.skill."))
  .sort();

function hero(sim: Sim, o: TestHeroOptions = {}): Entity {
  return spawnTestHero(sim.world, {
    skills: ALL_SKILLS.map((skill) => ({ skill, rank: 1 })),
    mana: 100,
    ...o,
  });
}

function monster(sim: Sim, o: TestMonsterOptions = {}): Entity {
  return spawnTestMonster(sim.world, { life: 200, ...o });
}

function order(sim: Sim, caster: Entity, skill: string, target: Entity = 0, at?: [number, number]) {
  let x = 0;
  let y = 0;
  if (at) [x, y] = at;
  else if (target !== 0) ({ x, y } = sim.world.read(target, Pos));
  else ({ x, y } = sim.world.read(caster, Pos));
  sim.world.add(caster, CastOrder, { skill, target, x, y });
}

const sub = (tile: number) => tileCenter(tile);
const of = <T extends string>(events: GameEvent[], type: T) =>
  events.filter((e) => e.type === type) as (GameEvent & Record<string, any>)[];
const hp = (sim: Sim, e: Entity) => sim.world.read(e, Life).hp;
const deaths = (sim: Sim) => sim.world.getResource<DeathRecord[]>(DEATHS) ?? [];

// ---------------------------------------------------------------------------

describe("cast orders", () => {
  it("starts a basic attack with weapon timing and always removes the order", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, stats: { attackTicks: 12 } });
    const m = monster(sim, { x: 6, y: 5 });
    order(sim, h, "test.skill.strike", m);
    const ev = sim.step(1);
    expect(sim.world.has(h, CastOrder)).toBe(false);
    const c = sim.world.read(h, Casting);
    expect(c.endAt - c.startedAt).toBe(12);
    expect(c.hitAt - c.startedAt).toBe(6);
    expect(of(ev, "classic.cast")).toHaveLength(1);
    // Free exactly at endAt: a new order starts on that tick.
    sim.step(11);
    expect(sim.world.has(h, Casting)).toBe(false);
  });

  it("scales timing with attack speed and slows", () => {
    const strike = TEST_SKILLS["test.skill.strike"]!;
    const stats = { attackTicks: 12, attackSpeed: 150, castSpeed: 100 };
    expect(castTiming(strike, stats, 0)).toEqual([8, 4]);
    expect(castTiming(strike, { ...stats, attackSpeed: 100 }, 50)).toEqual([24, 12]);
    const bolt = TEST_SKILLS["test.skill.bolt"]!;
    expect(castTiming(bolt, { ...stats, castSpeed: 200 }, 0)).toEqual([5, 3]);
  });

  it("rejects busy, unknown, cooldown, mana and range problems with cast.failed", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, skills: [{ skill: "test.skill.strike", rank: 1 }], mana: 2 });
    sim.world.add(h, SkillBook, {
      ranks: [
        { skill: "test.skill.bolt", rank: 1 },
        { skill: "test.skill.mend", rank: 1 },
        { skill: "test.skill.strike", rank: 1 },
      ],
      cooldowns: [{ skill: "test.skill.mend", readyAt: 500 }],
    });
    const far = monster(sim, { x: 20, y: 5 });
    const codes: string[] = [];
    const tryOrder = (skill: string, target: Entity) => {
      order(sim, h, skill, target);
      const ev = sim.step(1);
      expect(sim.world.has(h, CastOrder)).toBe(false);
      codes.push(...of(ev, "classic.cast.failed").map((e) => e.code as string));
    };
    tryOrder("test.skill.nova", 0); // not known
    tryOrder("test.skill.mend", 0); // cooldown
    tryOrder("test.skill.bolt", 0); // 3 mana > 2
    tryOrder("test.skill.strike", far); // out of reach
    tryOrder("test.skill.strike", 0); // enemy skill without a target
    sim.world.add(h, Casting, {
      skill: "test.skill.strike",
      rank: 1,
      target: 0,
      x: 0,
      y: 0,
      startedAt: 0,
      hitAt: 999,
      endAt: 999,
      fired: false,
      pulses: 0,
    });
    tryOrder("test.skill.strike", far); // busy
    expect(codes).toEqual(["not_known", "cooldown", "no_mana", "too_far", "bad_target", "busy"]);
    expect(sim.world.read(h, Mana).mp).toBe(2);
  });

  it("spends mana, sets a sorted cooldown and faces the target", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, life: 100 });
    sim.world.read(h, SkillBook).cooldowns = [{ skill: "test.skill.zzz", readyAt: 999 }];
    order(sim, h, "test.skill.nova");
    sim.step(1);
    expect(sim.world.read(h, Mana).mp).toBe(92);
    expect(sim.world.read(h, SkillBook).cooldowns).toEqual([
      { skill: "test.skill.nova", readyAt: 40 },
      { skill: "test.skill.zzz", readyAt: 999 },
    ]);
    const m = monster(sim, { x: 5, y: 8 });
    sim.step(20);
    order(sim, h, "test.skill.bolt", m);
    sim.step(1);
    expect(sim.world.read(h, Mover).facing).toBe("sw"); // +y in tile space
  });
});

describe("skill shapes", () => {
  it("melee strike hits the target in reach (or misses) once", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, stats: { toHit: 100000 } });
    const m = monster(sim, { x: 6, y: 5, stats: { armor: 0 } });
    order(sim, h, "test.skill.strike", m);
    const ev = sim.step(12);
    const hits = of(ev, "classic.hit");
    const misses = of(ev, "classic.miss");
    expect(hits.length + misses.length).toBe(1);
    if (hits.length === 1) {
      expect(hits[0]!.byHero).toBe(true);
      expect(hp(sim, m)).toBe(200 - (hits[0]!.amount as number));
    }
  });

  it("bolt travels as a projectile, hits and is destroyed", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5 });
    const m = monster(sim, { x: 12, y: 5 });
    order(sim, h, "test.skill.bolt", 0, [sub(12), sub(5)]);
    sim.step(6); // cast at 5 ticks, first move on the same tick
    const pr = sim.world.query(Projectile);
    expect(pr).toHaveLength(1);
    const x0 = sim.world.read(pr[0]!, Pos).x;
    sim.step(1);
    expect(sim.world.read(pr[0]!, Pos).x - x0).toBe(64);
    const ev = sim.step(30);
    const hits = of(ev, "classic.hit");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.element).toBe("fire");
    // (6..10) x (100 + 20 mag)%
    expect(hits[0]!.amount).toBeGreaterThanOrEqual(7);
    expect(hits[0]!.amount).toBeLessThanOrEqual(12);
    expect(sim.world.query(Projectile)).toHaveLength(0);
    expect(hp(sim, m)).toBeLessThan(200);
  });

  it("projectiles stop at walls", () => {
    const sim = newSim();
    const map = useOpenMap(sim, 1, 32);
    for (let y = 1; y < 31; y++) map.walkable[y * 32 + 9] = 0;
    const h = hero(sim, { x: 5, y: 5 });
    const m = monster(sim, { x: 12, y: 5 });
    order(sim, h, "test.skill.bolt", 0, [sub(12), sub(5)]);
    const ev = sim.step(60);
    expect(of(ev, "classic.hit")).toHaveLength(0);
    expect(sim.world.query(Projectile)).toHaveLength(0);
    expect(hp(sim, m)).toBe(200);
    expect(sim.world.read(h, Pos).x).toBe(sub(5));
  });

  it("fans projectiles symmetrically and pierces", () => {
    expect(spreadOffsets(5, 3)).toEqual([-6, -3, 0, 3, 6]);
    expect(spreadOffsets(2, 3)).toEqual([-1, 1]);
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 10 });
    order(sim, h, "test.skill.fan", 0, [sub(15), sub(10)]);
    sim.step(6);
    const vs = sim.world.query(Projectile).map((p) => sim.world.read(p, Projectile).vy);
    expect(vs).toHaveLength(5);
    expect(vs[2]).toBe(0);
    expect(vs[0]).toBe(-vs[4]!);
    expect(vs[1]).toBe(-vs[3]!);

    const sim2 = newSim();
    const h2 = hero(sim2, { x: 5, y: 5 });
    const a = monster(sim2, { x: 9, y: 5 });
    const b = monster(sim2, { x: 12, y: 5 });
    const c = monster(sim2, { x: 15, y: 5 });
    order(sim2, h2, "test.skill.lance", 0, [sub(20), sub(5)]);
    const ev = sim2.step(60);
    expect(of(ev, "classic.hit").map((e) => e.target)).toEqual([a, b]);
    expect(hp(sim2, c)).toBe(200);
  });

  it("orb explodes on impact and hits everything in the blast", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5 });
    const a = monster(sim, { x: 11, y: 5 });
    const b = monster(sim, { x: 12, y: 6 });
    const c = monster(sim, { x: 16, y: 5 });
    order(sim, h, "test.skill.orb", 0, [sub(11), sub(5)]);
    const ev = sim.step(60);
    // Area hits are pushed in grid (entity id) order.
    expect(of(ev, "classic.hit").map((e) => e.target)).toEqual([a, b]);
    expect(hp(sim, c)).toBe(200);
    expect(of(ev, "classic.effect").some((e) => e.radius === tiles(2))).toBe(true);
  });

  it("an orb fired at a unit homes on it while it walks away perpendicular (regression)", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 16 });
    const m = monster(sim, { x: 10, y: 16 });
    // The target walks across the line of fire: a straight orb would miss it.
    const { x: x0, y: y0 } = sim.world.read(m, Pos);
    Object.assign(sim.world.read(m, Mover), { goalX: x0, goalY: y0 + tiles(10), speed: 24 });
    order(sim, h, "test.skill.orb", m);
    const ev = sim.step(80);
    expect(of(ev, "classic.hit").map((e) => e.target)).toContain(m);
    // It really moved off the original line of fire before the hit.
    expect(sim.world.read(m, Pos).y).toBeGreaterThan(y0 + tiles(1));
  });

  it("a point-aimed orb flies straight (no homing without a target unit)", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 16 });
    order(sim, h, "test.skill.orb", 0, [sub(12), sub(16)]);
    sim.step(8);
    const pr = sim.world.query(Projectile).map((e) => sim.world.read(e, Projectile));
    expect(pr.length).toBe(1);
    expect(pr[0]!.home).toBe(0);
  });

  it("overkill leaves a dead unit at 0 life, never below (regression)", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5 });
    const m = monster(sim, { x: 11, y: 5, life: 3 });
    order(sim, h, "test.skill.orb", 0, [sub(11), sub(5)]);
    sim.step(60);
    expect(sim.world.has(m, Dead)).toBe(true);
    expect(hp(sim, m)).toBe(0);
  });

  it("nova hits units in its radius and chill slows their movement", () => {
    const sim = newSim();
    const h = hero(sim, { x: 10, y: 10 });
    const near = monster(sim, { x: 12, y: 10 });
    const far = monster(sim, { x: 15, y: 10 });
    order(sim, h, "test.skill.nova");
    const ev = sim.step(6);
    expect(of(ev, "classic.hit").map((e) => e.target)).toEqual([near]);
    expect(of(ev, "classic.status").map((e) => e.target)).toEqual([near]);
    expect(of(ev, "classic.effect")[0]!.radius).toBe(tiles(3));
    expect(hp(sim, far)).toBe(200);
    // Both walk the same way: the chilled one is 40 % slower.
    for (const e of [near, far]) {
      const p = sim.world.read(e, Pos);
      Object.assign(sim.world.read(e, Mover), { goalX: p.x, goalY: p.y + tiles(10) });
    }
    const y0 = [sim.world.read(near, Pos).y, sim.world.read(far, Pos).y];
    sim.step(10);
    expect(sim.world.read(far, Pos).y - y0[1]!).toBe(400);
    expect(sim.world.read(near, Pos).y - y0[0]!).toBe(240);
  });

  it("mend heals a percentage of max life plus flat", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, life: 100 });
    sim.world.read(h, Life).hp = 40;
    order(sim, h, "test.skill.mend");
    const ev = sim.step(10);
    expect(hp(sim, h)).toBe(75);
    expect(of(ev, "classic.heal")[0]!.amount).toBe(35);
    expect(sim.world.read(h, Mana).mp).toBe(90);
  });

  it("chain bounces to the nearest unhit enemies with falloff and one polyline", () => {
    const sim = newSim();
    const h = hero(sim, { x: 4, y: 5 });
    const a = monster(sim, { x: 7, y: 5 });
    const b = monster(sim, { x: 9, y: 5 });
    const c = monster(sim, { x: 11, y: 6 });
    const d = monster(sim, { x: 25, y: 25 });
    order(sim, h, "test.skill.chain", a);
    const ev = sim.step(6);
    const hits = of(ev, "classic.hit");
    expect(hits.map((e) => e.target)).toEqual([a, b, c]);
    expect(hits.map((e) => e.amount)).toEqual([10, 5, 2]);
    expect(hp(sim, d)).toBe(200);
    const fx = of(ev, "classic.effect");
    expect(fx).toHaveLength(1);
    expect(fx[0]!.points).toHaveLength(4);
  });

  it("arc hits enemies in the cone only", () => {
    const sim = newSim();
    const h = hero(sim, { x: 10, y: 10 });
    const front = monster(sim, { x: 11, y: 10 });
    const side = monster(sim, { x: 11, y: 11 });
    const back = monster(sim, { x: 9, y: 10 });
    order(sim, h, "test.skill.arc", front);
    const ev = sim.step(6);
    expect(of(ev, "classic.hit").map((e) => e.target)).toEqual([front, side]);
    expect(hp(sim, back)).toBe(200);
    // One swing effect per cast, hits or not.
    expect(of(ev, "classic.effect")).toHaveLength(1);
  });

  it("arc emits one oriented classic.effect per swing, even when it hits nothing", () => {
    const sim = newSim();
    const h = hero(sim, { x: 10, y: 10 });
    const m = monster(sim, { x: 11, y: 10 });
    // Aimed east (+x) at the monster, which then steps out of reach (still east) before the swing lands.
    order(sim, h, "test.skill.arc", m);
    const ev = sim.step(1);
    expect(sim.world.has(h, Casting)).toBe(true);
    sim.world.update(m, Pos, { x: sub(20), y: sub(10) });
    ev.push(...sim.step(5));
    expect(of(ev, "classic.hit")).toHaveLength(0);
    const fx = of(ev, "classic.effect");
    expect(fx).toHaveLength(1);
    const reach = tiles(2);
    expect(fx[0]).toMatchObject({ x: sub(10), y: sub(10), radius: reach });
    // One point: the aim tip, `reach` along the aim from the caster.
    expect(fx[0]!.points).toEqual([{ x: sub(10) + reach, y: sub(10) }]);
    for (const k of ["x", "y", "radius"]) expect(Number.isInteger(fx[0]![k])).toBe(true);
  });

  it("aoeTarget hits around the target point", () => {
    const sim = newSim();
    const h = hero(sim, { x: 4, y: 4 });
    const a = monster(sim, { x: 12, y: 12 });
    const b = monster(sim, { x: 13, y: 12 });
    const c = monster(sim, { x: 5, y: 5 });
    order(sim, h, "test.skill.meteor", 0, [sub(12), sub(12)]);
    const ev = sim.step(6);
    expect(of(ev, "classic.hit").map((e) => e.target)).toEqual([a, b]);
    expect(hp(sim, c)).toBe(200);
  });

  it("pulse fires count novas and lets the caster move", () => {
    const sim = newSim();
    const h = hero(sim, { x: 10, y: 10 });
    const m = monster(sim, { x: 11, y: 10 });
    order(sim, h, "test.skill.whirl");
    sim.step(1);
    Object.assign(sim.world.read(h, Mover), { goalX: sub(10), goalY: sub(14) });
    const ev = sim.step(14);
    expect(of(ev, "classic.hit").filter((e) => e.target === m)).toHaveLength(3);
    expect(sim.world.read(h, Pos).y).toBeGreaterThan(sub(10));
  });

  it("dash carries the caster to the target, hits and knocks it back", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 10 });
    const m = monster(sim, { x: 11, y: 10 });
    order(sim, h, "test.skill.charge", m);
    sim.step(6);
    expect(sim.world.has(h, Dash)).toBe(true);
    const ev = sim.step(10);
    expect(sim.world.has(h, Dash)).toBe(false);
    expect(of(ev, "classic.hit").map((e) => e.target)).toEqual([m]);
    const hx = sim.world.read(h, Pos).x;
    expect(sub(11) - 160 - hx).toBeLessThanOrEqual(8);
    expect(sim.world.read(m, Pos).x).toBe(sub(11) + 256);
  });

  it("tumble dashes to a point without damage and stops at walls", () => {
    const sim = newSim();
    const map = useOpenMap(sim, 1, 32);
    for (let y = 1; y < 31; y++) map.walkable[y * 32 + 9] = 0;
    const h = hero(sim, { x: 5, y: 10 });
    order(sim, h, "test.skill.tumble", 0, [sub(11), sub(10)]);
    const ev = sim.step(20);
    expect(sim.world.has(h, Dash)).toBe(false);
    expect(of(ev, "classic.hit")).toHaveLength(0);
    const x = sim.world.read(h, Pos).x;
    expect(x).toBeLessThan(9 * 256);
    expect(x).toBeGreaterThan(8 * 256);
    expect(gridOf(sim.world).query(x, sim.world.read(h, Pos).y, 1)).toEqual([h]);
  });

  it("blink teleports up to its range onto walkable ground", () => {
    const sim = newSim();
    const h = hero(sim, { x: 4, y: 10 });
    order(sim, h, "test.skill.blink", 0, [sub(24), sub(10)]);
    const ev = sim.step(6);
    expect(sim.world.read(h, Pos)).toEqual({ x: sub(4) + tiles(8), y: sub(10) });
    expect(of(ev, "classic.effect")[0]!.points).toHaveLength(2);

    const sim2 = newSim();
    const map = useOpenMap(sim2, 1, 32);
    for (let x = 8; x < 14; x++) for (let y = 1; y < 31; y++) map.walkable[y * 32 + x] = 0;
    const h2 = hero(sim2, { x: 4, y: 10 });
    order(sim2, h2, "test.skill.blink", 0, [sub(10), sub(10)]);
    sim2.step(6);
    const p = sim2.world.read(h2, Pos);
    expect(p.x).toBeLessThan(8 * 256);
    expect(p.x).toBeGreaterThan(sub(4));
  });

  it("summon queues SpawnRequests with owner, team and expiry, respecting max", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, level: 4, stats: { level: 4 } });
    for (let i = 0; i < 3; i++) {
      order(sim, h, "test.skill.summon", 0, [sub(8), sub(5)]);
      sim.step(10);
    }
    const reqs: SpawnRequest[] = busOf(sim.world).spawns;
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({
      monster: "test.monster.dummy",
      x: sub(8),
      y: sub(5),
      depth: 1,
      level: 4,
      rarity: "summon",
      owner: h,
      team: "hero",
      until: 5 + 300,
      awake: true,
    });
  });

  it("rally buffs the caster and allies and stuns nearby enemies (interrupting casts)", () => {
    const sim = newSim();
    const h = hero(sim, { x: 10, y: 10 });
    const m = monster(sim, { x: 12, y: 10 });
    const far = monster(sim, { x: 20, y: 10 });
    order(sim, h, "test.skill.rally");
    order(sim, m, "test.mskill.bite", h);
    sim.world.read(m, SkillBook).ranks = [{ skill: "test.mskill.bite", rank: 1 }];
    sim.world.read(m, CombatStats).attackRange = tiles(3);
    sim.world.read(m, CombatStats).attackTicks = 40;
    const ev = sim.step(6);
    expect(sim.world.read(h, Statuses).list.map((s) => [s.id, s.power])).toEqual([
      ["test.status.rally", 20],
    ]);
    expect(sim.world.read(m, Statuses).list[0]!.id).toBe("test.status.stun");
    expect(sim.world.has(m, Casting)).toBe(false);
    expect(sim.world.read(far, Statuses).list).toEqual([]);
    expect(of(ev, "classic.hit").filter((e) => e.source === m)).toHaveLength(0);
  });

  it("ranged basic attacks fire the weapon projectile", () => {
    const sim = newSim();
    const h = hero(sim, {
      x: 5,
      y: 5,
      stats: { attackProjectile: "fx.arrow", attackRange: tiles(8) },
    });
    const m = monster(sim, { x: 10, y: 5 });
    order(sim, h, "test.skill.strike", m);
    sim.step(7);
    const pr = sim.world.query(Projectile);
    expect(pr).toHaveLength(1);
    expect(sim.world.read(pr[0]!, Projectile)).toMatchObject({ sprite: "fx.arrow", vx: 80, vy: 0 });
  });
});

describe("statuses", () => {
  it("dot damage over the duration totals exactly its power", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5 });
    const m = monster(sim, { x: 6, y: 5, life: 1000 });
    order(sim, h, "test.skill.ignite", m);
    const ev = sim.step(80);
    const dots = of(ev, "classic.hit").filter((e) => e.dot);
    expect(dots.length).toBe(6);
    expect(dots.reduce((a, e) => a + (e.amount as number), 0)).toBe(30);
    expect(dots.every((e) => e.element === "fire" && !e.crit)).toBe(true);
    expect(sim.world.read(m, Statuses).list).toEqual([]);
  });

  it("re-applying keeps the longer duration and the higher power, list sorted by id", () => {
    const sim = newSim();
    const m = monster(sim, { x: 6, y: 5 });
    sim.step(1);
    const ctx = { registry: sim.loaded.registry, tick: 10, emit() {} } as never;
    applyStatus(sim.world, ctx, m, { id: "test.status.stun", duration: 20, power: 1 }, 0);
    applyStatus(sim.world, ctx, m, { id: "test.status.chill", duration: 50, power: 20 }, 0);
    applyStatus(sim.world, ctx, m, { id: "test.status.chill", duration: 10, power: 40 }, 0);
    const list = sim.world.read(m, Statuses).list;
    expect(list.map((s) => s.id)).toEqual(["test.status.chill", "test.status.stun"]);
    expect(list[0]).toMatchObject({ until: 60, power: 40 });
  });
});

describe("damage resolution", () => {
  it("crits multiply by critMult", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, stats: { critPct: 100, critMult: 200 } });
    const m = monster(sim, { x: 6, y: 5 });
    order(sim, h, "test.skill.zap", m);
    const hit = of(sim.step(6), "classic.hit")[0]!;
    expect(hit).toMatchObject({ amount: 20, crit: true, element: "fire" });
  });

  it("armor reduces physical damage and resists reduce elemental damage", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, stats: { dmgMin: 20, dmgMax: 20, critPct: 0 } });
    const m = monster(sim, { x: 6, y: 5, stats: { armor: 50, resFire: 50 } });
    order(sim, h, "test.skill.smash", m);
    const a = of(sim.step(10), "classic.hit")[0]!;
    expect(a.amount).toBe(11); // 20 x (100 - 45)%
    order(sim, h, "test.skill.zap", m);
    const b = of(sim.step(10), "classic.hit")[0]!;
    expect(b.amount).toBe(5); // 10 x 50%
  });

  it("life steal heals the attacker; thorns hurt melee attackers", () => {
    const sim = newSim();
    const h = hero(sim, {
      x: 5,
      y: 5,
      stats: { dmgMin: 20, dmgMax: 20, critPct: 0, lifeSteal: 50 },
    });
    sim.world.read(h, Life).hp = 50;
    sim.world.read(h, CombatStats).armor = 0;
    const m = monster(sim, { x: 6, y: 5, stats: { armor: 0, thorns: 3 } });
    order(sim, h, "test.skill.smash", m);
    const ev = sim.step(10);
    expect(hp(sim, m)).toBe(180);
    expect(hp(sim, h)).toBe(50 + 10 - 3);
    expect(of(ev, "classic.hit").map((e) => [e.target, e.amount])).toEqual([
      [m, 20],
      [h, 3],
    ]);
  });

  it("thorns answer melee hits only", () => {
    const strike = TEST_SKILLS["test.skill.strike"]!;
    expect(isMeleeHit(strike, baseCombatStats())).toBe(true);
    expect(isMeleeHit(strike, baseCombatStats(1, { attackProjectile: "fx.arrow" }))).toBe(false);
    expect(isMeleeHit(TEST_SKILLS["test.skill.bolt"], undefined)).toBe(false);
    expect(isMeleeHit(EXTRA_SKILLS["test.skill.arc"], undefined)).toBe(true);
    expect(isMeleeHit(undefined, undefined)).toBe(false);
  });

  it("wakes sleeping targets and turns them on the attacker", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5 });
    const m = monster(sim, { x: 6, y: 5, awake: false });
    order(sim, h, "test.skill.zap", m);
    sim.step(6);
    expect(sim.world.read(m, Ai)).toMatchObject({ state: "chase", target: h });
  });

  it("deaths: Dead, grid removal, one DeathRecord credited to the hero, never twice", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5 });
    const m = monster(sim, { x: 6, y: 5, life: 5, pack: 3, stats: { armor: 0 } });
    order(sim, h, "test.skill.whirl"); // 3 pulses, the first one kills
    const ev = sim.step(20);
    expect(sim.world.read(m, Dead)).toEqual({ at: 2, killer: h });
    expect(hp(sim, m)).toBe(0);
    expect(gridOf(sim.world).has(m)).toBe(false);
    expect(of(ev, "classic.death")).toHaveLength(1);
    expect(deaths(sim)).toEqual([
      {
        entity: m,
        killer: h,
        creditTeam: "hero",
        team: "monster",
        isHero: false,
        x: sub(6),
        y: sub(5),
        depth: 1,
        monster: "test.monster.dummy",
        rarity: "normal",
        level: 1,
        xp: 10,
        pack: 3,
      },
    ]);
  });

  it("exploders detonate their burst and die by their own hand", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, life: 100 });
    const b = monster(sim, {
      x: 6,
      y: 5,
      proto: "test.monster.bloat",
      skills: ["test.mskill.burst"],
      life: 16,
    });
    order(sim, b, "test.mskill.burst");
    const ev = sim.step(20);
    expect(of(ev, "classic.hit").map((e) => [e.target, e.amount, e.element])).toEqual([
      [h, 12, "poison"],
    ]);
    // hitTick 16 of a 16-tick cast fires on the last busy tick (15).
    expect(sim.world.read(b, Dead)).toEqual({ at: 15, killer: b });
    expect(deaths(sim)).toHaveLength(1);
    expect(deaths(sim)[0]).toMatchObject({ entity: b, killer: b, creditTeam: "monster" });
  });

  it("the hero dies like any unit, with a hero DeathRecord", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, life: 10 });
    const m = monster(sim, { x: 6, y: 5, stats: { dmgMin: 50, dmgMax: 50, toHit: 100000 } });
    sim.world.read(h, CombatStats).armor = 0;
    for (let i = 0; i < 20 && !sim.world.has(h, Dead); i++) {
      order(sim, m, "test.mskill.bite", h);
      sim.step(12);
    }
    expect(sim.world.read(h, Dead).killer).toBe(m);
    expect(deaths(sim)[0]).toMatchObject({
      entity: h,
      isHero: true,
      creditTeam: "monster",
      team: "hero",
      rarity: "hero",
      monster: "",
    });
  });

  it("knockback stops at walls", () => {
    const sim = newSim();
    const map = useOpenMap(sim, 1, 32);
    for (let y = 1; y < 31; y++) map.walkable[y * 32 + 12] = 0;
    const h = hero(sim, { x: 5, y: 10 });
    const m = monster(sim, { x: 11, y: 10 });
    order(sim, h, "test.skill.charge", m);
    sim.step(20);
    const x = sim.world.read(m, Pos).x;
    expect(x).toBeGreaterThan(sub(11));
    expect(x + 56).toBeLessThan(12 * 256);
  });

  it("drops hits on targets in another area", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5, stats: { critPct: 0 } });
    const m = monster(sim, { x: 6, y: 5 });
    order(sim, h, "test.skill.zap", m);
    sim.step(1);
    sim.world.read(m, AreaTag).depth = 2;
    const ev = sim.step(10);
    expect(of(ev, "classic.hit")).toHaveLength(0);
  });

  it("ground effects tick every `every` ticks until they expire", () => {
    const sim = newSim();
    const h = hero(sim, { x: 5, y: 5 });
    const m = monster(sim, { x: 10, y: 10 });
    const g = sim.world.create();
    sim.world.add(g, GroundEffect, {
      skill: "test.skill.meteor",
      rank: 1,
      owner: h,
      team: "hero",
      radius: tiles(1),
      until: 30,
      nextAt: 0,
      every: 10,
      damage: { phys: 0, fire: 4, cold: 0, lightning: 0, poison: 0 },
      effect: "fx.test",
    });
    sim.world.add(g, Pos, { x: sub(10), y: sub(10) });
    sim.world.add(g, AreaTag, { depth: 1 });
    const ev = sim.step(40);
    expect(of(ev, "classic.hit").map((e) => e.amount)).toEqual([4, 4, 4]);
    expect(hp(sim, m)).toBe(188);
    expect(sim.world.exists(g)).toBe(false);
  });
});

describe("determinism", () => {
  function script(seed: number): Sim {
    const sim = newSim(seed);
    const h = hero(sim, { x: 5, y: 5 });
    const ms = [
      monster(sim, { x: 7, y: 5, life: 30 }),
      monster(sim, { x: 9, y: 7, life: 30 }),
      monster(sim, { x: 12, y: 5, life: 30 }),
    ];
    const plan: [string, number][] = [
      ["test.skill.strike", ms[0]!],
      ["test.skill.nova", 0],
      ["test.skill.chain", ms[1]!],
      ["test.skill.bolt", ms[2]!],
      ["test.skill.ignite", ms[0]!],
      ["test.skill.whirl", 0],
    ];
    for (const [skill, target] of plan) {
      if (target !== 0 && sim.world.has(target, Dead)) continue;
      order(sim, h, skill, target);
      for (const m of ms) if (!sim.world.has(m, Dead)) order(sim, m, "test.mskill.bite", h);
      sim.step(15);
    }
    sim.step(40);
    return sim;
  }

  it("same seed and script give the same hash; different seeds diverge", () => {
    expect(script(3).hash()).toBe(script(3).hash());
    expect(script(3).hash()).not.toBe(script(4).hash());
  });

  it("pins the hash after a fixed script", () => {
    expect(script(7).hash()).toBe("a822a57a4572986e");
  });
});
