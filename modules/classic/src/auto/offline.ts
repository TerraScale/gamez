/**
 * classic.offlineProgress (docs/design/offline-idle.md §4): what the hero
 * earns while the game was closed. Pure integer maths over the hero's
 * measured online rate (auto/rate.ts) or, with too little measured play, the
 * §15.4 rate model (computeOffline, unchanged). offlineGrant() turns that into
 * the final numbers; the action queues grantXp / grantGold / grantItems,
 * respawns a dead hero first, credits kill quests and emits
 * classic.offline.summary. XP is scaled by the factor xpPct (the admin tunable
 * classic.offlineXpPct, passed by the server); gold, items and quest kills
 * are not scaled by it. Gold is net of the measured upkeep (potions, scrolls,
 * repairs). A second grant on the same sim tick is rejected (offline_twice).
 *
 * Party (docs/design/party.md §6.8): partyOfflineGrant() computes the same
 * grant for the party (kills, gold and items as party totals, scaled by the
 * party's loot %) and splits the XP per standing member, each with its own
 * share and the same xpPct factor; gold goes to the purse.
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
import { actingLeaderOf, aliveMembers, partyScaleOf, partySize } from "../party/shared.ts";
import {
  heroOf,
  RES,
  type AutoRate,
  type DungeonState,
  type QuestState,
  type RunStats,
} from "../resources.ts";
import {
  effectiveRank,
  itemValue,
  levelForXp,
  monsterLevel,
  partyKillXp,
  partyProtoOf,
  rollSkillDamage,
  scaledTicks,
  scaleMonster,
  skillManaCost,
  tierOf,
  xpForKill,
} from "../rules.ts";
import { totalDamage } from "../bus.ts";
import { isParty } from "./util.ts";
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
import { execRespawn } from "../progression/ops.ts";
import { AUTO_RATE_MIN_TICKS } from "./rate.ts";

export const MAX_OFFLINE_MS = 7 * 24 * 3600 * 1000;
/**
 * Actor of the verified server's dispatches (protocol BANK_ACTOR, the host's
 * SERVER_ACTOR): exempt from the same-tick guard (§4.4).
 */
export const OFFLINE_SERVER_ACTOR = "server";
/** Sim ticks per second (TickPolicy fixed 20 Hz) and per minute. */
const SIM_HZ = 20;
const TICKS_PER_MIN = 60 * SIM_HZ;
/** Items kept per minute of kills: floor(kills * 2 / 100), at most 20. */
const ITEM_KEEP_PCT = 2;
const ITEM_KEEP_MAX = 20;
const KILLS_PER_MIN_MAX = 120;
/** Sanity bound of the measured rate against the model (not a balance lever). */
const RATE_CAP_X = 3;
/**
 * Model only: sim ticks between kills spent walking, looting and in town
 * (offline-idle.md §4.3). Online Idle kills stay at about 15-28 a minute
 * whatever the hero's damage (measured L1-L16), so the model's time per kill
 * is the fight time plus this travel time: at most 1200 / 60 = 20 kills a
 * minute, and a weak hero is limited by its damage.
 */
export const OFFLINE_TRAVEL_TICKS = 60;

export interface OfflineResult {
  ms: number;
  depth: number;
  monsterLevel: number;
  kills: number;
  xp: number;
  gold: number;
  items: number;
  levels: number;
  /** Monster ids the offline kills are spread over (depthMonsterIds, computed once). */
  depthIds: string[];
}

/** The final numbers of one offline grant (offline-idle.md §4.2). */
export interface OfflineGrant {
  /** Credited time: min(elapsedMs, offlineCapMs). */
  ms: number;
  /** Whole minutes of `ms`. */
  minutes: number;
  depth: number;
  monsterLevel: number;
  /** Unscaled kills (quest credit and statistics). */
  kills: number;
  /** Scaled by xpPct. */
  xp: number;
  /** Scaled by goldPct; net of `upkeep`. */
  gold: number;
  /** Upkeep gold deducted from the rate path's gold (0 for the model). */
  upkeep: number;
  /**
   * Gold found before upkeep, scaled by goldPct: ground + junk at the measured
   * rate, capped with the gold so that gold = max(0, found - upkeep) (rate
   * path), or `gold` (model). The card shows it next to the upkeep so a grant
   * of 0 gold reads as "upkeep used it up", not as a bug.
   */
  found: number;
  /** Scaled by itemPct. */
  items: number;
  /** Levels gained by xp, clamped to maxLevel. */
  levels: number;
  depthIds: string[];
  /** "rate": the measured online rate. "model": the §15.4 fallback. */
  source: "rate" | "model";
  xpPct: number;
  goldPct: number;
  itemPct: number;
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
export function bestAttack(
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

/**
 * Ids of the monsters offline kills are spread over: the depth's theme tier
 * (sorted ids, minDepth <= depth), with a fallback to every themed monster.
 * Exported so the quest credit and the tests use the same list.
 */
export function depthMonsterIds(reg: FrozenRegistry, depth: number): string[] {
  const tier = tierOf(depth);
  const ids = new Set<string>();
  for (const [id, t] of reg.all<ThemeProto>(KIND.theme)) {
    if (id === "classic.theme.town" || t.tier !== tier) continue;
    for (const m of t.monsters) ids.add(m);
  }
  const sorted = [...ids].sort();
  const themed = sorted.filter((id) => {
    const m = reg.get<MonsterProto>(KIND.monster, id);
    return m !== undefined && m.minDepth <= depth;
  });
  if (themed.length > 0) return themed;
  return reg
    .all<MonsterProto>(KIND.monster)
    .filter(([, m]) => m.themes.length > 0)
    .map(([id]) => id);
}

/** The deterministic offline rate model (§15.4). Throws nothing; callers validate the hero. */
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
  const depthIds = depthMonsterIds(reg, depth);
  const empty: OfflineResult = {
    ms,
    depth,
    monsterLevel: mlvl,
    kills: 0,
    xp: 0,
    gold: 0,
    items: 0,
    levels: 0,
    depthIds,
  };
  if (!bal || minutes <= 0) return empty;

  const monsters = depthIds
    .map((id) => reg.get<MonsterProto>(KIND.monster, id))
    .filter((m): m is MonsterProto => m !== undefined);
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
  // Time per kill = fight ticks + travel ticks, with fight ticks =
  // avgLife * ticks * 100 / (dmg * eff%); killsPerMin = 1200 / time per kill.
  const effDmg = atk.dmg * bal.offlineEfficiencyPct;
  const killsPerMin = clamp(
    Math.floor(
      (effDmg * TICKS_PER_MIN) / (atk.ticks * avgLife * 100 + OFFLINE_TRAVEL_TICKS * effDmg),
    ),
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
  gold += junkGold(reg, bal, mlvl, kills, items);

  const xpNow = lvl?.xp ?? 0;
  const levels = Math.max(0, levelForXp(bal, xpNow + xp) - heroLevel);
  return { ms, depth, monsterLevel: mlvl, kills, xp, gold, items, levels, depthIds };
}

/**
 * Gold from the dropped normal items that are not kept (sold to the junk
 * buyer): floor(kills * drop item %) minus the kept items, at junkPrice(ilvl).
 */
function junkGold(
  reg: FrozenRegistry,
  bal: BalanceProto,
  ilvl: number,
  kills: number,
  kept: number,
  lootPct = 100,
): number {
  const dropped =
    lootPct === 100
      ? Math.floor((kills * bal.drops.normal.item) / 100)
      : Math.floor((kills * bal.drops.normal.item * lootPct) / 10000);
  const sold = Math.max(0, dropped - kept);
  return sold > 0 ? sold * junkPrice(reg, ilvl) : 0;
}

/** One member's share of a party's offline XP. */
export interface OfflineShare {
  hero: Entity;
  xp: number;
  levels: number;
}

/** computePartyOffline: the party model, with every standing member's model share. */
export interface PartyOfflineModel {
  /** Party totals: kills, gold, items; xp and levels summed over `shares`. */
  result: OfflineResult;
  /** Standing members in slot order: model XP (kills x perKill) and levels. */
  shares: OfflineShare[];
  /** XP per kill of each share's hero (aligned with `shares`). */
  perKill: number[];
  /**
   * Average raw XP pool per kill (Monster.xp x xpPct, before the over-level
   * penalty and the party share): AutoRate.pool's unit, the same for every hero.
   */
  poolPerKill: number;
}

/**
 * The party's offline rate model (docs/design/party.md §6.8, the fallback of
 * offline-idle.md §4.3): computeOffline for the ACTING LEADER's strength and
 * level (depth), against monsters scaled for the party size (life x lifePct),
 * with the damage of every standing member (the party kill rate) and the
 * travel time per kill shortened by the party's pack density. Each standing
 * member's XP per kill is partyKillXp for its own level (Monster.xp x xpPct);
 * gold, kept and junked items scale with lootPct. Unscaled by the offline
 * factors (partyOfflineGrant applies them).
 */
export function computePartyOffline(
  world: World,
  reg: FrozenRegistry,
  elapsedMs: number,
): PartyOfflineModel {
  const leader = actingLeaderOf(world);
  const alive = aliveMembers(world);
  const bal = reg.get<BalanceProto>(KIND.balance, BALANCE_ID);
  const proto = partyProtoOf(reg);
  const size = Math.max(1, partySize(world));
  const scale = partyScaleOf(world, reg);
  const leaderLevel = world.get(leader, Level)?.level ?? 1;
  const ms = Math.min(elapsedMs, bal?.offlineCapMs ?? elapsedMs);
  const minutes = Math.floor(ms / 60000);
  const depth = offlineDepth(world, leaderLevel);
  const mlvl = monsterLevel(depth);
  const depthIds = depthMonsterIds(reg, depth);
  const result: OfflineResult = {
    ms,
    depth,
    monsterLevel: mlvl,
    kills: 0,
    xp: 0,
    gold: 0,
    items: 0,
    levels: 0,
    depthIds,
  };
  const out: PartyOfflineModel = { result, shares: [], perKill: [], poolPerKill: 0 };
  if (!bal || minutes <= 0 || alive.length === 0) return out;

  const monsters = depthIds
    .map((id) => reg.get<MonsterProto>(KIND.monster, id))
    .filter((m): m is MonsterProto => m !== undefined);
  let lifeSum = 0;
  for (const m of monsters) lifeSum += scaleMonster(m, mlvl, "normal", []).life;
  const n = Math.max(1, monsters.length);
  const avgLife = Math.max(1, Math.floor((Math.floor(lifeSum / n) * scale.lifePct) / 100));
  const pools = monsters.map((m) =>
    Math.floor((scaleMonster(m, mlvl, "normal", []).xp * scale.xpPct) / 100),
  );
  /** Average XP per kill for a member of level `own` (its partyKillXp share). */
  const perKillAt = (own: number): number => {
    let xpSum = 0;
    for (const pool of pools) xpSum += partyKillXp(bal, proto, size, own, mlvl, pool);
    return Math.floor(xpSum / n);
  };
  out.poolPerKill = Math.floor(pools.reduce((a, b) => a + b, 0) / n);

  const atk = bestAttack(world, reg, leader);
  const effDmg = atk.dmg * bal.offlineEfficiencyPct * alive.length;
  const travel = Math.floor((OFFLINE_TRAVEL_TICKS * 100) / Math.max(100, scale.densityPct));
  const killsPerMin = clamp(
    Math.floor((effDmg * TICKS_PER_MIN) / (atk.ticks * avgLife * 100 + travel * effDmg)),
    1,
    KILLS_PER_MIN_MAX,
  );
  const kills = killsPerMin * minutes;

  for (const e of alive) {
    const lvl = world.get(e, Level);
    const own = lvl?.level ?? 1;
    const perKill = perKillAt(own);
    const xp = kills * perKill;
    const levels = Math.max(0, levelForXp(bal, (lvl?.xp ?? 0) + xp) - own);
    out.shares.push({ hero: e, xp, levels });
    out.perKill.push(perKill);
    result.xp += xp;
    result.levels += levels;
  }

  const goldFind = world.get(leader, HeroStats)?.goldFind ?? 0;
  const avgPile = Math.floor(
    ((bal.goldPerLevel[0] + bal.goldPerLevel[1]) * mlvl * (100 + goldFind)) / 200,
  );
  let gold = Math.floor((kills * bal.drops.normal.gold * avgPile * scale.lootPct) / 10000);
  const items = Math.min(
    ITEM_KEEP_MAX,
    Math.floor((kills * ITEM_KEEP_PCT * scale.lootPct) / 10000),
  );
  gold += junkGold(reg, bal, mlvl, kills, items, scale.lootPct);
  result.kills = kills;
  result.gold = gold;
  result.items = items;
  return out;
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
 * The final numbers of an offline grant (offline-idle.md §4.2). With a
 * measured online rate of at least AUTO_RATE_MIN_TICKS, kills, XP, and gold
 * are the rate extrapolated to the credited ticks (T = minutes * 1200), capped
 * at 3x the model (and 120 kills per minute): the offline XP is xpPct of the
 * measured online Idle XP rate, never more. Gold is ground + junk minus the measured
 * upkeep (potions, scrolls, repairs), floored at 0. Otherwise the model is
 * used: XP scaled by offlineModelXpPct, gold by offlineModelGoldPct, no
 * upkeep. The factors are applied last. `xpPct` overrides
 * BalanceProto.offlineXpPct (the server's effective tunable).
 */
export function offlineGrant(
  world: World,
  reg: FrozenRegistry,
  hero: Entity,
  elapsedMs: number,
  xpPct?: number,
): OfflineGrant {
  const bal = reg.get<BalanceProto>(KIND.balance, BALANCE_ID);
  const model = computeOffline(world, reg, hero, elapsedMs);
  const minutes = Math.floor(model.ms / 60000);
  const xpPctEff = xpPct ?? bal?.offlineXpPct ?? 0;
  const base = {
    ms: model.ms,
    minutes,
    depth: model.depth,
    monsterLevel: model.monsterLevel,
    depthIds: model.depthIds,
    xpPct: xpPctEff,
    goldPct: bal?.offlineGoldPct ?? 0,
    itemPct: bal?.offlineItemPct ?? 0,
  };
  if (!bal || minutes <= 0) {
    return {
      ...base,
      kills: 0,
      xp: 0,
      gold: 0,
      upkeep: 0,
      found: 0,
      items: 0,
      levels: 0,
      source: "model",
    };
  }

  const T = minutes * TICKS_PER_MIN;
  const fbXp = Math.floor((model.xp * bal.offlineModelXpPct) / 100);
  const rate = world.getResource<AutoRate>(RES.autoRate);
  let kills: number;
  let baseXp: number;
  let itemsB: number;
  let baseGold: number;
  let baseFound: number;
  let upkeep: number;
  let source: "rate" | "model";
  if (rate && rate.ticks >= AUTO_RATE_MIN_TICKS) {
    source = "rate";
    kills = Math.min(
      Math.floor((rate.kills * T) / rate.ticks),
      model.kills * RATE_CAP_X,
      KILLS_PER_MIN_MAX * minutes,
    );
    // The measured online rate itself (§4.2, §4.3): no model floor, which paid
    // 2-4x the online rate at the depth-3 waypoint (L5-L9).
    baseXp = Math.min(Math.floor((rate.xp * T) / rate.ticks), fbXp * RATE_CAP_X);
    itemsB = Math.min(ITEM_KEEP_MAX, Math.floor((kills * ITEM_KEEP_PCT) / 100));
    const rateGold = Math.floor((rate.gold * T) / rate.ticks);
    upkeep = Math.floor(((rate.upkeep ?? 0) * T) / rate.ticks);
    // found is capped with the gold, so the card's numbers add up:
    // baseGold = max(0, baseFound - upkeep).
    baseFound = Math.min(
      rateGold + junkGold(reg, bal, model.monsterLevel, kills, itemsB),
      model.gold * RATE_CAP_X + upkeep,
    );
    baseGold = clamp(baseFound - upkeep, 0, model.gold * RATE_CAP_X);
  } else {
    source = "model";
    kills = model.kills;
    baseXp = fbXp;
    itemsB = model.items;
    upkeep = 0;
    baseGold = Math.floor((model.gold * (bal.offlineModelGoldPct ?? 100)) / 100);
    baseFound = baseGold;
  }

  const xp = Math.floor((baseXp * xpPctEff) / 100);
  const gold = Math.floor((baseGold * bal.offlineGoldPct) / 100);
  const found = Math.floor((baseFound * bal.offlineGoldPct) / 100);
  const items = Math.floor((itemsB * bal.offlineItemPct) / 100);
  const lvl = world.get(hero, Level);
  const heroLevel = lvl?.level ?? 1;
  const levels = Math.max(
    0,
    Math.min(bal.maxLevel, levelForXp(bal, (lvl?.xp ?? 0) + xp)) - heroLevel,
  );
  return { ...base, kills, xp, gold, upkeep, found, items, levels, source };
}

/**
 * The party's offline grant (offline-idle.md §4.2 applied per member,
 * docs/design/party.md §6.8). Kills, gold, upkeep and items are party totals:
 * the measured rate (AutoRate counts every kill credited to the heroes' side,
 * the purse's pickups and upkeep) or the party model, with the same caps as
 * offlineGrant. XP is per standing member: the measured rate is the raw XP
 * pool of the party's kills (AutoRate.pool, the same whichever hero is
 * controlled), and each member gets it times its own model XP per kill over the
 * model pool per kill (its partyKillXp share at its level), capped at 3x its
 * model; a rate without a pool (measured before the field) and the model path
 * pay each member its model XP x offlineModelXpPct. The factor xpPct (the
 * admin tunable) applies to every member's XP. `grant.xp` and `grant.levels`
 * are the members' sums.
 */
export function partyOfflineGrant(
  world: World,
  reg: FrozenRegistry,
  elapsedMs: number,
  xpPct?: number,
): { grant: OfflineGrant; shares: OfflineShare[] } {
  const bal = reg.get<BalanceProto>(KIND.balance, BALANCE_ID);
  const model = computePartyOffline(world, reg, elapsedMs);
  const m = model.result;
  const minutes = Math.floor(m.ms / 60000);
  const xpPctEff = xpPct ?? bal?.offlineXpPct ?? 0;
  const grant: OfflineGrant = {
    ms: m.ms,
    minutes,
    depth: m.depth,
    monsterLevel: m.monsterLevel,
    depthIds: m.depthIds,
    xpPct: xpPctEff,
    goldPct: bal?.offlineGoldPct ?? 0,
    itemPct: bal?.offlineItemPct ?? 0,
    kills: 0,
    xp: 0,
    gold: 0,
    upkeep: 0,
    found: 0,
    items: 0,
    levels: 0,
    source: "model",
  };
  const shares: OfflineShare[] = [];
  if (!bal || minutes <= 0 || model.shares.length === 0) return { grant, shares };

  const lootPct = partyScaleOf(world, reg).lootPct;
  const T = minutes * TICKS_PER_MIN;
  const fbXp = (modelXp: number): number => Math.floor((modelXp * bal.offlineModelXpPct) / 100);
  const rate = world.getResource<AutoRate>(RES.autoRate);
  let kills: number;
  let itemsB: number;
  let baseGold: number;
  let baseFound: number;
  let upkeep: number;
  let baseXp: number[];
  if (rate && rate.ticks >= AUTO_RATE_MIN_TICKS) {
    grant.source = "rate";
    kills = Math.min(
      Math.floor((rate.kills * T) / rate.ticks),
      m.kills * RATE_CAP_X,
      KILLS_PER_MIN_MAX * minutes,
    );
    // The measured raw XP pool (no hero's level or control in it), turned into
    // each member's own XP with its model share of a pool (partyKillXp at its
    // level / pool per kill). A control switch before the grant changes nothing.
    const poolXp = rate.pool === undefined ? -1 : Math.floor((rate.pool * T) / rate.ticks);
    baseXp = model.shares.map((sh, i) => {
      if (poolXp < 0 || model.poolPerKill <= 0) return fbXp(sh.xp);
      const cap = fbXp(sh.xp) * RATE_CAP_X;
      return Math.min(Math.floor((poolXp * model.perKill[i]!) / model.poolPerKill), cap);
    });
    itemsB = Math.min(ITEM_KEEP_MAX, Math.floor((kills * ITEM_KEEP_PCT * lootPct) / 10000));
    const rateGold = Math.floor((rate.gold * T) / rate.ticks);
    upkeep = Math.floor(((rate.upkeep ?? 0) * T) / rate.ticks);
    baseFound = Math.min(
      rateGold + junkGold(reg, bal, m.monsterLevel, kills, itemsB, lootPct),
      m.gold * RATE_CAP_X + upkeep,
    );
    baseGold = clamp(baseFound - upkeep, 0, m.gold * RATE_CAP_X);
  } else {
    kills = m.kills;
    baseXp = model.shares.map((sh) => fbXp(sh.xp));
    itemsB = m.items;
    upkeep = 0;
    baseGold = Math.floor((m.gold * (bal.offlineModelGoldPct ?? 100)) / 100);
    baseFound = baseGold;
  }

  model.shares.forEach((sh, i) => {
    const xp = Math.floor((baseXp[i]! * xpPctEff) / 100);
    const lvl = world.get(sh.hero, Level);
    const own = lvl?.level ?? 1;
    const levels = Math.max(0, Math.min(bal.maxLevel, levelForXp(bal, (lvl?.xp ?? 0) + xp)) - own);
    shares.push({ hero: sh.hero, xp, levels });
    grant.xp += xp;
    grant.levels += levels;
  });
  grant.kills = kills;
  grant.upkeep = upkeep;
  grant.gold = Math.floor((baseGold * bal.offlineGoldPct) / 100);
  grant.found = Math.floor((baseFound * bal.offlineGoldPct) / 100);
  grant.items = Math.floor((itemsB * bal.offlineItemPct) / 100);
  return { grant, shares };
}

/** Offline kills count for killMonsters quests (rule (d), design §16). `kills`
 * is spread evenly over `depthIds`, the monsters of the offline depth
 * (depthMonsterIds), so with n of them:
 *  - target "*" (any monster) gains `kills`;
 *  - a named target that is one of the n monsters gains floor(kills / n);
 *  - a named target outside that list gains 0.
 * Progress is capped at the quest's count. Done quests and the other quest
 * kinds (reachDepth, killBoss, clearLevel) never change offline. Quests are
 * visited in qs.active order. The events are the same as for live kills
 * (classic.quest.progress / classic.quest.done, progression/quests.ts).
 */
export function creditOfflineKills(
  world: World,
  ctx: SimContext,
  kills: number,
  depthIds: readonly string[],
): void {
  if (kills <= 0) return;
  const qs = world.getResource<QuestState>(RES.quests);
  if (!qs || qs.active.length === 0) return;
  const share = depthIds.length > 0 ? Math.floor(kills / depthIds.length) : 0;
  let changed = false;
  for (const q of qs.active) {
    if (q.done) continue;
    const qp = ctx.registry.get<QuestProto>(KIND.quest, q.id);
    if (!qp || qp.kind !== "killMonsters") continue;
    const gain = qp.target === "*" ? kills : depthIds.includes(qp.target) ? share : 0;
    if (gain <= 0) continue;
    const progress = Math.min(qp.count, q.progress + gain);
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

/**
 * Payload of classic.offlineProgress (server-only in server play). `xpPct`:
 * the effective offline XP percent (admin tunable "classic.offlineXpPct",
 * integer 0..100), set by the server; absent = BalanceProto.offlineXpPct.
 */
export interface OfflinePayload {
  elapsedMs: number;
  xpPct?: number;
}

export const offlineAction: ActionDef<OfflinePayload> = {
  name: ACTION.offlineProgress,
  parse(_world, payload) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload))
      throw new ActionError(ERR.badPayload, "expected { elapsedMs }");
    const keys = Object.keys(payload);
    if (keys.some((k) => k !== "elapsedMs" && k !== "xpPct"))
      throw new ActionError(ERR.badPayload, "unknown field");
    const ms = (payload as { elapsedMs?: unknown }).elapsedMs;
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms <= 0 || ms > MAX_OFFLINE_MS)
      throw new ActionError(ERR.badPayload, "elapsedMs must be an integer in 1..7 days");
    if (!("xpPct" in payload)) return { elapsedMs: ms };
    const pct = (payload as { xpPct?: unknown }).xpPct;
    if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 0 || pct > 100)
      throw new ActionError(ERR.badPayload, "xpPct must be an integer in 0..100");
    return { elapsedMs: ms, xpPct: pct };
  },
  apply(world, p, ctx) {
    const hero = heroOf(world);
    if (hero === 0 || !world.has(hero, Level)) throw new ActionError(ERR.noHero, "no hero");
    // Same-tick guard (§4.4): a double local dispatch can never pay twice.
    // Throwing rolls back the whole action. The verified server (actor
    // "server") is exempt: it pays measured absences only, and two of them
    // may follow each other on one tick (a grant, then leaving before a tick
    // of play), which the guard would lose.
    const stats = world.getResource<RunStats>(RES.stats);
    if (ctx.actor !== OFFLINE_SERVER_ACTOR && stats?.offlineAt === ctx.tick)
      throw new ActionError(ERR.offlineTwice, "offline progress was already granted this tick");
    const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
    const party = isParty(world);
    let g = party
      ? partyOfflineGrant(world, ctx.registry, p.elapsedMs, p.xpPct).grant
      : offlineGrant(world, ctx.registry, hero, p.elapsedMs, p.xpPct);
    // A dead hero is respawned by the grant (§4.4). Its death was in the absence,
    // so the respawn delay counts as served, and execRespawn runs now, before the
    // grants are queued. (A queued respawn would race the controller's own respawn
    // on the same tick, and the loser would emit classic.command.failed.) In a
    // party, a dead controlled hero (a wipe, or downed while others stand)
    // respawns every downed member with it (party.md §7.2).
    if (g.minutes > 0 && world.has(hero, Dead)) {
      const dead = world.read(hero, Dead);
      world.update(hero, Dead, { at: Math.min(dead.at, ctx.tick - bal.respawnDelay) });
      execRespawn(world, ctx, hero);
    }
    // A party's XP goes to its standing members (after the respawn), each its own share.
    if (party) {
      const pg = partyOfflineGrant(world, ctx.registry, p.elapsedMs, p.xpPct);
      g = pg.grant;
      for (const sh of pg.shares) {
        if (sh.xp <= 0) continue;
        const cmd = { op: "grantXp", amount: sh.xp, reason: "offline" } as const;
        pushCommand(world, sh.hero === hero ? cmd : { ...cmd, hero: sh.hero });
      }
    } else if (g.xp > 0) pushCommand(world, { op: "grantXp", amount: g.xp, reason: "offline" });
    if (g.gold > 0) pushCommand(world, { op: "grantGold", amount: g.gold, reason: "offline" });
    if (g.items > 0)
      pushCommand(world, {
        op: "grantItems",
        count: g.items,
        ilvl: g.monsterLevel,
        minRarity: "magic",
        toStash: true,
        reason: "offline",
      });
    creditOfflineKills(world, ctx, g.kills, g.depthIds);
    if (stats) {
      stats.offlineMs += g.ms;
      stats.offlineAt = ctx.tick;
      world.setResource(RES.stats, stats);
    }
    emit(ctx, {
      type: "classic.offline.summary",
      ms: g.ms,
      awayMs: p.elapsedMs,
      capMs: bal.offlineCapMs,
      xpPct: g.xpPct,
      goldPct: g.goldPct,
      itemPct: g.itemPct,
      source: g.source,
      depth: g.depth,
      kills: g.kills,
      xp: g.xp,
      gold: g.gold,
      upkeep: g.upkeep,
      found: g.found,
      items: g.items,
      levels: g.levels,
    });
  },
};
