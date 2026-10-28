/**
 * classic.auto.think (pre 0): the deterministic Auto/Idle controller
 * (§15.2). It reads world state and writes only the hero Intent (source
 * "auto"), AutoState and Bus.commands. Danger (death, potions, retreat,
 * fight) is handled every tick; the rest re-plans every REPLAN_TICKS or as
 * soon as the hero's intent went idle.
 *
 * Priority (first that applies wins):
 *  1 dead -> respawn   2 busy   3 potions   4 retreat   5 fight   6 loot
 *  7 equip (side action)   8 go to town   9 town routine   10 descend   11 explore
 *
 * Once descend or toTown is chosen the hero is leaving the level (AutoLeave):
 * until it gets there, step 5 only fights foes within LEAVE_FIGHT_RANGE or
 * attacking it, and step 6 only picks up loot within LEAVE_LOOT_RANGE.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { pushCommand } from "../bus.ts";
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
  Pos,
  AreaTag,
  Supplies,
  Wallet,
  type AutoPlan,
} from "../components.ts";
import { PICKUP_RANGE } from "../actions.ts";
import { autoActive } from "../control.ts";
import { SYSTEM } from "../ids.ts";
import { emit } from "../events.ts";
import {
  currentDepth,
  heroOf,
  RES,
  type AreaState,
  type QuestState,
  type RunStats,
} from "../resources.ts";
import { rarityRank } from "../rules.ts";
import { KIND, type ItemBaseProto, type NpcProto, type QuestProto } from "../types.ts";
import { getAreaMap } from "../world/maps.ts";
import { dungeonStep, giveUpFrontier, travel } from "./explore.ts";
import { engagedFoes, fightStep, isStunned, scanFoes, type Foe } from "./fight.ts";
import { pickEquip } from "./gear.ts";
import { walkTo } from "./route.ts";
import { restockPrice, skipTownStep, townFreesBag, townStep } from "./town.ts";
import {
  addIgnore,
  bagFits,
  balanceOf,
  beltCount,
  beltHasRoom,
  configOf,
  currentIntent,
  d2To,
  ensureAutoState,
  FIGHT_LINGER_TICKS,
  heroClass,
  inReach,
  isIgnored,
  LEAVE_LOOT_RANGE,
  leaving,
  lifePct,
  LOOT_RANGE,
  LOOT_SAFE_RANGE,
  manaPct,
  nearestInteractable,
  potionAmount,
  potionOf,
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

export function makeAutoCtx(world: World, ctx: SimContext, hero: Entity): AutoCtx {
  const st = ensureAutoState(world, hero, ctx.tick);
  const p = world.read(hero, Pos);
  return {
    world,
    ctx,
    reg: ctx.registry,
    tick: ctx.tick,
    hero,
    st,
    cfg: configOf(world),
    map: getAreaMap(world, ctx.registry),
    depth: currentDepth(world),
    hx: p.x,
    hy: p.y,
    tx: p.x >> 8,
    ty: p.y >> 8,
    classProto: heroClass(world, ctx.registry, hero),
    due: ctx.tick >= st.thinkAt,
  };
}

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
  emit(c.ctx, {
    type: "classic.auto.notice",
    code: loop ? "travel_loop" : "no_kills",
    message: loop
      ? "Auto: travelling without progress, staying in the dungeon for a while"
      : "Auto: no kills for a while, looking for a fresh level",
  });
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
}
const MAX_CAUTION = 3;

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
  if (since >= 0 && since % TRAVEL_RETRY_TICKS === 0) pushCommand(c.world, { op: "respawn" });
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

function potionStep(c: AutoCtx, foes: readonly Foe[]): void {
  if (c.depth === 0) return;
  const belt = c.world.get(c.hero, Belt);
  if (!belt || belt.readyAt > c.tick) return;
  if (lifePct(c) < c.cfg.lifePotionPct) {
    const slot = choosePotion(c, "life");
    if (slot >= 0) {
      pushCommand(c.world, { op: "drink", slot });
      return;
    }
  }
  if (foes.length > 0 && manaPct(c) < c.cfg.manaPotionPct) {
    const slot = choosePotion(c, "mana");
    if (slot >= 0) pushCommand(c.world, { op: "drink", slot });
  }
}

function retreatStep(c: AutoCtx): boolean {
  if (c.depth === 0 || lifePct(c) >= c.cfg.retreatPct) return false;
  if (beltCount(c, "life") > 0) return false;
  if ((c.world.get(c.hero, Supplies)?.tpScrolls ?? 0) <= 0) return false;
  // A travel command went out less than REPLAN_TICKS ago (travel sets thinkAt 20 ahead).
  if (c.st.thinkAt - c.tick > REPLAN_TICKS) return false;
  c.due = true;
  if (!travel(c, { op: "townPortal" })) return false;
  setPlan(c, "toTown", "retreat");
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
    let ok = false;
    if (l.kind === "gold") ok = c.cfg.pickupGold;
    else if (l.kind === "potion") ok = c.cfg.pickupPotions && beltHasRoom(c, l.potion);
    else if (l.item) {
      const base = c.reg.get<ItemBaseProto>(KIND.itemBase, l.item.base);
      ok =
        rarityRank(l.item.rarity) >= pickRank && bagFits(c, base?.size.w ?? 1, base?.size.h ?? 1);
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
  pushCommand(c.world, { op: "pickup", target: e });
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

function equipStep(c: AutoCtx): void {
  if (!c.cfg.autoEquip) return;
  const eq = pickEquip(c);
  if (eq) pushCommand(c.world, { op: "equip", uid: eq.uid, slot: eq.slot });
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

/** Why a voluntary town trip is due now ("" = none). */
export function townTripReason(c: AutoCtx): "" | "bag full" | "quest" | "restock" {
  if (c.depth === 0 || c.tick < c.st.tripAt || stalled(c)) return "";
  if (!bagFits(c, 2, 3) && townFreesBag(c)) return "bag full";
  if (questTurnInWaiting(c) || questAcceptWaiting(c)) return "quest";
  const gold = c.world.get(c.hero, Wallet)?.gold ?? 0;
  if (beltCount(c, "life") === 0 && gold >= restockPrice(c)) return "restock";
  return "";
}

function toTownStep(c: AutoCtx): boolean {
  const note = townTripReason(c);
  if (note === "") return false;
  if ((c.world.get(c.hero, Supplies)?.tpScrolls ?? 0) > 0) {
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
  } else if (dungeonStep(c)) return;
  setPlan(c, "none", "idle");
  stopIntent(c);
}

export function think(world: World, ctx: SimContext, hero: Entity): void {
  const c = makeAutoCtx(world, ctx, hero);
  thinkTick(c);
  syncLeave(c);
}

function thinkTick(c: AutoCtx): void {
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
  if (world.has(hero, Casting) || world.has(hero, Dash) || isStunned(c)) {
    // Acting (or unable to act) is not being stuck.
    st.stuck = 0;
    st.lastTileX = c.tx;
    st.lastTileY = c.ty;
    return;
  }
  trackStuck(c);
  if (retreatStep(c)) return;
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
  const e = c.st.focus;
  if (e === 0 || !inReach(c, e)) return;
  const kind = c.world.get(e, Interactable)?.kind;
  if (c.st.plan === "descend" && (kind === "stairsDown" || kind === "stairsUp"))
    travel(c, { op: "stairs", target: e });
  else if (c.st.plan === "toTown" && kind === "waypoint") travel(c, { op: "waypoint", depth: 0 });
}

export const thinkSystem: SystemDef = {
  ...SYSTEM.autoThink,
  run(world, ctx) {
    if (!autoActive(world, ctx.tick)) return;
    const hero = heroOf(world);
    if (hero === 0 || !world.has(hero, Pos) || !world.has(hero, Intent)) return;
    think(world, ctx, hero);
  },
};
