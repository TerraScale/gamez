/**
 * Quest-blocking balance (quest fix, round 1): the gameplay that kept Auto
 * and Idle heroes from finishing the boss and depth quests, on the real
 * classic content with every module (plus classic.debug for the grants).
 *
 * - The warrior used to stall at depths 3-4 (34 deaths and 2 depth-4 boss
 *   kills in 8 seeds x 36 000 ticks): it burnt its small mana pool on
 *   single-target cleaves (no Rallying Cry or Mend left) and opened with a
 *   2-7 short sword. Now: 7 deaths, 5 kills, 5 runs at depth 6+.
 * - Boss fights: a level-appropriate hero of each class kills Morrow
 *   (depth 4). Vessa (depth 12) and the Hollow King (16) are still out of
 *   reach for Auto (see the todos for the measured numbers).
 * - Browser QA: `spawnBoss` + `woundBosses: 1` in one grant failed with "no
 *   living boss" (the spawn is queued) and rolled the spawn back with it, so
 *   QA wounded nothing and watched a full-life boss. The wound now waits for
 *   the queued boss, and the spawn tile is always one the hero can walk to.
 *
 * Budgets are the measured ticks plus a margin; content and the Auto
 * controller change in parallel, so they are not exact.
 */
import { createSim, loadMode, type Entity, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { pushTransition } from "../src/bus.ts";
import { AreaTag, Belt, Dead, Level, Life, Monster, Pos, Supplies } from "../src/components.ts";
import {
  DEBUG_GRANT,
  reachableSpawnTile,
  SPAWN_MAX_STEPS,
  SPAWN_MIN_TILES,
} from "../src/debug/index.ts";
import { debugModules, mode, modules } from "../src/index.ts";
import { placeNear } from "../src/monsters/spawn.ts";
import { currentDepth, dungeonOf, heroOf } from "../src/resources.ts";
import { gridOf } from "../src/spatial.ts";
import type { ClassicMap } from "../src/world/maps.ts";
import { getAreaMap } from "../src/world/maps.ts";

const loaded = loadMode(mode, modules);
const debugLoaded = loadMode(mode, [...modules, ...debugModules]);

const WARDEN = "classic.monster.boss_warden";

function grant(sim: Sim, payload: Record<string, unknown>): void {
  const r = sim.dispatch(DEBUG_GRANT, payload, null);
  expect(r.ok, `${JSON.stringify(payload)}: ${r.error?.message ?? ""}`).toBe(true);
}

function bossAlive(sim: Sim, depth = currentDepth(sim.world)): Entity {
  for (const e of sim.world.query(Monster, AreaTag)) {
    if (sim.world.has(e, Dead) || sim.world.read(e, AreaTag).depth !== depth) continue;
    if (sim.world.read(e, Monster).rarity === "boss") return e;
  }
  return 0;
}

/** Steps until a classic.boss.killed event (or the budget); returns the ticks it took, or -1. */
function untilBossKilled(sim: Sim, budget: number): number {
  for (let i = 1; i <= budget; i++) {
    const ev = sim.step(1) as GameEvent[];
    if (ev.some((e) => e.type === "classic.boss.killed")) return i;
  }
  return -1;
}

/** 4-neighbour walking distance (tiles) between two tiles of `map`, or -1. */
function walkSteps(map: ClassicMap, ax: number, ay: number, bx: number, by: number): number {
  const w = map.width;
  const seen = new Map<number, number>([[ay * w + ax, 0]]);
  const queue = [ay * w + ax];
  for (let h = 0; h < queue.length; h++) {
    const k = queue[h]!;
    const d = seen.get(k)!;
    const x = k % w;
    const y = (k - x) / w;
    if (x === bx && y === by) return d;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const nk = ny * w + nx;
      if (nx < 0 || ny < 0 || nx >= w || ny >= map.height) continue;
      if (seen.has(nk) || map.walkable[nk] !== 1) continue;
      seen.set(nk, d + 1);
      queue.push(nk);
    }
  }
  return -1;
}

/**
 * A level-appropriate hero (debug grants: `level`, ilvl level-1 rares in
 * every slot, waypoints to `depth`, full belt of the level's potion tier, 5
 * scrolls) on the boss depth `depth` with the level's other monsters
 * removed, 6 tiles from the boss, then Auto.
 */
function bossFight(classId: string, level: number, depth: number, seed: number): Sim {
  const sim = createSim(debugLoaded, { seed });
  expect(sim.dispatch("classic.newHero", { classId, name: "Tester" }, null).ok).toBe(true);
  sim.dispatch("classic.setControl", { mode: "manual" }, null);
  sim.step(1);
  grant(sim, { levels: level - 1, gold: 5000, deepest: depth });
  for (const category of ["weapon", "weapon", "weapon", "weapon", "armor", "helm", "boots"])
    grant(sim, { items: { count: 1, rarity: "rare", ilvl: level, category } });
  for (const category of ["gloves", "ring", "amulet", "shield"])
    grant(sim, {
      items: { count: category === "ring" ? 2 : 1, rarity: "rare", ilvl: level, category },
    });
  sim.step(40);
  // Auto equips the grants and spends the stat and skill points.
  sim.dispatch("classic.setControl", { mode: "auto" }, null);
  sim.step(60);
  sim.dispatch("classic.setControl", { mode: "manual" }, null);
  const dungeon = dungeonOf(sim.world);
  dungeon.waypoints = [];
  for (let d = 1; d <= depth; d += 2) dungeon.waypoints.push(d);
  pushTransition(sim.world, { to: depth, via: "stairsDown" });
  sim.step(2);
  const hero = heroOf(sim.world);
  const potion =
    level >= 20
      ? "classic.item.potion_life_3"
      : level >= 10
        ? "classic.item.potion_life_2"
        : "classic.item.potion_life_1";
  const belt = sim.world.read(hero, Belt);
  sim.world.update(hero, Belt, { slots: belt.slots.map(() => ({ base: potion, count: 5 })) });
  sim.world.update(hero, Supplies, { tpScrolls: 5 });
  for (const e of sim.world.query(Monster, AreaTag)) {
    if (sim.world.read(e, AreaTag).depth !== depth) continue;
    if (sim.world.read(e, Monster).rarity !== "boss") sim.world.destroy(e);
  }
  const boss = bossAlive(sim, depth);
  expect(boss, "the boss of the depth").not.toBe(0);
  const bp = sim.world.read(boss, Pos);
  const at = placeNear(getAreaMap(sim.world, sim.loaded.registry), bp.x + 6 * 256, bp.y);
  sim.world.update(hero, Pos, at);
  gridOf(sim.world).move(hero, at.x, at.y);
  sim.step(1);
  sim.dispatch("classic.setControl", { mode: "auto" }, null);
  return sim;
}

describe("warrior Auto reaches the depth-4 boss and depth 6", () => {
  it("seed 8: kills Morrow and reaches depth 6 within 32 000 ticks from a fresh hero", () => {
    // Measured: Morrow at tick 26 734, depth 6 at 30 410 (before: deepest 3, 0 boss kills).
    const sim = createSim(loaded, { seed: 8 });
    expect(
      sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "W" }, null).ok,
    ).toBe(true);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    let warden = -1;
    let deaths = 0;
    for (let t = 0; t < 32_000; t++) {
      for (const e of sim.step(1) as GameEvent[]) {
        if (e.type === "classic.hero.died") deaths++;
        if (e.type === "classic.boss.killed" && (e as { monster?: string }).monster === WARDEN)
          warden = sim.tick;
      }
      if (warden > 0 && dungeonOf(sim.world).deepest >= 6) break;
    }
    expect(warden, "Morrow killed").toBeGreaterThan(0);
    expect(dungeonOf(sim.world).deepest).toBeGreaterThanOrEqual(6);
    expect(deaths).toBeLessThanOrEqual(3);
  }, 240_000);
});

describe("boss fights: a level-appropriate Auto hero kills the boss", () => {
  // Measured (seed 1): warrior 4 130, rogue 1 873, sorcerer 2 062 ticks.
  for (const cls of ["classic.warrior", "classic.rogue", "classic.sorcerer"]) {
    it(`${cls} (level 9) kills Morrow at depth 4 within 5 000 ticks`, () => {
      const sim = bossFight(cls, 9, 4, 1);
      expect(untilBossKilled(sim, 5000)).toBeGreaterThan(0);
      expect(dungeonOf(sim.world).bossesKilled).toContain(4);
    }, 120_000);
  }

  // Vessa (depth 12) and the Hollow King (depth 16) are not killed by Auto yet: isolated
  // fights (the level's other monsters removed, quests out of the way, ilvl-level rares,
  // 12 000 ticks, seeds 1-3) never finished either boss. Vessa vs level-22 heroes: 2-6 k of
  // her 8 625 life dealt, 2-5 deaths and 40-90 potions per run (her basic Firebolt is 60-70 %
  // of the damage taken); the Hollow King vs level 27: 0.7-9 k of 17 400. Each death or
  // retreat loop rebuilds the level (the wound is kept, the packs come back).
  it.todo("each class (level 20-22) kills Vessa at depth 12 within a bounded budget");
  it.todo("each class (level 26-28) kills the Hollow King at depth 16 within a bounded budget");
});

describe("debug boss grants (browser QA repro: spawnBoss + woundBosses 1 + Auto)", () => {
  function questHero(seed: number): Sim {
    const sim = createSim(debugLoaded, { seed });
    expect(
      sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "QA" }, null).ok,
    ).toBe(true);
    sim.dispatch("classic.setControl", { mode: "manual" }, null);
    sim.step(1);
    grant(sim, { levels: 25 });
    sim.step(40);
    pushTransition(sim.world, { to: 1, via: "stairsDown" });
    sim.step(2);
    return sim;
  }

  it("wounds a boss spawned in the same grant; Auto then kills it at once", () => {
    const sim = questHero(7);
    grant(sim, { spawnBoss: WARDEN, woundBosses: 1 });
    sim.step(1);
    const boss = bossAlive(sim);
    expect(boss).not.toBe(0);
    const life = sim.world.read(boss, Life);
    expect(life.hp).toBe(Math.max(1, Math.floor(life.max / 100)));
    // The boss stands on a tile the hero can walk to.
    const map = getAreaMap(sim.world, sim.loaded.registry);
    const hp = sim.world.read(heroOf(sim.world), Pos);
    const bp = sim.world.read(boss, Pos);
    const steps = walkSteps(map, hp.x >> 8, hp.y >> 8, bp.x >> 8, bp.y >> 8);
    expect(steps).toBeGreaterThanOrEqual(SPAWN_MIN_TILES);
    expect(steps).toBeLessThanOrEqual(SPAWN_MAX_STEPS);
    sim.dispatch("classic.setControl", { mode: "auto" }, null);
    // Measured: 50 ticks.
    expect(untilBossKilled(sim, 400)).toBeGreaterThan(0);
  }, 60_000);

  it("also wounds it when woundBosses comes as a second grant before the next step", () => {
    const sim = questHero(11);
    grant(sim, { spawnBoss: WARDEN });
    grant(sim, { woundBosses: 1 });
    sim.step(1);
    const boss = bossAlive(sim);
    const life = sim.world.read(boss, Life);
    expect(life.hp).toBe(Math.max(1, Math.floor(life.max / 100)));
    sim.dispatch("classic.setControl", { mode: "auto" }, null);
    expect(untilBossKilled(sim, 400)).toBeGreaterThan(0);
  }, 60_000);

  it("never places the boss behind a wall: the spawn tile is walked to, not measured across", () => {
    // 9 x 7: two rooms split by a wall at x = 4 with a door at (4, 6). From (3, 1)
    // the old ring scan (findFreeNear, radius 3) picked (6, 1): across the wall, 13 steps.
    const rows = [
      "#########",
      "#...#...#",
      "#...#...#",
      "#...#...#",
      "#...#...#",
      "#...#...#",
      "#.......#",
    ];
    const width = rows[0]!.length;
    const walkable = new Uint8Array(width * rows.length);
    rows.forEach((r, y) => {
      for (let x = 0; x < width; x++) walkable[y * width + x] = r[x] === "." ? 1 : 0;
    });
    const map = { width, height: rows.length, walkable } as unknown as ClassicMap;
    const at = reachableSpawnTile(map, { x: 3, y: 1 }, new Set());
    expect(at).not.toBeNull();
    const steps = walkSteps(map, 3, 1, at!.x, at!.y);
    expect(steps).toBeGreaterThanOrEqual(SPAWN_MIN_TILES);
    expect(steps).toBeLessThanOrEqual(SPAWN_MAX_STEPS);
    // Breadth-first from (3, 1) with up/right/down/left: the first tile 3 away in its own room.
    expect(at).toEqual({ x: 3, y: 4 });
    // Occupied tiles are skipped.
    const busy = new Set([4 * width + 3]);
    expect(reachableSpawnTile(map, { x: 3, y: 1 }, busy)).toEqual({ x: 3, y: 5 });
  });

  it("still refuses woundBosses with no boss alive or queued", () => {
    const sim = questHero(3);
    const before = sim.hash();
    const r = sim.dispatch(DEBUG_GRANT, { woundBosses: 1 }, null);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("bad_target");
    expect(sim.hash()).toBe(before);
  }, 60_000);
});

describe("determinism", () => {
  function script(): Sim {
    const sim = createSim(debugLoaded, { seed: 2026 });
    sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Pin" }, null);
    sim.dispatch("classic.setControl", { mode: "auto" }, null);
    sim.step(600);
    pushTransition(sim.world, { to: 2, via: "stairsDown" });
    sim.step(2);
    grant(sim, { levels: 6 });
    grant(sim, { spawnBoss: WARDEN, woundBosses: 20 });
    sim.step(400);
    return sim;
  }

  it("the same seed and script give the same hash (pinned)", () => {
    const a = script();
    const b = script();
    expect(a.hash()).toBe(b.hash());
    expect(a.world.read(heroOf(a.world), Level).level).toBeGreaterThanOrEqual(7);
    expect(a.hash()).toBe("183f66642ba90b3c");
  }, 120_000);
});
