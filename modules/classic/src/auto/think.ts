/**
 * classic.auto.think (pre 0): the deterministic Auto/Idle controller
 * (§15.2). It reads world state and writes only the hero Intent (source
 * "auto"), AutoState and Bus.commands. Danger (death, potions, retreat,
 * fight) is handled every tick; the rest re-plans every REPLAN_TICKS or as
 * soon as the hero's intent went idle.
 *
 * Priority (first that applies wins):
 *  1 dead -> respawn   3 potions   4 retreat (before busy and dodging: the
 *  portal is instant)   2 busy   3b dodge telegraphs   5 fight   6 loot   7 equip (side action)   8 go to town   9 town routine
 *  10 descend (or the rift loop)   11 explore
 *
 * Once descend or toTown is chosen the hero is leaving the level (AutoLeave):
 * until it gets there, step 5 only fights foes within LEAVE_FIGHT_RANGE or
 * attacking it, and step 6 only picks up loot within LEAVE_LOOT_RANGE.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import {
  Belt,
  Casting,
  Dash,
  Dead,
  HeroStats,
  Intent,
  Interactable,
  Level,
  Life,
  Loot,
  Mana,
  Monster,
  Pos,
  AreaTag,
  Reviving,
  type AutoPlan,
} from "../components.ts";
import { PICKUP_RANGE } from "../actions.ts";
import { autoActive } from "../control.ts";
import { SYSTEM } from "../ids.ts";
import {
  heroOf,
  lootFilterOf,
  RES,
  type AreaState,
  type QuestState,
  type RunStats,
} from "../resources.ts";
import { lootVisible } from "../loot.ts";
import { isRiftDepth, rarityRank, repairCost } from "../rules.ts";
import { KIND, type ItemBaseProto, type NpcProto, type QuestProto } from "../types.ts";
import { actingLeaderOf, leaderMode, partyWiped } from "../party/shared.ts";
import { brokenGear, wornGear } from "./craft.ts";
import { dodgeStep } from "./dodge.ts";
import { econOf, goldOf, hasCraftingSmith } from "./econ.ts";
import { dungeonStep, giveUpFrontier, liveBoss, travel } from "./dungeon.ts";
import { engagedFoes, fightStep, isStunned, scanFoes, type Foe } from "./fight.ts";
import { pickEquip } from "./gear.ts";
import { anyDowned, downedStep, gatherWait, reviveRetreat } from "./lead.ts";
import { healAllyStep, otherMemberCtxs, partyInDanger } from "./party.ts";
import { walkTo } from "./route.ts";
import { restockPrice, skipTownStep, townFreesBag, townStep } from "./town.ts";
import { tileDist } from "./route.ts";
import {
  addIgnore,
  AutoLeave,
  bagFits,
  balanceOf,
  beltCount,
  beltHasRoom,
  currentIntent,
  d2To,
  emitFor,
  FIGHT_LINGER_TICKS,
  inReach,
  isParty,
  makeAutoCtx,
  isIgnored,
  LEAVE_LOOT_RANGE,
  leaving,
  lifePct,
  LOOT_RANGE,
  LOOT_SAFE_RANGE,
  manaPct,
  nearestInteractable,
  noteRetreat,
  potionAmount,
  potionOf,
  purseGold,
  purseScrolls,
  pushCmd,
  REPLAN_TICKS,
  setIntent,
  setPlan,
  STALL_TICKS,
  stopIntent,
  STUCK_TICKS,
  syncLeave,
  TOWN_STEPS,
  TRAVEL_RETRY_TICKS,
  TRIP_COOLDOWN_TICKS,
  WATCHDOG_HOPS,
  WATCHDOG_TICKS,
  type AutoCtx,
} from "./util.ts";

/** Plans during which the hero is expected to walk (stuck detection). */
const WALKING: readonly AutoPlan[] = ["explore", "loot", "town", "toDungeon", "descend", "toTown"];
/** Plans whose order is finished when the intent goes back to idle (re-plan at once). */
const REACTIVE: readonly AutoPlan[] = ["explore", "loot", "town"];

/** Fresh area: forget per-area memory; start the town routine in town. */
function onAreaEntered(c: AutoCtx): void {
  const st = c.st;
  st.ignore = [];
  st.frontierX = -1;
  st.frontierY = -1;
  st.focus = 0;
  st.stuck = 0;
  st.lastTileX = c.tx;
  st.lastTileY = c.ty;
  st.todo = c.depth === 0 ? [...TOWN_STEPS] : [];
  st.thinkAt = c.tick;
  st.hops++;
  // The first dungeon level entered after a death ends the "come back below it" rule.
  if (c.depth > 0) st.deathDepth = 0;
  // Voluntary trips (bag full, restock) at most once per cooldown, counted from the town visit.
  if (c.depth === 0) st.tripAt = c.tick + TRIP_COOLDOWN_TICKS;
  c.due = true;
}

// ---------------------------------------------------------------------------
// Progress watchdog
// ---------------------------------------------------------------------------

/**
 * Detects zero-progress loops the tile-based stuck detector cannot see:
 * WATCHDOG_HOPS area changes without a kill (town ping-pong), or
 * WATCHDOG_TICKS in a dungeon without a kill (unkillable or unreachable
 * foes). Either starts a stall: for STALL_TICKS no voluntary town trips and
 * the dungeon routine heads for a fresh level.
 */
function watchdog(c: AutoCtx): void {
  const st = c.st;
  const kills = c.world.getResource<RunStats>(RES.stats)?.kills ?? 0;
  if (kills !== st.killsSeen) {
    st.killsSeen = kills;
    st.killAt = c.tick;
    st.hops = 0;
    return;
  }
  // Damaging a boss is progress without kills (a 2-minute fight with Skarn started a stall
  // that walked the warrior away from her), and so are the portal trips of its retreats. Only
  // real progress counts: a new boss focus or its life below the lowest seen. A boss the hero
  // cannot hurt (out of reach, kiting, healing) leaves the drought and loop counters running.
  if (bossProgress(c)) {
    st.killAt = c.tick;
    st.hops = 0;
    return;
  }
  // Time in town or dead is not a drought.
  if (c.depth === 0 || c.world.has(c.hero, Dead)) st.killAt = Math.max(st.killAt, c.tick - 1);
  const loop = st.hops >= WATCHDOG_HOPS;
  const drought = c.depth > 0 && c.tick - st.killAt >= WATCHDOG_TICKS;
  if (!loop && !drought) return;
  st.stallUntil = c.tick + STALL_TICKS;
  st.hops = 0;
  st.killAt = c.tick;
  st.ignore = [];
  st.frontierX = -1;
  st.frontierY = -1;
  st.focus = 0;
  emitFor(c, {
    type: "classic.auto.notice",
    code: loop ? "travel_loop" : "no_kills",
    message: loop
      ? "Auto: travelling without progress, staying in the dungeon for a while"
      : "Auto: no kills for a while, looking for a fresh level",
  });
}

/** True while the hero fights a living boss (plan fight, focus on it). */
function fightingBoss(c: AutoCtx): boolean {
  const f = c.st.focus;
  if (c.st.plan !== "fight" || f === 0 || c.world.has(f, Dead)) return false;
  return c.world.get(f, Monster)?.rarity === "boss";
}

/**
 * True on a boss-fight tick (fightingBoss) that made progress: the focus
 * moved to this boss (AutoState.bossE) or its life fell below the lowest
 * seen (AutoState.bossHp). Updates both fields.
 */
export function bossProgress(c: AutoCtx): boolean {
  if (!fightingBoss(c)) return false;
  const st = c.st;
  const hp = c.world.get(st.focus, Life)?.hp ?? 0;
  if (st.bossE !== st.focus) {
    st.bossE = st.focus;
    st.bossHp = hp;
    return true;
  }
  if (st.bossHp === undefined || hp < st.bossHp) {
    st.bossHp = hp;
    return true;
  }
  return false;
}

/**
 * Death caution: each death raises AutoState.caution (max 3) and remembers
 * its depth; each level up lowers it. While cautious the hero plans with a
 * lower effective level (descend, boss and waypoint choices). The first
 * return after a death goes below the depth it died on (a fresh level
 * instead of the pack that killed it).
 */
function trackCaution(c: AutoCtx): void {
  const st = c.st;
  const dead = c.world.get(c.hero, Dead);
  if (dead && dead.at !== st.deathAt) {
    st.deathAt = dead.at;
    st.deathDepth = c.depth;
    st.caution = Math.min(MAX_CAUTION, st.caution + 1);
  }
  const level = c.world.get(c.hero, Level)?.level ?? 1;
  if (level > st.levelSeen) st.caution = Math.max(0, st.caution - (level - st.levelSeen));
  st.levelSeen = level;
  // Caution also wears off with time alive (a slow class levels slowly: 3 deaths used to
  // hold a warrior back for 3 whole levels).
  const since = c.tick - st.deathAt;
  if (st.caution > 0 && !dead && since > 0 && since % CAUTION_DECAY_TICKS === 0) st.caution--;
}
const MAX_CAUTION = 3;
/** One caution step wears off after this long without a death: 5 minutes. */
export const CAUTION_DECAY_TICKS = 6000;

/** True while a watchdog stall is active. */
export function stalled(c: AutoCtx): boolean {
  return c.st.stallUntil > c.tick;
}

// ---------------------------------------------------------------------------
// 1 dead, 3 potions, 4 retreat
// ---------------------------------------------------------------------------

function deadStep(c: AutoCtx): void {
  setPlan(c, "dead", "waiting to respawn");
  c.st.focus = 0;
  const dead = c.world.read(c.hero, Dead);
  const since = c.tick - (dead.at + balanceOf(c.reg).respawnDelay);
  if (since >= 0 && since % TRAVEL_RETRY_TICKS === 0) pushCmd(c, { op: "respawn" });
}

/** Belt slot of the potion to drink for `kind`, or -1. Prefers the biggest one that is not wasted. */
export function choosePotion(c: AutoCtx, kind: "life" | "mana"): number {
  const belt = c.world.get(c.hero, Belt);
  if (!belt) return -1;
  const vit = kind === "life" ? c.world.get(c.hero, Life) : undefined;
  const mag = kind === "mana" ? c.world.get(c.hero, Mana) : undefined;
  const max = vit?.max ?? mag?.max ?? 0;
  const cur = vit?.hp ?? mag?.mp ?? 0;
  if (max <= 0) return -1;
  const missing = max - cur;
  // Nothing to restore: a potion would be wasted (the drink op refuses it too).
  if (missing <= 0) return -1;
  const bonus = c.world.get(c.hero, HeroStats)?.potionPct ?? 0;
  const pick = (allowRejuv: boolean): number => {
    let fit = -1;
    let fitAmt = -1;
    let small = -1;
    let smallAmt = Number.MAX_SAFE_INTEGER;
    belt.slots.forEach((s, i) => {
      if (s.count <= 0) return;
      const p = potionOf(c.reg, s.base);
      if (!p || (p.kind !== kind && !(allowRejuv && p.kind === "rejuv"))) return;
      if (!allowRejuv && p.kind === "rejuv") return;
      const amt = potionAmount(p, max, bonus);
      if (amt <= missing && amt > fitAmt) {
        fit = i;
        fitAmt = amt;
      }
      if (amt < smallAmt) {
        small = i;
        smallAmt = amt;
      }
    });
    return fit >= 0 ? fit : small;
  };
  const slot = pick(false);
  return slot >= 0 ? slot : pick(true);
}

export function potionStep(
  c: AutoCtx,
  foes: readonly Foe[],
  inFight: boolean = foes.length > 0,
): void {
  if (c.depth === 0) return;
  const belt = c.world.get(c.hero, Belt);
  if (!belt || belt.readyAt > c.tick) return;
  if (lifePct(c) < c.cfg.lifePotionPct) {
    const slot = choosePotion(c, "life");
    if (slot >= 0) {
      pushCmd(c, { op: "drink", slot });
      return;
    }
  }
  if (inFight && manaPct(c) < c.cfg.manaPotionPct) {
    const slot = choosePotion(c, "mana");
    if (slot >= 0) pushCmd(c, { op: "drink", slot });
  }
}

/**
 * Below this life % with the belt on cooldown (or empty) the hero leaves
 * through a town portal at once: a champion hitting for a fifth of the
 * hero's life per second outpaces a potion every second (wave A playtest:
 * many deaths with full belts).
 */
export const EMERGENCY_PCT = 15;

/**
 * With a boss in the fight and no life potion left the hero leaves below
 * this life % (or retreatPct when higher): one boss hit takes a fifth to a
 * third of a squishy hero's life (Vessa's enraged Firebolt: 40-54 of a
 * level-20 sorcerer's 150), so retreatPct (25) came one hit too late. The
 * portal opens next to the boss, which keeps its wound.
 */
export const BOSS_RETREAT_PCT = 50;

/**
 * Step 4. Runs before the busy check and before dodging: the town portal is
 * instant and the area change cancels a cast, while a 6-tick spell or a
 * dodge at 20 % life without a potion ended in deaths at the boss. A party
 * also leaves when two members are in danger or a downed member could not
 * be revived (docs/design/party.md §6.1).
 */
function retreatStep(c: AutoCtx, foes: readonly Foe[]): boolean {
  return soloRetreat(c, foes) || (c.party && (partyRetreat(c) || reviveRetreat(c)));
}

/** Life of this level's living boss for AutoRetreats (boss retreat loops), or -1. */
function retreatBossHp(c: AutoCtx): number {
  const boss = liveBoss(c);
  return boss === 0 ? -1 : (c.world.get(boss, Life)?.hp ?? -1);
}

/**
 * Party retreat (docs/design/party.md §6.1): two or more standing members
 * below retreatPct with no life potion left. Same rules for scrolls, rifts
 * and recent travel commands as the solo retreat.
 */
function partyRetreat(c: AutoCtx): boolean {
  if (c.depth === 0 || isRiftDepth(c.depth) || purseScrolls(c) <= 0) return false;
  if (c.st.thinkAt - c.tick > REPLAN_TICKS) return false;
  if (!partyInDanger(c)) return false;
  c.due = true;
  if (!travel(c, { op: "townPortal" })) return false;
  setPlan(c, "toTown", "party retreat");
  noteRetreat(c, retreatBossHp(c));
  return true;
}

function soloRetreat(c: AutoCtx, foes: readonly Foe[]): boolean {
  if (c.depth === 0) return false;
  const life = lifePct(c);
  const noPotion = beltCount(c, "life") === 0;
  const atBoss = noPotion && c.cfg.retreatPct > 0 && foes.some((f) => f.rarity === "boss");
  const threshold = atBoss ? Math.max(c.cfg.retreatPct, BOSS_RETREAT_PCT) : c.cfg.retreatPct;
  if (life >= threshold) return false;
  // Town portals do not work in a rift (ERR.inRift).
  if (isRiftDepth(c.depth)) return false;
  const belt = c.world.get(c.hero, Belt);
  const potionLate = (belt?.readyAt ?? 0) > c.tick + 2;
  const emergency = life < Math.min(EMERGENCY_PCT, c.cfg.retreatPct) && potionLate;
  if (!noPotion && !emergency) return false;
  if (purseScrolls(c) <= 0) return false;
  // A travel command went out less than REPLAN_TICKS ago (travel sets thinkAt 20 ahead).
  if (c.st.thinkAt - c.tick > REPLAN_TICKS) return false;
  c.due = true;
  if (!travel(c, { op: "townPortal" })) return false;
  setPlan(c, "toTown", "retreat");
  noteRetreat(c, retreatBossHp(c));
  return true;
}

// ---------------------------------------------------------------------------
// 6 loot, 7 equip, 8 go to town
// ---------------------------------------------------------------------------

/**
 * Nearest Loot within 12 tiles that passes the pickup filter, or 0. The
 * loot being walked to stays eligible up to twice that range (the route
 * around walls may lead away from it first). While leaving the level only
 * loot within LEAVE_LOOT_RANGE counts.
 */
export function pickLoot(c: AutoCtx): Entity {
  const pickRank = rarityRank(c.cfg.pickupRarity);
  const filter = lootFilterOf(c.world);
  const keep = c.st.plan === "loot" ? c.st.focus : 0;
  const leave = leaving(c);
  let best = 0;
  let bestD = Number.MAX_SAFE_INTEGER;
  for (const e of c.world.query(Loot, Pos, AreaTag)) {
    if (c.world.read(e, AreaTag).depth !== c.depth) continue;
    const p = c.world.read(e, Pos);
    const d = d2To(c, p.x, p.y);
    const range = leave ? LEAVE_LOOT_RANGE : e === keep ? 2 * LOOT_RANGE : LOOT_RANGE;
    if (d > range * range || d >= bestD) continue;
    if (isIgnored(c.st, p.x >> 8, p.y >> 8)) continue;
    const l = c.world.read(e, Loot);
    // Loot hidden by the player's loot filter is never picked up by Auto (wave A).
    if (!lootVisible(filter, c.reg, l)) continue;
    let ok = false;
    if (l.kind === "gold") ok = c.cfg.pickupGold;
    else if (l.kind === "potion") ok = c.cfg.pickupPotions && beltHasRoom(c, l.potion);
    else if (l.item) {
      const base = c.reg.get<ItemBaseProto>(KIND.itemBase, l.item.base);
      // Gems are always worth the 1x1 cell (smith sockets), whatever pickupRarity says.
      const wanted = base?.gem !== undefined || rarityRank(l.item.rarity) >= pickRank;
      ok = wanted && bagFits(c, base?.size.w ?? 1, base?.size.h ?? 1);
    }
    if (!ok) continue;
    best = e;
    bestD = d;
  }
  return best;
}

/** Loot within this distance (sub) is picked up directly with the pickup op. */
const PICK_REACH = PICKUP_RANGE - 32;

/**
 * Picks up the focused loot once within reach: pushes the items op from here
 * (pre stage, before classic.items.commands drains the bus this tick) and
 * stops the walk. True when it did.
 */
function pickupInReach(c: AutoCtx): boolean {
  const e = c.st.focus;
  if (e === 0 || !c.world.has(e, Loot)) return false;
  const p = c.world.read(e, Pos);
  if (d2To(c, p.x, p.y) > PICK_REACH * PICK_REACH) return false;
  pushCmd(c, { op: "pickup", target: e });
  stopIntent(c);
  return true;
}

function lootStep(c: AutoCtx, foes: readonly Foe[]): boolean {
  // A watchdog stall skips looting (it breaks loot/route oscillations).
  if (stalled(c) || foes.some((f) => f.dist <= LOOT_SAFE_RANGE)) return false;
  const st = c.st;
  // The last pickup of the focused loot did not take (bag/belt full, refused): give it up.
  if (st.plan === "loot" && st.focus !== 0 && c.world.has(st.focus, Loot)) {
    const cur = currentIntent(c);
    if (cur && cur.kind === "idle") {
      const p = c.world.read(st.focus, Pos);
      if (d2To(c, p.x, p.y) <= PICK_REACH * PICK_REACH) addIgnore(st, p.x >> 8, p.y >> 8);
    }
  }
  const e = pickLoot(c);
  if (e === 0) return false;
  st.focus = e;
  const l = c.world.read(e, Loot);
  setPlan(c, "loot", l.item?.name ?? l.kind);
  if (pickupInReach(c)) return true;
  setIntent(c, { kind: "pickup", target: e });
  return true;
}

export function equipStep(c: AutoCtx): void {
  if (!c.cfg.autoEquip) return;
  const eq = pickEquip(c);
  if (eq) pushCmd(c, { op: "equip", uid: eq.uid, slot: eq.slot });
}

/**
 * True when a finished quest waits for its giver (turned in by the town
 * routine's quests step). Checked against the registry, because the giver
 * is only an entity while the hero is in town.
 */
export function questTurnInWaiting(c: AutoCtx): boolean {
  const qs = c.world.getResource<QuestState>(RES.quests);
  if (!qs) return false;
  return qs.active.some((a) => {
    if (!a.done) return false;
    const qp = c.reg.get<QuestProto>(KIND.quest, a.id);
    return qp !== undefined && c.reg.get<NpcProto>(KIND.npc, qp.giver) !== undefined;
  });
}

/**
 * True when a quest the hero may accept now (level >= reqLevel, its `after`
 * quest done, not active nor completed) has a giver NPC: the town routine's
 * quests step accepts it. Like questTurnInWaiting, a voluntary trip reason:
 * only at a safe point (no fight), after the trip cooldown, outside a stall;
 * once accepted the quest is active and the reason is gone (no ping-pong).
 */
export function questAcceptWaiting(c: AutoCtx): boolean {
  const qs = c.world.getResource<QuestState>(RES.quests);
  if (!qs) return false;
  const level = c.world.get(c.hero, Level)?.level ?? 1;
  for (const [id, q] of c.reg.all<QuestProto>(KIND.quest)) {
    if (q.reqLevel > level || qs.completed.includes(id)) continue;
    if (q.after !== "" && !qs.completed.includes(q.after)) continue;
    if (qs.active.some((a) => a.id === id)) continue;
    if (c.reg.get<NpcProto>(KIND.npc, q.giver) !== undefined) return true;
  }
  return false;
}

/**
 * Stairs this close (tiles) while descending: no voluntary trip (the stairs
 * come first; the trip happens on the next level).
 */
export const TRIP_STAIRS_TILES = 30;

/** True while the hero walks to the stairs down and they are within TRIP_STAIRS_TILES. */
function nearStairsDown(c: AutoCtx): boolean {
  if (c.st.plan !== "descend" && !leavingFor(c, "descend")) return false;
  const s = c.map.stairsDown;
  return s !== null && tileDist(s.x, s.y, c.tx, c.ty) <= TRIP_STAIRS_TILES;
}

function leavingFor(c: AutoCtx, plan: "descend" | "toTown"): boolean {
  if (!leaving(c)) return false;
  return c.st.plan === plan || c.world.get(c.hero, AutoLeave)?.plan === plan;
}

/** Why a voluntary town trip is due now ("" = none). */
export function townTripReason(c: AutoCtx): "" | "bag full" | "quest" | "restock" | "repair" {
  if (c.depth === 0 || c.tick < c.st.tripAt || stalled(c)) return "";
  // No town portal in a rift; the run ends at its exit.
  if (isRiftDepth(c.depth)) return "";
  // A broken weapon or armor piece adds nothing: repair it (wave A), even near the stairs.
  if (repairDue(c)) return "repair";
  const others = c.party ? otherMemberCtxs(c) : [];
  if (others.some((m) => repairDue(m))) return "repair";
  if (nearStairsDown(c)) return "";
  if (!bagFits(c, 2, 3) && townFreesBag(c)) return "bag full";
  if (others.some((m) => !bagFits(m, 2, 3) && townFreesBag(m))) return "bag full";
  if (questTurnInWaiting(c) || questAcceptWaiting(c)) return "quest";
  const gold = purseGold(c);
  const life = beltCount(c, "life");
  const price = restockPrice(c);
  if (life === 0 && gold >= price) return "restock";
  // Running low with gold to spare: restock before the belt is empty.
  if (life <= RESTOCK_LOW && price < Number.MAX_SAFE_INTEGER && gold >= RESTOCK_LOW_GOLD * price)
    return "restock";
  // Party: a member with an empty belt (or one below its retreat % without a life potion).
  if (others.some((m) => beltCount(m, "life") === 0 && gold >= restockPrice(m))) return "restock";
  return "";
}
/** Life potions left that count as running low. */
export const RESTOCK_LOW = 2;
/** A low-belt restock trip needs gold for this many potions. */
export const RESTOCK_LOW_GOLD = 8;

/**
 * A repair trip is due: autoRepair, a crafting smith exists, some equipped
 * item is broken (or two are worn below 10 %), and the gold covers at least
 * the cheapest of those repairs.
 */
export function repairDue(c: AutoCtx): boolean {
  if (!(c.cfg.autoRepair ?? true) || !hasCraftingSmith(c.reg)) return false;
  const econ = econOf(c.reg);
  if (!econ) return false;
  const worn = wornGear(c).filter((it) => it.dur !== undefined && it.dur.cur * 10 <= it.dur.max);
  if (!brokenGear(c) && worn.length < 2) return false;
  const gold = goldOf(c);
  return worn.some((it) => repairCost(econ, it) <= gold);
}

/**
 * Scrolls a voluntary trip leaves in the pack: the last scroll is kept for a
 * retreat (only restock and repair trips, which fix survival, may use it).
 */
export const KEEP_SCROLLS = 1;

function toTownStep(c: AutoCtx): boolean {
  const note = townTripReason(c);
  if (note === "") return false;
  const scrolls = purseScrolls(c);
  const keep = note === "restock" || note === "repair" ? 0 : KEEP_SCROLLS;
  if (scrolls > keep) {
    if (!travel(c, { op: "townPortal" })) return false;
    setPlan(c, "toTown", note);
    return true;
  }
  // No scroll: walk to this level's waypoint if it has one, else keep playing.
  const wp = nearestInteractable(c, "waypoint");
  if (wp === 0) return false;
  const same = c.st.focus === wp && c.st.plan === "toTown";
  c.st.focus = wp;
  setPlan(c, "toTown", `${note} (waypoint)`);
  if (inReach(c, wp)) travel(c, { op: "waypoint", depth: 0 });
  else {
    const p = c.world.read(wp, Pos);
    walkTo(c, p.x >> 8, p.y >> 8, () => setIntent(c, { kind: "interact", target: wp }), same);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stuck detection
// ---------------------------------------------------------------------------

function trackStuck(c: AutoCtx): void {
  const st = c.st;
  if (st.plan === "fight") return; // fightStep tracks its own progress
  if (WALKING.includes(st.plan) && st.lastTileX === c.tx && st.lastTileY === c.ty) {
    st.stuck++;
  } else {
    st.lastTileX = c.tx;
    st.lastTileY = c.ty;
    st.stuck = 0;
    return;
  }
  if (st.stuck < STUCK_TICKS) return;
  st.stuck = 0;
  if (st.plan === "explore") giveUpFrontier(c);
  else if (st.plan === "town" || st.plan === "toDungeon") skipTownStep(c);
  else if (st.plan === "descend" || st.plan === "toTown") {
    // Stairs are never given up: the next plan re-routes (in legs).
    st.focus = 0;
  } else if (st.focus !== 0 && c.world.has(st.focus, Pos)) {
    const p = c.world.read(st.focus, Pos);
    addIgnore(st, p.x >> 8, p.y >> 8);
    st.focus = 0;
  }
  stopIntent(c);
  st.thinkAt = c.tick;
  c.due = true;
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

/** Steps 6-11 (the slow part). */
function plan(c: AutoCtx, foes: readonly Foe[]): void {
  if (lootStep(c, foes)) return;
  equipStep(c);
  if (toTownStep(c)) return;
  if (c.depth === 0) {
    if (c.st.todo.length === 0 && c.st.plan !== "town" && c.st.plan !== "toDungeon")
      c.st.todo = [...TOWN_STEPS];
    if (townStep(c)) return;
  } else if (c.party && (downedStep(c, true) || gatherWait(c))) return;
  else if (dungeonStep(c)) return;
  setPlan(c, "none", "idle");
  stopIntent(c);
}

/**
 * What the leader brain may do (docs/design/party.md §3): "full" = the whole
 * controller; "defend" (party: Manual while the controlled hero is down) =
 * potions, dodge, heals, fights and revives only (no loot, travel, explore).
 */
export type LeadMode = "full" | "defend";

export function think(world: World, ctx: SimContext, hero: Entity, mode: LeadMode = "full"): void {
  const c = makeAutoCtx(world, ctx, hero);
  thinkTick(c, mode);
  syncLeave(c);
}

function thinkTick(c: AutoCtx, mode: LeadMode): void {
  const { world, ctx, hero, st } = c;
  const area = world.getResource<AreaState>(RES.area);
  if (area && area.enteredAt === ctx.tick) onAreaEntered(c);
  watchdog(c);
  trackCaution(c);

  if (world.has(hero, Dead)) {
    deadStep(c);
    return;
  }
  const foes = scanFoes(c);
  potionStep(c, foes);
  // Leaving comes first: the portal is instant and cancels a cast (see retreatStep).
  // Party "defend" mode (Manual, the controlled hero down) never leaves.
  if (mode === "full" && retreatStep(c, foes)) return;
  if (world.has(hero, Casting) || world.has(hero, Dash) || isStunned(c)) {
    // Acting (or unable to act) is not being stuck.
    st.stuck = 0;
    st.lastTileX = c.tx;
    st.lastTileY = c.ty;
    return;
  }
  trackStuck(c);
  // Telegraphs fire on a fixed tick: stepping out comes before everything but potions.
  if (dodgeStep(c)) return;
  // Party: channelling a revive (classic.party cancels it on any move or cast).
  if (c.party && world.has(hero, Reviving)) {
    st.stuck = 0;
    return;
  }
  // Party: Mend (allyRadius) on an ally below half life.
  if (c.party && healAllyStep(c)) return;
  // While leaving the level only close foes and attackers are fought (see engagedFoes).
  const targets = engagedFoes(c, foes);
  if (targets.length > 0) {
    st.foeAt = ctx.tick;
    fightStep(c, foes, targets);
    return;
  }
  // Hysteresis: a foe that just left the scan (line of sight, range) often comes back at once.
  if (st.plan === "fight" && ctx.tick - st.foeAt < FIGHT_LINGER_TICKS) return;
  if (st.plan === "fight" || st.plan === "dead") {
    // Combat is over: re-plan right away.
    st.focus = 0;
    c.due = true;
  }
  if (mode === "defend") {
    // Party, Manual, the controlled hero is down: revive it, never wander off.
    if (downedStep(c, false)) return;
    setPlan(c, "none", "defend");
    stopIntent(c);
    return;
  }
  const intent = currentIntent(c);
  // A finished order (intent back to idle) re-plans at once; travel plans wait for the transition.
  const idle = (intent === undefined || intent.kind === "idle") && REACTIVE.includes(st.plan);
  if (!c.due && !idle) {
    // Cheap per-tick reactions: the town routine (arrivals at NPCs) and reaching the stairs.
    if (c.depth === 0 && (st.plan === "town" || st.plan === "toDungeon")) townStep(c);
    else if (st.plan === "descend" || st.plan === "toTown") arriveAt(c);
    else if (st.plan === "loot") pickupInReach(c);
    return;
  }
  const wasDue = c.due;
  plan(c, foes);
  if (wasDue) st.thinkAt = Math.max(st.thinkAt, ctx.tick + REPLAN_TICKS);
}

/** Takes the focused stairs (descend) or waypoint (to town) as soon as they are within reach. */
function arriveAt(c: AutoCtx): void {
  // Party: never take the stairs down while a member is downed (revive first).
  if (c.st.plan === "descend" && anyDowned(c)) return;
  const e = c.st.focus;
  if (e === 0 || !inReach(c, e)) return;
  const kind = c.world.get(e, Interactable)?.kind;
  if (c.st.plan === "descend" && (kind === "stairsDown" || kind === "stairsUp"))
    travel(c, { op: "stairs", target: e });
  else if (c.st.plan === "toTown" && kind === "waypoint") travel(c, { op: "waypoint", depth: 0 });
  else if (c.st.plan === "toTown" && kind === "riftExit") travel(c, { op: "leaveRift" });
}

/**
 * Party (two or more members): the leader brain drives the acting leader
 * when leaderMode is "full" or "defend"; on a wipe the controlled hero runs
 * the solo death flow (auto respawn, which revives the whole party).
 */
function partyThink(world: World, ctx: SimContext): void {
  if (partyWiped(world)) {
    if (!autoActive(world, ctx.tick)) return;
    const hero = heroOf(world);
    if (hero === 0 || !world.has(hero, Pos) || !world.has(hero, Intent)) return;
    think(world, ctx, hero);
    return;
  }
  const mode = leaderMode(world, ctx.tick);
  if (mode === "off") return;
  const leader = actingLeaderOf(world);
  if (leader === 0 || world.has(leader, Dead)) return;
  if (!world.has(leader, Pos) || !world.has(leader, Intent)) return;
  think(world, ctx, leader, mode);
}

export const thinkSystem: SystemDef = {
  ...SYSTEM.autoThink,
  run(world, ctx) {
    if (isParty(world)) {
      partyThink(world, ctx);
      return;
    }
    if (!autoActive(world, ctx.tick)) return;
    const hero = heroOf(world);
    if (hero === 0 || !world.has(hero, Pos) || !world.has(hero, Intent)) return;
    think(world, ctx, hero);
  },
};

export { makeAutoCtx } from "./util.ts";
