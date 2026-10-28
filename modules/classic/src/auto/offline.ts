/**
 * classic.offlineProgress (§15.4): a deterministic rate model of what the
 * hero would have earned while the game was closed. Pure integer maths over
 * the hero's current stats and the registry; queues grantXp / grantGold /
 * grantItems for their owners and emits classic.offline.summary.
 */
import {
  ActionError,
  type ActionDef,
  type Entity,
  type FrozenRegistry,
  type SimContext,
  type World,
} from "@gamez/kernel";
import { ACTION, ERR } from "../actions.ts";
import { pushCommand } from "../bus.ts";
import {
  CombatStats,
  Dead,
  HeroStats,
  Attributes,
  Level,
  Mana,
  SkillBar,
  SkillBook,
} from "../components.ts";
import { emit } from "../events.ts";
import { clamp } from "../fixed.ts";
import { heroOf, RES, type DungeonState, type QuestState, type RunStats } from "../resources.ts";
import {
  effectiveRank,
  itemValue,
  levelForXp,
  monsterLevel,
  rollSkillDamage,
  scaledTicks,
  scaleMonster,
  skillManaCost,
  tierOf,
  xpForKill,
} from "../rules.ts";
import { totalDamage } from "../bus.ts";
import {
  BALANCE_ID,
  KIND,
  type BalanceProto,
  type ItemBaseProto,
  type MonsterProto,
  type NpcProto,
  type QuestProto,
  type SkillProto,
  type ThemeProto,
} from "../types.ts";

export const MAX_OFFLINE_MS = 7 * 24 * 3600 * 1000;
/** Items kept per minute of kills: floor(kills * 2 / 100), at most 20. */
const ITEM_KEEP_PCT = 2;
const ITEM_KEEP_MAX = 20;
const KILLS_PER_MIN_MAX = 120;

export interface OfflineResult {
  ms: number;
  depth: number;
  monsterLevel: number;
  kills: number;
  xp: number;
  gold: number;
  items: number;
  levels: number;
}

/** Deepest unlocked waypoint whose monster level is at most heroLevel + 1 (>= 1). */
export function offlineDepth(world: World, heroLevel: number): number {
  let depth = 1;
  for (const w of world.getResource<DungeonState>(RES.dungeon)?.waypoints ?? []) {
    if (w >= 1 && monsterLevel(w) <= heroLevel + 1 && w > depth) depth = w;
  }
  return depth;
}

/** Average damage and the attack time (ticks) of the hero's best affordable bar skill. */
function bestAttack(
  world: World,
  reg: FrozenRegistry,
  hero: Entity,
): { dmg: number; ticks: number } {
  const stats = world.get(hero, CombatStats);
  const book = world.get(hero, SkillBook);
  const bar = world.get(hero, SkillBar);
  if (!stats || !book || !bar) return { dmg: 1, ticks: 20 };
  const attrs = world.get(hero, HeroStats)?.attrs ?? world.get(hero, Attributes) ?? null;
  const manaMax = world.get(hero, Mana)?.max ?? 0;
  const allSkills = world.get(hero, HeroStats)?.allSkills ?? 0;
  let best = { dmg: 0, ticks: 20 };
  for (const id of bar.slots) {
    if (id === null) continue;
    const known = book.ranks.find((r) => r.skill === id);
    const s = reg.get<SkillProto>(KIND.skill, id);
    if (!known || known.rank < 1 || !s) continue;
    if (s.ai.tags.some((t) => t === "heal" || t === "buff" || t === "summon" || t === "mobility"))
      continue;
    const rank = effectiveRank(s, known.rank, allSkills);
    if (skillManaCost(s, rank) > manaMax) continue;
    const dmg = totalDamage(rollSkillDamage(s, rank, stats, attrs, null));
    if (dmg <= 0) continue;
    const basic = s.shape === "melee" && s.range === 0;
    const speed = s.speedStat === "cast" ? stats.castSpeed : stats.attackSpeed;
    const ticks = Math.max(
      basic ? scaledTicks(stats.attackTicks, stats.attackSpeed) : scaledTicks(s.castTicks, speed),
      s.cooldown,
    );
    // Compare damage per tick exactly: dmg / ticks > best.dmg / best.ticks.
    if (dmg * best.ticks > best.dmg * ticks) best = { dmg, ticks };
  }
  return best.dmg > 0
    ? best
    : { dmg: Math.max(1, stats.dmgMin), ticks: Math.max(2, stats.attackTicks) };
}

/** Monster protos of the depth's theme tier (sorted ids), with a fallback to every themed monster. */
function depthMonsters(reg: FrozenRegistry, depth: number): MonsterProto[] {
  const tier = tierOf(depth);
  const ids = new Set<string>();
  for (const [id, t] of reg.all<ThemeProto>(KIND.theme)) {
    if (id === "classic.theme.town" || t.tier !== tier) continue;
    for (const m of t.monsters) ids.add(m);
  }
  const sorted = [...ids].sort();
  let protos = sorted
    .map((id) => reg.get<MonsterProto>(KIND.monster, id))
    .filter((m): m is MonsterProto => m !== undefined && m.minDepth <= depth);
  if (protos.length === 0) {
    protos = reg
      .all<MonsterProto>(KIND.monster)
      .map(([, m]) => m)
      .filter((m) => m.themes.length > 0);
  }
  return protos;
}

/** The deterministic offline rate model. Throws nothing; callers validate the hero. */
export function computeOffline(
  world: World,
  reg: FrozenRegistry,
  hero: Entity,
  elapsedMs: number,
): OfflineResult {
  const bal = reg.get<BalanceProto>(KIND.balance, BALANCE_ID);
  const lvl = world.get(hero, Level);
  const heroLevel = lvl?.level ?? 1;
  const ms = Math.min(elapsedMs, bal?.offlineCapMs ?? elapsedMs);
  const minutes = Math.floor(ms / 60000);
  const depth = offlineDepth(world, heroLevel);
  const mlvl = monsterLevel(depth);
  const empty: OfflineResult = {
    ms,
    depth,
    monsterLevel: mlvl,
    kills: 0,
    xp: 0,
    gold: 0,
    items: 0,
    levels: 0,
  };
  if (!bal || minutes <= 0) return empty;

  const monsters = depthMonsters(reg, depth);
  let lifeSum = 0;
  let xpSum = 0;
  for (const m of monsters) {
    const s = scaleMonster(m, mlvl, "normal", []);
    lifeSum += s.life;
    xpSum += xpForKill(bal, heroLevel, mlvl, s.xp);
  }
  const n = Math.max(1, monsters.length);
  const avgLife = Math.max(1, Math.floor(lifeSum / n));
  const avgXp = Math.floor(xpSum / n);

  const atk = bestAttack(world, reg, hero);
  // killsPerMin = dps * 60 * eff% / avgLife, dps = dmg * 20 / ticks.
  const killsPerMin = clamp(
    Math.floor((atk.dmg * 1200 * bal.offlineEfficiencyPct) / (atk.ticks * avgLife * 100)),
    1,
    KILLS_PER_MIN_MAX,
  );
  const kills = killsPerMin * minutes;
  const xp = kills * avgXp;

  const goldFind = world.get(hero, HeroStats)?.goldFind ?? 0;
  const avgPile = Math.floor(
    ((bal.goldPerLevel[0] + bal.goldPerLevel[1]) * mlvl * (100 + goldFind)) / 200,
  );
  let gold = Math.floor((kills * bal.drops.normal.gold * avgPile) / 100);

  const items = Math.min(ITEM_KEEP_MAX, Math.floor((kills * ITEM_KEEP_PCT) / 100));
  // The other dropped items are sold to the junk buyer.
  const dropped = Math.floor((kills * bal.drops.normal.item) / 100);
  const sold = Math.max(0, dropped - items);
  if (sold > 0) gold += sold * junkPrice(reg, mlvl);

  const xpNow = lvl?.xp ?? 0;
  const levels = Math.max(0, levelForXp(bal, xpNow + xp) - heroLevel);
  return { ms, depth, monsterLevel: mlvl, kills, xp, gold, items, levels };
}

/** What the junk buyer pays for an average normal item of item level `ilvl`. */
function junkPrice(reg: FrozenRegistry, ilvl: number): number {
  let buyPct = 0;
  for (const [, npc] of reg.all<NpcProto>(KIND.npc))
    if (npc.role === "junk") buyPct = Math.max(buyPct, npc.buyPct);
  if (buyPct <= 0) buyPct = 10;
  let sum = 0;
  let count = 0;
  for (const [, b] of reg.all<ItemBaseProto>(KIND.itemBase)) {
    if (b.category === "potion" || b.ilvl > ilvl) continue;
    sum += itemValue(b, "normal", ilvl);
    count++;
  }
  if (count === 0) return 0;
  return Math.max(1, Math.floor((sum * buyPct) / (count * 100)));
}

/**
 * Offline kills count for quests: every active, not done killMonsters quest
 * whose target is "*" (any monster) gains `kills` (capped at its count),
 * with the same classic.quest.progress / classic.quest.done events as live
 * kills (progression/quests.ts). No other quest kind changes offline.
 */
export function creditOfflineKills(world: World, ctx: SimContext, kills: number): void {
  if (kills <= 0) return;
  const qs = world.getResource<QuestState>(RES.quests);
  if (!qs || qs.active.length === 0) return;
  let changed = false;
  for (const q of qs.active) {
    if (q.done) continue;
    const qp = ctx.registry.get<QuestProto>(KIND.quest, q.id);
    if (!qp || qp.kind !== "killMonsters" || qp.target !== "*") continue;
    const progress = Math.min(qp.count, q.progress + kills);
    if (progress === q.progress) continue;
    q.progress = progress;
    emit(ctx, { type: "classic.quest.progress", quest: q.id, progress, count: qp.count });
    if (progress >= qp.count) {
      q.done = true;
      emit(ctx, { type: "classic.quest.done", quest: q.id });
    }
    changed = true;
  }
  if (changed) world.setResource(RES.quests, qs);
}

export const offlineAction: ActionDef<{ elapsedMs: number }> = {
  name: ACTION.offlineProgress,
  parse(_world, payload) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload))
      throw new ActionError(ERR.badPayload, "expected { elapsedMs }");
    const keys = Object.keys(payload);
    if (keys.some((k) => k !== "elapsedMs")) throw new ActionError(ERR.badPayload, "unknown field");
    const ms = (payload as { elapsedMs?: unknown }).elapsedMs;
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms <= 0 || ms > MAX_OFFLINE_MS)
      throw new ActionError(ERR.badPayload, "elapsedMs must be an integer in 1..7 days");
    return { elapsedMs: ms };
  },
  apply(world, p, ctx) {
    const hero = heroOf(world);
    if (hero === 0 || !world.has(hero, Level)) throw new ActionError(ERR.noHero, "no hero");
    if (world.has(hero, Dead)) throw new ActionError(ERR.dead, "the hero is dead");
    const r = computeOffline(world, ctx.registry, hero, p.elapsedMs);
    if (r.xp > 0) pushCommand(world, { op: "grantXp", amount: r.xp, reason: "offline" });
    if (r.gold > 0) pushCommand(world, { op: "grantGold", amount: r.gold, reason: "offline" });
    if (r.items > 0)
      pushCommand(world, {
        op: "grantItems",
        count: r.items,
        ilvl: r.monsterLevel,
        minRarity: "magic",
        toStash: true,
        reason: "offline",
      });
    creditOfflineKills(world, ctx, r.kills);
    const stats = world.getResource<RunStats>(RES.stats);
    if (stats) stats.offlineMs += r.ms;
    emit(ctx, {
      type: "classic.offline.summary",
      ms: r.ms,
      depth: r.depth,
      kills: r.kills,
      xp: r.xp,
      gold: r.gold,
      items: r.items,
      levels: r.levels,
    });
  },
};
