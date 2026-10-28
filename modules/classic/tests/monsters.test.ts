/**
 * classic.monsters tests (owner: T4 monster builder): spawn, sleep/wake, AI
 * behaviours (they write orders and goals only), the hero distance field,
 * on-death bursts, corpse and summon removal, determinism and a pinned hash.
 * classic.combat and classic.core.movement are stubs in this workflow, so every
 * assertion is about what THIS module writes.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type GameEvent,
  type Sim,
  type SystemDef,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import {
  busOf,
  pushSpawn,
  type DeathRecord,
  type HitRequest,
  type SpawnRequest,
} from "../src/bus.ts";
import {
  Ai,
  AreaTag,
  Body,
  CastOrder,
  Casting,
  CombatStats,
  Dead,
  Faction,
  Life,
  Monster,
  Mover,
  Pos,
  SkillBook,
  Summoned,
} from "../src/components.ts";
import { angleVec, pct, tileCenter, tiles } from "../src/fixed.ts";
import { modules as classicModules } from "../src/index.ts";
import { scaleMonster } from "../src/rules.ts";
import { fieldDistance, heroField, nextStep } from "../src/monsters/field.ts";
import { aggroOf } from "../src/monsters/util.ts";
import { gridOf } from "../src/spatial.ts";
import { KIND, type MonsterModProto, type MonsterProto, type SkillProto } from "../src/types.ts";
import { openTestMap } from "../src/world/maps.ts";
import { TEST_BALANCE, TEST_SKILLS, testContent } from "./support/content.ts";
import { ensureResources, spawnTestHero, spawnTestMonster, useOpenMap } from "./support/harness.ts";

// ---------------------------------------------------------------------------
// Test-only content: the kinds the minimal test content does not define
// (exploder, summoner, charger, totem, tank, swarm, caster, boss with a summon,
// blinking and ember mods). Only this file depends on it.
// ---------------------------------------------------------------------------

function mskill(
  p: Partial<SkillProto> & Pick<SkillProto, "name" | "shape" | "target">,
): SkillProto {
  return {
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
    speedStat: "cast",
    weaponPct: 0,
    weaponPctPerRank: 0,
    damage: null,
    scaling: null,
    canMiss: false,
    effect: "fx.test",
    ai: { tags: ["basic"], priority: 1 },
    ...p,
  };
}

const EXTRA_SKILLS: Record<string, SkillProto> = {
  "test.mskill.burst": mskill({
    name: "Burst",
    shape: "aoeTarget",
    target: "self",
    radius: 2 * 256,
    castTicks: 8,
    hitTick: 4,
    damage: { element: "poison", min: 6, max: 10, minPerRank: 0, maxPerRank: 0 },
    effect: "fx.burst",
    ai: { tags: ["aoe"], priority: 1 },
  }),
  "test.mskill.raise": mskill({
    name: "Raise",
    shape: "summon",
    target: "self",
    cooldown: 60,
    castTicks: 8,
    hitTick: 4,
    summon: { monster: "test.monster.dummy", count: 2, duration: 0, max: 3 },
    effect: "fx.raise",
    ai: { tags: ["summon"], priority: 3 },
  }),
  "test.mskill.charge": mskill({
    name: "Charge",
    shape: "dash",
    target: "enemy",
    range: 7 * 256,
    weaponPct: 150,
    castTicks: 6,
    hitTick: 6,
    dash: { speed: 160, maxRange: 7 * 256 },
    effect: "fx.charge",
    ai: { tags: ["mobility"], priority: 2 },
  }),
  "test.mskill.slam": mskill({
    name: "Slam",
    shape: "nova",
    target: "self",
    radius: tiles(1.6),
    weaponPct: 130,
    castTicks: 10,
    hitTick: 5,
    cooldown: 40,
    effect: "fx.slam",
    ai: { tags: ["aoe", "control"], priority: 4 },
  }),
};

const monster = (
  p: Partial<MonsterProto> & Pick<MonsterProto, "name" | "behaviour">,
): MonsterProto => ({
  family: "test",
  description: p.name,
  appearance: "unit.monster.test",
  fallbackAppearance: "unit.hero",
  tint: 0x88ff88,
  scale: 100,
  life: 20,
  armor: 5,
  toHit: 20,
  dmgMin: 1,
  dmgMax: 3,
  element: "phys",
  resist: { fire: 0, cold: 0, lightning: 0, poison: 0 },
  xp: 10,
  moveSpeed: 40,
  radius: 80,
  skills: ["test.mskill.bite"],
  aggroRange: 8 * 256,
  keepDistance: 0,
  packSize: [2, 4],
  themes: [],
  minDepth: 1,
  weight: 0,
  ...p,
});

const EXTRA_MONSTERS: Record<string, MonsterProto> = {
  "test.monster.exploder": monster({
    name: "Bloat Test",
    behaviour: "exploder",
    skills: ["test.mskill.burst"],
    onDeathSkill: "test.mskill.burst",
    life: 16,
    moveSpeed: 44,
  }),
  "test.monster.bloat": monster({
    name: "Bloat",
    behaviour: "rusher",
    onDeathSkill: "test.mskill.burst",
  }),
  "test.monster.summoner": monster({
    name: "Summoner",
    behaviour: "summoner",
    skills: ["test.mskill.arrow", "test.mskill.raise"],
    keepDistance: 6 * 256,
  }),
  "test.monster.charger": monster({
    name: "Charger",
    behaviour: "charger",
    skills: ["test.mskill.bite", "test.mskill.charge"],
    life: 30,
  }),
  "test.monster.totem": monster({
    name: "Totem",
    behaviour: "totem",
    skills: ["test.mskill.arrow"],
    moveSpeed: 0,
    life: 30,
  }),
  "test.monster.tank": monster({
    name: "Tank",
    behaviour: "tank",
    skills: ["test.mskill.bite", "test.mskill.slam"],
    life: 60,
    moveSpeed: 26,
  }),
  "test.monster.swarm": monster({ name: "Swarm", behaviour: "swarm", moveSpeed: 62, life: 7 }),
  "test.monster.caster": monster({
    name: "Caster",
    behaviour: "caster",
    skills: ["test.mskill.arrow"],
    keepDistance: 6 * 256,
  }),
  "test.monster.warden": monster({
    name: "Warden",
    behaviour: "boss",
    skills: ["test.mskill.bite", "test.mskill.raise"],
    life: 300,
    boss: { depth: 4, title: "the Warden", minions: "test.monster.dummy", minionCount: 2 },
  }),
};

const modProto = (
  p: Partial<MonsterModProto> & Pick<MonsterModProto, "name">,
): MonsterModProto => ({
  lifePct: 0,
  dmgPct: 0,
  speedPct: 0,
  armorPct: 0,
  lifeStealPct: 0,
  blinkEvery: 0,
  extraProjectiles: 0,
  resistAll: 0,
  tint: 0xffffff,
  minDepth: 1,
  ...p,
});

const EXTRA_MODS: Record<string, MonsterModProto> = {
  "test.mod.blinking": modProto({ name: "Blinking", blinkEvery: 2 }),
  "test.mod.ember": modProto({
    name: "Emberbound",
    addElement: { element: "fire", pct: 50 },
    onDeathSkill: "test.mskill.burst",
  }),
};

/** Copies the bus hits of each tick (before cleanup) into a resource so tests can read bursts. */
const captureHits: SystemDef = {
  id: "test.monsters.captureHits",
  stage: "update",
  order: 760,
  run(world) {
    const hits = busOf(world).hits.map((h) => ({ ...h, damage: { ...h.damage } }));
    world.setResource("test.capture.hits", hits);
  },
};

const extraContent = defineModule({
  id: "test.monsters",
  version: "0.0.1",
  deps: ["test.content"],
  data(reg) {
    for (const id of Object.keys(EXTRA_SKILLS).sort())
      reg.define(KIND.skill, id, EXTRA_SKILLS[id]!);
    for (const id of Object.keys(EXTRA_MONSTERS).sort()) {
      reg.define(KIND.monster, id, EXTRA_MONSTERS[id]!);
    }
    for (const id of Object.keys(EXTRA_MODS).sort())
      reg.define(KIND.monsterMod, id, EXTRA_MODS[id]!);
  },
  systems: [captureHits],
});

/** A sim with classic.core + classic.monsters, the test content and the extra kinds above. */
function monstersSim(seed = 1): Sim {
  const mode = defineMode({
    id: "classic",
    name: "Classic (monsters test)",
    description: "test",
    world: null,
    modules: ["classic.core", "classic.monsters", "test.content", "test.monsters"],
    tick: { kind: "fixed", hz: 20 },
  });
  const sim = createSim(loadMode(mode, [...classicModules, testContent, extraContent]), { seed });
  ensureResources(sim.world);
  return sim;
}

function spawnReq(
  p: Partial<SpawnRequest> & Pick<SpawnRequest, "monster" | "x" | "y">,
): SpawnRequest {
  return {
    depth: 1,
    level: 1,
    rarity: "normal",
    mods: [],
    pack: 0,
    name: "",
    owner: 0,
    team: "monster",
    until: 0,
    awake: true,
    ...p,
  };
}

function eventsOf(events: GameEvent[], type: string): GameEvent[] {
  return events.filter((e) => e.type === type);
}

/** A fresh 32x32 open depth-1 level with the hero at tile (5, 5). */
function scene(seed = 1): { sim: Sim; hero: number } {
  const sim = monstersSim(seed);
  useOpenMap(sim, 1, 32);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
  return { sim, hero };
}

/**
 * A harness monster with its movement frozen (speed 0): behaviour tests assert
 * goals and orders, so the monster must not walk away from them while the
 * movement system runs.
 */
function mon(sim: Sim, o: Parameters<typeof spawnTestMonster>[1]): number {
  const e = spawnTestMonster(sim.world, o);
  sim.world.update(e, Mover, { speed: 0 });
  return e;
}

function deathOf(entity: number, killer: number, x: number, y: number): DeathRecord {
  return {
    entity,
    killer,
    creditTeam: "hero",
    team: "monster",
    isHero: false,
    x,
    y,
    depth: 1,
    monster: "test.monster.bloat",
    rarity: "normal",
    level: 1,
    xp: 10,
    pack: 0,
  };
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

describe("classic.monsters.spawn", () => {
  it("creates every component from a spawn request with scaled stats", () => {
    const { sim } = scene();
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(14),
        y: tileCenter(2),
        level: 6,
        pack: 3,
      }),
    );
    sim.step(1);
    const e = sim.world.query(Monster)[0]!;
    const proto = sim.loaded.registry.require<MonsterProto>(KIND.monster, "test.monster.dummy");
    const want = scaleMonster(proto, 6, "normal", []);
    expect(sim.world.read(e, Monster)).toMatchObject({
      proto: "test.monster.dummy",
      level: 6,
      rarity: "normal",
      pack: 3,
      name: "Dummy",
      xp: want.xp,
    });
    expect(sim.world.read(e, Life)).toEqual({ hp: want.life, max: want.life, acc: 0 });
    const cs = sim.world.read(e, CombatStats);
    expect(cs).toMatchObject({
      level: 6,
      armor: want.armor,
      toHit: want.toHit,
      dmgMin: want.dmgMin,
      dmgMax: want.dmgMax,
      critPct: 0,
      critMult: 150,
      attackSpeed: 100,
      moveSpeed: 100,
      resFire: 0,
      attackElement: "phys",
      attackProjectile: "",
    });
    // Melee basic attack with range 0: reach = body radius + 1 tile.
    expect(cs.attackRange).toBe(80 + tiles(1));
    expect(cs.attackTicks).toBe(TEST_SKILLS["test.mskill.bite"]!.castTicks);
    // Rank = max(1, floor(level / 3)) = 2 at level 6.
    expect(sim.world.read(e, SkillBook)).toEqual({
      ranks: [{ skill: "test.mskill.bite", rank: 2 }],
      cooldowns: [],
    });
    expect(sim.world.read(e, Mover)).toMatchObject({ speed: 40, goalX: -1, goalY: -1, path: [] });
    expect(sim.world.read(e, Body)).toEqual({ radius: 80, solid: true });
    expect(sim.world.read(e, Faction)).toEqual({ team: "monster" });
    expect(sim.world.read(e, AreaTag)).toEqual({ depth: 1 });
    expect(sim.world.read(e, Ai)).toMatchObject({ state: "idle", target: 0 });
    expect(sim.world.has(e, Summoned)).toBe(false);
    expect(gridOf(sim.world).has(e)).toBe(true);
  });

  it("names champions after their mods and scales them by rarity", () => {
    const { sim } = scene();
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(14),
        y: tileCenter(2),
        rarity: "champion",
        mods: ["test.mod.mighty"],
        level: 3,
      }),
    );
    sim.step(1);
    const e = sim.world.query(Monster)[0]!;
    const proto = sim.loaded.registry.require<MonsterProto>(KIND.monster, "test.monster.dummy");
    const mighty = sim.loaded.registry.require<MonsterModProto>(KIND.monsterMod, "test.mod.mighty");
    const want = scaleMonster(proto, 3, "champion", [mighty]);
    expect(sim.world.read(e, Monster).name).toBe("Mighty Dummy");
    expect(sim.world.read(e, Life).max).toBe(want.life);
    expect(sim.world.read(e, CombatStats).dmgMax).toBe(want.dmgMax);
    expect(sim.world.read(e, CombatStats).critPct).toBe(5);
    expect(sim.world.read(e, Monster).xp).toBe(want.xp);
  });

  it("gives an ember champion fire damage from its mod (% of average physical)", () => {
    const { sim } = scene();
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(14),
        y: tileCenter(2),
        rarity: "champion",
        mods: ["test.mod.ember"],
        level: 2,
      }),
    );
    sim.step(1);
    const e = sim.world.query(Monster)[0]!;
    const proto = sim.loaded.registry.require<MonsterProto>(KIND.monster, "test.monster.dummy");
    const ember = sim.loaded.registry.require<MonsterModProto>(KIND.monsterMod, "test.mod.ember");
    const want = scaleMonster(proto, 2, "champion", [ember]);
    const avg = Math.floor((want.dmgMin + want.dmgMax) / 2);
    expect(sim.world.read(e, CombatStats).addFire).toBe(pct(avg, 50));
    expect(sim.world.read(e, Monster).name).toBe("Emberbound Dummy");
  });

  it("uses the requested name, and emits classic.boss.spawned for bosses", () => {
    const { sim } = scene();
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.warden",
        x: tileCenter(14),
        y: tileCenter(2),
        rarity: "boss",
        level: 4,
      }),
    );
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(15),
        y: tileCenter(2),
        name: "Grimjaw",
      }),
    );
    const events = sim.step(1);
    const boss = eventsOf(events, "classic.boss.spawned");
    expect(boss).toHaveLength(1);
    expect(boss[0]).toMatchObject({ monster: "test.monster.warden", depth: 1 });
    const names = sim.world.query(Monster).map((e) => sim.world.read(e, Monster).name);
    expect(names).toEqual(["Warden, the Warden", "Grimjaw"]);
  });

  it("gives summons their owner, expiry and hero team; skips unknown ids", () => {
    const { sim, hero } = scene();
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(3),
        y: tileCenter(3),
        team: "hero",
        owner: hero,
        until: sim.tick + 100,
      }),
    );
    pushSpawn(
      sim.world,
      spawnReq({ monster: "test.monster.nope", x: tileCenter(5), y: tileCenter(5) }),
    );
    sim.step(1);
    const all = sim.world.query(Monster);
    expect(all).toHaveLength(1);
    const e = all[0]!;
    expect(sim.world.read(e, Summoned).owner).toBe(hero);
    expect(sim.world.read(e, Summoned).until).toBeGreaterThan(sim.tick);
    expect(sim.world.read(e, Faction).team).toBe("hero");
  });

  it("spawns asleep when asked, and idle otherwise", () => {
    const { sim } = scene();
    // Far away (beyond sleep range): stays asleep.
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(28),
        y: tileCenter(28),
        awake: false,
      }),
    );
    // 12 tiles from the hero: beyond aggro (8), inside sleep range (20): idle, no target.
    pushSpawn(
      sim.world,
      spawnReq({ monster: "test.monster.dummy", x: tileCenter(14), y: tileCenter(2) }),
    );
    sim.step(1);
    const [far, near] = sim.world.query(Monster);
    expect(sim.world.read(far!, Ai).state).toBe("sleep");
    expect(sim.world.read(near!, Ai)).toMatchObject({
      state: "idle",
      target: 0,
      homeX: tileCenter(14),
    });
  });
});

// ---------------------------------------------------------------------------
// Sleep and wake
// ---------------------------------------------------------------------------

describe("classic.monsters.wake", () => {
  it("checks ten monsters over ten ticks: exactly one per tick", () => {
    const { sim } = scene();
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(mon(sim, { x: 30 + (i % 5), y: 30 + Math.floor(i / 5), depth: 1 }));
    }
    const asleep = () => ids.filter((e) => sim.world.read(e, Ai).state === "sleep").length;
    sim.step(1);
    expect(asleep()).toBe(1);
    sim.step(9);
    expect(asleep()).toBe(10);
  });

  it("wakes monsters when the hero comes within sleep range", () => {
    const { sim, hero } = scene();
    const m = mon(sim, { x: 28, y: 28, depth: 1, awake: false });
    sim.step(10);
    expect(sim.world.read(m, Ai).state).toBe("sleep");
    // Walk the hero (state only) to 8 tiles away: inside sleep range.
    sim.world.update(hero, Pos, { x: tileCenter(20), y: tileCenter(20) });
    sim.step(10);
    expect(sim.world.read(m, Ai).state).toBe("idle");
  });

  it("wakes the sleeping pack of a chasing monster", () => {
    // b is far from the hero (25 tiles) and 11 tiles from a, which is inside sleep range.
    // Only a pack wake can make b idle; the stagger check would put it back to sleep.
    const wasIdle = (chasing: boolean): boolean => {
      const { sim } = scene();
      const a = mon(sim, { x: 19, y: 5, depth: 1, pack: 5 });
      const b = mon(sim, { x: 30, y: 5, depth: 1, pack: 5, awake: false });
      if (chasing) sim.world.update(a, Ai, { state: "chase" });
      let idle = false;
      for (let i = 0; i < 10; i++) {
        sim.step(1);
        if (sim.world.read(b, Ai).state === "idle") idle = true;
      }
      return idle;
    };
    expect(wasIdle(false)).toBe(false);
    expect(wasIdle(true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hero distance field
// ---------------------------------------------------------------------------

describe("hero distance field", () => {
  it("routes a chaser around a wall through its gap", () => {
    const map = openTestMap(16, 16, 1);
    // Wall on column 8 from row 2 to row 14: the only gap is row 1 (row 0 and 15 are the border).
    for (let y = 2; y <= 14; y++) map.walkable[y * map.width + 8] = 0;
    const field = heroField(map, 12, 8);
    const path: { x: number; y: number }[] = [];
    let at = { x: 4, y: 8 };
    for (let i = 0; i < 100; i++) {
      path.push(at);
      const next = nextStep(map, field, at.x, at.y);
      if (next === null) break;
      at = next;
    }
    expect(at).toEqual({ x: 12, y: 8 });
    expect(path.some((p) => p.x === 8 && p.y === 1)).toBe(true);
    expect(path.some((p) => p.x === 8 && p.y >= 2 && p.y <= 14)).toBe(false);
    expect(fieldDistance(field, 4, 8)).toBeGreaterThan(8);
  });

  it("memoises one field per map and hero tile, and stops at its radius", () => {
    const map = openTestMap(80, 8, 1);
    const a = heroField(map, 2, 2);
    expect(heroField(map, 2, 2)).toBe(a);
    expect(heroField(map, 3, 2)).not.toBe(a);
    expect(fieldDistance(a, 60, 2)).toBeUndefined();
    expect(fieldDistance(a, 20, 2)).toBe(18);
  });
});

// ---------------------------------------------------------------------------
// Behaviours (orders and goals only)
// ---------------------------------------------------------------------------

describe("classic.monsters.think behaviours", () => {
  it("rusher closes in along the hero field, then orders its basic attack in reach", () => {
    const { sim, hero } = scene();
    const m = mon(sim, { proto: "test.monster.dummy", x: 9, y: 5, depth: 1 });
    sim.step(4);
    expect(sim.world.read(m, Ai)).toMatchObject({ state: "chase", target: hero });
    // Next field step toward the hero: one tile closer in x.
    expect(sim.world.read(m, Mover).goalX).toBe(tileCenter(8));

    sim.world.update(m, Pos, { x: tileCenter(6), y: tileCenter(5) });
    sim.step(1);
    expect(sim.world.read(m, Ai).state).toBe("attack");
    expect(sim.world.read(m, CastOrder)).toEqual({
      skill: "test.mskill.bite",
      target: hero,
      x: tileCenter(5),
      y: tileCenter(5),
    });
    expect(sim.world.read(m, Mover).goalX).toBe(-1);
  });

  it("archer steps away when too close (kite)", () => {
    const { sim } = scene();
    const a = mon(sim, { proto: "test.monster.archer", x: 7, y: 5, depth: 1 });
    sim.step(4);
    expect(sim.world.read(a, Ai).state).toBe("kite");
    expect(sim.world.read(a, Mover).goalX).toBeGreaterThan(tileCenter(7));
    expect(sim.world.has(a, CastOrder)).toBe(false);
  });

  it("archer shoots arrows from range with line of sight", () => {
    const { sim, hero } = scene();
    const a = mon(sim, {
      proto: "test.monster.archer",
      x: 12,
      y: 5,
      depth: 1,
      stats: { attackRange: 8 * 256, attackProjectile: "fx.arrow" },
    });
    sim.step(4);
    expect(sim.world.read(a, CastOrder)).toEqual({
      skill: "test.mskill.arrow",
      target: hero,
      x: tileCenter(5),
      y: tileCenter(5),
    });
  });

  it("exploder orders its burst at point blank and chases from further away", () => {
    const { sim } = scene();
    const near = mon(sim, { proto: "test.monster.exploder", x: 6, y: 5, depth: 1 });
    sim.step(4);
    expect(sim.world.read(near, CastOrder)).toEqual({
      skill: "test.mskill.burst",
      target: 0,
      x: tileCenter(6),
      y: tileCenter(5),
    });
    const far = mon(sim, { proto: "test.monster.exploder", x: 9, y: 9, depth: 1 });
    sim.step(4);
    expect(sim.world.has(far, CastOrder)).toBe(false);
    expect(sim.world.read(far, Mover).goalX).toBeLessThan(tileCenter(9));
  });

  it("summoner raises minions when it has none", () => {
    const { sim } = scene();
    const s = mon(sim, { proto: "test.monster.summoner", x: 9, y: 5, depth: 1 });
    sim.step(4);
    expect(sim.world.read(s, CastOrder)).toEqual({
      skill: "test.mskill.raise",
      target: 0,
      x: tileCenter(9),
      y: tileCenter(5),
    });
    expect(sim.world.read(s, Ai).specialAt).toBeGreaterThan(sim.tick);
  });

  it("charger winds up a charge from 3 to 7 tiles and sets its cooldown", () => {
    const { sim, hero } = scene();
    const c = mon(sim, { proto: "test.monster.charger", x: 10, y: 5, depth: 1 });
    sim.step(4);
    expect(sim.world.read(c, CastOrder)).toMatchObject({
      skill: "test.mskill.charge",
      target: hero,
    });
    expect(sim.world.read(c, Ai)).toMatchObject({ state: "charge" });
    // Cooldown of 100 ticks from the think tick (one of the last four ticks).
    const until = sim.world.read(c, Ai).specialAt;
    expect(until).toBeGreaterThanOrEqual(sim.tick + 97);
    expect(until).toBeLessThanOrEqual(sim.tick + 100);
  });

  it("tank slams when two hero-team units crowd it", () => {
    const { sim, hero } = scene();
    // A hero-team summon next to the tank's spot (spawned first, so the tank has no earlier order).
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(6),
        y: tileCenter(6),
        team: "hero",
        owner: hero,
      }),
    );
    sim.step(1);
    const t = mon(sim, { proto: "test.monster.tank", x: 6, y: 5, depth: 1 });
    sim.step(4);
    expect(sim.world.read(t, CastOrder)).toEqual({
      skill: "test.mskill.slam",
      target: 0,
      x: tileCenter(6),
      y: tileCenter(5),
    });
  });

  it("swarm approaches the hero from an angle chosen by its id", () => {
    const { sim, hero } = scene();
    const s = mon(sim, { proto: "test.monster.swarm", x: 7, y: 5, depth: 1 });
    sim.step(4);
    const [ox, oy] = angleVec((s % 8) * 8, tiles(1.2));
    expect(sim.world.read(s, Mover)).toMatchObject({
      goalX: tileCenter(5) + ox,
      goalY: tileCenter(5) + oy,
    });
    expect(sim.world.read(s, Ai).target).toBe(hero);
  });

  it("caster falls back to its home when the hero is adjacent", () => {
    const { sim } = scene();
    const c = mon(sim, { proto: "test.monster.caster", x: 9, y: 9, depth: 1 });
    sim.world.update(c, Pos, { x: tileCenter(6), y: tileCenter(5) });
    sim.step(4);
    expect(sim.world.read(c, Ai).state).toBe("flee");
    const path = sim.world.read(c, Mover).path;
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual({ x: 9, y: 9 });
  });

  it("boss summons its minions when below 90 % life", () => {
    const { sim, hero } = scene();
    const b = mon(sim, { proto: "test.monster.warden", x: 9, y: 5, depth: 1, life: 300 });
    sim.world.update(b, Life, { hp: 100 });
    sim.step(4);
    expect(sim.world.read(b, CastOrder)).toEqual({
      skill: "test.mskill.raise",
      target: 0,
      x: tileCenter(9),
      y: tileCenter(5),
    });
    expect(sim.world.read(b, Ai).target).toBe(hero);
  });

  it("boss does not summon at full life", () => {
    const { sim } = scene();
    const b = mon(sim, { proto: "test.monster.warden", x: 9, y: 5, depth: 1, life: 300 });
    sim.step(4);
    expect(sim.world.has(b, CastOrder)).toBe(false);
    expect(sim.world.read(b, Ai).state).toBe("chase");
  });

  it("totem never moves and targets the nearest enemy in range", () => {
    const { sim, hero } = scene();
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.totem",
        x: tileCenter(10),
        y: tileCenter(10),
        team: "hero",
        owner: hero,
      }),
    );
    sim.step(1);
    const totem = sim.world
      .query(Summoned)
      .find((e) => sim.world.read(e, Monster).proto === "test.monster.totem")!;
    const near = mon(sim, { x: 12, y: 10, depth: 1 });
    mon(sim, { x: 14, y: 10, depth: 1 });
    sim.step(4);
    expect(sim.world.read(totem, CastOrder)).toMatchObject({
      skill: "test.mskill.arrow",
      target: near,
    });
    expect(sim.world.read(totem, Mover)).toMatchObject({ goalX: -1, goalY: -1, path: [] });
  });

  it("blinking mod teleports next to its target", () => {
    const { sim, hero } = scene();
    const m = mon(sim, { x: 12, y: 5, depth: 1 });
    sim.world.update(m, Monster, { mods: ["test.mod.blinking"] });
    const events: GameEvent[] = [];
    for (let i = 0; i < 4; i++) events.push(...sim.step(1));
    const p = sim.world.read(m, Pos);
    const hp = sim.world.read(hero, Pos);
    expect(Math.hypot(p.x - hp.x, p.y - hp.y)).toBeLessThanOrEqual(tiles(1.5));
    expect(
      eventsOf(events, "classic.effect").some(
        (e) => e.type === "classic.effect" && e.effect === "fx.phase_step",
      ),
    ).toBe(true);
  });

  it("returns home along an A* path after losing contact for 100 ticks", () => {
    const { sim, hero } = scene();
    const m = mon(sim, { x: 17, y: 5, depth: 1 });
    sim.world.update(m, Ai, { state: "chase", homeX: tileCenter(3), homeY: tileCenter(3) });
    sim.step(60);
    expect(sim.world.read(m, Ai)).toMatchObject({ state: "chase", target: hero });
    sim.step(60);
    expect(sim.world.read(m, Ai)).toMatchObject({ state: "return", target: 0 });
    const path = sim.world.read(m, Mover).path;
    expect(path[path.length - 1]).toEqual({ x: 3, y: 3 });
    expect(aggroOf(sim.world).last[String(m)]).toBeUndefined();
  });

  it("does not move or order while casting", () => {
    const { sim } = scene();
    const m = mon(sim, { x: 17, y: 5, depth: 1 });
    sim.world.update(m, Ai, { state: "return", homeX: tileCenter(3), homeY: tileCenter(3) });
    sim.world.add(m, Casting, {
      skill: "test.mskill.bite",
      rank: 1,
      target: 0,
      x: 0,
      y: 0,
      startedAt: sim.tick,
      hitAt: sim.tick + 5,
      endAt: sim.tick + 20,
      fired: false,
      pulses: 0,
    });
    sim.step(8);
    expect(sim.world.read(m, Mover)).toMatchObject({ goalX: -1, path: [] });
    expect(sim.world.read(m, Ai).state).toBe("return");
  });
});

// ---------------------------------------------------------------------------
// On-death bursts
// ---------------------------------------------------------------------------

describe("classic.monsters.onDeath", () => {
  it("pushes one burst hit per hero-team unit in radius, and emits the effect", () => {
    const { sim, hero } = scene();
    const m = mon(sim, { proto: "test.monster.bloat", x: 6, y: 5, depth: 1 });
    sim.world.add(m, Dead, { at: sim.tick, killer: hero });
    busOf(sim.world).deaths.push(deathOf(m, hero, tileCenter(6), tileCenter(5)));
    const events = sim.step(1);
    const hits = sim.world
      .getResource<HitRequest[]>("test.capture.hits")!
      .filter((h) => h.skill === "test.mskill.burst");
    expect(hits.map((h) => h.target)).toEqual([hero]);
    expect(hits[0]!.source).toBe(m);
    expect(hits[0]!.damage.poison).toBeGreaterThanOrEqual(6);
    expect(eventsOf(events, "classic.effect")).toContainEqual(
      expect.objectContaining({ effect: "fx.burst" }),
    );
  });

  it("does not burst from a hero outside the radius", () => {
    const { sim, hero } = scene();
    sim.world.update(hero, Pos, { x: tileCenter(20), y: tileCenter(20) });
    const m = mon(sim, { proto: "test.monster.bloat", x: 6, y: 5, depth: 1 });
    sim.world.add(m, Dead, { at: sim.tick, killer: hero });
    busOf(sim.world).deaths.push(deathOf(m, hero, tileCenter(6), tileCenter(5)));
    sim.step(1);
    const hits = sim.world.getResource<HitRequest[]>("test.capture.hits")!;
    expect(hits).toEqual([]);
  });

  it("skips the on-death skill when the monster killed itself (exploder burst)", () => {
    const { sim, hero } = scene();
    const m = mon(sim, { proto: "test.monster.exploder", x: 6, y: 5, depth: 1 });
    sim.world.add(m, Dead, { at: sim.tick, killer: m });
    busOf(sim.world).deaths.push(deathOf(m, m, tileCenter(6), tileCenter(5)));
    sim.step(1);
    expect(sim.world.getResource<HitRequest[]>("test.capture.hits")).toEqual([]);
    expect(hero).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Corpses and summons
// ---------------------------------------------------------------------------

describe("classic.monsters.corpses", () => {
  it("removes a monster corpseTicks after its death and never the hero", () => {
    const { sim, hero } = scene();
    const m = mon(sim, { x: 9, y: 9, depth: 1 });
    sim.world.add(m, Dead, { at: sim.tick, killer: hero });
    sim.world.add(hero, Dead, { at: sim.tick, killer: 0 });
    sim.step(TEST_BALANCE.corpseTicks / 2);
    expect(sim.world.exists(m)).toBe(true);
    sim.step(TEST_BALANCE.corpseTicks);
    expect(sim.world.exists(m)).toBe(false);
    expect(sim.world.exists(hero)).toBe(true);
  });

  it("expires a summon at its until tick", () => {
    const { sim, hero } = scene();
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(3),
        y: tileCenter(8),
        team: "hero",
        owner: hero,
        until: sim.tick + 10,
      }),
    );
    sim.step(1);
    const s = sim.world.query(Summoned)[0]!;
    sim.step(4);
    expect(sim.world.exists(s)).toBe(true);
    sim.step(10);
    expect(sim.world.exists(s)).toBe(false);
  });

  it("expires summons when their owner dies or leaves the area", () => {
    const { sim, hero } = scene();
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(3),
        y: tileCenter(8),
        team: "hero",
        owner: hero,
      }),
    );
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(4),
        y: tileCenter(8),
        team: "hero",
        owner: hero,
      }),
    );
    sim.step(1);
    const [a, b] = sim.world.query(Summoned);
    sim.world.add(hero, Dead, { at: sim.tick, killer: 0 });
    sim.step(1);
    expect(sim.world.exists(a!)).toBe(false);
    expect(sim.world.exists(b!)).toBe(false);
  });

  it("expires a summon whose owner is in another area", () => {
    const { sim, hero } = scene();
    pushSpawn(
      sim.world,
      spawnReq({
        monster: "test.monster.dummy",
        x: tileCenter(3),
        y: tileCenter(8),
        team: "hero",
        owner: hero,
      }),
    );
    sim.step(1);
    const s = sim.world.query(Summoned)[0]!;
    sim.world.update(hero, AreaTag, { depth: 2 });
    sim.step(1);
    expect(sim.world.exists(s)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism and a pinned hash
// ---------------------------------------------------------------------------

/** A fixed script with every behaviour family in play. */
function script(seed: number): Sim {
  const { sim, hero } = scene(seed);
  mon(sim, { proto: "test.monster.dummy", x: 9, y: 5, depth: 1 });
  mon(sim, { proto: "test.monster.archer", x: 13, y: 9, depth: 1 });
  mon(sim, { proto: "test.monster.exploder", x: 6, y: 9, depth: 1 });
  mon(sim, { proto: "test.monster.caster", x: 12, y: 2, depth: 1 });
  mon(sim, { proto: "test.monster.warden", x: 10, y: 11, depth: 1, life: 300 });
  const far = mon(sim, { proto: "test.monster.dummy", x: 26, y: 26, depth: 1, awake: false });
  pushSpawn(
    sim.world,
    spawnReq({
      monster: "test.monster.dummy",
      x: tileCenter(4),
      y: tileCenter(14),
      pack: 2,
      rarity: "champion",
      mods: ["test.mod.mighty"],
      level: 3,
    }),
  );
  sim.world.update(far, Ai, { state: "sleep" });
  sim.step(60);
  sim.world.update(hero, Pos, { x: tileCenter(14), y: tileCenter(14) });
  sim.step(140);
  return sim;
}

describe("classic.monsters determinism", () => {
  it("the same seed and script give the same hash", () => {
    expect(script(7).hash()).toBe(script(7).hash());
  });

  it("the hash after the fixed script is pinned", () => {
    expect(script(7).hash()).toBe("7420c08e3f54b393");
  });
});
