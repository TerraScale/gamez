/**
 * classic.core with a party (docs/design/party.md §4.2, §7.1): every
 * member's Intent runs in the same ticks, interacting with a downed member
 * queues a revive for the right hero, downed members are not solid, and the
 * manual interact action accepts a downed member.
 */
import type { Entity, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION, ERR, type HeroCommand } from "../src/actions.ts";
import { busOf } from "../src/bus.ts";
import { Dead, Intent, Life, Pos } from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { gridOf } from "../src/spatial.ts";
import { spawnTestParty, testSim, useOpenMap } from "./support/harness.ts";

const MODULES = ["classic.core"];

function tileOf(sim: Sim, e: Entity): { x: number; y: number } {
  const p = sim.world.read(e, Pos);
  return { x: p.x >> 8, y: p.y >> 8 };
}

function down(sim: Sim, e: Entity): void {
  sim.world.add(e, Dead, { at: sim.tick, killer: 0 });
  sim.world.update(e, Life, { hp: 0 });
}

function party(n: number, seed = 1) {
  const sim = testSim(MODULES, { seed });
  useOpenMap(sim, 1);
  const heroes = spawnTestParty(
    sim.world,
    Array.from({ length: n }, () => ({ life: 500 })),
  );
  return { sim, heroes };
}

/** Commands queued this tick (cleanup marks leftovers `carried`; strip it for comparisons). */
function queued(sim: Sim): HeroCommand[] {
  return busOf(sim.world).commands.map((c) => {
    const { carried: _c, ...rest } = c as HeroCommand & { carried?: number };
    return rest as HeroCommand;
  });
}

describe("party intents", () => {
  it("runs every member's Intent in the same ticks", () => {
    const { sim, heroes } = party(3);
    const [a, b, c] = heroes as [Entity, Entity, Entity];
    sim.world.add(a, Intent, { kind: "move", source: "manual", at: sim.tick + 1, x: 5, y: 20 });
    sim.world.add(b, Intent, { kind: "move", source: "auto", at: sim.tick + 1, x: 20, y: 5 });
    sim.world.add(c, Intent, { kind: "move", source: "auto", at: sim.tick + 1, x: 20, y: 20 });
    sim.step(6);
    // Everyone left its spawn tile in the same ticks.
    expect(sim.world.read(a, Pos).y).toBeGreaterThan(tileCenter(5));
    expect(sim.world.read(b, Pos).x).toBeGreaterThan(tileCenter(6));
    expect(sim.world.read(c, Pos).y).toBeGreaterThan(tileCenter(5));
    sim.step(200);
    expect(tileOf(sim, a)).toEqual({ x: 5, y: 20 });
    expect(tileOf(sim, b)).toEqual({ x: 20, y: 5 });
    expect(tileOf(sim, c)).toEqual({ x: 20, y: 20 });
    for (const h of heroes) expect(sim.world.read(h, Intent).kind).toBe("idle");
  });

  it("queues a revive for the follower that interacts with a downed member", () => {
    const { sim, heroes } = party(3);
    const [, b, c] = heroes as [Entity, Entity, Entity];
    down(sim, c);
    sim.world.update(c, Pos, { x: tileCenter(12), y: tileCenter(10) });
    sim.world.add(b, Intent, { kind: "interact", source: "auto", at: sim.tick + 1, target: c });
    let revive: HeroCommand | undefined;
    for (let i = 0; i < 120 && revive === undefined; i++) {
      sim.step(1);
      revive = queued(sim).find((cmd) => cmd.op === "revive");
    }
    expect(revive).toEqual({ op: "revive", target: c, hero: b });
    expect(sim.world.read(b, Intent).kind).toBe("idle");
  });

  it("the controlled hero's revive command carries no hero (solo producers unchanged)", () => {
    const { sim, heroes } = party(2);
    const [a, b] = heroes as [Entity, Entity];
    down(sim, b);
    expect(sim.dispatch(ACTION.interact, { target: b }, null).ok).toBe(true);
    let revive: HeroCommand | undefined;
    for (let i = 0; i < 60 && revive === undefined; i++) {
      sim.step(1);
      revive = queued(sim).find((cmd) => cmd.op === "revive");
    }
    expect(revive).toEqual({ op: "revive", target: b });
    expect("hero" in revive!).toBe(false);
    expect(sim.world.read(a, Intent).kind).toBe("idle");
  });

  it("the interact action accepts only downed members", () => {
    const { sim, heroes } = party(2);
    const [, b] = heroes as [Entity, Entity];
    const before = sim.hash();
    const r = sim.dispatch(ACTION.interact, { target: b }, null);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(ERR.badTarget);
    expect(sim.hash()).toBe(before);
  });
});

describe("downed members", () => {
  it("are not solid: not indexed, never pushed, and they do not push", () => {
    const { sim, heroes } = party(2);
    const [a, b] = heroes as [Entity, Entity];
    down(sim, b);
    // Stack the standing hero exactly on the downed one.
    const p = sim.world.read(b, Pos);
    sim.world.update(a, Pos, { x: p.x, y: p.y });
    sim.step(10);
    expect(gridOf(sim.world).has(b)).toBe(false);
    expect(gridOf(sim.world).has(a)).toBe(true);
    expect(sim.world.read(a, Pos)).toEqual({ x: p.x, y: p.y });
    expect(sim.world.read(b, Pos)).toEqual({ x: p.x, y: p.y });
  });

  it("standing members still separate from each other", () => {
    const { sim, heroes } = party(2);
    const [a, b] = heroes as [Entity, Entity];
    const p = sim.world.read(b, Pos);
    sim.world.update(a, Pos, { x: p.x, y: p.y });
    sim.step(10);
    const pa = sim.world.read(a, Pos);
    const pb = sim.world.read(b, Pos);
    expect(pa.x !== pb.x || pa.y !== pb.y).toBe(true);
  });
});
