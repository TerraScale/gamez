/**
 * Test harness (architect-owned, read-only for builders). Builds sims with a
 * chosen subset of classic modules plus either the minimal test content
 * (default) or the real classic.content, and spawns fully-formed heroes and
 * monsters directly (without progression/monsters/items modules), so each
 * module's unit tests only depend on the contract.
 *
 *   const sim = testSim(["classic.core", "classic.combat"]);
 *   const map = useOpenMap(sim, 1);            // 32x32 open room at depth 1, area set to it
 *   const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
 *   const m = spawnTestMonster(sim.world, { x: 7, y: 5 });
 *   sim.step(20);
 */
import {
  createSim,
  defineMode,
  loadMode,
  type Entity,
  type LoadedMode,
  type ModuleSpec,
  type Sim,
  type World,
} from "@gamez/kernel";
import { emptyBus } from "../../src/bus.ts";
import {
  AreaTag,
  Attributes,
  Belt,
  Body,
  CombatStats,
  type CombatStatsValue,
  Equipment,
  Faction,
  Hero,
  HeroStats,
  type HeroStatsValue,
  Intent,
  Inventory,
  Level,
  Life,
  Mana,
  Monster,
  Mover,
  Ai,
  PartyMember,
  Pos,
  SkillBar,
  SkillBook,
  Statuses,
  Supplies,
  Wallet,
} from "../../src/components.ts";
import { tileCenter } from "../../src/fixed.ts";
import { modules as classicModules } from "../../src/index.ts";
import {
  DEFAULT_AUTO_CONFIG,
  RES,
  type AreaState,
  type ControlState,
  type DungeonState,
  type ExploreState,
  type GameState,
  DEFAULT_PARTY_CONFIG,
  type PartyConfig,
  type PartyState,
} from "../../src/resources.ts";
import { gridOf } from "../../src/spatial.ts";
import type { EquipSlot, ItemInstance, MonsterRarity } from "../../src/types.ts";
import { openTestMap, setTestMap, type ClassicMap } from "../../src/world/maps.ts";
import { testContent } from "./content.ts";

export interface TestSimOptions {
  seed?: number;
  /** "test" (default): tests/support/content.ts; "real": classic.content. */
  content?: "test" | "real";
}

const loadedCache = new Map<string, LoadedMode>();

/** Loads a fixed-20Hz mode made of the given classic module ids (+ content). Cached. */
export function testLoaded(moduleIds: string[], opts: TestSimOptions = {}): LoadedMode {
  const content = opts.content ?? "test";
  const ids = [...new Set(moduleIds.filter((id) => id !== "classic.content"))].sort();
  const key = `${content}|${ids.join(",")}`;
  const hit = loadedCache.get(key);
  if (hit) return hit;
  const catalog: ModuleSpec[] = [...classicModules, testContent];
  const all = [...ids, content === "test" ? "test.content" : "classic.content"];
  const mode = defineMode({
    id: "classic",
    name: "Classic (test)",
    description: "test",
    world: null,
    modules: all,
    tick: { kind: "fixed", hz: 20 },
  });
  const loaded = loadMode(mode, catalog);
  loadedCache.set(key, loaded);
  return loaded;
}

export function testSim(moduleIds: string[], opts: TestSimOptions = {}): Sim {
  const sim = createSim(testLoaded(moduleIds, opts), { seed: opts.seed ?? 1 });
  ensureResources(sim.world);
  return sim;
}

/**
 * Creates any classic resource that is missing (when the owning module is not
 * in the test mode): game, bus, area (town), dungeon, explore, control.
 */
export function ensureResources(world: World): void {
  if (!world.getResource(RES.game)) {
    const g: GameState = { phase: "play", worldSeed: 12345, nextUid: 1, hero: 0, nextPack: 1 };
    world.setResource(RES.game, g);
  }
  if (!world.getResource(RES.bus)) world.setResource(RES.bus, emptyBus());
  if (!world.getResource(RES.area)) {
    const a: AreaState = { depth: 0, theme: "classic.theme.town", enteredAt: 0 };
    world.setResource(RES.area, a);
  }
  if (!world.getResource(RES.dungeon)) {
    const d: DungeonState = {
      deepest: 0,
      waypoints: [0],
      live: 0,
      portal: null,
      bossesKilled: [],
      liveSpawned: 0,
      liveKilled: 0,
      liveBossAlive: false,
    };
    world.setResource(RES.dungeon, d);
  }
  if (!world.getResource(RES.explore)) {
    const e: ExploreState = { areas: [] };
    world.setResource(RES.explore, e);
  }
  if (!world.getResource(RES.control)) {
    const c: ControlState = {
      mode: "manual",
      speed: 1,
      overrideUntil: 0,
      config: { ...DEFAULT_AUTO_CONFIG },
    };
    world.setResource(RES.control, c);
  }
}

/**
 * Installs an open test map (border walls) for `depth` and makes it the
 * current area. Returns the map. Also injects a town map for depth 0 when
 * depth !== 0 so town transitions work without the generator.
 */
export function useOpenMap(sim: Sim, depth = 1, size = 32): ClassicMap {
  const map = openTestMap(size, size, depth);
  setTestMap(sim.world, depth, map);
  if (depth !== 0) setTestMap(sim.world, 0, openTestMap(size, size, 0));
  useMap(sim.world, depth, map);
  return map;
}

/** Makes `map` (already installed with setTestMap) the current area. */
export function useMap(world: World, depth: number, map: ClassicMap): void {
  setTestMap(world, depth, map);
  const area = world.getResource<AreaState>(RES.area);
  if (area) {
    area.depth = depth;
    area.theme = map.theme;
  }
  const d = world.getResource<DungeonState>(RES.dungeon);
  if (d && depth > 0) {
    d.live = depth;
    d.deepest = Math.max(d.deepest, depth);
  }
  gridOf(world).rebuild(world, map.width, map.height, -1);
}

export function baseCombatStats(
  level = 1,
  patch: Partial<CombatStatsValue> = {},
): CombatStatsValue {
  return {
    level,
    armor: 10,
    toHit: 100,
    dmgMin: 2,
    dmgMax: 6,
    addFire: 0,
    addCold: 0,
    addLightning: 0,
    addPoison: 0,
    spellPct: 0,
    critPct: 5,
    critMult: 150,
    attackSpeed: 100,
    castSpeed: 100,
    moveSpeed: 100,
    resFire: 0,
    resCold: 0,
    resLightning: 0,
    resPoison: 0,
    lifeSteal: 0,
    manaSteal: 0,
    blockPct: 0,
    thorns: 0,
    attackTicks: 12,
    attackRange: 400,
    attackProjectile: "",
    attackElement: "phys",
    ...patch,
  };
}

export function emptyEquipment(): Record<EquipSlot, ItemInstance | null> {
  return {
    weapon: null,
    offhand: null,
    helm: null,
    armor: null,
    gloves: null,
    boots: null,
    amulet: null,
    ring1: null,
    ring2: null,
  };
}

export interface TestHeroOptions {
  /** Tile position. */
  x?: number;
  y?: number;
  depth?: number;
  classId?: string;
  level?: number;
  life?: number;
  mana?: number;
  skills?: { skill: string; rank: number }[];
  bar?: (string | null)[];
  stats?: Partial<CombatStatsValue>;
  gold?: number;
}

/**
 * A complete hero (every hero component) registered in GameState.hero, at
 * the centre of tile (x, y). Does not need progression/items modules; note
 * that classic.progression.stats (if loaded) will recompute its stats.
 */
export function spawnTestHero(world: World, o: TestHeroOptions = {}): Entity {
  ensureResources(world);
  const e = world.create();
  const life = o.life ?? 100;
  const mana = o.mana ?? 50;
  const level = o.level ?? 1;
  const sheet: HeroStatsValue = {
    attrs: { str: 20, dex: 20, mag: 20, vit: 20 },
    lifeMax: life,
    manaMax: mana,
    lifeRegen: 0,
    manaRegen: 0,
    magicFind: 0,
    goldFind: 0,
    lightRadius: 8,
    lifeOnKill: 0,
    manaOnKill: 0,
    allSkills: 0,
    potionPct: 0,
    twoHanded: false,
    primary: "str",
  };
  const skills = o.skills ?? [
    { skill: "test.skill.bolt", rank: 1 },
    { skill: "test.skill.strike", rank: 1 },
  ];
  world.add(e, Hero, {
    classId: o.classId ?? "test.class.fighter",
    name: "Tester",
    createdTick: 0,
  });
  world.add(e, Level, { level, xp: 0, statPoints: 0, skillPoints: 0 });
  world.add(e, Attributes, { str: 20, dex: 20, mag: 20, vit: 20 });
  world.add(e, SkillBook, {
    ranks: [...skills].sort((a, b) => (a.skill < b.skill ? -1 : 1)),
    cooldowns: [],
  });
  world.add(e, SkillBar, {
    slots: o.bar ?? ["test.skill.strike", "test.skill.bolt", null, null, null, null],
  });
  world.add(e, Life, { hp: life, max: life, acc: 0 });
  world.add(e, Mana, { mp: mana, max: mana, acc: 0 });
  world.add(e, CombatStats, baseCombatStats(level, o.stats));
  world.add(e, HeroStats, sheet);
  world.add(e, Pos, { x: tileCenter(o.x ?? 5), y: tileCenter(o.y ?? 5) });
  world.add(e, AreaTag, { depth: o.depth ?? world.getResource<AreaState>(RES.area)?.depth ?? 0 });
  world.add(e, Mover, {
    speed: 51,
    path: [],
    goalX: -1,
    goalY: -1,
    moving: false,
    facing: "s",
    blocked: 0,
  });
  world.add(e, Body, { radius: 80, solid: true });
  world.add(e, Faction, { team: "hero" });
  world.add(e, Intent, { kind: "idle", source: "manual", at: 0 });
  world.add(e, Statuses, { list: [] });
  world.add(e, Inventory, { cols: 10, rows: 4, items: [] });
  world.add(e, Equipment, emptyEquipment());
  world.add(e, Belt, {
    slots: [
      { base: "test.item.potion.life", count: 3 },
      { base: null, count: 0 },
      { base: null, count: 0 },
      { base: null, count: 0 },
    ],
    readyAt: 0,
  });
  world.add(e, Wallet, { gold: o.gold ?? 0 });
  world.add(e, Supplies, { tpScrolls: 2 });
  const g = world.getResource<GameState>(RES.game)!;
  g.hero = e;
  g.phase = "play";
  const p = world.read(e, Pos);
  gridOf(world).insert(e, p.x, p.y);
  return e;
}

export interface TestPartyOptions {
  /** Index into the heroes of the controlled hero (default 0 = the founder). */
  controlled?: number;
  config?: Partial<PartyConfig>;
  slotsBought?: number;
  /** Formation role per hero (default: "front"). */
  roles?: ("front" | "back")[];
}

/**
 * A party (docs/design/party.md §2) of spawnTestHero heroes: heroes[0] is the
 * founder (keeps Wallet + Supplies, PartyMember uid 0); the others lose
 * Wallet/Supplies like real recruits. Sets RES.party and GameState.hero (the
 * controlled one). Returns the hero entities in slot order.
 */
export function spawnTestParty(
  world: World,
  heroes: TestHeroOptions[],
  o: TestPartyOptions = {},
): Entity[] {
  if (heroes.length < 1) throw new Error("spawnTestParty: at least one hero");
  const ents = heroes.map((h, i) =>
    spawnTestHero(world, { x: 5 + i, y: 5, ...h, gold: i === 0 ? h.gold : 0 }),
  );
  ents.forEach((e, i) => {
    if (i > 0) {
      world.remove(e, Wallet);
      world.remove(e, Supplies);
    }
    world.add(e, PartyMember, {
      uid: i,
      joinedTick: 0,
      role: o.roles?.[i] ?? "front",
      kills: 0,
      deaths: 0,
    });
  });
  const party: PartyState = {
    members: [...ents],
    founder: ents[0]!,
    slotsBought: o.slotsBought ?? Math.max(0, ents.length - 1),
    nextUid: ents.length,
    config: { ...DEFAULT_PARTY_CONFIG, ...o.config },
  };
  world.setResource(RES.party, party);
  const g = world.getResource<GameState>(RES.game)!;
  g.hero = ents[o.controlled ?? 0]!;
  return ents;
}

export interface TestMonsterOptions {
  proto?: string;
  x?: number;
  y?: number;
  depth?: number;
  life?: number;
  level?: number;
  rarity?: MonsterRarity;
  awake?: boolean;
  stats?: Partial<CombatStatsValue>;
  skills?: string[];
  pack?: number;
}

/** A complete monster entity at the centre of tile (x, y) (no classic.monsters needed). */
export function spawnTestMonster(world: World, o: TestMonsterOptions = {}): Entity {
  ensureResources(world);
  const e = world.create();
  const life = o.life ?? 20;
  const level = o.level ?? 1;
  world.add(e, Monster, {
    proto: o.proto ?? "test.monster.dummy",
    level,
    rarity: o.rarity ?? "normal",
    mods: [],
    pack: o.pack ?? 0,
    name: "Dummy",
    xp: 10,
  });
  world.add(e, Ai, {
    state: o.awake === false ? "sleep" : "idle",
    target: 0,
    homeX: tileCenter(o.x ?? 8),
    homeY: tileCenter(o.y ?? 8),
    thinkAt: 0,
    repathAt: 0,
    specialAt: 0,
    count: 0,
  });
  world.add(e, SkillBook, {
    ranks: (o.skills ?? ["test.mskill.bite"])
      .map((skill) => ({ skill, rank: 1 }))
      .sort((a, b) => (a.skill < b.skill ? -1 : 1)),
    cooldowns: [],
  });
  world.add(e, Life, { hp: life, max: life, acc: 0 });
  world.add(
    e,
    CombatStats,
    baseCombatStats(level, { armor: 5, toHit: 20, dmgMin: 1, dmgMax: 3, ...o.stats }),
  );
  world.add(e, Pos, { x: tileCenter(o.x ?? 8), y: tileCenter(o.y ?? 8) });
  world.add(e, AreaTag, { depth: o.depth ?? world.getResource<AreaState>(RES.area)?.depth ?? 0 });
  world.add(e, Mover, {
    speed: 40,
    path: [],
    goalX: -1,
    goalY: -1,
    moving: false,
    facing: "s",
    blocked: 0,
  });
  world.add(e, Body, { radius: 80, solid: true });
  world.add(e, Faction, { team: "monster" });
  world.add(e, Statuses, { list: [] });
  const p = world.read(e, Pos);
  gridOf(world).insert(e, p.x, p.y);
  return e;
}

/** Steps a fixed sim `n` ticks and returns every event. */
export function run(sim: Sim, n: number) {
  return sim.step(n);
}
