/**
 * Review findings on the Auto boss changes (docs/design/offline-idle.md §10),
 * one focused regression test per fixed finding, on the real classic content
 * with every module loaded:
 *
 * - #1 the progress watchdog: a boss fight only counts as progress while the
 *   boss loses life (AutoState.bossE / bossHp, think.ts bossProgress).
 * - #2 the half-dead boss exemption from the retreat loop needs the boss to
 *   have lost life between the last two retreats (AutoRetreats.bossHp /
 *   prevBossHp, util.ts bossRetreatProgress, town.ts returnStep).
 * - #4 a boss's melee phase minion within 2 tiles is scored like any foe.
 * - #5 three quick retreats from alternating depths are a loop.
 * - #9 liveBoss takes a depth.
 */
import { createSim, loadMode, type Entity, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { BOSS_READY_LEVELS, liveBoss } from "../src/auto/dungeon.ts";
import { BOSS_SUMMON_PENALTY, targetScore, type Foe } from "../src/auto/fight.ts";
import { bossProgress, makeAutoCtx } from "../src/auto/think.ts";
import {
  AutoRetreats,
  bossRetreatProgress,
  noteRetreat,
  RETREAT_LOOP_TICKS,
  retreatLoop,
  WATCHDOG_TICKS,
  type AutoCtx,
} from "../src/auto/util.ts";
import { pushCommand, pushTransition } from "../src/bus.ts";
import {
  AreaTag,
  AutoState,
  Belt,
  Dead,
  Level,
  Life,
  Monster,
  Pos,
  Summoned,
  Supplies,
} from "../src/components.ts";
import { BALANCE } from "../src/content/balance.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { currentDepth, dungeonOf, heroOf, RES } from "../src/resources.ts";
import { monsterLevel, xpAtLevel } from "../src/rules.ts";
import { gridOf } from "../src/spatial.ts";
import { KIND, type ItemCategory } from "../src/types.ts";
import { getAreaMap, walkableAt, type ClassicMap } from "../src/world/maps.ts";

const loaded = loadMode(mode, modules);
const TILE = 256;

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

function bossAt(sim: Sim, depth: number): Entity {
  for (const e of sim.world.query(Monster, AreaTag)) {
    if (sim.world.has(e, Dead) || sim.world.read(e, AreaTag).depth !== depth) continue;
    if (sim.world.read(e, Monster).rarity === "boss") return e;
  }
  return 0;
}

/** Centre of the first tile (BFS order) `steps` walking steps from tile (x, y). */
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
 * The tests/auto.bosses.test.ts harness: a boss-ready hero of `classId`
 * (rare gear of its level, a full belt, 5 000 gold, quests out of the way)
 * on boss depth `depth` with the level's other monsters removed, 6 tiles
 * from the boss, in manual control.
 */
function bossLevel(classId: string, depth: number, seed: number): { sim: Sim; boss: Entity } {
  const sim = createSim(loaded, { seed });
  expect(sim.dispatch("classic.newHero", { classId, name: "Reviewer" }, null).ok).toBe(true);
  expect(sim.dispatch("classic.setControl", { mode: "manual" }, null).ok).toBe(true);
  sim.step(1);
  const hero = heroOf(sim.world);
  const level = monsterLevel(depth) + BOSS_READY_LEVELS;
  const xp = xpAtLevel(BALANCE, level) - sim.world.read(hero, Level).xp;
  pushCommand(sim.world, { op: "grantXp", amount: xp, reason: "test" });
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
  sim.world.setResource(RES.quests, {
    active: [],
    completed: [...sim.loaded.registry.all(KIND.quest)].map(([id]) => id),
  });
  for (const e of sim.world.query(Monster, AreaTag)) {
    if (sim.world.read(e, AreaTag).depth !== depth) continue;
    if (sim.world.read(e, Monster).rarity !== "boss") sim.world.destroy(e);
  }
  const boss = bossAt(sim, depth);
  expect(boss, "the boss of the depth").not.toBe(0);
  const bp = sim.world.read(boss, Pos);
  const at = walkAway(getAreaMap(sim.world, sim.loaded.registry), bp.x >> 8, bp.y >> 8, 6);
  sim.world.update(hero, Pos, at);
  gridOf(sim.world).move(hero, at.x, at.y);
  sim.step(1);
  return { sim, boss };
}

function ctxOf(sim: Sim): AutoCtx {
  return makeAutoCtx(
    sim.world,
    { tick: sim.tick, registry: sim.loaded.registry } as never,
    heroOf(sim.world),
  );
}

/** Same context at another tick and depth (pure helpers read c.tick / c.depth only). */
function at(c: AutoCtx, tick: number, depth: number): AutoCtx {
  return { ...c, tick, depth };
}

function step(sim: Sim, ticks: number, out: ClassicEvent[]): void {
  for (let i = 0; i < ticks; i++)
    for (const e of sim.step(1) as GameEvent[]) out.push(e as ClassicEvent);
}

function notices(ev: readonly ClassicEvent[]): string[] {
  const out: string[] = [];
  for (const e of ev) if (e.type === "classic.auto.notice") out.push(e.code);
  return out;
}

// ---------------------------------------------------------------------------
// #1 watchdog: boss progress, not boss focus
// ---------------------------------------------------------------------------

describe("#1 a boss fight counts as watchdog progress only while the boss loses life", () => {
  it("bossProgress: a new focus and each new lowest life are progress; a steady life is not", () => {
    const { sim, boss } = bossLevel("classic.warrior", 4, 1);
    const c = ctxOf(sim);
    c.st.plan = "fight";
    c.st.focus = boss;
    const max = sim.world.read(boss, Life).max;
    expect(bossProgress(c), "new focus").toBe(true);
    expect(c.st.bossE).toBe(boss);
    expect(c.st.bossHp).toBe(max);
    expect(bossProgress(c), "same life").toBe(false);
    sim.world.update(boss, Life, { hp: max - 10 });
    expect(bossProgress(c), "lower life").toBe(true);
    expect(c.st.bossHp).toBe(max - 10);
    // Healing back up and down to above the lowest seen is no progress.
    sim.world.update(boss, Life, { hp: max - 5 });
    expect(bossProgress(c)).toBe(false);
    expect(c.st.bossHp).toBe(max - 10);
    // Not fighting (another plan or another focus): never progress, fields kept.
    c.st.plan = "explore";
    sim.world.update(boss, Life, { hp: 1 });
    expect(bossProgress(c)).toBe(false);
    expect(c.st.bossHp).toBe(max - 10);
  });

  it("an unhurtable boss trips the watchdog within WATCHDOG_TICKS plus a margin", () => {
    const { sim, boss } = bossLevel("classic.rogue", 4, 1);
    expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
    const ev: ClassicEvent[] = [];
    let first = -1;
    for (let i = 0; i < WATCHDOG_TICKS + 1200 && notices(ev).length === 0; i++) {
      // The boss shrugs off every hit (out of reach, healing, kiting: no real progress).
      const l = sim.world.read(boss, Life);
      if (l.hp < l.max) sim.world.update(boss, Life, { hp: l.max });
      step(sim, 1, ev);
      const st = sim.world.read(heroOf(sim.world), AutoState);
      if (first < 0 && st.plan === "fight" && st.focus === boss) first = sim.tick;
    }
    expect(first, "the hero engages the boss").toBeGreaterThan(0);
    const got = notices(ev);
    expect(got.length, "watchdog notice").toBeGreaterThan(0);
    expect(["no_kills", "travel_loop"]).toContain(got[0]);
  }, 60_000);

  it("a boss that keeps losing life does not trip it (a fight longer than WATCHDOG_TICKS)", () => {
    const { sim, boss } = bossLevel("classic.rogue", 4, 1);
    // Four times the life: the rogue's 1 375-tick Morrow fight lasts well past 2 minutes.
    const l = sim.world.read(boss, Life);
    sim.world.update(boss, Life, { hp: l.max * 4, max: l.max * 4 });
    expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
    const ev: ClassicEvent[] = [];
    let killed = -1;
    for (let i = 0; i < 4 * WATCHDOG_TICKS && killed < 0; i++) {
      step(sim, 1, ev);
      if (sim.world.has(boss, Dead) || !sim.world.exists(boss)) killed = i;
    }
    expect(killed, "the boss dies").toBeGreaterThan(WATCHDOG_TICKS);
    expect(notices(ev)).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// #2 half-dead boss exemption needs boss progress between the retreats
// ---------------------------------------------------------------------------

describe("#2 quick retreats from a half-dead boss avoid the portal unless the boss lost life", () => {
  /**
   * A warrior ready for Vessa (depth 12) portals to town with her at 40 %
   * life; `retreats` is the retreat memory it comes back with. Returns the
   * note of the travel plan that takes it back down ("portal", "waypoint 11").
   */
  function wayBack(retreats: (tick: number, hp: number) => object): string {
    const { sim, boss } = bossLevel("classic.warrior", 12, 1);
    const l = sim.world.read(boss, Life);
    const hp = Math.floor((l.max * 40) / 100);
    sim.world.update(boss, Life, { hp });
    expect(sim.dispatch("classic.townPortal", {}, null).ok).toBe(true);
    sim.step(2);
    expect(currentDepth(sim.world)).toBe(0);
    expect(dungeonOf(sim.world).portal?.depth).toBe(12);
    const hero = heroOf(sim.world);
    if (sim.world.has(hero, AutoRetreats)) sim.world.remove(hero, AutoRetreats);
    sim.world.add(hero, AutoRetreats, retreats(sim.tick, hp) as never);
    expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
    const ev: ClassicEvent[] = [];
    for (let i = 0; i < 1500; i++) {
      step(sim, 1, ev);
      if (currentDepth(sim.world) !== 0) break;
    }
    const plans = ev.filter(
      (e): e is Extract<ClassicEvent, { type: "classic.auto.plan" }> =>
        e.type === "classic.auto.plan" && e.plan === "toDungeon",
    );
    expect(plans.length, "a plan back down").toBeGreaterThan(0);
    return plans[plans.length - 1]!.note;
  }

  it("the boss lost life between the two retreats: back through the portal", () => {
    const note = wayBack((t, hp) => ({
      last: t,
      prev: t - 600,
      depth: 12,
      prevDepth: 12,
      bossHp: hp,
      prevBossHp: hp + 300,
    }));
    expect(note).toBe("portal");
  }, 60_000);

  it("no boss progress between the two retreats: a loop, back by waypoint", () => {
    const note = wayBack((t, hp) => ({
      last: t,
      prev: t - 600,
      depth: 12,
      prevDepth: 12,
      bossHp: hp,
      prevBossHp: hp,
    }));
    expect(note).toBe("waypoint 11");
  }, 60_000);

  it("a save from before the boss life fields: a loop, back by waypoint", () => {
    const note = wayBack((t) => ({ last: t, prev: t - 600, depth: 12, prevDepth: 12 }));
    expect(note).toBe("waypoint 11");
  }, 60_000);

  it("bossRetreatProgress needs both retreats from the boss depth", () => {
    const { sim } = bossLevel("classic.warrior", 4, 1);
    const hero = heroOf(sim.world);
    const c = ctxOf(sim);
    sim.world.add(hero, AutoRetreats, {
      last: 100,
      prev: 50,
      depth: 4,
      prevDepth: 3,
      bossHp: 10,
      prevBossHp: 20,
    });
    expect(bossRetreatProgress(c, 4)).toBe(false);
    sim.world.update(hero, AutoRetreats, { prevDepth: 4 });
    expect(bossRetreatProgress(c, 4)).toBe(true);
    expect(bossRetreatProgress(c, 8)).toBe(false);
    sim.world.update(hero, AutoRetreats, { bossHp: -1, prevBossHp: 20 });
    expect(bossRetreatProgress(c, 4), "no boss at the last retreat").toBe(false);
  });

  it("noteRetreat records the boss life of the last two retreats", () => {
    const { sim } = bossLevel("classic.warrior", 4, 1);
    const c = ctxOf(sim);
    noteRetreat(at(c, 1000, 4), 500);
    noteRetreat(at(c, 1500, 4), 420);
    const r = sim.world.read(heroOf(sim.world), AutoRetreats);
    expect(r.bossHp).toBe(420);
    expect(r.prevBossHp).toBe(500);
    expect(bossRetreatProgress(c, 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #4 melee phase minions
// ---------------------------------------------------------------------------

describe("#4 a boss's melee phase minion", () => {
  function minionSetup(): { c: AutoCtx; minion: Entity; plain: Entity } {
    const { sim, boss } = bossLevel("classic.warrior", 4, 1);
    const w = sim.world;
    const mk = (owner: Entity): Entity => {
      const e = w.create();
      w.add(e, Monster, { ...w.read(boss, Monster), rarity: "summon", name: "Minion" });
      w.add(e, Summoned, { owner, until: sim.tick + 1000 });
      return e;
    };
    // A normal summon's owner: any non-boss monster.
    const owner = w.create();
    w.add(owner, Monster, { ...w.read(boss, Monster), rarity: "normal", name: "Caller" });
    const minion = mk(boss);
    const plain = mk(owner);
    const c = ctxOf(sim);
    c.st.focus = 0;
    return { c, minion, plain };
  }
  const foe = (e: Entity, dist: number): Foe => ({
    e,
    x: 0,
    y: 0,
    dist,
    behaviour: "",
    rarity: "summon",
    melee: true,
    name: "Minion",
  });

  it("within 2 tiles (body-blocking) scores like any adjacent summon", () => {
    const { c, minion, plain } = minionSetup();
    expect(targetScore(c, foe(minion, TILE))).toBe(TILE);
    expect(targetScore(c, foe(minion, 2 * TILE))).toBe(targetScore(c, foe(plain, 2 * TILE)));
  });

  it("farther than 2 tiles takes BOSS_SUMMON_PENALTY (a normal summon: 4 tiles)", () => {
    const { c, minion, plain } = minionSetup();
    const d = 2 * TILE + 1;
    expect(targetScore(c, foe(minion, d))).toBe(d + BOSS_SUMMON_PENALTY);
    expect(targetScore(c, foe(plain, d))).toBe(d + 4 * TILE);
  });
});

// ---------------------------------------------------------------------------
// #5 retreat loops across depths
// ---------------------------------------------------------------------------

describe("#5 retreatLoop", () => {
  const W = RETREAT_LOOP_TICKS;
  function fresh(): { sim: Sim; c: AutoCtx } {
    const { sim } = bossLevel("classic.warrior", 4, 1);
    return { sim, c: ctxOf(sim) };
  }

  it("three quick retreats alternating 12 / 11 / 12 are a loop", () => {
    const { c } = fresh();
    const t0 = 10_000;
    noteRetreat(at(c, t0, 12), -1);
    noteRetreat(at(c, t0 + 800, 11), -1);
    expect(retreatLoop(at(c, t0 + 900, 0)), "two retreats from different depths").toBe(false);
    noteRetreat(at(c, t0 + 1600, 12), -1);
    expect(retreatLoop(at(c, t0 + 1700, 0))).toBe(true);
    // The loop ends W after the last retreat.
    expect(retreatLoop(at(c, t0 + 1600 + W, 0))).toBe(false);
  });

  it("three retreats spread over more than 2 W are no loop", () => {
    const { c } = fresh();
    noteRetreat(at(c, 10_000, 12), -1);
    noteRetreat(at(c, 10_000 + W, 11), -1);
    noteRetreat(at(c, 10_000 + 2 * W, 12), -1);
    expect(retreatLoop(at(c, 10_000 + 2 * W + 10, 0))).toBe(false);
  });

  it("the first record's placeholder is not a retreat: two early retreats from two depths are no loop", () => {
    const { sim, c } = fresh();
    noteRetreat(at(c, 100, 12), -1);
    noteRetreat(at(c, 300, 11), -1);
    expect(sim.world.read(heroOf(sim.world), AutoRetreats).prev2).toBeUndefined();
    expect(retreatLoop(at(c, 400, 0))).toBe(false);
  });

  it("two quick retreats from one depth are a loop (unchanged)", () => {
    const { c } = fresh();
    noteRetreat(at(c, 10_000, 12), -1);
    noteRetreat(at(c, 10_500, 12), -1);
    expect(retreatLoop(at(c, 10_600, 0))).toBe(true);
  });

  it("old saves behave as before", () => {
    const { sim, c } = fresh();
    const hero = heroOf(sim.world);
    // Before the depths: one depth.
    sim.world.add(hero, AutoRetreats, { last: 10_000, prev: 9_500 });
    expect(retreatLoop(at(c, 10_100, 0))).toBe(true);
    // Before prev2: two depths are no loop.
    sim.world.add(hero, AutoRetreats, { last: 10_000, prev: 9_500, depth: 12, prevDepth: 11 });
    expect(retreatLoop(at(c, 10_100, 0))).toBe(false);
    // The next retreat of such a save shifts in a prev2 and sees the loop.
    noteRetreat(at(c, 10_200, 12), -1);
    expect(sim.world.read(hero, AutoRetreats).prev2).toBe(9_500);
    expect(retreatLoop(at(c, 10_300, 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #9 liveBoss with an explicit depth
// ---------------------------------------------------------------------------

describe("#9 liveBoss(c, depth)", () => {
  it("finds the live boss of another depth from town; the current area has none", () => {
    const { sim, boss } = bossLevel("classic.warrior", 12, 1);
    expect(liveBoss(ctxOf(sim))).toBe(boss);
    expect(sim.dispatch("classic.townPortal", {}, null).ok).toBe(true);
    sim.step(2);
    expect(currentDepth(sim.world)).toBe(0);
    const c = ctxOf(sim);
    expect(liveBoss(c)).toBe(0);
    expect(liveBoss(c, 12)).toBe(boss);
    expect(liveBoss(c, 11)).toBe(0);
    sim.world.add(boss, Dead, { at: sim.tick } as never);
    expect(liveBoss(c, 12)).toBe(0);
  });
});
