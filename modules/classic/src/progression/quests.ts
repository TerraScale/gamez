/**
 * Quest progress (docs/design/classic.md §16). Kill quests advance from
 * Bus.deaths in classic.progression.kills; depth and level quests are checked
 * every tick there too. Acceptance and turn-in live in ops.ts.
 */
import type { SimContext, World } from "@gamez/kernel";
import type { DeathRecord } from "../bus.ts";
import { AreaTag, Dead, Faction, Life, Monster, Summoned } from "../components.ts";
import { emit } from "../events.ts";
import { RES, questsOf, type DungeonState, type QuestProgress } from "../resources.ts";
import { KIND, type QuestProto } from "../types.ts";

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
 * Depth and level quests, checked every tick: reachDepth follows
 * DungeonState.deepest; clearLevel completes when the live level at depth
 * `count` has no living monsters left. `killedOnLive` is true when this tick
 * credited a kill.
 */
export function advanceLevelQuests(world: World, ctx: SimContext, killedOnLive: boolean): void {
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
    } else if (qp.kind === "clearLevel" && killedOnLive && dungeon.live === qp.count) {
      if (liveMonsterCount(world, dungeon.live) === 0 && setProgress(ctx, q, 1, 1)) changed = true;
    }
  }
  if (changed) world.setResource(RES.quests, qs);
}
