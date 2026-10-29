/**
 * Boss-quest fight harness on the real classic content with every module
 * (plus classic.debug for the grants): a level-appropriate hero next to the
 * boss of its depth, under Auto. Shared by tests/quests.balance.test.ts and
 * tests/quests.bosses.test.ts.
 */
import { createSim, loadMode, type Entity, type GameEvent, type Sim } from "@gamez/kernel";
import { expect } from "vite-plus/test";
import { pushTransition } from "../../src/bus.ts";
import { AreaTag, Belt, Dead, Monster, Pos, Supplies } from "../../src/components.ts";
import { DEBUG_GRANT } from "../../src/debug/index.ts";
import { debugModules, mode, modules } from "../../src/index.ts";
import { placeNear } from "../../src/monsters/spawn.ts";
import {
  currentDepth,
  dungeonOf,
  heroOf,
  questsOf,
  RES,
  type QuestState,
} from "../../src/resources.ts";
import { gridOf } from "../../src/spatial.ts";
import { KIND, type QuestProto } from "../../src/types.ts";
import { getAreaMap } from "../../src/world/maps.ts";

const debugLoaded = loadMode(mode, [...modules, ...debugModules]);

export function grant(sim: Sim, payload: Record<string, unknown>): void {
  const r = sim.dispatch(DEBUG_GRANT, payload, null);
  expect(r.ok, `${JSON.stringify(payload)}: ${r.error?.message ?? ""}`).toBe(true);
}

/** The living boss of `depth` (default: the current one), or 0. */
export function bossAlive(sim: Sim, depth = currentDepth(sim.world)): Entity {
  for (const e of sim.world.query(Monster, AreaTag)) {
    if (sim.world.has(e, Dead) || sim.world.read(e, AreaTag).depth !== depth) continue;
    if (sim.world.read(e, Monster).rarity === "boss") return e;
  }
  return 0;
}

/**
 * The quest log of a hero that reached `quest`'s level: every quest with a
 * lower reqLevel turned in, `quest` accepted, the rest untouched.
 */
export function questLogAt(sim: Sim, quest: string): QuestState {
  const all = sim.loaded.registry.all<QuestProto>(KIND.quest);
  const req = sim.loaded.registry.get<QuestProto>(KIND.quest, quest)!.reqLevel;
  return {
    active: [{ id: quest, progress: 0, done: false }],
    completed: all
      .filter(([id, q]) => id !== quest && q.reqLevel < req)
      .map(([id]) => id)
      .sort(),
  };
}

/**
 * A level-appropriate hero (debug grants: `level`, ilvl `level` rares in
 * every slot, 5 000 gold, waypoints to `depth`, full belt of the level's
 * potion tier, 5 scrolls) on the boss depth `depth` with the level's other
 * monsters removed, 6 tiles from the boss, then Auto. With `quest` the hero
 * carries the quest log of that quest's level (questLogAt); without it, the
 * log of a fresh hero.
 */
export function bossFight(
  classId: string,
  level: number,
  depth: number,
  seed: number,
  quest?: string,
): Sim {
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
  if (quest !== undefined) sim.world.setResource(RES.quests, questLogAt(sim, quest));
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

/** Steps until a classic.boss.killed event (or the budget); returns the ticks it took, or -1. */
export function untilBossKilled(sim: Sim, budget: number): number {
  for (let i = 1; i <= budget; i++) {
    const ev = sim.step(1) as GameEvent[];
    if (ev.some((e) => e.type === "classic.boss.killed")) return i;
  }
  return -1;
}

export interface BossQuestRun {
  /** Ticks to the kill of `monster`, or -1. */
  kill: number;
  /** Hero deaths before the kill (or the end). */
  deaths: number;
  /** Phases the boss entered. */
  phases: number;
  /** Ticks to the turn-in of `quest`, or -1. */
  turnIn: number;
  /** Gold and XP of the turn-in event (0 when none). */
  gold: number;
  xp: number;
  /** Gold and XP actually paid with reason "quest" (classic.gold / classic.xp events). */
  goldPaid: number;
  xpPaid: number;
}

/**
 * Runs Auto until `quest` is turned in (or `killBudget` ticks pass without
 * the kill of `monster`, or `turnInBudget` more after it).
 */
export function runBossQuest(
  sim: Sim,
  monster: string,
  quest: string,
  killBudget: number,
  turnInBudget: number,
): BossQuestRun {
  const r: BossQuestRun = {
    kill: -1,
    deaths: 0,
    phases: 0,
    turnIn: -1,
    gold: 0,
    xp: 0,
    goldPaid: 0,
    xpPaid: 0,
  };
  for (let i = 1; i <= killBudget + turnInBudget; i++) {
    if (r.kill < 0 && i > killBudget) break;
    if (r.kill > 0 && i > r.kill + turnInBudget) break;
    for (const e of sim.step(1) as GameEvent[]) {
      const a = e as {
        type: string;
        monster?: string;
        quest?: string;
        gold?: number;
        xp?: number;
        amount?: number;
        reason?: string;
      };
      if (a.reason === "quest" && a.type === "classic.gold") r.goldPaid += a.amount ?? 0;
      if (a.reason === "quest" && a.type === "classic.xp") r.xpPaid += a.amount ?? 0;
      if (r.kill < 0 && a.type === "classic.hero.died") r.deaths++;
      if (a.type === "classic.boss.phase" && a.monster === monster) r.phases++;
      if (a.type === "classic.boss.killed" && a.monster === monster) r.kill = i;
      if (a.type === "classic.quest.completed" && a.quest === quest) {
        r.turnIn = i;
        r.gold = a.gold ?? 0;
        r.xp = a.xp ?? 0;
      }
    }
    // The gold grant is queued by the turn-in: one more tick pays it.
    if (r.turnIn > 0 && i > r.turnIn) break;
  }
  return r;
}

/** A boss quest of the chain: its boss, depth, reqLevel, phase count and reward gold. */
export interface BossQuest {
  name: string;
  monster: string;
  quest: string;
  depth: number;
  level: number;
  phases: number;
  gold: number;
}

export const SKARN: BossQuest = {
  name: "Skarn",
  monster: "classic.monster.boss_tunnel_mother",
  quest: "classic.quest.tunnel_mother",
  depth: 8,
  level: 14,
  phases: 2,
  gold: 1500,
};
export const VESSA: BossQuest = {
  name: "Vessa",
  monster: "classic.monster.boss_ninth_flame",
  quest: "classic.quest.ninth_flame",
  depth: 12,
  level: 20,
  phases: 3,
  gold: 3000,
};
export const HOLLOW_KING: BossQuest = {
  name: "the Hollow King",
  monster: "classic.monster.boss_hollow_king",
  quest: "classic.quest.crown_of_hollows",
  depth: 16,
  level: 26,
  phases: 3,
  gold: 8000,
};

/** Ticks allowed to the kill (the 12 000-tick target of the fix) and from the kill to the turn-in. */
export const BOSS_KILL_BUDGET = 12_000;
export const BOSS_TURN_IN_BUDGET = 3_000;

/**
 * One Auto boss quest (bossFight with the quest log of `b`'s level, then
 * runBossQuest): the boss dies within BOSS_KILL_BUDGET after every phase and
 * no fewer than 600 ticks (a real fight), with at most 3 deaths; the quest is
 * turned in in town and its gold and XP are paid. Returns the run.
 */
export function expectBossQuest(
  cls: string,
  b: BossQuest,
  level: number,
  seed: number,
): BossQuestRun {
  const sim = bossFight(cls, level, b.depth, seed, b.quest);
  const r = runBossQuest(sim, b.monster, b.quest, BOSS_KILL_BUDGET, BOSS_TURN_IN_BUDGET);
  const at = `${cls} level ${level} seed ${seed}: ${JSON.stringify(r)}`;
  expect(r.kill, `${b.name} killed, ${at}`).toBeGreaterThan(0);
  expect(r.deaths, at).toBeLessThanOrEqual(3);
  expect(r.phases, at).toBe(b.phases);
  expect(r.kill, at).toBeGreaterThanOrEqual(600);
  expect(dungeonOf(sim.world).bossesKilled, at).toContain(b.depth);
  expect(r.turnIn, `turned in, ${at}`).toBeGreaterThan(r.kill);
  expect(r.gold, at).toBe(b.gold);
  expect(r.goldPaid, at).toBe(b.gold);
  expect(r.xpPaid, at).toBeGreaterThan(0);
  const qs = questsOf(sim.world);
  expect(qs.completed, at).toContain(b.quest);
  expect(
    qs.active.map((q) => q.id),
    at,
  ).not.toContain(b.quest);
  return r;
}
