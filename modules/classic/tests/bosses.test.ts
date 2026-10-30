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
import { Casting, Dead, GroundEffect, Intent, Life, Mana, Mover, Pos } from "../src/components.ts";
import { angleDiff, angleOf, angleVec, tileCenter, tiles } from "../src/fixed.ts";
import { modules as classicModules } from "../src/index.ts";
import { gridOf } from "../src/spatial.ts";
import {
  KIND,
  type MonsterProto,
  type SkillModifier,
  type SkillProto,
  type StatusProto,
} from "../src/types.ts";
import { nearSegment } from "../src/combat/telegraphs.ts";
import { ENRAGE_STATUS } from "../src/content/boss.ts";
import { getAreaMap, walkableAt } from "../src/world/maps.ts";
import { testContent } from "./support/content.ts";
import {
  ensureResources,
  spawnTestHero,
  spawnTestMonster,
  useOpenMap,
  type TestHeroOptions,
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

type Ev = GameEvent & Record<string, any>;

const of = (events: GameEvent[], type: string) => events.filter((e) => e.type === type) as Ev[];
const telegraphs = (w: World) => w.query(GroundEffect).filter((g) => w.read(g, GroundEffect).once);

function withMods(sim: Sim, h: Entity, mods: SkillModifier[]): void {
  setBonusSource(sim.world, h, "test.mods", [], mods);
}

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

describe("determinism", () => {
  function script(seed: number): Sim {
    const sim = newSim({ monsters: true, seed });
    const h = hero(sim, { x: 10, y: 20, life: 2000, stats: { dmgMin: 40, dmgMax: 60, armor: 50 } });
    withMods(sim, h, [{ skill: "*", field: "damagePct", value: 20 }]);
    const b = phaseBoss(sim, 22, 20);
    scriptedFight(sim, h, b, 600);
    return sim;
  }

  it("same seed and script give the same hash; different seeds diverge", () => {
    expect(script(3).hash()).toBe(script(3).hash());
    expect(script(3).hash()).not.toBe(script(4).hash());
  });

  it("pins the hash after a fixed script", () => {
    expect(script(7).hash()).toBe("528266a92130c624");
  });
});

// ---------------------------------------------------------------------------
// Evidence: real content, one scripted fight per boss
// ---------------------------------------------------------------------------
