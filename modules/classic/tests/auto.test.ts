/**
 * classic.auto unit tests (T7). The controller only reads world state and
 * writes the hero Intent, AutoState and Bus.commands, so these tests run it
 * in an isolated mode: the architect's core infrastructure (setup, spatial
 * grid, cleanup — no intent executor or movement), classic.auto, the minimal
 * test content plus a few extra prototypes, and a spy module that records
 * every queued HeroCommand. Nothing here depends on another builder's module.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type Entity,
  type LoadedMode,
  type SimContext,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import type { HeroCommand } from "../src/actions.ts";
import { classicAuto } from "../src/auto/index.ts";
import { allocCycle, skillPlan, statPlan } from "../src/auto/allocate.ts";
import { computeOffline } from "../src/auto/offline.ts";
import { itemScore } from "../src/auto/score.ts";
import { AutoLeave, ensureAutoState, TOWN_STEPS } from "../src/auto/util.ts";
import { busOf } from "../src/bus.ts";
import {
  Ai,
  AutoState,
  Belt,
  Dead,
  Equipment,
  Intent,
  Interactable,
  Inventory,
  Level,
  Life,
  Loot,
  Mana,
  Npc,
  Pos,
  AreaTag,
  Body,
  Supplies,
  type InteractableKind,
} from "../src/components.ts";
import { noteManual } from "../src/control.ts";
import { cleanupSystem, setupCore, spatialSystem } from "../src/core/infra.ts";
import { tileCenter } from "../src/fixed.ts";
import { MODULE } from "../src/ids.ts";
import {
  controlOf,
  DEFAULT_AUTO_CONFIG,
  RES,
  type DungeonState,
  type ExploreArea,
  type ExploreState,
  type QuestState,
  type RunStats,
} from "../src/resources.ts";
import { KIND, type ItemInstance, type ItemRarity, type MonsterProto } from "../src/types.ts";
import { lineOfSight, type ClassicMap } from "../src/world/maps.ts";
import { testContent } from "./support/content.ts";
import {
  ensureResources,
  spawnTestHero,
  spawnTestMonster,
  testSim,
  useOpenMap,
} from "./support/harness.ts";

// ---------------------------------------------------------------------------
// Isolated test mode
// ---------------------------------------------------------------------------

type LoggedCommand = HeroCommand & { tick: number };
interface SpyLog {
  cmds: LoggedCommand[];
}
const SPY = "test.spy";

/** Core infrastructure only (setup + spatial grid + cleanup), no intent executor/movement. */
const infraCore = defineModule({
  id: MODULE.core,
  version: "0.0.0-auto-test",
  setup: setupCore,
  systems: [spatialSystem, cleanupSystem],
});

/** Records and drains every queued command before any owner would run. */
const spy = defineModule({
  id: SPY,
  version: "0.0.1",
  deps: [MODULE.core],
  setup(world) {
    world.setResource<SpyLog>(SPY, { cmds: [] });
  },
  systems: [
    {
      id: "test.spy.commands",
      stage: "update",
      order: -1,
      run(world, ctx) {
        const log = world.getResource<SpyLog>(SPY)!;
        const bus = busOf(world);
        for (const c of bus.commands) log.cmds.push({ ...c, tick: ctx.tick } as LoggedCommand);
        bus.commands.length = 0;
      },
    },
  ],
});

const monsterTemplate: MonsterProto = {
  name: "x",
  family: "test",
  description: "x",
  appearance: "unit.monster.test",
  fallbackAppearance: "unit.hero",
  tint: 0,
  scale: 100,
  behaviour: "rusher",
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
  packSize: [1, 1],
  themes: [],
  minDepth: 1,
  weight: 1,
};

/** Extra prototypes for behaviour-specific tests (original test-only names). */
const extraContent = defineModule({
  id: "test.autocontent",
  version: "0.0.1",
  data(reg) {
    reg.define<MonsterProto>(KIND.monster, "test.monster.exploder", {
      ...monsterTemplate,
      name: "Popper",
      behaviour: "exploder",
    });
    reg.define<MonsterProto>(KIND.monster, "test.monster.caster", {
      ...monsterTemplate,
      name: "Chanter",
      behaviour: "caster",
      keepDistance: 6 * 256,
    });
  },
});

let loadedCache: LoadedMode | null = null;
function autoLoaded(): LoadedMode {
  if (loadedCache) return loadedCache;
  const mode = defineMode({
    id: "classic",
    name: "Classic (auto test)",
    description: "auto test",
    world: null,
    modules: [MODULE.core, MODULE.auto, "test.content", "test.autocontent", SPY],
    tick: { kind: "fixed", hz: 20 },
  });
  loadedCache = loadMode(mode, [infraCore, classicAuto, testContent, extraContent, spy]);
  return loadedCache;
}

function autoSim(seed = 1): Sim {
  const sim = createSim(autoLoaded(), { seed });
  ensureResources(sim.world);
  return sim;
}

function cmds(sim: Sim): LoggedCommand[] {
  return sim.world.getResource<SpyLog>(SPY)!.cmds;
}
function ops(sim: Sim): string[] {
  return cmds(sim).map((c) => c.op);
}
function clearCmds(sim: Sim): void {
  sim.world.getResource<SpyLog>(SPY)!.cmds.length = 0;
}

function setMode(sim: Sim, mode: "manual" | "auto" | "idle"): void {
  const r = sim.dispatch("classic.setControl", { mode }, null);
  expect(r.ok).toBe(true);
}

/** Dungeon depth 1 open map, hero at (5,5), controller on. */
function dungeon(
  opts: Parameters<typeof spawnTestHero>[1] = {},
  depth = 1,
): {
  sim: Sim;
  map: ClassicMap;
  hero: Entity;
} {
  const sim = autoSim();
  const map = useOpenMap(sim, depth);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth, ...opts });
  setMode(sim, "auto");
  return { sim, map, hero };
}

function intentOf(sim: Sim, hero: Entity) {
  return sim.world.read(hero, Intent);
}
function stateOf(sim: Sim, hero: Entity) {
  return sim.world.read(hero, AutoState);
}

function item(
  uid: number,
  base: string,
  rarity: ItemRarity,
  mods: ItemInstance["mods"] = [],
): ItemInstance {
  return { uid, base, rarity, ilvl: 1, name: base, mods, affixes: [], value: 20 };
}

function spawnLoot(
  sim: Sim,
  x: number,
  y: number,
  l: { kind: "item" | "gold" | "potion"; item?: ItemInstance; gold?: number; potion?: string },
  depth = 1,
): Entity {
  const e = sim.world.create();
  sim.world.add(e, Loot, {
    kind: l.kind,
    item: l.item ?? null,
    gold: l.gold ?? 0,
    potion: l.potion ?? "",
    droppedAt: 0,
  });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth });
  return e;
}

function spawnNpc(sim: Sim, proto: string, x: number, y: number): Entity {
  const e = sim.world.create();
  sim.world.add(e, Npc, { proto });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth: 0 });
  sim.world.add(e, Body, { radius: 80, solid: true });
  return e;
}

function spawnInteractable(
  sim: Sim,
  kind: InteractableKind,
  x: number,
  y: number,
  depth: number,
  toDepth = 0,
): Entity {
  const e = sim.world.create();
  sim.world.add(e, Interactable, { kind, toDepth });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth });
  return e;
}

/** Exploration bits for `depth`: every walkable tile for which `explored(x, y)` holds. */
function setExplored(
  sim: Sim,
  map: ClassicMap,
  explored: (x: number, y: number) => boolean,
): ExploreArea {
  const bits: number[] = Array.from({ length: Math.ceil((map.width * map.height) / 32) }, () => 0);
  let revealed = 0;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const i = y * map.width + x;
      if (map.walkable[i] !== 1 || !explored(x, y)) continue;
      bits[i >> 5] = (bits[i >> 5]! | (1 << (i & 31))) >>> 0;
      revealed++;
    }
  }
  const area: ExploreArea = {
    depth: map.depth,
    width: map.width,
    bits,
    revealed,
    total: map.walkableCount,
  };
  const st = sim.world.getResource<ExploreState>(RES.explore)!;
  st.areas = [...st.areas.filter((a) => a.depth !== map.depth), area];
  return area;
}

function setLife(sim: Sim, hero: Entity, hp: number): void {
  sim.world.update(hero, Life, { hp });
}

// ---------------------------------------------------------------------------
// Control actions
// ---------------------------------------------------------------------------

describe("control actions", () => {
  it("sets up ControlState with defaults", () => {
    const sim = autoSim();
    // A new game starts in Auto: the hero plays itself until the player takes over.
    expect(controlOf(sim.world)).toEqual({
      mode: "auto",
      speed: 1,
      overrideUntil: 0,
      config: DEFAULT_AUTO_CONFIG,
    });
  });

  it("switches modes and emits classic.control; manual/auto reset the speed", () => {
    const sim = autoSim();
    const r = sim.dispatch("classic.setControl", { mode: "idle" }, null);
    expect(r.ok).toBe(true);
    expect(r.events).toContainEqual({ type: "classic.control", mode: "idle", speed: 1 });
    expect(sim.dispatch("classic.setSpeed", { speed: 8 }, null).ok).toBe(true);
    expect(controlOf(sim.world).speed).toBe(8);
    expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
    expect(controlOf(sim.world)).toMatchObject({ mode: "auto", speed: 1 });
  });

  it("rejects setSpeed unless idle, and bad speeds (hash unchanged)", () => {
    const sim = autoSim();
    const h = sim.hash();
    const r = sim.dispatch("classic.setSpeed", { speed: 4 }, null);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("mode_not_idle");
    expect(sim.hash()).toBe(h);
    setMode(sim, "idle");
    const h2 = sim.hash();
    for (const speed of [3, 0, 16, "2", null]) {
      const bad = sim.dispatch("classic.setSpeed", { speed }, null);
      expect(bad.ok).toBe(false);
      expect(bad.error?.code).toBe("bad_payload");
    }
    expect(sim.hash()).toBe(h2);
  });

  it("rejects bad setControl payloads (hash unchanged)", () => {
    const sim = autoSim();
    const h = sim.hash();
    for (const p of [{ mode: "turbo" }, {}, null, 3, { mode: 1 }]) {
      const r = sim.dispatch("classic.setControl", p, null);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("bad_payload");
    }
    expect(sim.hash()).toBe(h);
  });

  it("validates setAutoConfig field by field", () => {
    const sim = autoSim();
    const h = sim.hash();
    const bad = [
      { config: { unknownKey: 1 } },
      { config: { lifePotionPct: 101 } },
      { config: { lifePotionPct: 20.5 } },
      { config: { retreatPct: -1 } },
      { config: { pickupRarity: "legendary" } },
      { config: { autoEquip: "yes" } },
      { config: { maxDepth: -2 } },
      { config: null },
      {},
    ];
    for (const p of bad) {
      const r = sim.dispatch("classic.setAutoConfig", p, null);
      expect(r.ok, JSON.stringify(p)).toBe(false);
      expect(r.error?.code).toBe("bad_payload");
    }
    expect(sim.hash()).toBe(h);
    const ok = sim.dispatch(
      "classic.setAutoConfig",
      { config: { lifePotionPct: 60, keepRarity: "magic", maxDepth: 5, autoDescend: false } },
      null,
    );
    expect(ok.ok).toBe(true);
    expect(controlOf(sim.world).config).toEqual({
      ...DEFAULT_AUTO_CONFIG,
      lifePotionPct: 60,
      keepRarity: "magic",
      maxDepth: 5,
      autoDescend: false,
    });
  });

  it("switching to manual stops the controller's intent", () => {
    const { sim, hero } = dungeon();
    spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    sim.step(1);
    expect(intentOf(sim, hero).source).toBe("auto");
    setMode(sim, "manual");
    expect(intentOf(sim, hero).kind).toBe("idle");
    expect(stateOf(sim, hero).plan).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

describe("activation", () => {
  it("does nothing in manual mode", () => {
    const sim = autoSim();
    setMode(sim, "manual");
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1, life: 100 });
    setLife(sim, hero, 10);
    spawnTestMonster(sim.world, { x: 7, y: 5, depth: 1 });
    const before = intentOf(sim, hero);
    sim.step(30);
    expect(intentOf(sim, hero)).toEqual(before);
    expect(sim.world.has(hero, AutoState)).toBe(false);
    expect(cmds(sim)).toEqual([]);
  });

  it("pauses after a manual action (noteManual) and resumes after the override", () => {
    const { sim, hero } = dungeon();
    spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    noteManual(sim.world, { tick: sim.tick } as SimContext);
    const until = controlOf(sim.world).overrideUntil;
    expect(until).toBe(sim.tick + 60);
    sim.step(59);
    expect(intentOf(sim, hero).source).toBe("manual");
    sim.step(2);
    expect(intentOf(sim, hero)).toMatchObject({ kind: "skill", source: "auto" });
  });

  it("works through the shared harness with the real classic.core module", () => {
    const sim = testSim(["classic.core", "classic.auto"]);
    expect(controlOf(sim.world).mode).toBe("auto");
    expect(sim.dispatch("classic.setControl", { mode: "manual" }, null).ok).toBe(true);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
    spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    const events = sim.step(1);
    expect(stateOf(sim, hero).plan).toBe("fight");
    expect(events).toContainEqual({ type: "classic.auto.plan", plan: "fight", note: "Dummy" });
  });
});

// ---------------------------------------------------------------------------
// Danger: death, potions, retreat
// ---------------------------------------------------------------------------

describe("survival", () => {
  it("respawns after respawnDelay", () => {
    const { sim, hero } = dungeon();
    sim.world.add(hero, Dead, { at: sim.tick, killer: 0 });
    const diedAt = sim.tick;
    sim.step(60);
    expect(ops(sim)).toEqual([]);
    expect(stateOf(sim, hero).plan).toBe("dead");
    sim.step(1);
    expect(cmds(sim)).toEqual([{ op: "respawn", tick: diedAt + 60 }]);
  });

  it("drinks a life potion below lifePotionPct and respects the belt cooldown", () => {
    const { sim, hero } = dungeon({ life: 100 });
    setLife(sim, hero, 40);
    sim.step(1);
    expect(cmds(sim)).toContainEqual({ op: "drink", slot: 0, tick: 0 });
    clearCmds(sim);
    sim.world.update(hero, Belt, { readyAt: sim.tick + 5 });
    sim.step(5);
    expect(ops(sim)).not.toContain("drink");
    sim.step(1);
    expect(ops(sim)).toContain("drink");
  });

  it("does not drink above the threshold", () => {
    const { sim, hero } = dungeon({ life: 100 });
    setLife(sim, hero, 55);
    sim.step(3);
    expect(ops(sim)).not.toContain("drink");
  });

  it("drinks only strictly below the threshold (50 % default, boundary included)", () => {
    const { sim, hero } = dungeon({ life: 100 });
    setLife(sim, hero, 50);
    sim.step(2);
    expect(ops(sim)).not.toContain("drink");
    setLife(sim, hero, 49);
    sim.step(1);
    expect(ops(sim)).toContain("drink");
  });

  it("follows a configured life threshold", () => {
    const { sim, hero } = dungeon({ life: 100 });
    expect(sim.dispatch("classic.setAutoConfig", { config: { lifePotionPct: 80 } }, null).ok).toBe(
      true,
    );
    setLife(sim, hero, 80);
    sim.step(2);
    expect(ops(sim)).not.toContain("drink");
    setLife(sim, hero, 79);
    sim.step(1);
    expect(ops(sim)).toContain("drink");
  });

  it("drinks a mana potion when low on mana in a fight", () => {
    const { sim, hero } = dungeon({ mana: 100 });
    sim.world.update(hero, Mana, { mp: 10 });
    sim.world.update(hero, Belt, {
      slots: [
        { base: "test.item.potion.life", count: 3 },
        { base: "test.item.potion.mana", count: 2 },
        { base: null, count: 0 },
        { base: null, count: 0 },
      ],
    });
    spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    sim.step(1);
    expect(cmds(sim)).toContainEqual({ op: "drink", slot: 1, tick: 0 });
  });

  it("retreats with a town portal when low and out of life potions", () => {
    const { sim, hero } = dungeon({ life: 100 });
    sim.world.update(hero, Belt, {
      slots: [0, 1, 2, 3].map(() => ({ base: null, count: 0 })),
    });
    spawnTestMonster(sim.world, { x: 7, y: 5, depth: 1 });
    setLife(sim, hero, 20);
    const events = sim.step(1);
    expect(ops(sim)).toEqual(["townPortal"]);
    expect(stateOf(sim, hero).plan).toBe("toTown");
    expect(events).toContainEqual({ type: "classic.auto.plan", plan: "toTown", note: "retreat" });
    // Not re-sent every tick.
    sim.step(5);
    expect(ops(sim)).toEqual(["townPortal"]);
  });

  it("keeps fighting when it cannot retreat (no scroll)", () => {
    const { sim, hero } = dungeon({ life: 100 });
    sim.world.update(hero, Belt, { slots: [0, 1, 2, 3].map(() => ({ base: null, count: 0 })) });
    sim.world.update(hero, Supplies, { tpScrolls: 0 });
    spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    setLife(sim, hero, 20);
    sim.step(1);
    expect(ops(sim)).not.toContain("townPortal");
    expect(stateOf(sim, hero).plan).toBe("fight");
  });
});

// ---------------------------------------------------------------------------
// Fight
// ---------------------------------------------------------------------------

describe("fight", () => {
  it("prefers a close exploder, then casters, over nearer plain monsters", () => {
    const { sim, hero } = dungeon();
    spawnTestMonster(sim.world, { x: 7, y: 5, depth: 1 }); // 2 tiles
    const caster = spawnTestMonster(sim.world, {
      proto: "test.monster.caster",
      x: 9,
      y: 5,
      depth: 1,
    });
    sim.step(1);
    expect(stateOf(sim, hero).focus).toBe(caster); // 4 - 3 = 1 tile < 2
    const exploder = spawnTestMonster(sim.world, {
      proto: "test.monster.exploder",
      x: 5,
      y: 8,
      depth: 1,
    }); // 3 tiles - 6
    sim.step(1);
    expect(stateOf(sim, hero).focus).toBe(exploder);
  });

  it("sticks to its current focus unless another target is clearly better", () => {
    const { sim, hero } = dungeon();
    const first = spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 }); // 4 tiles
    sim.step(1);
    expect(stateOf(sim, hero).focus).toBe(first);
    spawnTestMonster(sim.world, { x: 5, y: 8, depth: 1 }); // 3 tiles: not 2 tiles better
    sim.step(1);
    expect(stateOf(sim, hero).focus).toBe(first);
    const close = spawnTestMonster(sim.world, { x: 6, y: 6, depth: 1 }); // ~1.4 tiles
    sim.step(1);
    expect(stateOf(sim, hero).focus).toBe(close);
  });

  it("ignores sleeping monsters and monsters behind walls", () => {
    const { sim, hero } = dungeon();
    spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1, awake: false });
    sim.step(1);
    expect(stateOf(sim, hero).plan).not.toBe("fight");
  });

  const novaHero = {
    skills: [
      { skill: "test.skill.strike", rank: 1 },
      { skill: "test.skill.bolt", rank: 1 },
      { skill: "test.skill.nova", rank: 1 },
      { skill: "test.skill.mend", rank: 1 },
    ],
    bar: ["test.skill.strike", "test.skill.bolt", "test.skill.nova", "test.skill.mend", null, null],
    mana: 50,
    life: 100,
  };

  it("casts the nova when two enemies are inside its radius", () => {
    const { sim, hero } = dungeon(novaHero);
    spawnTestMonster(sim.world, { x: 7, y: 5, depth: 1 });
    spawnTestMonster(sim.world, { x: 5, y: 7, depth: 1 });
    sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({
      kind: "skill",
      source: "auto",
      skill: "test.skill.nova",
      target: 0,
    });
  });

  it("casts the single-target bolt (point cast) against one enemy", () => {
    const { sim, hero } = dungeon(novaHero);
    const m = spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    sim.step(1);
    // Projectile point casts keep the target entity so combat aims at where it is on release.
    expect(intentOf(sim, hero)).toMatchObject({
      kind: "skill",
      skill: "test.skill.bolt",
      target: m,
      x: tileCenter(9),
      y: tileCenter(5),
    });
    expect(stateOf(sim, hero).focus).toBe(m);
  });

  it("heals with mend when life is below 60 %", () => {
    const { sim, hero } = dungeon(novaHero);
    setLife(sim, hero, 55);
    spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({ kind: "skill", skill: "test.skill.mend" });
  });

  it("falls back to the basic strike without mana", () => {
    const { sim, hero } = dungeon(novaHero);
    sim.world.update(hero, Mana, { mp: 0 });
    const m = spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({
      kind: "skill",
      skill: "test.skill.strike",
      target: m,
    });
  });

  it("keeps the mana reserve for spells but not for the basic attack", () => {
    const { sim, hero } = dungeon(novaHero);
    sim.world.update(hero, Mana, { mp: 9 }); // 9 - 3 = 6 < 15 % of 50
    spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({ skill: "test.skill.strike" });
  });

  it("steps up to line a projectile shot past a wall corner", () => {
    const { sim, map, hero } = dungeon({
      skills: [{ skill: "test.skill.strike", rank: 1 }],
      bar: ["test.skill.strike", null, null, null, null, null],
      stats: { attackProjectile: "fx.arrow", attackRange: 10 * 256 },
    });
    // A wall block whose corner (4,7) the shot would graze (geometry seen in a real level).
    for (let y = 1; y <= 7; y++) for (let x = 1; x <= 4; x++) map.walkable[y * map.width + x] = 0;
    sim.world.update(hero, Pos, { x: 1029, y: 2176 });
    const m = spawnTestMonster(sim.world, { x: 10, y: 4, depth: 1 });
    sim.world.update(m, Pos, { x: 2620, y: 1160 });
    expect(lineOfSight(map, 1029, 2176, 2620, 1160)).toBe(true); // the thin line passes...
    sim.step(1);
    // ...but an arrow would clip the corner: walk toward the target first.
    expect(intentOf(sim, hero)).toMatchObject({ kind: "move", x: 10, y: 4 });
    sim.world.update(hero, Pos, { x: tileCenter(6), y: tileCenter(8) });
    sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({
      kind: "skill",
      skill: "test.skill.strike",
      target: m,
    });
  });

  it("gives up a target it can neither reach nor hit", () => {
    const { sim, hero } = dungeon();
    const m = spawnTestMonster(sim.world, { x: 11, y: 5, depth: 1 });
    sim.step(45); // no executor or combat here: the hero never moves nor casts
    const st = stateOf(sim, hero);
    expect(st.ignore).toContainEqual({ x: 11, y: 5 });
    expect(st.focus).not.toBe(m);
    expect(st.plan).not.toBe("fight");
  });

  it("kites a melee enemy that got within 2 tiles when fighting at range", () => {
    const { sim, hero } = dungeon(novaHero);
    spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    sim.step(1); // engage
    sim.world.update(hero, Pos, { x: tileCenter(8), y: tileCenter(5) });
    sim.step(1);
    const intent = intentOf(sim, hero);
    expect(intent.kind).toBe("move");
    if (intent.kind === "move") expect(intent.x).toBeLessThan(8);
  });
});

// ---------------------------------------------------------------------------
// Loot and gear
// ---------------------------------------------------------------------------

describe("loot and gear", () => {
  it("picks up gold and filters items by rarity", () => {
    const { sim, hero } = dungeon();
    spawnLoot(sim, 7, 5, { kind: "item", item: item(1, "test.item.ring", "normal") });
    const magic = spawnLoot(sim, 10, 5, { kind: "item", item: item(2, "test.item.ring", "magic") });
    sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({ kind: "pickup", source: "auto", target: magic });
    expect(stateOf(sim, hero).plan).toBe("loot");
    const gold = spawnLoot(sim, 8, 7, { kind: "gold", gold: 12 });
    sim.world.update(hero, Intent, { kind: "idle", source: "auto", at: sim.tick });
    sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({ kind: "pickup", target: gold });
  });

  it("picks up loot in reach directly with the pickup op, and gives up a refused pickup", () => {
    const { sim, hero } = dungeon();
    const gold = spawnLoot(sim, 6, 6, { kind: "gold", gold: 12 });
    sim.step(1);
    expect(cmds(sim)).toEqual([{ op: "pickup", target: gold, tick: 0 }]);
    expect(intentOf(sim, hero).kind).toBe("idle");
    // No items module here: the loot stays, so the next plan ignores its tile.
    sim.step(1);
    expect(stateOf(sim, hero).ignore).toContainEqual({ x: 6, y: 6 });
    expect(ops(sim)).toEqual(["pickup"]);
  });

  it("does not loot with an awake enemy around", () => {
    const { sim, hero } = dungeon();
    spawnLoot(sim, 6, 5, { kind: "gold", gold: 5 });
    spawnTestMonster(sim.world, { x: 9, y: 5, depth: 1 });
    sim.step(1);
    expect(stateOf(sim, hero).plan).toBe("fight");
  });

  it("skips potions when the belt is full and gold when disabled", () => {
    const { sim, hero } = dungeon();
    sim.world.update(hero, Belt, {
      slots: [0, 1, 2, 3].map(() => ({ base: "test.item.potion.mana", count: 5 })),
    });
    spawnLoot(sim, 7, 5, { kind: "potion", potion: "test.item.potion.life" });
    spawnLoot(sim, 8, 5, { kind: "gold", gold: 5 });
    expect(sim.dispatch("classic.setAutoConfig", { config: { pickupGold: false } }, null).ok).toBe(
      true,
    );
    sim.step(1);
    expect(intentOf(sim, hero).kind).not.toBe("pickup");
  });

  it("equips a bag item that beats the equipped one by more than 5 %", () => {
    const { sim, hero } = dungeon();
    sim.world.update(hero, Inventory, {
      items: [{ item: item(7, "test.item.cap", "normal"), x: 0, y: 0 }],
    });
    sim.step(1);
    expect(cmds(sim)).toContainEqual({ op: "equip", uid: 7, slot: "helm", tick: 0 });
  });

  it("does not equip worse items or items above the hero's level", () => {
    const { sim, hero } = dungeon();
    const eq = sim.world.read(hero, Equipment);
    sim.world.update(hero, Equipment, {
      ...eq,
      helm: item(3, "test.item.cap", "magic", [{ stat: "life", value: 10 }]),
    });
    sim.world.update(hero, Inventory, {
      items: [{ item: item(8, "test.item.cap", "normal"), x: 0, y: 0 }],
    });
    sim.step(12);
    expect(ops(sim)).not.toContain("equip");
  });

  it("scores items sensibly per slot", () => {
    const reg = autoLoaded().registry;
    const plain = item(1, "test.item.sword", "normal");
    const sharp = item(2, "test.item.sword", "magic", [{ stat: "dmgPct", value: 30 }]);
    const mighty = item(3, "test.item.sword", "magic", [{ stat: "str", value: 5 }]);
    expect(itemScore(reg, sharp, "str")).toBeGreaterThan(itemScore(reg, plain, "str"));
    expect(itemScore(reg, mighty, "str")).toBeGreaterThan(itemScore(reg, mighty, "dex"));
    const ring = item(4, "test.item.ring", "normal");
    const band = item(5, "test.item.ring", "rare", [{ stat: "resAll", value: 10 }]);
    expect(itemScore(reg, ring, "str")).toBeGreaterThanOrEqual(1);
    expect(itemScore(reg, band, "str")).toBeGreaterThan(itemScore(reg, ring, "str"));
    expect(Number.isInteger(itemScore(reg, sharp, "dex"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exploration and descending
// ---------------------------------------------------------------------------

describe("explore and descend", () => {
  it("walks toward the nearest frontier", () => {
    const { sim, map, hero } = dungeon();
    // Without autoDescend there is no stairs bias: the nearest frontier wins.
    expect(sim.dispatch("classic.setAutoConfig", { config: { autoDescend: false } }, null).ok).toBe(
      true,
    );
    setExplored(sim, map, (x) => x <= 10);
    const events = sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({ kind: "move", source: "auto", x: 10, y: 5 });
    expect(stateOf(sim, hero)).toMatchObject({ plan: "explore", frontierX: 10, frontierY: 5 });
    expect(events).toContainEqual({ type: "classic.auto.plan", plan: "explore", note: "10,5" });
  });

  it("grows exploration toward the stairs down (QA major #1)", () => {
    const { sim, map, hero } = dungeon();
    expect(map.stairsDown).not.toBeNull();
    setExplored(sim, map, (x) => x <= 10);
    sim.step(1);
    const st = stateOf(sim, hero);
    expect(st.plan).toBe("explore");
    expect(st.frontierX).toBe(10);
    // The frontier tile nearest to the stairs (walking distance), not the one next to the hero.
    expect(st.frontierY).toBe(map.stairsDown!.y);
  });

  it("gives up an unreachable frontier when stuck and picks another", () => {
    const { sim, map, hero } = dungeon();
    expect(sim.dispatch("classic.setAutoConfig", { config: { autoDescend: false } }, null).ok).toBe(
      true,
    );
    setExplored(sim, map, (x) => x <= 10);
    sim.step(45); // no movement system: the hero never leaves its tile
    const st = stateOf(sim, hero);
    expect(st.ignore).toContainEqual({ x: 10, y: 5 });
    expect(st.frontierX).toBe(10);
    expect(st.frontierY).not.toBe(5);
  });

  it("descends through the stairs once explorePct is reached", () => {
    const { sim, map, hero } = dungeon();
    setExplored(sim, map, () => true);
    const stairs = spawnInteractable(sim, "stairsDown", 20, 20, 1, 2);
    sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({ kind: "interact", target: stairs });
    expect(stateOf(sim, hero).plan).toBe("descend");
    sim.world.update(hero, Pos, { x: tileCenter(19), y: tileCenter(20) });
    sim.step(1);
    expect(cmds(sim)).toContainEqual({ op: "stairs", target: stairs, tick: 1 });
  });

  it("goes back up to farm when under-levelled on a finished level", () => {
    const { sim, map, hero } = dungeon({ level: 1 }, 3);
    setExplored(sim, map, () => true);
    spawnInteractable(sim, "stairsDown", 20, 20, 3, 4);
    const up = spawnInteractable(sim, "stairsUp", 2, 2, 3, 2);
    sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({ kind: "interact", target: up });
  });

  it("walks to far stairs in legs along its own route", () => {
    const sim = autoSim();
    const map = useOpenMap(sim, 1, 64);
    const hero = spawnTestHero(sim.world, { x: 3, y: 3, depth: 1 });
    setMode(sim, "auto");
    setExplored(sim, map, () => true);
    // A wall across the map with one gap at the bottom: the route is long.
    for (let y = 1; y < 58; y++) map.walkable[y * map.width + 30] = 0;
    spawnInteractable(sim, "stairsDown", 50, 3, 1, 2);
    sim.step(1);
    const intent = intentOf(sim, hero);
    expect(intent.kind).toBe("move");
    if (intent.kind === "move") {
      // One 16-step leg of the BFS route (4-neighbour steps), still west of the wall.
      expect(Math.abs(intent.x - 3) + Math.abs(intent.y - 3)).toBe(16);
      expect(intent.x).toBeLessThan(30);
    }
    expect(stateOf(sim, hero).plan).toBe("descend");
  });

  it("goes to town through the level's waypoint when it has no scroll", () => {
    const { sim, hero } = dungeon({ gold: 100 });
    sim.world.update(hero, Supplies, { tpScrolls: 0 });
    sim.world.update(hero, Belt, { slots: [0, 1, 2, 3].map(() => ({ base: null, count: 0 })) });
    const wp = spawnInteractable(sim, "waypoint", 6, 5, 1);
    sim.step(1);
    expect(cmds(sim)).toContainEqual({ op: "waypoint", depth: 0, tick: 0 });
    expect(stateOf(sim, hero)).toMatchObject({ plan: "toTown", focus: wp });
  });

  it("respects maxDepth and autoDescend", () => {
    const { sim, map, hero } = dungeon();
    setExplored(sim, map, () => true);
    spawnInteractable(sim, "stairsDown", 20, 20, 1, 2);
    expect(sim.dispatch("classic.setAutoConfig", { config: { maxDepth: 1 } }, null).ok).toBe(true);
    sim.step(1);
    expect(intentOf(sim, hero).kind).not.toBe("interact");
    expect(stateOf(sim, hero).plan).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Leaving the level: fights and loot stay close (QA r2)
// ---------------------------------------------------------------------------

describe("leaving the level (descend / toTown)", () => {
  /** Finished level 1, stairs at (20,20): the hero commits to descend on the first tick. */
  function descending() {
    const d = dungeon();
    setExplored(d.sim, d.map, () => true);
    const stairs = spawnInteractable(d.sim, "stairsDown", 20, 20, 1, 2);
    d.sim.step(1);
    expect(stateOf(d.sim, d.hero).plan).toBe("descend");
    expect(d.sim.world.get(d.hero, AutoLeave)).toEqual({ plan: "descend", depth: 1 });
    return { ...d, stairs };
  }

  it("a foe outside the near radius does not preempt the walk to the stairs", () => {
    const { sim, hero, stairs } = descending();
    // Awake, in line of sight, 7 tiles away: inside FIGHT_RANGE, outside LEAVE_FIGHT_RANGE.
    spawnTestMonster(sim.world, { x: 12, y: 5 });
    sim.step(30);
    expect(stateOf(sim, hero).plan).toBe("descend");
    expect(intentOf(sim, hero)).toMatchObject({ kind: "interact", target: stairs });
  });

  it("the same foe is fought when the hero is not leaving (control)", () => {
    const { sim, map, hero } = dungeon();
    setExplored(sim, map, (x) => x <= 10);
    spawnTestMonster(sim.world, { x: 12, y: 5 });
    sim.step(1);
    expect(stateOf(sim, hero).plan).toBe("fight");
  });

  it("fights a foe within the near radius, and one attacking it from farther away", () => {
    const near = descending();
    const m = spawnTestMonster(near.sim.world, { x: 8, y: 5 });
    near.sim.step(1);
    expect(stateOf(near.sim, near.hero)).toMatchObject({ plan: "fight", focus: m });

    const far = descending();
    const archer = spawnTestMonster(far.sim.world, { x: 12, y: 5 });
    far.sim.world.update(archer, Ai, { state: "attack", target: far.hero });
    far.sim.step(1);
    expect(stateOf(far.sim, far.hero)).toMatchObject({ plan: "fight", focus: archer });
  });

  it("stays committed through a close fight: afterwards a far foe is still ignored", () => {
    const { sim, hero, stairs } = descending();
    const close = spawnTestMonster(sim.world, { x: 7, y: 5 });
    spawnTestMonster(sim.world, { x: 5, y: 12 });
    sim.step(1);
    expect(stateOf(sim, hero)).toMatchObject({ plan: "fight", focus: close });
    // The commitment survives the fight plan.
    expect(sim.world.get(hero, AutoLeave)).toEqual({ plan: "descend", depth: 1 });
    sim.world.destroy(close);
    sim.step(30);
    expect(stateOf(sim, hero).plan).toBe("descend");
    expect(intentOf(sim, hero)).toMatchObject({ kind: "interact", target: stairs });
  });

  it("does not walk to loot farther than LEAVE_LOOT_RANGE while descending", () => {
    const { sim, hero, stairs } = descending();
    spawnLoot(sim, 10, 5, { kind: "gold", gold: 20 });
    sim.step(30);
    expect(stateOf(sim, hero).plan).toBe("descend");
    expect(intentOf(sim, hero)).toMatchObject({ kind: "interact", target: stairs });
    // Loot right next to the hero is still picked up.
    expect(ops(sim)).not.toContain("pickup");
    const g = spawnLoot(sim, 6, 5, { kind: "gold", gold: 20 });
    sim.step(11);
    expect(cmds(sim).some((c) => c.op === "pickup" && c.target === g)).toBe(true);
  });

  it("drops the commitment when the plan turns to something else", () => {
    const { sim, map, hero } = descending();
    // Unexplore the level: the next re-plan explores instead.
    setExplored(sim, map, (x) => x <= 6);
    sim.step(11);
    expect(stateOf(sim, hero).plan).toBe("explore");
    expect(sim.world.has(hero, AutoLeave)).toBe(false);
  });
});

describe("quest trips (QA r2)", () => {
  function questSim(qs: QuestState) {
    const d = dungeon();
    setExplored(d.sim, d.map, (x) => x <= 10);
    d.sim.world.setResource(RES.quests, qs);
    return d;
  }

  it("goes to town to accept a quest it now qualifies for", () => {
    const { sim, hero } = questSim({ active: [], completed: [] });
    const ev = sim.step(1);
    expect(ops(sim)).toContain("townPortal");
    expect(stateOf(sim, hero).plan).toBe("toTown");
    expect(ev).toContainEqual({ type: "classic.auto.plan", plan: "toTown", note: "quest" });
  });

  it("no trip once the quest is active, completed, or during the trip cooldown", () => {
    const active = questSim({
      active: [{ id: "test.quest.hunt", progress: 0, done: false }],
      completed: [],
    });
    active.sim.step(1);
    expect(ops(active.sim)).not.toContain("townPortal");

    const done = questSim({ active: [], completed: ["test.quest.hunt"] });
    done.sim.step(1);
    expect(ops(done.sim)).not.toContain("townPortal");

    const cooling = questSim({ active: [], completed: [] });
    // As if it just left town: voluntary trips wait for the cooldown.
    ensureAutoState(cooling.sim.world, cooling.hero, cooling.sim.tick).tripAt = 1000;
    cooling.sim.step(1);
    expect(ops(cooling.sim)).not.toContain("townPortal");
  });

  it("does not leave a fight for it", () => {
    const { sim, hero } = questSim({ active: [], completed: [] });
    spawnTestMonster(sim.world, { x: 8, y: 5 });
    sim.step(1);
    expect(stateOf(sim, hero).plan).toBe("fight");
    expect(ops(sim)).not.toContain("townPortal");
  });
});

// ---------------------------------------------------------------------------
// Town routine
// ---------------------------------------------------------------------------

describe("town routine", () => {
  it("heals, sells junk, buys potions, then returns through the open portal", () => {
    const sim = autoSim();
    useOpenMap(sim, 0);
    const hero = spawnTestHero(sim.world, { x: 10, y: 10, depth: 0, life: 100, gold: 200 });
    setLife(sim, hero, 60);
    const eq = sim.world.read(hero, Equipment);
    sim.world.update(hero, Equipment, {
      ...eq,
      helm: item(3, "test.item.cap", "magic", [{ stat: "life", value: 10 }]),
    });
    sim.world.update(hero, Inventory, {
      items: [{ item: item(9, "test.item.cap", "normal"), x: 0, y: 0 }],
    });
    const healer = spawnNpc(sim, "test.npc.healer", 11, 10);
    const junk = spawnNpc(sim, "test.npc.junk", 12, 10);
    const alch = spawnNpc(sim, "test.npc.alchemist", 10, 12);
    spawnInteractable(sim, "portal", 8, 10, 0, 1);
    sim.world.getResource<DungeonState>(RES.dungeon)!.portal = { depth: 1, x: 1000, y: 1000 };
    setMode(sim, "auto");
    sim.step(25);
    const list = cmds(sim).map(({ tick: _t, ...c }) => c);
    expect(list).toEqual([
      { op: "heal", npc: healer },
      { op: "sell", npc: junk, uid: 9 },
      { op: "buy", npc: alch, index: 0, potion: "test.item.potion.life", count: 8 },
      { op: "usePortal" },
    ]);
    expect(stateOf(sim, hero).todo).toEqual(["return"]);
    expect(stateOf(sim, hero).plan).toBe("toDungeon");
  });

  it("walks to a distant NPC with an interact intent", () => {
    const sim = autoSim();
    useOpenMap(sim, 0);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0, life: 100 });
    setLife(sim, hero, 50);
    const healer = spawnNpc(sim, "test.npc.healer", 20, 20);
    setMode(sim, "auto");
    sim.step(1);
    expect(intentOf(sim, hero)).toMatchObject({ kind: "interact", source: "auto", target: healer });
    expect(stateOf(sim, hero)).toMatchObject({ plan: "town", todo: TOWN_TODO });
  });

  it("buys scrolls and uses the waypoint when no portal is open", () => {
    const sim = autoSim();
    useOpenMap(sim, 0);
    const hero = spawnTestHero(sim.world, { x: 10, y: 10, depth: 0, gold: 175 });
    sim.world.update(hero, Supplies, { tpScrolls: 0 });
    sim.world.update(hero, Belt, {
      slots: [0, 1, 2, 3].map(() => ({ base: "test.item.potion.life", count: 5 })),
    });
    const alch = spawnNpc(sim, "test.npc.alchemist", 11, 10);
    const wp = spawnInteractable(sim, "waypoint", 10, 11, 0);
    const d = sim.world.getResource<DungeonState>(RES.dungeon)!;
    d.waypoints = [0, 1, 5];
    setMode(sim, "auto");
    sim.step(15);
    const list = cmds(sim).map(({ tick: _t, ...c }) => c);
    // 2 scrolls first, potions (belt full), then up to 5 scrolls with what is left (175 - 100 = 75):
    // consecutive scroll purchases are one op.
    expect(list[0]).toEqual({ op: "buy", npc: alch, index: 0, potion: "tp", count: 3 });
    // Level 1 hero: depth 5 (monster level 7) is too deep, waypoint 1 it is.
    expect(list[1]).toEqual({ op: "waypoint", depth: 1 });
    expect(stateOf(sim, hero).focus).toBe(wp);
  });
});

const TOWN_TODO = [...TOWN_STEPS];

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

describe("allocation", () => {
  it("learns a newly unlocked skill at once, then spreads points with an order bias (regression)", () => {
    const skills: Record<string, { reqLevel: number; maxRank: number }> = {
      a: { reqLevel: 1, maxRank: 20 },
      b: { reqLevel: 1, maxRank: 20 },
      c: { reqLevel: 6, maxRank: 20 },
    };
    const cls = { autoSkillOrder: ["a", "b", "c"], skills: ["a", "b", "c"] } as never;
    const get = (id: string) => skills[id] as never;
    // Below level 6 c is locked: points spread a, b, a, ... (2 x rank + index).
    expect(skillPlan(cls, get, new Map([["a", 1]]), 5, 4)).toEqual(["b", "a", "b", "a"]);
    // At level 6 the new skill gets the first point even though a is far ahead.
    expect(
      skillPlan(
        cls,
        get,
        new Map([
          ["a", 5],
          ["b", 1],
        ]),
        6,
        1,
      ),
    ).toEqual(["c"]);
    // A rank-5 front skill does not starve the others: b catches up first.
    expect(
      skillPlan(
        cls,
        get,
        new Map([
          ["a", 5],
          ["b", 1],
          ["c", 1],
        ]),
        6,
        3,
      ),
    ).toEqual(["b", "c", "b"]);
  });

  it("builds the str -> dex -> mag -> vit weight cycle", () => {
    expect(allocCycle({ str: 2, dex: 1, mag: 0, vit: 2 })).toEqual([
      "str",
      "dex",
      "vit",
      "str",
      "vit",
    ]);
    expect(statPlan({ str: 2, dex: 1, mag: 0, vit: 2 }, 3, 4)).toEqual({
      str: 2,
      dex: 1,
      mag: 0,
      vit: 1,
    });
  });

  it("spends stat and skill points by class weights and order in auto mode", () => {
    const { sim, hero } = dungeon();
    sim.world.update(hero, Level, { statPoints: 5, skillPoints: 2 });
    sim.step(10);
    const list = cmds(sim)
      .filter((c) => c.op !== "drink")
      .map(({ tick: _t, ...c }) => c);
    // New skills first (nova, then mend), each into the next empty bar slot.
    expect(list).toEqual([
      { op: "allocate", attr: "str", points: 2 },
      { op: "allocate", attr: "dex", points: 1 },
      { op: "allocate", attr: "vit", points: 2 },
      { op: "learn", skill: "test.skill.nova" },
      { op: "setBar", slot: 2, skill: "test.skill.nova" },
      { op: "learn", skill: "test.skill.mend" },
      { op: "setBar", slot: 3, skill: "test.skill.mend" },
    ]);
  });

  it("does not allocate in manual mode or when autoAllocate is off", () => {
    const sim = autoSim();
    setMode(sim, "manual");
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    sim.world.update(hero, Level, { statPoints: 5, skillPoints: 1 });
    sim.step(20);
    expect(cmds(sim)).toEqual([]);
    setMode(sim, "auto");
    expect(
      sim.dispatch("classic.setAutoConfig", { config: { autoAllocate: false } }, null).ok,
    ).toBe(true);
    sim.step(20);
    expect(ops(sim).filter((o) => o === "allocate" || o === "learn")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Offline progress
// ---------------------------------------------------------------------------

describe("offline progress", () => {
  function offlineSim(): { sim: Sim; hero: Entity } {
    const sim = autoSim();
    useOpenMap(sim, 0);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0, level: 3 });
    sim.world.setResource<RunStats>(RES.stats, {
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
    });
    return { sim, hero };
  }

  it("grants XP, gold and items deterministically and emits a summary", () => {
    const a = offlineSim();
    const b = offlineSim();
    const ra = a.sim.dispatch("classic.offlineProgress", { elapsedMs: 3_600_000 }, null);
    const rb = b.sim.dispatch("classic.offlineProgress", { elapsedMs: 3_600_000 }, null);
    expect(ra.ok).toBe(true);
    expect(ra.events).toEqual(rb.events);
    const summary = ra.events.find((e) => e.type === "classic.offline.summary")!;
    expect(summary).toMatchObject({ ms: 3_600_000, depth: 1 });
    expect(summary.kills as number).toBeGreaterThan(0);
    expect(summary.xp as number).toBeGreaterThan(0);
    a.sim.step(1);
    b.sim.step(1);
    const ca = cmds(a.sim).map(({ tick: _t, ...c }) => c);
    expect(ca).toEqual(cmds(b.sim).map(({ tick: _t, ...c }) => c));
    expect(ca.map((c) => c.op)).toEqual(["grantXp", "grantGold", "grantItems"]);
    expect(ca[0]).toEqual({ op: "grantXp", amount: summary.xp, reason: "offline" });
    expect(ca[2]).toMatchObject({ op: "grantItems", toStash: true, minRarity: "magic" });
    expect(a.sim.world.getResource<RunStats>(RES.stats)!.offlineMs).toBe(3_600_000);
    expect(a.sim.hash()).toBe(b.sim.hash());
  });

  it("caps the elapsed time at offlineCapMs and items at 20", () => {
    const { sim, hero } = offlineSim();
    const reg = autoLoaded().registry;
    const week = computeOffline(sim.world, reg, hero, 7 * 24 * 3600 * 1000);
    const cap = computeOffline(sim.world, reg, hero, 8 * 3600 * 1000);
    expect(week).toEqual(cap);
    expect(week.ms).toBe(8 * 3600 * 1000);
    expect(week.items).toBeLessThanOrEqual(20);
    const short = computeOffline(sim.world, reg, hero, 59_000);
    expect(short).toMatchObject({ kills: 0, xp: 0, gold: 0, items: 0 });
  });

  it("rejects bad input, a missing hero and a dead hero (hash unchanged)", () => {
    const { sim, hero } = offlineSim();
    const h = sim.hash();
    for (const p of [
      { elapsedMs: 0 },
      { elapsedMs: -5 },
      { elapsedMs: 1.5 },
      { elapsedMs: 7 * 24 * 3600 * 1000 + 1 },
      { elapsedMs: "100" },
      { elapsedMs: 1000, extra: true },
      null,
    ]) {
      const r = sim.dispatch("classic.offlineProgress", p, null);
      expect(r.ok, JSON.stringify(p)).toBe(false);
      expect(r.error?.code).toBe("bad_payload");
    }
    expect(sim.hash()).toBe(h);
    sim.world.add(hero, Dead, { at: 0, killer: 0 });
    const h2 = sim.hash();
    const dead = sim.dispatch("classic.offlineProgress", { elapsedMs: 60_000 }, null);
    expect(dead.error?.code).toBe("dead");
    expect(sim.hash()).toBe(h2);
    const empty = autoSim();
    const h3 = empty.hash();
    const none = empty.dispatch("classic.offlineProgress", { elapsedMs: 60_000 }, null);
    expect(none.error?.code).toBe("no_hero");
    expect(empty.hash()).toBe(h3);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

function scripted(seed: number): Sim {
  const sim = autoSim(seed);
  const map = useOpenMap(sim, 1);
  const hero = spawnTestHero(sim.world, {
    x: 5,
    y: 5,
    depth: 1,
    skills: [
      { skill: "test.skill.strike", rank: 1 },
      { skill: "test.skill.bolt", rank: 1 },
    ],
  });
  sim.world.update(hero, Level, { statPoints: 5, skillPoints: 1 });
  setExplored(sim, map, (x, y) => x <= 12 && y <= 12);
  spawnTestMonster(sim.world, { x: 9, y: 6, depth: 1 });
  spawnTestMonster(sim.world, { proto: "test.monster.caster", x: 11, y: 9, depth: 1 });
  spawnLoot(sim, 4, 8, { kind: "gold", gold: 9 });
  spawnInteractable(sim, "stairsDown", 25, 25, 1, 2);
  setMode(sim, "idle");
  expect(sim.dispatch("classic.setSpeed", { speed: 4 }, null).ok).toBe(true);
  sim.step(50);
  setLife(sim, hero, 30);
  sim.step(150);
  return sim;
}

describe("determinism", () => {
  it("same seed and script give the same hash", () => {
    expect(scripted(3).hash()).toBe(scripted(3).hash());
  });

  it("pins the hash after a fixed script", () => {
    // Wave A (T-auto): stairs-biased exploration, new town steps.
    expect(scripted(1).hash()).toBe("47bc9ce5d15bd05c");
  });
});
