/**
 * classic.world inside a sim: area transitions, level bookkeeping, portals,
 * waypoints, exploration, command failures, action rejections, determinism
 * and one pinned hash. Uses the test content (64x64 dungeon levels).
 */
import type { Entity, GameEvent, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf, pushCommand, type DeathRecord } from "../src/bus.ts";
import { ACTION, ERR, INTERACT_RANGE } from "../src/actions.ts";
import {
  AreaTag,
  Dead,
  Interactable,
  Npc,
  Pos,
  Supplies,
  type InteractableKind,
} from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import {
  exploredPct,
  exploreAreaOf,
  isExplored,
  RES,
  type AreaState,
  type DungeonState,
} from "../src/resources.ts";
import { getMap, type ClassicMap } from "../src/world/maps.ts";
import { spawnTestHero, spawnTestMonster, testSim } from "./support/harness.ts";

const MODULES = ["classic.core", "classic.world"];

function townMap(sim: Sim): ClassicMap {
  return getMap(sim.world, sim.loaded.registry, 0);
}

function levelMap(sim: Sim, depth: number): ClassicMap {
  return getMap(sim.world, sim.loaded.registry, depth);
}

function dungeonOf(sim: Sim): DungeonState {
  return sim.world.getResource<DungeonState>(RES.dungeon)!;
}

function areaOf(sim: Sim): AreaState {
  return sim.world.getResource<AreaState>(RES.area)!;
}

function heroTile(sim: Sim, hero: Entity): { x: number; y: number } {
  const p = sim.world.read(hero, Pos);
  return { x: p.x >> 8, y: p.y >> 8 };
}

function moveHero(sim: Sim, hero: Entity, x: number, y: number): void {
  sim.world.update(hero, Pos, { x: tileCenter(x), y: tileCenter(y) });
}

/** Stands the hero half a tile left of the first `kind` Interactable of the current area. */
function standNextTo(sim: Sim, hero: Entity, kind: InteractableKind): void {
  const depth = areaOf(sim).depth;
  for (const e of sim.world.query(Interactable, Pos, AreaTag)) {
    if (sim.world.read(e, AreaTag).depth !== depth) continue;
    if (sim.world.read(e, Interactable).kind !== kind) continue;
    const p = sim.world.read(e, Pos);
    sim.world.update(hero, Pos, { x: p.x - 128, y: p.y });
    return;
  }
  throw new Error(`no ${kind} in area ${depth}`);
}

function eventsOf(events: GameEvent[], type: string): GameEvent[] {
  return events.filter((e) => e.type === type);
}

/** Walks the hero to the town's dungeon entrance, takes it and settles the arrival. */
function descend(sim: Sim, hero: Entity): GameEvent[] {
  const stairs = townMap(sim).stairsDown!;
  moveHero(sim, hero, stairs.x - 1, stairs.y);
  const r = sim.dispatch(ACTION.useStairs, {}, null);
  expect(r.ok).toBe(true);
  return sim.step(1);
}

/** A sim with the town and a hero standing on the town spawn. */
function setup(seed = 1) {
  const sim = testSim(MODULES, { seed });
  const spawn = townMap(sim).spawn;
  const hero = spawnTestHero(sim.world, { x: spawn.x, y: spawn.y, depth: 0 });
  return { sim, hero };
}

function deathOf(over: Partial<DeathRecord>, hero: Entity): DeathRecord {
  return {
    entity: 0,
    killer: hero,
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

describe("area transitions", () => {
  it("creates the town, its NPCs and Interactables at setup", () => {
    const { sim } = setup();
    expect(areaOf(sim)).toEqual({ depth: 0, theme: "classic.theme.town", enteredAt: 0 });
    expect(dungeonOf(sim)).toMatchObject({
      deepest: 0,
      waypoints: [0],
      live: 0,
      portal: null,
      bossesKilled: [],
      liveSpawned: 0,
      liveKilled: 0,
      liveBossAlive: false,
    });
    expect(sim.world.query(Npc).length).toBe(townMap(sim).npcSpots.length);
    const kinds = sim.world
      .query(Interactable)
      .map((e) => sim.world.read(e, Interactable).kind)
      .sort();
    expect(kinds).toEqual(["stairsDown", "stash", "waypoint"]);
    expect(exploredPct(exploreAreaOf(sim.world, 0)!)).toBe(100);
  });

  it("takes the stairs down, queues population and places the hero on a walkable tile", () => {
    const { sim, hero } = setup();
    const events = descend(sim, hero);
    expect(eventsOf(events, "classic.area.changed")).toEqual([
      expect.objectContaining({ depth: 1, via: "stairsDown", name: "Test Halls - Level 1" }),
    ]);
    expect(areaOf(sim).depth).toBe(1);
    expect(sim.world.read(hero, AreaTag).depth).toBe(1);
    const map = levelMap(sim, 1);
    const at = heroTile(sim, hero);
    expect(map.walkable[at.y * map.width + at.x]).toBe(1);
    const up = map.stairsUp!;
    expect(Math.max(Math.abs(at.x - up.x), Math.abs(at.y - up.y))).toBeLessThanOrEqual(3);

    const bus = busOf(sim.world);
    expect(bus.spawns.length).toBeGreaterThan(0);
    expect(bus.spawns.every((r) => r.depth === 1 && r.owner === 0 && r.team === "monster")).toBe(
      true,
    );
    expect(dungeonOf(sim)).toMatchObject({
      live: 1,
      deepest: 1,
      liveSpawned: bus.spawns.length,
      liveKilled: 0,
    });
    const level = sim.world
      .query(Interactable, AreaTag)
      .filter((e) => sim.world.read(e, AreaTag).depth === 1)
      .map((e) => sim.world.read(e, Interactable));
    expect(level.map((i) => i.kind).sort()).toEqual(["stairsDown", "stairsUp", "waypoint"]);
    expect(level.find((i) => i.kind === "stairsUp")?.toDepth).toBe(0);
    expect(level.find((i) => i.kind === "stairsDown")?.toDepth).toBe(2);
  });

  it("goes back up and keeps the live level while visiting town", () => {
    const { sim, hero } = setup();
    descend(sim, hero);
    const monster = spawnTestMonster(sim.world, { x: 20, y: 20, depth: 1 });
    standNextTo(sim, hero, "stairsUp");
    expect(sim.dispatch(ACTION.useStairs, {}, null).ok).toBe(true);
    const events = sim.step(1);
    expect(eventsOf(events, "classic.area.changed")[0]).toMatchObject({
      depth: 0,
      via: "stairsUp",
    });
    expect(areaOf(sim).depth).toBe(0);
    const town = townMap(sim);
    const at = heroTile(sim, hero);
    expect(
      Math.max(Math.abs(at.x - town.stairsDown!.x), Math.abs(at.y - town.stairsDown!.y)),
    ).toBeLessThanOrEqual(3);
    expect(dungeonOf(sim).live).toBe(1);
    expect(sim.world.exists(monster)).toBe(true);
  });

  it("destroys the old live level when a different depth is entered", () => {
    const { sim, hero } = setup();
    descend(sim, hero);
    const old = spawnTestMonster(sim.world, { x: 20, y: 20, depth: 1 });
    standNextTo(sim, hero, "stairsUp");
    sim.dispatch(ACTION.useStairs, {}, null);
    sim.step(1);
    descend(sim, hero);
    expect(sim.world.exists(old)).toBe(true);
    standNextTo(sim, hero, "stairsDown");
    expect(sim.dispatch(ACTION.useStairs, {}, null).ok).toBe(true);
    sim.step(1);
    expect(areaOf(sim).depth).toBe(2);
    expect(dungeonOf(sim).live).toBe(2);
    expect(sim.world.exists(old)).toBe(false);
    const leftover = sim.world.query(AreaTag).filter((e) => sim.world.read(e, AreaTag).depth === 1);
    expect(leftover).toEqual([]);
  });

  it("unlocks waypoints on arrival and emits classic.waypoint.unlocked", () => {
    const { sim, hero } = setup();
    const events = descend(sim, hero);
    expect(eventsOf(events, "classic.waypoint.unlocked")).toEqual([
      { type: "classic.waypoint.unlocked", depth: 1 },
    ]);
    expect(dungeonOf(sim).waypoints).toEqual([0, 1]);
  });

  it("reveals the level around the hero as it moves", () => {
    const { sim, hero } = setup();
    descend(sim, hero);
    const area = exploreAreaOf(sim.world, 1)!;
    expect(area.revealed).toBeGreaterThan(0);
    expect(area.total).toBe(levelMap(sim, 1).walkableCount);
    expect(exploredPct(area)).toBeLessThan(100);

    const map = levelMap(sim, 1);
    const far = map.rooms[map.rooms.length - 1]!;
    const fx = far.x + (far.w >> 1);
    const fy = far.y + (far.h >> 1);
    expect(isExplored(area, fx, fy)).toBe(false);
    const before = area.revealed;
    moveHero(sim, hero, fx, fy);
    sim.step(1);
    const after = exploreAreaOf(sim.world, 1)!;
    expect(isExplored(after, fx, fy)).toBe(true);
    expect(after.revealed).toBeGreaterThan(before);
  });
});

describe("portals and waypoints", () => {
  it("round-trips through the town portal and keeps the live level's entities", () => {
    const { sim, hero } = setup();
    descend(sim, hero);
    const monster = spawnTestMonster(sim.world, { x: 22, y: 22, depth: 1 });

    const opening = sim.dispatch(ACTION.townPortal, {}, null);
    expect(opening.ok).toBe(true);
    expect(eventsOf(opening.events, "classic.portal.opened")).toEqual([
      { type: "classic.portal.opened", depth: 1 },
    ]);
    const opened = sim.step(1);
    expect(eventsOf(opened, "classic.area.changed")[0]).toMatchObject({
      depth: 0,
      via: "townPortal",
    });
    expect(sim.world.read(hero, Supplies).tpScrolls).toBe(1);
    expect(dungeonOf(sim).portal).toMatchObject({ depth: 1 });
    expect(sim.world.exists(monster)).toBe(true);

    expect(sim.dispatch(ACTION.usePortal, {}, null).ok).toBe(true);
    const back = sim.step(1);
    expect(eventsOf(back, "classic.area.changed")[0]).toMatchObject({ depth: 1, via: "portal" });
    expect(areaOf(sim).depth).toBe(1);
    expect(dungeonOf(sim).portal).toBeNull();
    expect(sim.world.exists(monster)).toBe(true);
    const portals = sim.world
      .query(Interactable)
      .filter((e) => sim.world.read(e, Interactable).kind === "portal");
    expect(portals).toEqual([]);
  });

  it("closes the pair when used from town and can be reopened from the dungeon", () => {
    const { sim, hero } = setup();
    descend(sim, hero);
    sim.dispatch(ACTION.townPortal, {}, null);
    sim.step(1);
    expect(sim.dispatch(ACTION.usePortal, {}, null).ok).toBe(true);
    sim.step(1);
    expect(dungeonOf(sim).portal).toBeNull();
    expect(sim.dispatch(ACTION.townPortal, {}, null).ok).toBe(true);
    sim.step(1);
    expect(dungeonOf(sim).portal).toMatchObject({ depth: 1 });
    expect(sim.world.read(hero, Supplies).tpScrolls).toBe(0);
  });

  it("uses a waypoint once it is unlocked", () => {
    const { sim, hero } = setup();
    descend(sim, hero);
    standNextTo(sim, hero, "stairsUp");
    sim.dispatch(ACTION.useStairs, {}, null);
    sim.step(1);
    expect(areaOf(sim).depth).toBe(0);

    const wp = townMap(sim).waypoint!;
    moveHero(sim, hero, wp.x + 1, wp.y);
    expect(sim.dispatch(ACTION.useWaypoint, { depth: 1 }, null).ok).toBe(true);
    const events = sim.step(1);
    expect(eventsOf(events, "classic.area.changed")[0]).toMatchObject({
      depth: 1,
      via: "waypoint",
    });
    const mapWp = levelMap(sim, 1).waypoint!;
    const at = heroTile(sim, hero);
    expect(Math.max(Math.abs(at.x - mapWp.x), Math.abs(at.y - mapWp.y))).toBeLessThanOrEqual(3);
  });
});

describe("level bookkeeping", () => {
  it("counts kills, records bosses and clears the level once", () => {
    const { sim, hero } = setup();
    descend(sim, hero);
    const dungeon = dungeonOf(sim);
    dungeon.liveSpawned = 2;
    dungeon.liveBossAlive = true;

    // Ignored: another depth, a hero death, a summon.
    busOf(sim.world).deaths.push(
      deathOf({ depth: 2 }, hero),
      deathOf({ isHero: true, team: "hero", rarity: "hero" }, hero),
      deathOf({ rarity: "summon" }, hero),
    );
    expect(eventsOf(sim.step(1), "classic.level.cleared")).toEqual([]);
    expect(dungeonOf(sim).liveKilled).toBe(0);

    busOf(sim.world).deaths.push(deathOf({}, hero));
    expect(eventsOf(sim.step(1), "classic.level.cleared")).toEqual([]);
    expect(dungeonOf(sim).liveKilled).toBe(1);

    busOf(sim.world).deaths.push(deathOf({ rarity: "boss", monster: "test.monster.boss" }, hero));
    const events = sim.step(1);
    expect(dungeonOf(sim)).toMatchObject({
      liveKilled: 2,
      liveBossAlive: false,
      bossesKilled: [1],
    });
    expect(eventsOf(events, "classic.boss.killed")).toEqual([
      { type: "classic.boss.killed", monster: "test.monster.boss", depth: 1 },
    ]);
    expect(eventsOf(events, "classic.level.cleared")).toEqual([
      { type: "classic.level.cleared", depth: 1 },
    ]);

    busOf(sim.world).deaths.push(deathOf({}, hero));
    expect(eventsOf(sim.step(1), "classic.level.cleared")).toEqual([]);
  });
});

describe("commands and rejections", () => {
  it("emits classic.command.failed for a town portal queued in town", () => {
    const { sim } = setup();
    pushCommand(sim.world, { op: "townPortal" });
    const events = sim.step(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "classic.command.failed",
        op: "townPortal",
        code: ERR.inTown,
      }),
    );
  });

  it("rejects bad actions in town and leaves the hash unchanged", () => {
    const { sim } = setup();
    const expectRejected = (name: string, payload: unknown, code: string) => {
      const before = sim.hash();
      const r = sim.dispatch(name, payload, null);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe(code);
      expect(sim.hash()).toBe(before);
    };
    expectRejected(ACTION.townPortal, {}, ERR.inTown);
    expectRejected(ACTION.townPortal, { extra: 1 }, ERR.badPayload);
    expectRejected(ACTION.useWaypoint, { depth: 5 }, ERR.noWaypoint);
    expectRejected(ACTION.useWaypoint, { depth: -1 }, ERR.badPayload);
    expectRejected(ACTION.useWaypoint, { depth: "1" }, ERR.badPayload);
    expectRejected(ACTION.useStairs, {}, ERR.tooFar);
    expectRejected(ACTION.usePortal, {}, ERR.noPortal);
  });

  it("rejects the town portal without a scroll, and a waypoint that is still locked", () => {
    const { sim, hero } = setup();
    descend(sim, hero);
    sim.world.update(hero, Supplies, { tpScrolls: 0 });
    const before = sim.hash();
    const r = sim.dispatch(ACTION.townPortal, {}, null);
    expect(r.error?.code).toBe(ERR.noScroll);
    expect(sim.hash()).toBe(before);
    expect(sim.dispatch(ACTION.useWaypoint, { depth: 9 }, null).error?.code).toBe(ERR.noWaypoint);
  });

  it("rejects everything for a dead hero and without a hero", () => {
    const { sim, hero } = setup();
    sim.world.add(hero, Dead, { at: 0, killer: 0 });
    const before = sim.hash();
    expect(sim.dispatch(ACTION.useStairs, {}, null).error?.code).toBe(ERR.dead);
    expect(sim.dispatch(ACTION.useWaypoint, { depth: 0 }, null).error?.code).toBe(ERR.dead);
    expect(sim.hash()).toBe(before);

    const bare = testSim(MODULES, { seed: 2 });
    expect(bare.dispatch(ACTION.useStairs, {}, null).error?.code).toBe(ERR.noHero);
    expect(bare.dispatch(ACTION.townPortal, {}, null).error?.code).toBe(ERR.noHero);
  });

  it("refuses a staircase that is out of reach", () => {
    const { sim, hero } = setup();
    const town = townMap(sim);
    const stairs = town.stairsDown!;
    expect((stairs.x - town.spawn.x) * 256).toBeGreaterThan(INTERACT_RANGE);
    expect(sim.dispatch(ACTION.useStairs, {}, null).error?.code).toBe(ERR.tooFar);
    expect(hero).toBeGreaterThan(0);
  });
});

describe("determinism", () => {
  /** A fixed script covering descent, a portal round trip and a stairs climb. */
  function runScript(seed: number): { hash: string; events: string[] } {
    const sim = testSim(MODULES, { seed });
    const spawn = townMap(sim).spawn;
    const hero = spawnTestHero(sim.world, { x: spawn.x, y: spawn.y, depth: 0 });
    const events: string[] = [];
    const record = (evs: GameEvent[]) => events.push(...evs.map((e) => e.type));
    record(descend(sim, hero));
    record(sim.step(30));
    sim.dispatch(ACTION.townPortal, {}, null);
    record(sim.step(2));
    sim.dispatch(ACTION.usePortal, {}, null);
    record(sim.step(30));
    return { hash: sim.hash(), events };
  }

  it("gives the same hash and events for the same seed and script", () => {
    const a = runScript(7);
    const b = runScript(7);
    expect(a.hash).toBe(b.hash);
    expect(a.events).toEqual(b.events);
  });

  it("generates different levels for different seeds", () => {
    const a = testSim(MODULES, { seed: 3 });
    const b = testSim(MODULES, { seed: 4 });
    expect(levelMap(a, 1).walkable).not.toEqual(levelMap(b, 1).walkable);
  });

  it("pins the hash after the fixed script", () => {
    expect(runScript(7).hash).toBe("11b047066179571d");
  });
});
