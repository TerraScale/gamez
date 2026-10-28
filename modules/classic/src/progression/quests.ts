/**
 * Quest progress (docs/design/classic.md §16). Kill quests advance from
 * Bus.deaths in classic.progression.kills; depth, level and boss-history quests
 * are checked every tick there too. Acceptance and turn-in live in ops.ts.
 *
 * Rules (decided in §16 for round 1 of the quest fix):
 *  - killBoss completes for a boss of the quest's depth that is already in
 *    DungeonState.bossesKilled (killed before acceptance counts), and for a
 *    live kill of the boss (advanceKillQuests).
 *  - clearLevel completes when the live level at depth N has no living hostile
 *    monsters after any monster death on it, credited or not (a self-killing
 *    exploder included), and also when accepted on an already empty live level.
 */
import type { SimContext, World } from "@gamez/kernel";
import type { DeathRecord } from "../bus.ts";
import { AreaTag, Dead, Faction, Life, Monster, Summoned } from "../components.ts";
import { emit } from "../events.ts";
import { isRiftDepth } from "../rules.ts";
import { RES, questsOf, type DungeonState, type QuestProgress } from "../resources.ts";
import { KIND, type MonsterProto, type QuestProto } from "../types.ts";

/** Boss depths cycle through the boss protos every 16 levels (world/populate.ts BOSS_CYCLE). */
const BOSS_CYCLE = 16;

/** The boss slot (1..16, MonsterProto.boss.depth) that a main-dungeon boss depth belongs to. */
function bossSlotOf(depth: number): number {
  return ((depth - 1) % BOSS_CYCLE) + 1;
}

/** Progress needed to complete a quest. */
export function requiredOf(q: QuestProto): number {
  return q.kind === "killMonsters" || q.kind === "reachDepth" ? q.count : 1;
}

/** Living hostile monsters of a dungeon depth (summons and corpses excluded). */
export function liveMonsterCount(world: World, depth: number): number {
  let n = 0;
  for (const e of world.query(Monster, Faction, AreaTag, Life)) {
    if (world.read(e, Faction).team !== "monster") continue;
    if (world.read(e, AreaTag).depth !== depth) continue;
    if (world.has(e, Dead) || world.has(e, Summoned)) continue;
    if (world.read(e, Life).hp <= 0) continue;
    n++;
  }
  return n;
}

/** Sets a quest's progress (events on change, done when it reaches `need`). Returns true on change. */
function setProgress(ctx: SimContext, q: QuestProgress, progress: number, need: number): boolean {
  if (q.done || progress === q.progress) return false;
  q.progress = progress;
  emit(ctx, { type: "classic.quest.progress", quest: q.id, progress, count: need });
  if (progress >= need) {
    q.done = true;
    emit(ctx, { type: "classic.quest.done", quest: q.id });
  }
  return true;
}

/** Advances killMonsters / killBoss quests for one credited monster death. */
export function advanceKillQuests(world: World, ctx: SimContext, d: DeathRecord): void {
  const qs = questsOf(world);
  if (qs.active.length === 0) return;
  let changed = false;
  for (const q of qs.active) {
    if (q.done) continue;
    const qp = ctx.registry.get<QuestProto>(KIND.quest, q.id);
    if (!qp) continue;
    let add = 0;
    if (qp.kind === "killMonsters" && (qp.target === "*" || qp.target === d.monster)) add = 1;
    if (qp.kind === "killBoss" && d.rarity === "boss" && qp.target === d.monster) add = 1;
    if (add === 0) continue;
    const need = requiredOf(qp);
    if (setProgress(ctx, q, Math.min(need, q.progress + add), need)) changed = true;
  }
  if (changed) world.setResource(RES.quests, qs);
}

/**
 * Depth, level and boss-history quests, checked every tick (and right after an
 * accept, with `levelDeath` true). reachDepth follows DungeonState.deepest;
 * clearLevel completes when the live level at depth `count` has no living
 * monsters left, after a monster death on it (`levelDeath`); killBoss completes
 * when a boss of its depth is already in DungeonState.bossesKilled.
 */
export function advanceLevelQuests(world: World, ctx: SimContext, levelDeath: boolean): void {
  const qs = questsOf(world);
  if (qs.active.length === 0) return;
  const dungeon = world.getResource<DungeonState>(RES.dungeon);
  if (!dungeon) return;
  let changed = false;
  for (const q of qs.active) {
    if (q.done) continue;
    const qp = ctx.registry.get<QuestProto>(KIND.quest, q.id);
    if (!qp) continue;
    if (qp.kind === "reachDepth") {
      const need = requiredOf(qp);
      if (setProgress(ctx, q, Math.min(need, dungeon.deepest), need)) changed = true;
    } else if (qp.kind === "clearLevel") {
      if (!levelDeath || dungeon.live !== qp.count) continue;
      if (liveMonsterCount(world, dungeon.live) === 0 && setProgress(ctx, q, 1, 1)) changed = true;
    } else if (qp.kind === "killBoss") {
      const slot = ctx.registry.get<MonsterProto>(KIND.monster, qp.target)?.boss?.depth;
      if (slot === undefined) continue;
      const killed = dungeon.bossesKilled.some((d) => !isRiftDepth(d) && bossSlotOf(d) === slot);
      if (killed && setProgress(ctx, q, 1, requiredOf(qp))) changed = true;
    }
  }
  if (changed) world.setResource(RES.quests, qs);
}

/**
 * Accept-time check (ops.ts execAcceptQuest): a clearLevel quest accepted while
 * its depth is the live level and already empty completes at once. Other kinds
 * are settled by the next tick (advanceLevelQuests), so their events come in
 * the step after the accept.
 */
export function settleAcceptedClear(world: World, ctx: SimContext, quest: string): void {
  const qs = questsOf(world);
  const q = qs.active.find((a) => a.id === quest);
  if (!q || q.done) return;
  const qp = ctx.registry.get<QuestProto>(KIND.quest, quest);
  if (!qp || qp.kind !== "clearLevel") return;
  const dungeon = world.getResource<DungeonState>(RES.dungeon);
  if (!dungeon || dungeon.live !== qp.count) return;
  if (liveMonsterCount(world, dungeon.live) === 0 && setProgress(ctx, q, 1, 1)) {
    world.setResource(RES.quests, qs);
  }
}
