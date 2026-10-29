/**
 * classic.monsters with a party (docs/design/party.md §7.1, §8): target
 * choice among members (nearest standing, sticky, threat), per-member
 * distance fields, waking near any standing member, and spawn scaling by
 * party size (size 1 identical to solo).
 */
import type { Entity, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { pushHit, pushSpawn, type SpawnRequest } from "../src/bus.ts";
import { Ai, CombatStats, Dead, Life, Monster, Pos } from "../src/components.ts";
import { pct, tileCenter, tiles } from "../src/fixed.ts";
import { THREAT_HOLD } from "../src/monsters/util.ts";
import { DEFAULT_PARTY_PROTO } from "../src/rules.ts";
import {
  spawnTestHero,
  spawnTestMonster,
  spawnTestParty,
  testSim,
  useOpenMap,
} from "./support/harness.ts";

const MODULES = ["classic.core", "classic.combat", "classic.monsters"];

function newSim(seed = 1): Sim {
  const sim = testSim(MODULES, { seed });
  useOpenMap(sim, 1, 48);
  return sim;
}

function party(sim: Sim, at: [number, number][]): Entity[] {
  return spawnTestParty(
    sim.world,
    at.map(([x, y]) => ({ x, y, life: 100000 })),
  );
}

function down(sim: Sim, e: Entity): void {
  sim.world.add(e, Dead, { at: sim.tick, killer: 0 });
  sim.world.update(e, Life, { hp: 0 });
}

function targetOf(sim: Sim, m: Entity): Entity {
  return sim.world.read(m, Ai).target;
}

function hitFrom(sim: Sim, source: Entity, target: Entity): void {
  pushHit(sim.world, {
    source,
    target,
    skill: "",
    damage: { phys: 1, fire: 0, cold: 0, lightning: 0, poison: 0 },
    canMiss: false,
    crit: false,
    dot: false,
    statuses: [],
    knockback: 0,
  });
}

describe("party targeting", () => {
  it("targets the nearest standing member and switches when it goes down", () => {
    const sim = newSim();
    const [a, b, c] = party(sim, [
      [5, 5],
      [14, 5],
      [30, 30],
    ]) as [Entity, Entity, Entity];
    const m = spawnTestMonster(sim.world, { x: 16, y: 5, life: 100000 });
    // Monsters never attack: keep the members still with huge life anyway.
    sim.step(8);
    expect(targetOf(sim, m)).toBe(b);
    down(sim, b);
    sim.step(8);
    expect(targetOf(sim, m)).toBe(a);
    expect(targetOf(sim, m)).not.toBe(c);
  });

  it("keeps a member target until another member is 3 tiles closer", () => {
    const sim = newSim();
    const [a, b] = party(sim, [
      [10, 10],
      [10, 20],
    ]) as [Entity, Entity];
    const m = spawnTestMonster(sim.world, { x: 12, y: 10, life: 100000 });
    sim.step(8);
    expect(targetOf(sim, m)).toBe(a);
    // b becomes slightly closer than a: no switch.
    sim.world.update(b, Pos, {
      x: sim.world.read(m, Pos).x - tiles(1.5),
      y: sim.world.read(m, Pos).y + tiles(0.5),
    });
    sim.world.update(a, Pos, {
      x: sim.world.read(m, Pos).x - tiles(2.5),
      y: sim.world.read(m, Pos).y,
    });
    sim.step(8);
    expect(targetOf(sim, m)).toBe(a);
    // a walks 6 tiles away: b is now 3+ tiles closer.
    sim.world.update(a, Pos, {
      x: sim.world.read(m, Pos).x - tiles(7),
      y: sim.world.read(m, Pos).y - tiles(3),
    });
    sim.step(8);
    expect(targetOf(sim, m)).toBe(b);
  });

  it("switches to a member that hits it (threat), then holds THREAT_HOLD ticks", () => {
    const sim = newSim();
    const [a, b, c] = party(sim, [
      [10, 10],
      [10, 18],
      [18, 18],
    ]) as [Entity, Entity, Entity];
    const m = spawnTestMonster(sim.world, { x: 11, y: 10, life: 100000 });
    sim.step(8);
    expect(targetOf(sim, m)).toBe(a);
    hitFrom(sim, b, m);
    sim.step(1);
    expect(targetOf(sim, m)).toBe(b);
    // A second hitter during the hold does not flip it back.
    hitFrom(sim, c, m);
    sim.step(1);
    expect(targetOf(sim, m)).toBe(b);
    // Even with a much closer than b, the lock holds.
    sim.step(THREAT_HOLD - 10);
    expect(targetOf(sim, m)).toBe(b);
  });

  it("never targets a downed member and goes idle when the whole party is down", () => {
    const sim = newSim();
    const [a, b] = party(sim, [
      [10, 10],
      [12, 10],
    ]) as [Entity, Entity];
    const m = spawnTestMonster(sim.world, { x: 13, y: 10, life: 100000 });
    down(sim, b);
    sim.step(8);
    expect(targetOf(sim, m)).toBe(a);
    down(sim, a);
    sim.step(200);
    expect(targetOf(sim, m)).toBe(0);
  });

  it("each chaser walks around walls toward its own member", () => {
    const sim = newSim();
    const [a, b] = party(sim, [
      [5, 5],
      [40, 40],
    ]) as [Entity, Entity];
    const ma = spawnTestMonster(sim.world, { x: 9, y: 5, life: 100000 });
    const mb = spawnTestMonster(sim.world, { x: 36, y: 40, life: 100000 });
    const da = sim.world.read(ma, Pos).x - sim.world.read(a, Pos).x;
    const db = sim.world.read(b, Pos).x - sim.world.read(mb, Pos).x;
    sim.step(30);
    expect(targetOf(sim, ma)).toBe(a);
    expect(targetOf(sim, mb)).toBe(b);
    expect(sim.world.read(ma, Pos).x - sim.world.read(a, Pos).x).toBeLessThan(da);
    expect(sim.world.read(b, Pos).x - sim.world.read(mb, Pos).x).toBeLessThan(db);
  });

  it("wakes near any standing member, sleeps when far from all", () => {
    const sim = newSim();
    const [a, b] = party(sim, [
      [3, 3],
      [40, 40],
    ]) as [Entity, Entity];
    void a;
    void b;
    const near = spawnTestMonster(sim.world, { x: 42, y: 42, awake: false, life: 100000 });
    sim.step(12);
    expect(sim.world.read(near, Ai).state).not.toBe("sleep");
    down(sim, b);
    sim.step(12);
    expect(sim.world.read(near, Ai).state).toBe("sleep");
  });
});

// ---------------------------------------------------------------------------
// Spawn scaling
// ---------------------------------------------------------------------------

function req(over: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    monster: "test.monster.dummy",
    x: tileCenter(20),
    y: tileCenter(20),
    depth: 1,
    level: 5,
    rarity: "normal",
    mods: [],
    pack: 1,
    name: "",
    owner: 0,
    team: "monster",
    until: 0,
    awake: false,
    ...over,
  };
}

/** Spawns `request` in a fresh sim with `size` heroes (0 = solo, no party resource). */
function spawned(size: number, request: SpawnRequest = req()): { sim: Sim; m: Entity } {
  const sim = newSim(3);
  if (size === 0) spawnTestHero(sim.world, { x: 5, y: 5 });
  else
    party(
      sim,
      Array.from({ length: size }, (_, i) => [5 + i, 5] as [number, number]),
    );
  pushSpawn(sim.world, request);
  sim.step(1);
  const m = sim.world.query(Monster).at(-1)!;
  return { sim, m };
}

function stateOf(sim: Sim, m: Entity) {
  return {
    life: sim.world.read(m, Life),
    stats: sim.world.read(m, CombatStats),
    mon: sim.world.read(m, Monster),
  };
}

describe("party spawn scaling", () => {
  it("a party of one spawns exactly like solo", () => {
    const solo = spawned(0);
    const one = spawned(1);
    expect(stateOf(one.sim, one.m)).toEqual(stateOf(solo.sim, solo.m));
  });

  it("scales life, damage and xp by party size; hero summons stay unscaled", () => {
    const s0 = spawned(0);
    const solo = stateOf(s0.sim, s0.m);
    const four = spawned(4);
    const s4 = stateOf(four.sim, four.m);
    expect(s4.life.max).toBe(pct(solo.life.max, DEFAULT_PARTY_PROTO.monsterLifePct[3]!));
    expect(s4.life.hp).toBe(s4.life.max);
    expect(s4.stats.dmgMin).toBe(pct(solo.stats.dmgMin, 130));
    expect(s4.stats.dmgMax).toBe(pct(solo.stats.dmgMax, 130));
    expect(s4.mon.xp).toBe(pct(solo.mon.xp, 210));
    const two = spawned(2);
    expect(stateOf(two.sim, two.m).life.max).toBe(pct(solo.life.max, 160));

    const summon = spawned(4, req({ team: "hero", rarity: "summon" }));
    const soloSummon = spawned(0, req({ team: "hero", rarity: "summon" }));
    expect(stateOf(summon.sim, summon.m).life.max).toBe(
      stateOf(soloSummon.sim, soloSummon.m).life.max,
    );
  });
});
