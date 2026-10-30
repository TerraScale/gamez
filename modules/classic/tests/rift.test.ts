/**
 * The endless Rift (wave A, T-rift): rift map generation, the town obelisk,
 * opening and leaving runs, population at the rift level, progress, the
 * guardian, completion and rewards, failure, blocked town travel, the view
 * model, determinism and a pinned hash. Uses a small test RiftProto (48 tiles,
 * goal 20) on the test content, so every run finishes in a few ticks.
 */
import {
  createSim,
  defineModule,
  defineMode,
  loadMode,
  type Entity,
  type GameEvent,
  type LoadedMode,
  type ModuleSpec,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { modules as classicModules } from "../src/index.ts";
import { ACTION, ERR, INTERACT_RANGE } from "../src/actions.ts";
import { busOf, type DeathRecord } from "../src/bus.ts";
import { AreaTag, Dead, Interactable, Monster, Pos, Wallet } from "../src/components.ts";
import { buildRiftView } from "../src/client/model/rift.ts";
import type { ModelContext } from "../src/client/model/context.ts";
import { riftDepth, riftFee, monsterLevel, isRiftDepth } from "../src/rules.ts";
import {
  RES,
  type DungeonState,
  type RiftRecord,
  type RiftState,
  type RunStats,
} from "../src/resources.ts";
import { riftOf } from "../src/resources.ts";
import { riftStateOf } from "../src/rift/state.ts";
import { KIND, RIFT_ID, type MonsterProto, type RiftProto } from "../src/types.ts";
import { generateArea } from "../src/world/generate.ts";
import { obeliskTile } from "../src/world/riftObelisk.ts";
import { getMap, mapFor } from "../src/world/maps.ts";
import { ensureResources, spawnTestHero } from "./support/harness.ts";
import { testContent } from "./support/content.ts";

// ---------------------------------------------------------------------------
// Test catalog
// ---------------------------------------------------------------------------

/** The unlock boss depth of the test rift (the test content boss is on depth 4). */
const UNLOCK_DEPTH = 4;
const GUARDIAN = "test.monster.guardian";
const GOAL = 20;
const TIME_LIMIT = 2400;

const RIFT: RiftProto = {
  unlockBossDepth: UNLOCK_DEPTH,
  size: 48,
  rooms: [4, 6],
  roomSize: [5, 8],
  packs: [3, 4],
  progress: { normal: 1, minion: 1, champion: 4, unique: 10, boss: 0, summon: 0 },
  goal: GOAL,
  timeLimit: TIME_LIMIT,
  guardians: [GUARDIAN],
  feeBase: 100,
  feePerLevel: 50,
  reward: { goldPerLevel: 10, items: 1, bonusEvery: 2, minRarity: "normal" },
  themes: ["test.theme"],
};

const GUARDIAN_PROTO: MonsterProto = {
  name: "Test Guardian",
  family: "test",
  description: "Rift guardian for tests",
  appearance: "unit.monster.test",
  fallbackAppearance: "unit.hero",
  tint: 0xffcc00,
  scale: 140,
  behaviour: "rusher",
  life: 60,
  armor: 5,
  toHit: 20,
  dmgMin: 1,
  dmgMax: 3,
  element: "phys",
  resist: { fire: 0, cold: 0, lightning: 0, poison: 0 },
  xp: 50,
  moveSpeed: 40,
  radius: 100,
  skills: ["test.mskill.bite"],
  aggroRange: 8 * 256,
  keepDistance: 0,
  packSize: [1, 1],
  themes: [],
  minDepth: 1,
  weight: 0,
};

const testRiftContent = defineModule({
  id: "test.rift",
  version: "0.0.1",
  data(reg) {
    reg.define(KIND.rift, RIFT_ID, RIFT);
    reg.define(KIND.monster, GUARDIAN, GUARDIAN_PROTO);
  },
});

const IDS = [
  "classic.core",
  "classic.world",
  "classic.rift",
  "classic.monsters",
  "classic.combat",
  "classic.progression",
];

let loadedCache: LoadedMode | null = null;

function riftLoaded(): LoadedMode {
  if (loadedCache) return loadedCache;
  const catalog: ModuleSpec[] = [...classicModules, testContent, testRiftContent];
  const mode = defineMode({
    id: "classic",
    name: "Classic (rift test)",
    description: "test",
    world: null,
    modules: [...IDS, "test.content", "test.rift"],
    tick: { kind: "fixed", hz: 20 },
  });
  loadedCache = loadMode(mode, catalog);
  return loadedCache;
}

/** A sim of the rift test mode with the classic resources (and RunStats) in place. */
function riftSim(seed = 1): Sim {
  const sim = createSim(riftLoaded(), { seed });
  ensureResources(sim.world);
  return sim;
}

/** A sim with a hero (with `gold`) standing on the town spawn. */
function heroSim(seed = 1, gold = 5000): { sim: Sim; hero: Entity } {
  const sim = riftSim(seed);
  const spawn = getMap(sim.world, sim.loaded.registry, 0).spawn;
  const hero = spawnTestHero(sim.world, { x: spawn.x, y: spawn.y, depth: 0, gold });
  return { sim, hero };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dungeonOf(sim: Sim): DungeonState {
  return sim.world.getResource<DungeonState>(RES.dungeon)!;
}

function stateOf(sim: Sim): RiftState {
  return riftStateOf(sim.world);
}

function depthOf(sim: Sim): number {
  return sim.world.getResource<{ depth: number }>(RES.area)!.depth;
}

function eventsOf(events: GameEvent[], type: string): GameEvent[] {
  return events.filter((e) => e.type === type);
}

function obeliskOf(sim: Sim): Entity {
  for (const e of sim.world.query(Interactable, AreaTag)) {
    if (sim.world.read(e, Interactable).kind === "riftObelisk") return e;
  }
  return 0;
}

/** Puts the hero on the obelisk tile (in reach). */
function standAtObelisk(sim: Sim, hero: Entity): Entity {
  const obelisk = obeliskOf(sim);
  const p = sim.world.read(obelisk, Pos);
  sim.world.update(hero, Pos, { x: p.x, y: p.y });
  return obelisk;
}

/** Marks the test unlock boss dead and lets the tracker unlock the rift. */
function unlock(sim: Sim): void {
  dungeonOf(sim).bossesKilled = [UNLOCK_DEPTH];
  sim.step(1);
}

/** Opens level `level` from the obelisk, settles the transition and returns the rift depth. */
function openRift(sim: Sim, hero: Entity, level = 1): number {
  const obelisk = standAtObelisk(sim, hero);
  const r = sim.dispatch(ACTION.openRift, { target: obelisk, level }, null);
  expect(r.ok).toBe(true);
  sim.step(1);
  return depthOf(sim);
}

function deathOf(over: Partial<DeathRecord>, killer: Entity): DeathRecord {
  return {
    entity: 0,
    killer,
    creditTeam: "hero",
    team: "monster",
    isHero: false,
    x: 0,
    y: 0,
    depth: 1,
    monster: "test.monster.dummy",
    rarity: "normal",
    level: 1,
    xp: 10,
    pack: 1,
    ...over,
  };
}

/** Injects kill records into the bus for the next step. */
function kill(
  sim: Sim,
  hero: Entity,
  depth: number,
  n: number,
  rarity: DeathRecord["rarity"] = "normal",
): void {
  const bus = busOf(sim.world);
  for (let i = 0; i < n; i++) bus.deaths.push(deathOf({ depth, rarity, monster: GUARDIAN }, hero));
}

function guardianAlive(sim: Sim, depth: number): Entity[] {
  return sim.world
    .query(Monster, AreaTag)
    .filter(
      (e) =>
        sim.world.read(e, AreaTag).depth === depth &&
        sim.world.read(e, Monster).rarity === "boss" &&
        !sim.world.has(e, Dead),
    );
}

/** Opens a rift, pushes enough kills to fill the bar, and settles the guardian. Returns the guardian. */
function fillBar(sim: Sim, hero: Entity, depth: number): Entity {
  kill(sim, hero, depth, GOAL);
  sim.step(1);
  sim.step(1);
  const [g] = guardianAlive(sim, depth);
  expect(g).toBeDefined();
  return g!;
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

describe("rift map (classic.world)", () => {
  it("builds a RiftProto.size square level with no stairs, no waypoint and no boss spot", () => {
    const { sim } = heroSim(3);
    const map = generateArea(sim.loaded.registry, 77, riftDepth(1, 1));
    expect(map.width).toBe(RIFT.size);
    expect(map.height).toBe(RIFT.size);
    expect(map.stairsDown).toBeNull();
    expect(map.stairsUp).toBeNull();
    expect(map.waypoint).toBeNull();
    expect(map.bossSpot).toBeNull();
    expect(map.theme).toBe("test.theme");
    expect(map.name).toBe("Test Halls - Rift 1");
    expect(map.depth).toBe(riftDepth(1, 1));
    expect(map.objects.some((o) => o === "prop.stairs.down" || o === "prop.stairs.up")).toBe(false);
    expect(map.rooms.length).toBeGreaterThan(0);
    const arrival = map.rooms[0]!;
    expect(map.spawn.x).toBeGreaterThanOrEqual(arrival.x);
    expect(map.spawn.x).toBeLessThan(arrival.x + arrival.w);
  });

  it("is a pure function: the same level is identical, different runs differ", () => {
    const { sim } = heroSim(3);
    const reg = sim.loaded.registry;
    const a = generateArea(reg, 77, riftDepth(1, 1));
    const b = generateArea(reg, 77, riftDepth(1, 1));
    expect(a.walkable).toEqual(b.walkable);
    expect(a.objects).toEqual(b.objects);
    expect(mapFor(reg, 77, riftDepth(1, 1)).walkable).toEqual(a.walkable);
    const other = generateArea(reg, 77, riftDepth(1, 2));
    expect(other.walkable).not.toEqual(a.walkable);
  });

  it("keeps the main dungeon's depth 16 without a staircase down (and depth 15 with one)", () => {
    const { sim } = heroSim(3);
    const reg = sim.loaded.registry;
    expect(generateArea(reg, 5, 16).stairsDown).toBeNull();
    expect(generateArea(reg, 5, 16).objects.includes("prop.stairs.down")).toBe(false);
    expect(generateArea(reg, 5, 15).stairsDown).not.toBeNull();
    expect(generateArea(reg, 5, 16).stairsUp).not.toBeNull();
  });

  it("places the town obelisk on a deterministic free tile near the waypoint", () => {
    const { sim } = heroSim(3);
    const town = getMap(sim.world, sim.loaded.registry, 0);
    const tile = obeliskTile(town)!;
    expect(tile).not.toBeNull();
    expect(town.walkable[tile.y * town.width + tile.x]).toBe(1);
    expect(town.objects[tile.y * town.width + tile.x] ?? null).toBeNull();
    const obelisks = sim.world
      .query(Interactable)
      .filter((e) => sim.world.read(e, Interactable).kind === "riftObelisk");
    expect(obelisks.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Obelisk and unlock
// ---------------------------------------------------------------------------

describe("rift unlock and obelisk", () => {
  it("is sealed until the unlock boss is dead, then unlocks once", () => {
    const { sim } = heroSim(4);
    sim.step(1);
    expect(riftOf(sim.world)?.unlocked ?? false).toBe(false);
    const ev = sim.step(1);
    expect(eventsOf(ev, "classic.rift.unlocked").length).toBe(0);
    dungeonOf(sim).bossesKilled = [UNLOCK_DEPTH];
    const first = sim.step(1);
    expect(eventsOf(first, "classic.rift.unlocked").length).toBe(1);
    expect(stateOf(sim).unlocked).toBe(true);
    expect(eventsOf(sim.step(3), "classic.rift.unlocked").length).toBe(0);
  });

  it("re-creates a missing obelisk while the hero is in town (old saves)", () => {
    const { sim } = heroSim(5);
    sim.world.destroy(obeliskOf(sim));
    expect(obeliskOf(sim)).toBe(0);
    sim.step(1);
    expect(obeliskOf(sim)).not.toBe(0);
  });

  it("does not create a second obelisk", () => {
    const { sim } = heroSim(5);
    sim.step(5);
    const count = sim.world
      .query(Interactable)
      .filter((e) => sim.world.read(e, Interactable).kind === "riftObelisk").length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Opening and leaving
// ---------------------------------------------------------------------------

describe("opening a rift", () => {
  it("rejects every bad request and leaves the sim hash unchanged", () => {
    const { sim, hero } = heroSim(6);
    const obelisk = standAtObelisk(sim, hero);
    const before = sim.hash();
    const cases: {
      name: string;
      code: string;
      run: () => { ok: boolean; error?: { code: string } };
    }[] = [
      {
        name: "locked",
        code: ERR.riftLocked,
        run: () => sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null),
      },
    ];
    unlock(sim);
    const unlockedHash = sim.hash();
    cases.length = 0;
    cases.push(
      {
        name: "level 0",
        code: ERR.riftLevel,
        run: () => sim.dispatch(ACTION.openRift, { target: obelisk, level: 0 }, null),
      },
      {
        name: "level above max completed + 1",
        code: ERR.riftLevel,
        run: () => sim.dispatch(ACTION.openRift, { target: obelisk, level: 2 }, null),
      },
      {
        name: "fractional level",
        code: ERR.badPayload,
        run: () => sim.dispatch(ACTION.openRift, { target: obelisk, level: 1.5 }, null),
      },
      {
        name: "not the obelisk",
        code: ERR.badTarget,
        run: () => sim.dispatch(ACTION.openRift, { target: hero, level: 1 }, null),
      },
    );
    for (const c of cases) {
      const r = c.run();
      expect(r.ok, c.name).toBe(false);
      if (c.name !== "fractional level") expect(r.error?.code, c.name).toBe(c.code);
      expect(sim.hash(), c.name).toBe(unlockedHash);
    }
    expect(before).not.toBe(unlockedHash);
  });

  it("rejects a far obelisk, an empty purse and a dead hero", () => {
    const { sim, hero } = heroSim(7, 0);
    unlock(sim);
    const obelisk = obeliskOf(sim);
    const p = sim.world.read(obelisk, Pos);
    sim.world.update(hero, Pos, { x: p.x + INTERACT_RANGE * 4, y: p.y });
    const far = sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null);
    expect(far.error?.code).toBe(ERR.tooFar);
    standAtObelisk(sim, hero);
    const broke = sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null);
    expect(broke.error?.code).toBe(ERR.noGold);
    sim.world.update(hero, Wallet, { gold: 10_000 });
    sim.world.add(hero, Dead, { at: 0, killer: 0 });
    const dead = sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null);
    expect(dead.error?.code).toBe(ERR.dead);
  });

  it("pays the fee, creates the run and moves the hero to the rift level via the transition", () => {
    const { sim, hero } = heroSim(8, 5000);
    unlock(sim);
    const obelisk = standAtObelisk(sim, hero);
    const fee = riftFee(RIFT, 1);
    const r = sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null);
    expect(r.ok).toBe(true);
    expect(eventsOf(r.events, "classic.rift.opened")[0]).toMatchObject({
      type: "classic.rift.opened",
      level: 1,
      depth: riftDepth(1, 1),
      fee,
      run: 1,
    });
    expect(sim.world.get(hero, Wallet)?.gold).toBe(5000 - fee);
    expect(
      (sim.world.getResource<RunStats>(RES.stats) as RunStats & { goldSpent?: number }).goldSpent,
    ).toBe(fee);
    expect(stateOf(sim).active).toMatchObject({
      level: 1,
      depth: riftDepth(1, 1),
      run: 1,
      progress: 0,
      goal: GOAL,
    });
    const ev = sim.step(1);
    expect(depthOf(sim)).toBe(riftDepth(1, 1));
    expect(dungeonOf(sim).live).toBe(riftDepth(1, 1));
    expect(eventsOf(ev, "classic.area.changed")[0]).toMatchObject({
      depth: riftDepth(1, 1),
      via: "rift",
    });
    // Rift levels never touch the main dungeon bookkeeping.
    expect(dungeonOf(sim).deepest).toBe(0);
    expect(dungeonOf(sim).waypoints).toEqual([0]);
  });

  it("refuses a second run while one is open", () => {
    const { sim, hero } = heroSim(9);
    unlock(sim);
    openRift(sim, hero, 1);
    sim.world.update(hero, Pos, { x: 0, y: 0 });
    const r = sim.dispatch(ACTION.openRift, { target: 0, level: 1 }, null);
    expect(r.ok).toBe(false);
  });
});

describe("leaving a rift", () => {
  it("refuses outside a rift", () => {
    const { sim } = heroSim(10);
    const r = sim.dispatch(ACTION.leaveRift, {}, null);
    expect(r.error?.code).toBe(ERR.notInRift);
  });

  it("fails the run (reason left) and returns to town through the exit", () => {
    const { sim, hero } = heroSim(11);
    unlock(sim);
    openRift(sim, hero, 1);
    const r = sim.dispatch(ACTION.leaveRift, {}, null);
    expect(r.ok).toBe(true);
    expect(eventsOf(r.events, "classic.rift.failed").length).toBe(1);
    const ev = sim.step(1);
    expect(depthOf(sim)).toBe(0);
    expect(stateOf(sim).active).toBeNull();
    expect(stateOf(sim).history[0]).toMatchObject({
      completed: false,
      reason: "left",
      score: 0,
      level: 1,
    });
    expect(stateOf(sim).best).toBeNull();
    expect(eventsOf(ev, "classic.area.changed")[0]).toMatchObject({ depth: 0, via: "riftExit" });
    // The rift cannot be re-entered: its level is discarded on the way out.
    const dungeon = sim.world.getResource<DungeonState>(RES.dungeon)!;
    expect(dungeon.live).toBe(0);
    expect(dungeon.liveSpawned).toBe(0);
    const leftovers = sim.world
      .query(AreaTag)
      .filter((e) => isRiftDepth(sim.world.read(e, AreaTag).depth));
    expect(leftovers).toEqual([]);
  });

  it("blocks town portals, waypoints and stairs inside a rift", () => {
    const { sim, hero } = heroSim(12);
    unlock(sim);
    openRift(sim, hero, 1);
    expect(sim.dispatch(ACTION.townPortal, {}, null).error?.code).toBe(ERR.inRift);
    expect(sim.dispatch(ACTION.useWaypoint, { depth: 0 }, null).error?.code).toBe(ERR.inRift);
    expect(sim.dispatch(ACTION.useStairs, {}, null).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Population, progress, guardian
// ---------------------------------------------------------------------------

describe("population and progress", () => {
  it("populates the level at the rift monster level with no bosses", () => {
    const { sim, hero } = heroSim(13);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    const units = sim.world
      .query(Monster, AreaTag)
      .filter((e) => sim.world.read(e, AreaTag).depth === depth);
    expect(units.length).toBeGreaterThan(0);
    const level = monsterLevel(depth);
    expect(level).toBe(20);
    for (const e of units) {
      const m = sim.world.read(e, Monster);
      expect(m.level).toBeGreaterThanOrEqual(level);
      expect(m.level).toBeLessThanOrEqual(level + 2);
      expect(m.rarity).not.toBe("boss");
    }
  });

  it("counts hero-credited kills by rarity and reports every 10 %", () => {
    const { sim, hero } = heroSim(14);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    const bus = busOf(sim.world);
    bus.deaths.push(deathOf({ depth, rarity: "normal" }, hero));
    bus.deaths.push(deathOf({ depth, rarity: "champion" }, hero));
    bus.deaths.push(deathOf({ depth, rarity: "normal", creditTeam: "monster" }, hero));
    const ev = sim.step(1);
    expect(stateOf(sim).active?.progress).toBe(5);
    expect(
      eventsOf(ev, "classic.rift.progress").map((e) => (e as unknown as { pct: number }).pct),
    ).toEqual([10, 20]);
    kill(sim, hero, depth, 15);
    const more = sim.step(1);
    expect(stateOf(sim).active?.progress).toBe(GOAL);
    expect(eventsOf(more, "classic.rift.progress").length).toBe(8);
  });

  it("spawns the guardian once at the goal and finds it on the next tick", () => {
    const { sim, hero } = heroSim(15);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    const g = fillBar(sim, hero, depth);
    expect(stateOf(sim).active?.guardianSpawned).toBe(true);
    expect(sim.world.read(g, Monster).rarity).toBe("boss");
    expect(sim.world.read(g, Monster).level).toBe(monsterLevel(depth));
    expect(sim.world.read(g, Monster).proto).toBe(GUARDIAN);
    // No second guardian, even after many more ticks.
    sim.step(20);
    expect(guardianAlive(sim, depth).length).toBe(1);
  });

  it("emits classic.rift.guardian when the guardian entity appears", () => {
    const { sim, hero } = heroSim(16);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    kill(sim, hero, depth, GOAL);
    sim.step(1);
    const ev = sim.step(1);
    expect(eventsOf(ev, "classic.rift.guardian").length).toBe(1);
    expect(stateOf(sim).active?.guardian).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Completion, rewards, failure
// ---------------------------------------------------------------------------

describe("completing a rift", () => {
  it("records the run, grants rewards, opens the exit and counts the run", () => {
    const { sim, hero } = heroSim(17);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    const g = fillBar(sim, hero, depth);
    const exitTile = { x: 1234, y: 5678 };
    busOf(sim.world).deaths.push(
      deathOf(
        { depth, rarity: "boss", monster: GUARDIAN, entity: g, x: exitTile.x, y: exitTile.y },
        hero,
      ),
    );
    const ev = sim.step(1);
    const done = eventsOf(ev, "classic.rift.completed");
    expect(done.length).toBe(1);
    const record = (done[0] as unknown as { record: RiftRecord }).record;
    expect(record).toMatchObject({ level: 1, completed: true, reason: "", deaths: 0, run: 1 });
    expect(record.score).toBeGreaterThan(0);
    expect((done[0] as unknown as { gold: number }).gold).toBe(10);
    expect((done[0] as unknown as { items: number }).items).toBe(1);
    expect(stateOf(sim).active).toBeNull();
    expect(stateOf(sim).maxCompleted).toBe(1);
    expect(stateOf(sim).best).toEqual(record);
    expect(stateOf(sim).history[0]).toEqual(record);
    expect(
      (sim.world.getResource<RunStats>(RES.stats) as RunStats & { riftsCompleted?: number })
        .riftsCompleted,
    ).toBe(1);
    const grants = busOf(sim.world).commands;
    expect(grants).toContainEqual(
      expect.objectContaining({ op: "grantGold", amount: 10, reason: "rift" }),
    );
    expect(grants).toContainEqual(
      expect.objectContaining({
        op: "grantItems",
        count: 1,
        ilvl: monsterLevel(depth),
        toStash: false,
        reason: "rift",
      }),
    );
    const exits = sim.world
      .query(Interactable, AreaTag)
      .filter((e) => sim.world.read(e, Interactable).kind === "riftExit");
    expect(exits.length).toBe(1);
    expect(sim.world.read(exits[0]!, Pos)).toEqual({ x: exitTile.x, y: exitTile.y });
    expect(sim.world.read(exits[0]!, Interactable).toDepth).toBe(0);
  });

  it("never completes twice", () => {
    const { sim, hero } = heroSim(18);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    const g = fillBar(sim, hero, depth);
    busOf(sim.world).deaths.push(deathOf({ depth, rarity: "boss", entity: g }, hero));
    sim.step(1);
    busOf(sim.world).deaths.push(deathOf({ depth, rarity: "boss", entity: g }, hero));
    const again = sim.step(1);
    expect(eventsOf(again, "classic.rift.completed").length).toBe(0);
    expect(stateOf(sim).history.length).toBe(1);
  });

  it("halves the rewards over time and still completes", () => {
    const { sim, hero } = heroSim(19);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    const g = fillBar(sim, hero, depth);
    stateOf(sim).active!.startTick = sim.tick - TIME_LIMIT - 40;
    busOf(sim.world).deaths.push(deathOf({ depth, rarity: "boss", entity: g }, hero));
    const ev = sim.step(1);
    const done = eventsOf(ev, "classic.rift.completed")[0] as unknown as {
      record: RiftRecord;
      gold: number;
      items: number;
    };
    expect(done.gold).toBe(5);
    expect(done.items).toBe(1);
    expect(done.record.score).toBe(1000);
  });

  it("scores a completed level by its time left", () => {
    const { sim, hero } = heroSim(20);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    const g = fillBar(sim, hero, depth);
    busOf(sim.world).deaths.push(deathOf({ depth, rarity: "boss", entity: g }, hero));
    const ev = sim.step(1);
    const rec = (eventsOf(ev, "classic.rift.completed")[0] as unknown as { record: RiftRecord })
      .record;
    expect(rec.score).toBe(1000 + Math.floor((TIME_LIMIT - rec.ticks) / 20));
  });
});

describe("failing a rift", () => {
  it("fails when the hero dies in the run (reason death)", () => {
    const { sim, hero } = heroSim(21);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    busOf(sim.world).deaths.push(
      deathOf(
        {
          isHero: true,
          team: "hero",
          creditTeam: "monster",
          rarity: "hero",
          monster: "",
          depth,
          killer: 0,
        },
        0,
      ),
    );
    const ev = sim.step(1);
    expect(eventsOf(ev, "classic.rift.failed").length).toBe(1);
    expect(stateOf(sim).active).toBeNull();
    expect(stateOf(sim).history[0]).toMatchObject({
      completed: false,
      reason: "death",
      deaths: 1,
      score: 0,
    });
    expect(stateOf(sim).best).toBeNull();
    expect(stateOf(sim).maxCompleted).toBe(0);
    // The respawn brings the hero to town and discards the rift level.
    busOf(sim.world).transitions.push({ to: 0, via: "respawn" });
    sim.step(1);
    expect(depthOf(sim)).toBe(0);
    expect(dungeonOf(sim).live).toBe(0);
    expect(
      sim.world.query(AreaTag).filter((e) => sim.world.read(e, AreaTag).depth === depth),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Determinism and levels
// ---------------------------------------------------------------------------

describe("determinism", () => {
  /** A fixed script: unlock, open level 1, kill to the goal, complete. */
  function script(seed: number): string {
    const { sim, hero } = heroSim(seed);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    const g = fillBar(sim, hero, depth);
    busOf(sim.world).deaths.push(deathOf({ depth, rarity: "boss", entity: g }, hero));
    sim.step(3);
    return sim.hash();
  }

  it("gives the same hash for the same seed and script", () => {
    expect(script(31)).toBe(script(31));
  });

  it("pins the hash after the fixed script", () => {
    expect(script(31)).toBe(PINNED_HASH);
  });

  it("opens level 2 only after level 1 is completed", () => {
    const { sim, hero } = heroSim(32);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    const g = fillBar(sim, hero, depth);
    busOf(sim.world).deaths.push(deathOf({ depth, rarity: "boss", entity: g }, hero));
    sim.step(1);
    expect(stateOf(sim).maxCompleted).toBe(1);
    expect(riftFee(RIFT, 2)).toBe(200);
    // Walk back to the obelisk (the run ended, the hero is in the rift, so this is a town-only check).
    expect(isRiftDepth(depthOf(sim))).toBe(true);
  });
});

/** Pinned after the first green run of the fixed script (see script()). */
const PINNED_HASH = "f017fab41f17fe13";

// ---------------------------------------------------------------------------
// HUD view model
// ---------------------------------------------------------------------------

describe("rift HUD view", () => {
  function ctxOf(sim: Sim, hero: Entity): ModelContext {
    return {
      world: sim.world,
      registry: sim.loaded.registry,
      hero,
      heroView: null,
      tick: sim.tick,
      vendor: 0,
      itemView: () => {
        throw new Error("the rift view does not render items");
      },
    };
  }

  it("shows the sealed rift with level 1 and the obelisk in reach", () => {
    const { sim, hero } = heroSim(40);
    sim.step(1);
    const obelisk = standAtObelisk(sim, hero);
    const view = buildRiftView(ctxOf(sim, hero));
    expect(view).not.toBeNull();
    expect(view!.unlocked).toBe(false);
    expect(view!.unlockText).toBe("Defeat the Hollow King on depth 4 to open the Rift.");
    expect(view!.obelisk).toBe(obelisk);
    expect(view!.levels).toEqual([
      { level: 1, fee: riftFee(RIFT, 1), monsterLevel: 20, affordable: true },
    ]);
    expect(view!.active).toBeNull();
  });

  it("reports no obelisk when the hero is away from it", () => {
    const { sim, hero } = heroSim(41);
    sim.step(1);
    const obelisk = obeliskOf(sim);
    const p = sim.world.read(obelisk, Pos);
    sim.world.update(hero, Pos, { x: p.x + INTERACT_RANGE * 3, y: p.y });
    expect(buildRiftView(ctxOf(sim, hero))!.obelisk).toBe(0);
  });

  it("shows the active run: progress, time left and the guardian", () => {
    const { sim, hero } = heroSim(42);
    unlock(sim);
    const depth = openRift(sim, hero, 1);
    kill(sim, hero, depth, 5);
    sim.step(1);
    const active = buildRiftView(ctxOf(sim, hero))!.active!;
    expect(active.level).toBe(1);
    expect(active.progressPct).toBe(25);
    expect(active.guardianAlive).toBe(false);
    expect(active.done).toBe(false);
    expect(active.ticksLeft).toBeGreaterThan(0);
    expect(active.ticksLeft).toBeLessThanOrEqual(TIME_LIMIT);
  });

  it("is null without a hero", () => {
    const { sim } = heroSim(43);
    expect(buildRiftView(ctxOf(sim, 0))).toBeNull();
  });
});

describe("rift state is readable through the resource", () => {
  it("riftOf is null before the state exists (old saves)", () => {
    const { sim } = heroSim(44);
    expect(riftOf(sim.world)).toBeNull();
  });
});

/** isRiftDepth is used by the transitions and the HUD: rift levels are never main depths. */
describe("rift depths", () => {
  it("are not main dungeon depths", () => {
    expect(isRiftDepth(riftDepth(1, 1))).toBe(true);
    expect(isRiftDepth(16)).toBe(false);
    expect(monsterLevel(riftDepth(3, 7))).toBe(24);
  });
});
