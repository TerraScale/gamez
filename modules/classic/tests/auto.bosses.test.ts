/**
 * Auto boss fights (quest fix round 2, docs/design/classic.md §15.5): on the
 * real classic content with every module, through real actions and Auto
 * (classic.setControl {mode: "auto"}).
 *
 * - A boss-ready hero of each class (level monsterLevel(depth) +
 *   BOSS_READY_LEVELS, a rare item of its level in every slot, the belt full
 *   of the level's potion tier, 5 000 gold, waypoints to the depth, quests
 *   out of the way) kills Morrow (depth 4) and Vessa (depth 12) on an
 *   otherwise empty boss level, starting 6 walking steps from the boss.
 *   Before the rework (same harness, seed 1, 12 000 ticks): Morrow took the
 *   warrior 5 161 ticks (rogue 2 750, sorcerer 2 979) and Vessa killed every
 *   class (never killed).
 * - A fresh warrior under Auto kills Morrow (it used to stall at depth 4:
 *   3 of 8 seeds in 30 minutes, the boss barely scratched).
 * - Determinism: the same seed and script give the same hash.
 */
import { createSim, loadMode, type Entity, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { BOSS_READY_LEVELS } from "../src/auto/dungeon.ts";
import { pushCommand, pushTransition } from "../src/bus.ts";
import { AreaTag, Belt, Dead, Level, Monster, Pos, Supplies } from "../src/components.ts";
import { BALANCE } from "../src/content/balance.ts";
import { mode, modules } from "../src/index.ts";
import { currentDepth, dungeonOf, heroOf, RES } from "../src/resources.ts";
import { monsterLevel, xpAtLevel } from "../src/rules.ts";
import { gridOf } from "../src/spatial.ts";
import { KIND, type ItemCategory } from "../src/types.ts";
import { getAreaMap, walkableAt, type ClassicMap } from "../src/world/maps.ts";

const loaded = loadMode(mode, modules);

const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer"] as const;
const WARDEN = "classic.monster.boss_warden";
const VESSA = "classic.monster.boss_ninth_flame";

/**
 * Tick budget of a boss fight: measured with this harness (seed 1) Morrow
 * warrior 2 782, rogue 1 375, sorcerer 1 633; Vessa warrior 2 673, rogue
 * 1 368, sorcerer 1 288 (the warrior retreats once to refill its belt). The
 * slowest class plus about 30 %, the 3-minute target of the rework.
 */
const FIGHT_BUDGET = 3600;

/** One rare of the hero's level per equipment slot (four weapons: Auto keeps the best). */
const GEAR: readonly ItemCategory[] = [
  "weapon",
  "weapon",
  "weapon",
  "weapon",
  "armor",
  "helm",
  "boots",
  "gloves",
  "ring",
  "ring",
  "amulet",
  "shield",
];

function lifePotion(level: number): string {
  if (level >= 20) return "classic.item.potion_life_3";
  if (level >= 10) return "classic.item.potion_life_2";
  return "classic.item.potion_life_1";
}

function bossOf(sim: Sim, depth: number): Entity {
  for (const e of sim.world.query(Monster, AreaTag)) {
    if (sim.world.has(e, Dead) || sim.world.read(e, AreaTag).depth !== depth) continue;
    if (sim.world.read(e, Monster).rarity === "boss") return e;
  }
  return 0;
}

/**
 * Centre of the first tile (BFS order) `steps` walking steps from tile (x, y):
 * the hero starts where it can walk to the boss (a tile across a wall would
 * leave both of them stuck).
 */
function walkAway(map: ClassicMap, x: number, y: number, steps: number): { x: number; y: number } {
  const w = map.width;
  const seen = new Map<number, number>([[y * w + x, 0]]);
  const queue = [y * w + x];
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]!;
    const d = seen.get(k)!;
    const tx = k % w;
    const ty = (k - tx) / w;
    if (d >= steps) return { x: (tx << 8) + 128, y: (ty << 8) + 128 };
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (!walkableAt(map, nx, ny) || seen.has(ny * w + nx)) continue;
      seen.set(ny * w + nx, d + 1);
      queue.push(ny * w + nx);
    }
  }
  throw new Error("no tile that far from the boss");
}

/**
 * A boss-ready hero of `classId` on boss depth `depth` (the level's other
 * monsters removed), 6 tiles from the boss, under Auto.
 */
function bossFight(classId: string, depth: number, seed: number): Sim {
  const sim = createSim(loaded, { seed });
  expect(sim.dispatch("classic.newHero", { classId, name: "Slayer" }, null).ok).toBe(true);
  expect(sim.dispatch("classic.setControl", { mode: "manual" }, null).ok).toBe(true);
  sim.step(1);
  const hero = heroOf(sim.world);
  const level = monsterLevel(depth) + BOSS_READY_LEVELS;
  const xp = xpAtLevel(BALANCE, level) - sim.world.read(hero, Level).xp;
  pushCommand(sim.world, { op: "grantXp", amount: xp, reason: "test" });
  // Gold for a restock when the belt runs dry (a hero that got this far has some).
  pushCommand(sim.world, { op: "grantGold", amount: 5000, reason: "test" });
  for (const category of GEAR) {
    pushCommand(sim.world, {
      op: "grantItems",
      count: 1,
      ilvl: level,
      minRarity: "rare",
      category,
      toStash: false,
      reason: "test",
    });
  }
  sim.step(1);
  expect(sim.world.read(hero, Level).level).toBe(level);
  // Auto (in town) equips the items and spends the stat and skill points.
  expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
  sim.step(60);
  expect(sim.dispatch("classic.setControl", { mode: "manual" }, null).ok).toBe(true);
  const dungeon = dungeonOf(sim.world);
  dungeon.deepest = depth;
  dungeon.waypoints = [];
  for (let d = 1; d <= depth; d += 2) dungeon.waypoints.push(d);
  pushTransition(sim.world, { to: depth, via: "stairsDown" });
  sim.step(2);
  expect(currentDepth(sim.world)).toBe(depth);
  const belt = sim.world.read(hero, Belt);
  const potion = lifePotion(level);
  sim.world.update(hero, Belt, { slots: belt.slots.map(() => ({ base: potion, count: 5 })) });
  sim.world.update(hero, Supplies, { tpScrolls: 5 });
  // Quests out of the way: no quest trip to town and no clearLevel detour mid-fight.
  sim.world.setResource(RES.quests, {
    active: [],
    completed: [...sim.loaded.registry.all(KIND.quest)].map(([id]) => id),
  });
  for (const e of sim.world.query(Monster, AreaTag)) {
    if (sim.world.read(e, AreaTag).depth !== depth) continue;
    if (sim.world.read(e, Monster).rarity !== "boss") sim.world.destroy(e);
  }
  const boss = bossOf(sim, depth);
  expect(boss, "the boss of the depth").not.toBe(0);
  const bp = sim.world.read(boss, Pos);
  const at = walkAway(getAreaMap(sim.world, sim.loaded.registry), bp.x >> 8, bp.y >> 8, 6);
  sim.world.update(hero, Pos, at);
  gridOf(sim.world).move(hero, at.x, at.y);
  sim.step(1);
  expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
  return sim;
}

/** Steps until the boss of `monster` dies (or the budget); ticks taken (-1: never) and deaths. */
function untilBossKilled(
  sim: Sim,
  monster: string,
  budget: number,
): { ticks: number; deaths: number } {
  let deaths = 0;
  for (let i = 1; i <= budget; i++) {
    for (const e of sim.step(1) as GameEvent[]) {
      if (e.type === "classic.hero.died") deaths++;
      if (e.type === "classic.boss.killed" && (e as { monster?: string }).monster === monster)
        return { ticks: i, deaths };
    }
  }
  return { ticks: -1, deaths };
}

describe("a boss-ready Auto hero kills the boss", () => {
  for (const [monster, depth, name] of [
    [WARDEN, 4, "Morrow"],
    [VESSA, 12, "Vessa"],
  ] as const) {
    for (const cls of CLASSES) {
      it(`${cls} kills ${name} (depth ${depth}) within ${FIGHT_BUDGET} ticks, no death`, () => {
        const sim = bossFight(cls, depth, 1);
        const r = untilBossKilled(sim, monster, FIGHT_BUDGET);
        expect(r.ticks, `${name} still alive after ${FIGHT_BUDGET} ticks`).toBeGreaterThan(0);
        expect(r.deaths).toBe(0);
        expect(dungeonOf(sim.world).bossesKilled).toContain(depth);
      }, 120_000);
    }
  }
});

describe("a fresh warrior under Auto gets past the depth-4 boss (long: ~30 sim minutes each)", () => {
  /**
   * Ticks to the Morrow kill from a new warrior (measured: seed 2 28 733,
   * seed 4 27 294, seed 6 27 351; seeds 2 and 5 used to stall at depth 4).
   * The run stops at the kill.
   */
  const WARRIOR_BUDGET = 36_000;
  for (const seed of [2, 4, 6]) {
    it(`seed ${seed}: kills Morrow within ${WARRIOR_BUDGET} ticks`, () => {
      const sim = createSim(loaded, { seed });
      expect(
        sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "W" }, null).ok,
      ).toBe(true);
      expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
      const r = untilBossKilled(sim, WARDEN, WARRIOR_BUDGET);
      expect(r.ticks, `Morrow still alive after ${WARRIOR_BUDGET} ticks`).toBeGreaterThan(0);
      expect(dungeonOf(sim.world).bossesKilled).toContain(4);
    }, 180_000);
  }
});

describe("determinism", () => {
  /** A scripted boss fight: the Vessa setup for the rogue, then 600 ticks of Auto. */
  const script = (seed: number): string => {
    const sim = bossFight("classic.rogue", 12, seed);
    sim.step(600);
    return sim.hash();
  };

  it("the same seed and script give the same hash; another seed diverges", () => {
    const a = script(5);
    expect(script(5)).toBe(a);
    expect(script(6)).not.toBe(a);
  }, 120_000);
});
