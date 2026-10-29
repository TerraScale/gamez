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
 *   (depth 4), and a hero at the quest level kills Vessa (depth 12) and the
 *   Hollow King (16) and turns The Ninth Flame and Crown of Hollows in (the
 *   measured numbers are with those tests; Skarn is in quests.bosses.test.ts).
 * - Browser QA: `spawnBoss` + `woundBosses: 1` in one grant failed with "no
 *   living boss" (the spawn is queued) and rolled the spawn back with it, so
 *   QA wounded nothing and watched a full-life boss. The wound now waits for
 *   the queued boss, and the spawn tile is always one the hero can walk to.
 *
 * Budgets are the measured ticks plus a margin; content and the Auto
 * controller change in parallel, so they are not exact.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { pushTransition } from "../src/bus.ts";
import { Level, Life, Pos } from "../src/components.ts";
import {
  DEBUG_GRANT,
  reachableSpawnTile,
  SPAWN_MAX_STEPS,
  SPAWN_MIN_TILES,
} from "../src/debug/index.ts";
import { debugModules, mode, modules } from "../src/index.ts";
import { dungeonOf, heroOf } from "../src/resources.ts";
import type { ClassicMap } from "../src/world/maps.ts";
import { getAreaMap } from "../src/world/maps.ts";
import {
  bossAlive,
  bossFight,
  expectBossQuest,
  grant,
  HOLLOW_KING,
  untilBossKilled,
  VESSA,
} from "./support/boss-quests.ts";

const loaded = loadMode(mode, modules);
const debugLoaded = loadMode(mode, [...modules, ...debugModules]);

const WARDEN = "classic.monster.boss_warden";

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

describe("warrior Auto reaches the depth-4 boss and depth 6", () => {
  it("seed 8: kills Morrow and reaches depth 6 within 34 000 ticks from a fresh hero", () => {
    // Measured: Morrow at tick 26 734, depth 6 at 30 410 (before: deepest 3, 0 boss kills).
    const sim = createSim(loaded, { seed: 8 });
    expect(
      sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "W" }, null).ok,
    ).toBe(true);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    let warden = -1;
    let deaths = 0;
    for (let t = 0; t < 34_000; t++) {
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
});

/**
 * The last two chain quests (QA quest fix round 1, docs/design/classic.md
 * §15.6): a hero at the quest's reqLevel (rares of its level in every slot,
 * the quest log of that level: every lower quest turned in, this one
 * accepted) kills the boss under Auto, goes to town and turns the quest in
 * (tests/support/boss-quests.ts). Before, at the quest level: Vessa killed
 * the seed-2 sorcerer 5 times (empty belt, no retreat while casting), the
 * Hollow King never fell to the seed-1/2 sorcerer and the seed-2/3 warrior
 * (a death at his last phase, then 4-5 in all on the rebuilt levels). Measured
 * after (seeds 1-3, ticks to the kill): Vessa warrior 2 888-5 355, rogue
 * 956-1 656, sorcerer 1 328-1 730; the Hollow King warrior 3 146-6 300,
 * rogue 1 405-2 530, sorcerer 1 059-1 327. Budget: the 12 000-tick target.
 */
describe("boss quests: a quest-level Auto hero kills the boss and turns the quest in", () => {
  for (const b of [VESSA, HOLLOW_KING]) {
    for (const cls of ["classic.warrior", "classic.rogue", "classic.sorcerer"]) {
      it(`${cls} (level ${b.level}) kills ${b.name} at depth ${b.depth} and turns the quest in, seeds 1-3`, () => {
        for (const seed of [1, 2, 3]) expectBossQuest(cls, b, b.level, seed);
      }, 300_000);
    }
  }
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
    expect(a.hash()).toBe("b1c4f9363f445599");
  }, 120_000);
});
