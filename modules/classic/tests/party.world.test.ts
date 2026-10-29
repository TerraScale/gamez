/**
 * classic.world with a party (docs/design/party.md §2.3 I2, §4.3, §6.6,
 * §6.7): transitions move every member (leader on the arrival point,
 * followers in formation on distinct walkable tiles), any member can travel
 * for the party, the regroup leash, not_member rejections, exploration
 * around every standing member, summons left behind, determinism.
 */
import type { Entity, GameEvent, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION, ERR } from "../src/actions.ts";
import { pushCommand } from "../src/bus.ts";
import {
  AreaTag,
  Body,
  Dead,
  Interactable,
  Life,
  Pos,
  Summoned,
  Supplies,
  type InteractableKind,
} from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { RES, exploreAreaOf, isExplored, type AreaState } from "../src/resources.ts";
import { getMap, type ClassicMap } from "../src/world/maps.ts";
import { spawnTestParty, testSim } from "./support/harness.ts";

const MODULES = ["classic.core", "classic.world"];
/** Default PartyConfig.spread 2: followers within spread x 2 + 2 tiles. */
const WINDOW = 6;

function mapOf(sim: Sim, depth: number): ClassicMap {
  return getMap(sim.world, sim.loaded.registry, depth);
}

function depthOf(sim: Sim): number {
  return sim.world.getResource<AreaState>(RES.area)!.depth;
}

function tileOf(sim: Sim, e: Entity): { x: number; y: number } {
  const p = sim.world.read(e, Pos);
  return { x: p.x >> 8, y: p.y >> 8 };
}

function place(sim: Sim, e: Entity, x: number, y: number): void {
  sim.world.update(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
}

function interactable(sim: Sim, kind: InteractableKind): Entity {
  const depth = depthOf(sim);
  for (const e of sim.world.query(Interactable, Pos, AreaTag)) {
    if (sim.world.read(e, AreaTag).depth !== depth) continue;
    if (sim.world.read(e, Interactable).kind === kind) return e;
  }
  throw new Error(`no ${kind} in area ${depth}`);
}

function standNextTo(sim: Sim, hero: Entity, kind: InteractableKind): Entity {
  const it = interactable(sim, kind);
  const p = sim.world.read(it, Pos);
  sim.world.update(hero, Pos, { x: p.x - 128, y: p.y });
  return it;
}

function of(events: GameEvent[], type: string): GameEvent[] {
  return events.filter((e) => e.type === type);
}

/** Four members on walkable town tiles around the spawn (founder controlled). */
function setup(seed = 1): { sim: Sim; heroes: Entity[] } {
  const sim = testSim(MODULES, { seed });
  const town = mapOf(sim, 0);
  const spots: { x: number; y: number }[] = [];
  for (let r = 0; spots.length < 4 && r < 6; r++) {
    for (let dy = -r; dy <= r && spots.length < 4; dy++) {
      for (let dx = -r; dx <= r && spots.length < 4; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = town.spawn.x + dx;
        const y = town.spawn.y + dy;
        if (town.walkable[y * town.width + x] === 1) spots.push({ x, y });
      }
    }
  }
  const heroes = spawnTestParty(
    sim.world,
    spots.map((s) => ({ ...s, depth: 0 })),
    { roles: ["front", "front", "back", "back"] },
  );
  return { sim, heroes };
}

/** Every member in the current area, on distinct walkable tiles, followers near the leader. */
function expectGathered(sim: Sim, heroes: Entity[], leader: Entity): void {
  const depth = depthOf(sim);
  const map = mapOf(sim, depth);
  const seen = new Set<number>();
  const lt = tileOf(sim, leader);
  for (const h of heroes) {
    expect(sim.world.read(h, AreaTag).depth).toBe(depth);
    const t = tileOf(sim, h);
    expect(map.walkable[t.y * map.width + t.x]).toBe(1);
    seen.add(t.y * map.width + t.x);
    expect(Math.max(Math.abs(t.x - lt.x), Math.abs(t.y - lt.y))).toBeLessThanOrEqual(WINDOW);
  }
  expect(seen.size).toBe(heroes.length);
}

function descend(sim: Sim, hero: Entity): GameEvent[] {
  standNextTo(sim, hero, "stairsDown");
  expect(sim.dispatch(ACTION.useStairs, {}, null).ok).toBe(true);
  return sim.step(1);
}

describe("party transitions", () => {
  it("the stairs move all four members to the new depth in formation", () => {
    const { sim, heroes } = setup();
    const [a] = heroes as [Entity];
    const ev = descend(sim, a);
    expect(of(ev, "classic.area.changed")).toHaveLength(1);
    expect(depthOf(sim)).toBe(1);
    expectGathered(sim, heroes, a);
    // The leader lands on the arrival point exactly like a solo hero (next to the stairs up).
    const up = mapOf(sim, 1).stairsUp!;
    const at = tileOf(sim, a);
    expect(Math.max(Math.abs(at.x - up.x), Math.abs(at.y - up.y))).toBeLessThanOrEqual(3);
  });

  it("a waypoint and the town portal move the whole party too", () => {
    const { sim, heroes } = setup();
    const [a] = heroes as [Entity];
    descend(sim, a);
    sim.step(5);
    expect(sim.dispatch(ACTION.townPortal, {}, null).ok).toBe(true);
    sim.step(2);
    expect(depthOf(sim)).toBe(0);
    expectGathered(sim, heroes, a);
    // The scroll came out of the founder's purse.
    expect(sim.world.read(a, Supplies).tpScrolls).toBe(1);

    standNextTo(sim, a, "waypoint");
    expect(sim.dispatch(ACTION.useWaypoint, { depth: 1 }, null).ok).toBe(true);
    sim.step(1);
    expect(depthOf(sim)).toBe(1);
    expectGathered(sim, heroes, a);
  });

  it("downed members come along and stay down", () => {
    const { sim, heroes } = setup();
    const [a, , c] = heroes as [Entity, Entity, Entity];
    sim.world.add(c, Dead, { at: 0, killer: 0 });
    sim.world.update(c, Life, { hp: 0 });
    descend(sim, a);
    expect(sim.world.read(c, AreaTag).depth).toBe(1);
    expect(sim.world.has(c, Dead)).toBe(true);
    expectGathered(sim, heroes, a);
  });

  it("the acting leader takes the arrival point when the controlled hero is down", () => {
    const { sim, heroes } = setup();
    const [a, b] = heroes as [Entity, Entity];
    sim.world.add(a, Dead, { at: 0, killer: 0 });
    standNextTo(sim, b, "stairsDown");
    const stairs = interactable(sim, "stairsDown");
    pushCommand(sim.world, { op: "stairs", target: stairs, hero: b });
    sim.step(2);
    expect(depthOf(sim)).toBe(1);
    const up = mapOf(sim, 1).stairsUp!;
    const at = tileOf(sim, b);
    expect(Math.max(Math.abs(at.x - up.x), Math.abs(at.y - up.y))).toBeLessThanOrEqual(3);
    expectGathered(sim, heroes, b);
  });

  it("a follower can take the stairs for the party (cmd.hero)", () => {
    const { sim, heroes } = setup();
    const [a, b] = heroes as [Entity, Entity];
    // The controlled hero is far from the stairs: only the follower is in reach.
    const stairs = standNextTo(sim, b, "stairsDown");
    pushCommand(sim.world, { op: "stairs", target: stairs, hero: b });
    const ev = sim.step(2);
    expect(of(ev, "classic.command.failed")).toHaveLength(0);
    expect(depthOf(sim)).toBe(1);
    expectGathered(sim, heroes, a);
    // The same command for the controlled hero (no `hero`) fails: it is out of reach.
    sim.step(1);
    const down = interactable(sim, "stairsUp");
    place(sim, a, 2, 2);
    place(sim, b, tileOf(sim, b).x, tileOf(sim, b).y);
    pushCommand(sim.world, { op: "stairs", target: down });
    const ev2 = sim.step(1);
    expect(of(ev2, "classic.command.failed")).toEqual([
      expect.objectContaining({ op: "stairs", code: ERR.tooFar }),
    ]);
  });

  it("rejects travel commands for a hero that is not a member", () => {
    const { sim } = setup();
    const stairs = interactable(sim, "stairsDown");
    const before = depthOf(sim);
    pushCommand(sim.world, { op: "stairs", target: stairs, hero: 999_999 });
    pushCommand(sim.world, { op: "regroup", hero: 999_999 });
    const ev = sim.step(2);
    expect(depthOf(sim)).toBe(before);
    const failed = of(ev, "classic.command.failed");
    expect(failed.map((f) => f.code)).toEqual([ERR.notMember, ERR.notMember]);
  });

  it("leaving an area destroys the summons of every member", () => {
    const { sim, heroes } = setup();
    const [a, b, c] = heroes as [Entity, Entity, Entity];
    descend(sim, a);
    const pets = [b, c].map((owner, i) => {
      const e = sim.world.create();
      sim.world.add(e, Summoned, { owner, until: 0 });
      sim.world.add(e, Pos, {
        x: sim.world.read(owner, Pos).x + 64 * (i + 1),
        y: sim.world.read(owner, Pos).y,
      });
      sim.world.add(e, AreaTag, { depth: 1 });
      sim.world.add(e, Body, { radius: 60, solid: true });
      return e;
    });
    standNextTo(sim, a, "stairsUp");
    expect(sim.dispatch(ACTION.useStairs, {}, null).ok).toBe(true);
    sim.step(1);
    expect(depthOf(sim)).toBe(0);
    for (const p of pets) expect(sim.world.exists(p)).toBe(false);
    for (const h of heroes) expect(sim.world.exists(h)).toBe(true);
  });
});

describe("regroup", () => {
  it("places a far follower next to the leader", () => {
    const { sim, heroes } = setup();
    const [a, b] = heroes as [Entity, Entity];
    descend(sim, a);
    sim.step(2);
    // Send the follower somewhere far (any walkable tile at least 15 tiles away).
    const map = mapOf(sim, 1);
    const lt = tileOf(sim, a);
    let far: { x: number; y: number } | null = null;
    for (let i = 0; i < map.walkable.length && !far; i++) {
      const x = i % map.width;
      const y = (i - x) / map.width;
      if (map.walkable[i] === 1 && Math.max(Math.abs(x - lt.x), Math.abs(y - lt.y)) >= 15) {
        far = { x, y };
      }
    }
    place(sim, b, far!.x, far!.y);
    pushCommand(sim.world, { op: "regroup", hero: b });
    const ev = sim.step(1);
    expect(of(ev, "classic.command.failed")).toHaveLength(0);
    expectGathered(sim, heroes, a);
  });

  it("fails for the controlled hero, the acting leader and a downed follower", () => {
    const { sim, heroes } = setup();
    const [a, b, c] = heroes as [Entity, Entity, Entity];
    descend(sim, a);
    sim.world.add(c, Dead, { at: 0, killer: 0 });
    pushCommand(sim.world, { op: "regroup" });
    pushCommand(sim.world, { op: "regroup", hero: a });
    pushCommand(sim.world, { op: "regroup", hero: c });
    const ev = sim.step(1);
    expect(of(ev, "classic.command.failed").map((f) => f.code)).toEqual([
      ERR.notMember,
      ERR.notMember,
      ERR.dead,
    ]);
    // With the controlled hero down, the acting leader (b) cannot regroup either.
    sim.world.add(a, Dead, { at: 0, killer: 0 });
    pushCommand(sim.world, { op: "regroup", hero: b });
    const ev2 = sim.step(1);
    expect(of(ev2, "classic.command.failed").map((f) => f.code)).toEqual([ERR.notMember]);
  });
});

describe("party exploration", () => {
  it("reveals around a follower, not around a downed member", () => {
    const { sim, heroes } = setup();
    const [a, b, c] = heroes as [Entity, Entity, Entity];
    descend(sim, a);
    sim.step(1);
    const map = mapOf(sim, 1);
    const lt = tileOf(sim, a);
    const far: { x: number; y: number }[] = [];
    for (let i = 0; i < map.walkable.length && far.length < 2; i++) {
      const x = i % map.width;
      const y = (i - x) / map.width;
      const clear = far.every((f) => Math.max(Math.abs(x - f.x), Math.abs(y - f.y)) >= 20);
      if (
        map.walkable[i] === 1 &&
        Math.max(Math.abs(x - lt.x), Math.abs(y - lt.y)) >= 20 &&
        clear
      ) {
        far.push({ x, y });
      }
    }
    expect(far).toHaveLength(2);
    expect(isExplored(exploreAreaOf(sim.world, 1)!, far[0]!.x, far[0]!.y)).toBe(false);
    expect(isExplored(exploreAreaOf(sim.world, 1)!, far[1]!.x, far[1]!.y)).toBe(false);
    place(sim, b, far[0]!.x, far[0]!.y);
    place(sim, c, far[1]!.x, far[1]!.y);
    sim.world.add(c, Dead, { at: 0, killer: 0 });
    sim.step(1);
    expect(isExplored(exploreAreaOf(sim.world, 1)!, far[0]!.x, far[0]!.y)).toBe(true);
    expect(isExplored(exploreAreaOf(sim.world, 1)!, far[1]!.x, far[1]!.y)).toBe(false);
  });
});

describe("party determinism", () => {
  function script(seed: number): { hash: string; events: string[] } {
    const { sim, heroes } = setup(seed);
    const [a, b] = heroes as [Entity, Entity];
    const events: string[] = [];
    const rec = (evs: GameEvent[]) => events.push(...evs.map((e) => e.type));
    rec(descend(sim, a));
    rec(sim.step(20));
    pushCommand(sim.world, { op: "regroup", hero: b });
    rec(sim.step(5));
    sim.dispatch(ACTION.townPortal, {}, null);
    rec(sim.step(3));
    sim.dispatch(ACTION.usePortal, {}, null);
    rec(sim.step(20));
    return { hash: sim.hash(), events };
  }

  it("same seed and script give the same hash and events", () => {
    const x = script(5);
    const y = script(5);
    expect(x.hash).toBe(y.hash);
    expect(x.events).toEqual(y.events);
  });

  it("pins the party hash after the fixed script", () => {
    expect(script(5).hash).toBe("157af6911334d346");
  });
});
