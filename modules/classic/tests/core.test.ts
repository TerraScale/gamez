/**
 * classic.core behaviour: movement (paths, steering, walls, separation,
 * slows, sleep/stun/cast freezes, perf), the hero intent executor and the
 * core input actions (validation, rejection, noteManual).
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type Entity,
  type GameEvent,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf } from "../src/bus.ts";
import {
  AreaTag,
  Body,
  CastOrder,
  Casting,
  Dead,
  Intent,
  Interactable,
  Life,
  Loot,
  Mover,
  Npc,
  Pos,
  Statuses,
  type HeroIntentValue,
  type InteractableKind,
} from "../src/components.ts";
import { tileCenter, tiles, toTile } from "../src/fixed.ts";
import { modules as classicModules } from "../src/index.ts";
import { RES, type ControlState } from "../src/resources.ts";
import { gridOf } from "../src/spatial.ts";
import { planPath } from "../src/core/intent.ts";
import { canStand } from "../src/core/units.ts";
import type { ClassicMap } from "../src/world/maps.ts";
import { testContent } from "./support/content.ts";
import {
  ensureResources,
  spawnTestHero,
  spawnTestMonster,
  testSim,
  useOpenMap,
} from "./support/harness.ts";

const sub = (t: number) => tileCenter(t);
const of = (events: GameEvent[], type: string) =>
  events.filter((e) => e.type === type) as (GameEvent & Record<string, any>)[];

function newSim(seed = 1, size = 32): Sim {
  const sim = testSim(["classic.core", "classic.combat"], { seed });
  useOpenMap(sim, 1, size);
  return sim;
}

/** Installs a fresh 32x32 open map with a wall column at x (y0..y1) and returns it. */
function wall(sim: Sim, x: number, y0: number, y1: number): ClassicMap {
  const map = useOpenMap(sim, 1, 32);
  for (let y = y0; y <= y1; y++) map.walkable[y * 32 + x] = 0;
  return map;
}

/** Spawns the test hero and lets its initial idle intent settle (it clears the walk on its first tick). */
function settledHero(sim: Sim, o: Parameters<typeof spawnTestHero>[1]): Entity {
  const h = spawnTestHero(sim.world, o);
  sim.step(1);
  return h;
}

function setIntent(sim: Sim, hero: Entity, intent: HeroIntentValue): void {
  sim.world.add(hero, Intent, intent);
}

const tileOf = (sim: Sim, e: Entity) => {
  const p = sim.world.read(e, Pos);
  return { x: toTile(p.x), y: toTile(p.y) };
};

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

describe("movement", () => {
  it("follows a path through tile centres and stops at the end", () => {
    const sim = newSim();
    const h = settledHero(sim, { x: 5, y: 5 });
    sim.world.read(h, Mover).path = [
      { x: 6, y: 5 },
      { x: 7, y: 5 },
      { x: 8, y: 5 },
    ];
    sim.step(1);
    expect(sim.world.read(h, Pos)).toEqual({ x: sub(5) + 51, y: sub(5) });
    expect(sim.world.read(h, Mover)).toMatchObject({ moving: true, facing: "se" });
    sim.step(15); // 768 sub at 51 sub/tick
    expect(sim.world.read(h, Pos)).toEqual({ x: sub(8), y: sub(5) });
    expect(sim.world.read(h, Mover).path).toEqual([]);
    sim.step(1);
    expect(sim.world.read(h, Mover).moving).toBe(false);
  });

  it("steers straight to a goal and clears it on arrival", () => {
    const sim = newSim();
    const h = settledHero(sim, { x: 5, y: 5 });
    Object.assign(sim.world.read(h, Mover), { goalX: sub(5), goalY: sub(5) + 300 });
    sim.step(6);
    expect(sim.world.read(h, Pos)).toEqual({ x: sub(5), y: sub(5) + 300 });
    expect(sim.world.read(h, Mover)).toMatchObject({ goalX: -1, goalY: -1, facing: "sw" });
  });

  it("slides along walls and counts blocked ticks", () => {
    const sim = newSim();
    const map = wall(sim, 8, 1, 30);
    const h = settledHero(sim, { x: 7, y: 5 });
    Object.assign(sim.world.read(h, Mover), { goalX: sub(10), goalY: sub(9) });
    sim.step(80);
    const p = sim.world.read(h, Pos);
    // X is blocked by the wall; Y slides on until the goal's row (within a few sub).
    expect(p.x).toBeLessThan(8 * 256);
    expect(Math.abs(p.y - sub(9))).toBeLessThan(32);
    expect(sim.world.read(h, Mover).blocked).toBeGreaterThan(0);
    expect(canStand(map, p.x, p.y, 80)).toBe(true);
  });

  it("separates stacked units and monsters barely push the hero", () => {
    const sim = newSim();
    const a = spawnTestMonster(sim.world, { x: 10, y: 10 });
    const b = spawnTestMonster(sim.world, { x: 10, y: 10 });
    sim.step(20);
    const pa = sim.world.read(a, Pos);
    const pb = sim.world.read(b, Pos);
    const d2 = (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2;
    expect(d2).toBeGreaterThanOrEqual(150 * 150);

    const sim2 = newSim();
    const h = spawnTestHero(sim2.world, { x: 10, y: 10 });
    const m = spawnTestMonster(sim2.world, { x: 10, y: 10 });
    sim2.step(1);
    const ph = sim2.world.read(h, Pos);
    const pm = sim2.world.read(m, Pos);
    const moved = (p: { x: number; y: number }) =>
      Math.abs(p.x - sub(10)) + Math.abs(p.y - sub(10));
    expect(moved(ph)).toBeLessThanOrEqual(2 * 6);
    expect(moved(pm)).toBeGreaterThan(moved(ph));
    expect(gridOf(sim2.world).query(pm.x, pm.y, 0)).toEqual([m]);
  });

  it("applies move speed and the strongest slow", () => {
    const sim = newSim();
    const h = settledHero(sim, { x: 5, y: 5, stats: { moveSpeed: 150 } });
    sim.world.read(h, Statuses).list = [
      { id: "test.status.chill", until: 999, power: 20, source: 0, nextAt: 999, remaining: 0 },
      { id: "test.status.chill2", until: 999, power: 90, source: 0, nextAt: 999, remaining: 0 },
    ];
    // Unknown status ids are not slows: only the 20 % chill counts.
    Object.assign(sim.world.read(h, Mover), { goalX: sub(25), goalY: sub(5) });
    sim.step(1);
    expect(sim.world.read(h, Pos).x - sub(5)).toBe(
      Math.floor((Math.floor((51 * 150) / 100) * 80) / 100),
    );
  });

  it("sleeping, stunned, casting and dead units do not move", () => {
    const sim = newSim();
    const sleeper = spawnTestMonster(sim.world, { x: 5, y: 5, awake: false });
    const stunned = spawnTestMonster(sim.world, { x: 5, y: 10 });
    const caster = spawnTestMonster(sim.world, { x: 5, y: 15 });
    const dead = spawnTestMonster(sim.world, { x: 5, y: 20 });
    const free = spawnTestMonster(sim.world, { x: 5, y: 25 });
    sim.world.read(stunned, Statuses).list = [
      { id: "test.status.stun", until: 999, power: 1, source: 0, nextAt: 999, remaining: 0 },
    ];
    sim.world.add(caster, Casting, {
      skill: "test.mskill.bite",
      rank: 1,
      target: 0,
      x: 0,
      y: 0,
      startedAt: 0,
      hitAt: 900,
      endAt: 999,
      fired: false,
      pulses: 0,
    });
    sim.world.add(dead, Dead, { at: 0, killer: 0 });
    const all = [sleeper, stunned, caster, dead, free];
    for (const e of all) {
      const p = sim.world.read(e, Pos);
      Object.assign(sim.world.read(e, Mover), { goalX: p.x + tiles(5), goalY: p.y });
    }
    sim.step(5);
    const dx = all.map((e) => sim.world.read(e, Pos).x - sub(5));
    expect(dx).toEqual([0, 0, 0, 0, 200]);
  });

  it("moves 300 units in well under 1 ms per tick", () => {
    let total = 0;
    let ticks = 0;
    const timing = defineModule({
      id: "test.timing",
      version: "0.0.1",
      deps: ["classic.core"],
      overrides: [
        {
          kind: "system",
          target: "classic.core.movement",
          op: "wrap",
          with(_w, _ctx, next) {
            const t0 = performance.now();
            next();
            total += performance.now() - t0;
            ticks++;
          },
        },
      ],
    });
    const loaded = loadMode(
      defineMode({
        id: "classic",
        name: "perf",
        description: "perf",
        world: null,
        modules: ["classic.core", "test.content", "test.timing"],
        tick: { kind: "fixed", hz: 20 },
      }),
      [...classicModules, testContent, timing],
    );
    const sim = createSim(loaded, { seed: 1 });
    ensureResources(sim.world);
    useOpenMap(sim, 1, 96);
    spawnTestHero(sim.world, { x: 48, y: 48 });
    // 300 awake monsters crossing the map through each other (they keep walking all along).
    for (let i = 0; i < 300; i++) {
      const x = 4 + ((i * 7) % 88);
      const y = 4 + ((i * 13) % 88);
      const m = spawnTestMonster(sim.world, { x, y });
      Object.assign(sim.world.read(m, Mover), { goalX: sub(92 - x), goalY: sub(92 - y) });
    }
    sim.step(30); // warm-up
    // Best of three 100-tick windows, so a busy CI machine does not flake the bound.
    let best = Infinity;
    for (let w = 0; w < 3; w++) {
      total = 0;
      ticks = 0;
      sim.step(100);
      expect(ticks).toBe(100);
      best = Math.min(best, total / ticks);
    }
    console.log(`classic.core.movement: ${best.toFixed(3)} ms/tick for 300 movers`);
    // Budget 1 ms (logged above); the assertion allows 2x so a shared, loaded
    // machine does not flake the suite. A real regression is far larger.
    expect(best).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// Intent executor
// ---------------------------------------------------------------------------

describe("intent executor", () => {
  it("plans a path around walls with the nearest-walkable fallback", () => {
    const sim = newSim();
    const map = wall(sim, 10, 1, 20);
    const path = planPath(map, { x: 5, y: 5 }, { x: 15, y: 5 })!;
    expect(path[path.length - 1]).toEqual({ x: 15, y: 5 });
    expect(path.some((t) => t.y >= 21)).toBe(true);
    // Blocked target: ends next to it.
    const near = planPath(map, { x: 5, y: 5 }, { x: 10, y: 5 })!;
    const end = near[near.length - 1]!;
    expect(Math.max(Math.abs(end.x - 10), Math.abs(end.y - 5))).toBe(1);
    // Walled-in target (closed 7x7 box): unreachable, fallbacks included.
    for (let i = 20; i <= 26; i++) {
      for (const [x, y] of [
        [i, 20],
        [i, 26],
        [20, i],
        [26, i],
      ] as const)
        map.walkable[y * 32 + x] = 0;
    }
    expect(planPath(map, { x: 5, y: 5 }, { x: 23, y: 23 })).toBeNull();
  });

  it("move: walks the A* path and turns idle on arrival", () => {
    const sim = newSim();
    wall(sim, 10, 1, 20);
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    expect(sim.dispatch("classic.moveTo", { x: 15, y: 5 }, null).ok).toBe(true);
    sim.step(1);
    expect(sim.world.read(h, Mover).path.length).toBeGreaterThan(10);
    for (let i = 0; i < 200 && sim.world.read(h, Intent).kind !== "idle"; i++) sim.step(1);
    expect(sim.world.read(h, Intent).kind).toBe("idle");
    expect(tileOf(sim, h)).toEqual({ x: 15, y: 5 });
  });

  it("skill: approaches into range, orders the cast, then idles", () => {
    const sim = newSim();
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    const m = spawnTestMonster(sim.world, { x: 12, y: 5, life: 500 });
    sim.dispatch(
      "classic.useSkill",
      { skill: "test.skill.strike", target: m, x: sub(12), y: sub(5), repeat: false },
      null,
    );
    const events: GameEvent[] = [];
    for (let i = 0; i < 80 && sim.world.read(h, Intent).kind !== "idle"; i++) {
      events.push(...sim.step(1));
    }
    expect(of(events, "classic.cast")).toHaveLength(1);
    const p = sim.world.read(h, Pos);
    const reach = 400 + 80;
    expect((p.x - sub(12)) ** 2 + (p.y - sub(5)) ** 2).toBeLessThanOrEqual(reach * reach);
    expect(sim.world.read(h, Mover)).toMatchObject({ path: [], goalX: -1 });
    events.push(...sim.step(30));
    expect(of(events, "classic.cast")).toHaveLength(1);
  });

  it("skill: chases around a wall with A* when there is no line of sight", () => {
    const sim = newSim();
    wall(sim, 10, 1, 20);
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    const m = spawnTestMonster(sim.world, { x: 14, y: 5, life: 500 });
    sim.dispatch(
      "classic.useSkill",
      { skill: "test.skill.strike", target: m, x: 0, y: 0, repeat: false },
      null,
    );
    sim.step(1);
    expect(sim.world.read(h, Mover).path.length).toBeGreaterThan(0);
    const events: GameEvent[] = [];
    for (let i = 0; i < 300 && sim.world.read(h, Intent).kind !== "idle"; i++) {
      events.push(...sim.step(1));
    }
    expect(of(events, "classic.cast")).toHaveLength(1);
  });

  it("skill with repeat keeps attacking until the target is dead", () => {
    const sim = newSim();
    const h = spawnTestHero(sim.world, { x: 5, y: 5, stats: { toHit: 100000 } });
    const m = spawnTestMonster(sim.world, { x: 6, y: 5, life: 30, stats: { armor: 0 } });
    sim.dispatch(
      "classic.useSkill",
      { skill: "test.skill.strike", target: m, x: 0, y: 0, repeat: true },
      null,
    );
    const events = sim.step(400);
    expect(sim.world.has(m, Dead)).toBe(true);
    expect(of(events, "classic.cast").length).toBeGreaterThan(3);
    expect(sim.world.read(h, Intent).kind).toBe("idle");
  });

  it("self and point skills are ordered at once", () => {
    const sim = newSim();
    const h = spawnTestHero(sim.world, {
      x: 5,
      y: 5,
      skills: [
        { skill: "test.skill.bolt", rank: 1 },
        { skill: "test.skill.nova", rank: 1 },
      ],
    });
    setIntent(sim, h, {
      kind: "skill",
      source: "auto",
      at: 0,
      skill: "test.skill.bolt",
      target: 0,
      x: sub(25),
      y: sub(25),
      repeat: false,
    });
    const ev = sim.step(1);
    expect(of(ev, "classic.cast")[0]).toMatchObject({ tx: sub(25), ty: sub(25) });
    expect(sim.world.read(h, Intent)).toMatchObject({ kind: "idle", source: "auto" });
  });

  it("pickup walks to the loot then queues the pickup command", () => {
    const sim = newSim();
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    const loot = sim.world.create();
    sim.world.add(loot, Loot, { kind: "gold", item: null, gold: 10, potion: "", droppedAt: 0 });
    sim.world.add(loot, Pos, { x: sub(10), y: sub(8) });
    sim.world.add(loot, AreaTag, { depth: 1 });
    expect(sim.dispatch("classic.pickup", { target: loot }, null).ok).toBe(true);
    const events: GameEvent[] = [];
    for (let i = 0; i < 100 && sim.world.read(h, Intent).kind !== "idle"; i++) {
      events.push(...sim.step(1));
    }
    // Leftover commands get one more tick before core.cleanup drops them.
    events.push(...sim.step(1));
    // Nobody owns "pickup" in this test mode: core.cleanup reports it.
    expect(of(events, "classic.command.failed").map((e) => e.op)).toEqual(["pickup"]);
    const p = sim.world.read(h, Pos);
    expect((p.x - sub(10)) ** 2 + (p.y - sub(8)) ** 2).toBeLessThanOrEqual(384 * 384);
  });

  it("interact handles NPCs and every interactable kind", () => {
    const sim = newSim();
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    const spawnThing = (x: number, y: number): Entity => {
      const e = sim.world.create();
      sim.world.add(e, Pos, { x: sub(x), y: sub(y) });
      sim.world.add(e, AreaTag, { depth: 1 });
      return e;
    };
    const healer = spawnThing(8, 5);
    sim.world.add(healer, Npc, { proto: "test.npc.healer" });
    sim.world.add(healer, Body, { radius: 80, solid: true });
    const things: [InteractableKind, Entity][] = [];
    for (const [i, kind] of (
      ["stairsDown", "stairsUp", "portal", "waypoint", "stash"] as InteractableKind[]
    ).entries()) {
      const e = spawnThing(8 + i * 3, 12);
      sim.world.add(e, Interactable, { kind, toDepth: 2 });
      things.push([kind, e]);
    }
    const use = (target: Entity): GameEvent[] => {
      expect(sim.dispatch("classic.interact", { target }, null).ok).toBe(true);
      const out: GameEvent[] = [];
      for (let i = 0; i < 200; i++) {
        out.push(...sim.step(1));
        if (sim.world.read(h, Intent).kind === "idle") break;
      }
      // Leftover commands get one more tick before core.cleanup drops them.
      out.push(...sim.step(1));
      return out;
    };
    const ev = use(healer);
    expect(of(ev, "classic.npc.opened")[0]).toMatchObject({
      npc: healer,
      proto: "test.npc.healer",
      role: "healer",
    });
    expect(of(ev, "classic.command.failed").map((e) => e.op)).toEqual(["heal"]);
    const seen: string[] = [];
    for (const [, e] of things) {
      const out = use(e);
      seen.push(
        ...of(out, "classic.command.failed").map((x) => `cmd:${x.op}`),
        ...out
          .filter((x) => x.type === "classic.waypoint.opened" || x.type === "classic.stash.opened")
          .map((x) => x.type),
      );
    }
    expect(seen).toEqual([
      "cmd:stairs",
      "cmd:stairs",
      "cmd:usePortal",
      "classic.waypoint.opened",
      "classic.stash.opened",
    ]);
  });

  it("does nothing while busy, then resumes", () => {
    const sim = newSim();
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    sim.world.add(h, Casting, {
      skill: "test.skill.strike",
      rank: 1,
      target: 0,
      x: 0,
      y: 0,
      startedAt: 0,
      hitAt: 4,
      endAt: 6,
      fired: true,
      pulses: 0,
    });
    setIntent(sim, h, { kind: "move", source: "auto", at: 0, x: 10, y: 5 });
    sim.step(3);
    expect(sim.world.read(h, Mover).path).toEqual([]);
    expect(sim.world.read(h, Pos).x).toBe(sub(5));
    sim.step(5);
    expect(sim.world.read(h, Mover).path.length).toBeGreaterThan(0);
    expect(sim.world.read(h, Pos).x).toBeGreaterThan(sub(5));
  });

  it("a new intent drops the previous walk", () => {
    const sim = newSim();
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    sim.dispatch("classic.moveTo", { x: 20, y: 5 }, null);
    sim.step(5);
    setIntent(sim, h, { kind: "move", source: "auto", at: sim.tick, x: 5, y: 20 });
    sim.step(1);
    const path = sim.world.read(h, Mover).path;
    expect(path[path.length - 1]).toEqual({ x: 5, y: 20 });
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe("core actions", () => {
  function rejects(sim: Sim, name: string, payload: unknown, code: string): void {
    const before = sim.hash();
    const res = sim.dispatch(name, payload, null);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(code);
    expect(sim.hash()).toBe(before);
  }

  it("rejects everything without a hero or with a dead hero", () => {
    const sim = newSim();
    rejects(sim, "classic.moveTo", { x: 3, y: 3 }, "no_hero");
    rejects(sim, "classic.stop", {}, "no_hero");
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    sim.world.add(h, Dead, { at: 0, killer: 0 });
    rejects(sim, "classic.moveTo", { x: 3, y: 3 }, "dead");
    rejects(
      sim,
      "classic.useSkill",
      { skill: "test.skill.nova", target: 0, x: 0, y: 0, repeat: false },
      "dead",
    );
  });

  it("validates moveTo", () => {
    const sim = newSim();
    spawnTestHero(sim.world, { x: 5, y: 5 });
    rejects(sim, "classic.moveTo", null, "bad_payload");
    rejects(sim, "classic.moveTo", { x: 1.5, y: 3 }, "bad_payload");
    rejects(sim, "classic.moveTo", { x: "3", y: 3 }, "bad_payload");
    rejects(sim, "classic.moveTo", { x: 40, y: 3 }, "bad_target");
    rejects(sim, "classic.moveTo", { x: -1, y: 3 }, "bad_target");
    rejects(sim, "classic.moveTo", { x: 0, y: 3 }, "blocked");
  });

  it("validates useSkill", () => {
    const sim = newSim();
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    const m = spawnTestMonster(sim.world, { x: 8, y: 5 });
    const elsewhere = spawnTestMonster(sim.world, { x: 8, y: 6, depth: 2 });
    const dead = spawnTestMonster(sim.world, { x: 8, y: 7 });
    sim.world.add(dead, Dead, { at: 0, killer: 0 });
    const p = (o: Record<string, unknown>) => ({
      skill: "test.skill.strike",
      target: m,
      x: sub(8),
      y: sub(5),
      repeat: false,
      ...o,
    });
    rejects(sim, "classic.useSkill", p({ skill: 3 }), "bad_payload");
    rejects(sim, "classic.useSkill", p({ repeat: "yes" }), "bad_payload");
    rejects(sim, "classic.useSkill", p({ target: -2 }), "bad_payload");
    rejects(sim, "classic.useSkill", p({ skill: "test.skill.nope" }), "unknown_id");
    rejects(sim, "classic.useSkill", p({ skill: "test.skill.nova" }), "not_known");
    rejects(sim, "classic.useSkill", p({ target: 0 }), "bad_target");
    rejects(sim, "classic.useSkill", p({ target: elsewhere }), "bad_target");
    rejects(sim, "classic.useSkill", p({ target: dead }), "bad_target");
    rejects(sim, "classic.useSkill", p({ target: h }), "bad_target");
    rejects(sim, "classic.useSkill", p({ target: 999 }), "bad_target");
    rejects(
      sim,
      "classic.useSkill",
      p({ skill: "test.skill.bolt", target: 0, x: 32 * 256 }),
      "bad_target",
    );
    const res = sim.dispatch("classic.useSkill", p({ repeat: true }), null);
    expect(res.ok).toBe(true);
    expect(sim.world.read(h, Intent)).toEqual({
      kind: "skill",
      source: "manual",
      at: 0,
      skill: "test.skill.strike",
      target: m,
      x: sub(8),
      y: sub(5),
      repeat: true,
    });
  });

  it("validates pickup and interact targets", () => {
    const sim = newSim();
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    const m = spawnTestMonster(sim.world, { x: 8, y: 5 });
    rejects(sim, "classic.pickup", { target: m }, "bad_target");
    rejects(sim, "classic.pickup", { target: 0 }, "bad_target");
    rejects(sim, "classic.pickup", {}, "bad_payload");
    rejects(sim, "classic.interact", { target: m }, "bad_target");
    rejects(sim, "classic.interact", { target: h }, "bad_target");
    const npc = sim.world.create();
    sim.world.add(npc, Npc, { proto: "test.npc.smith" });
    sim.world.add(npc, Pos, { x: sub(9), y: sub(9) });
    sim.world.add(npc, AreaTag, { depth: 0 }); // town NPC, hero is in depth 1
    rejects(sim, "classic.interact", { target: npc }, "bad_target");
    sim.world.read(npc, AreaTag).depth = 1;
    expect(sim.dispatch("classic.interact", { target: npc }, null).ok).toBe(true);
  });

  it("stop idles the hero, clears the walk and the pending order", () => {
    const sim = newSim();
    const h = spawnTestHero(sim.world, { x: 5, y: 5 });
    sim.dispatch("classic.moveTo", { x: 20, y: 5 }, null);
    sim.step(3);
    sim.world.add(h, CastOrder, { skill: "test.skill.bolt", target: 0, x: 0, y: 0 });
    expect(sim.dispatch("classic.stop", {}, null).ok).toBe(true);
    expect(sim.dispatch("classic.stop", undefined, null).ok).toBe(true);
    expect(sim.world.read(h, Intent)).toEqual({ kind: "idle", source: "manual", at: 3 });
    expect(sim.world.read(h, Mover)).toMatchObject({ path: [], goalX: -1, goalY: -1 });
    expect(sim.world.has(h, CastOrder)).toBe(false);
    const x = sim.world.read(h, Pos).x;
    sim.step(5);
    expect(sim.world.read(h, Pos).x).toBe(x);
  });

  it("manual actions pause the auto controller", () => {
    const sim = newSim();
    spawnTestHero(sim.world, { x: 5, y: 5 });
    sim.world.getResource<ControlState>(RES.control)!.mode = "auto";
    sim.step(10);
    sim.dispatch("classic.moveTo", { x: 9, y: 9 }, null);
    expect(sim.world.getResource<ControlState>(RES.control)!.overrideUntil).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  function script(seed: number): Sim {
    const sim = newSim(seed);
    wall(sim, 12, 3, 25);
    const h = spawnTestHero(sim.world, { x: 4, y: 4 });
    const ms: Entity[] = [];
    for (let i = 0; i < 8; i++) {
      const m = spawnTestMonster(sim.world, { x: 15 + (i % 4), y: 6 + i * 2, life: 40 });
      Object.assign(sim.world.read(m, Mover), { goalX: sub(6), goalY: sub(6 + i) });
      ms.push(m);
    }
    sim.dispatch("classic.moveTo", { x: 20, y: 4 }, null);
    sim.step(30);
    sim.dispatch(
      "classic.useSkill",
      { skill: "test.skill.strike", target: ms[0]!, x: 0, y: 0, repeat: true },
      null,
    );
    sim.step(60);
    sim.dispatch(
      "classic.useSkill",
      { skill: "test.skill.bolt", target: 0, x: sub(20), y: sub(20), repeat: false },
      null,
    );
    sim.step(30);
    sim.dispatch("classic.moveTo", { x: 25, y: 25 }, null);
    sim.step(60);
    expect(busOf(sim.world).hits).toEqual([]);
    expect(sim.world.read(h, Life).hp).toBeGreaterThan(0);
    return sim;
  }

  it("same seed and script give the same hash", () => {
    expect(script(5).hash()).toBe(script(5).hash());
  });

  it("pins the hash after a fixed script", () => {
    expect(script(9).hash()).toBe("6f3ff82774784ff3");
  });
});
