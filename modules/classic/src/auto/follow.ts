/**
 * classic.auto.party (pre 5, docs/design/party.md §6.2): the FOLLOWER brain.
 * It drives every standing party member other than the controlled hero (and
 * other than the acting leader while the leader brain drives it), in slot
 * order, in ANY control mode. A no-op without a party of two or more, so
 * the solo game never runs any of it.
 *
 * A full re-plan happens when (tick + slot) % FOLLOW_REPLAN_TICKS === 0
 * (staggered); the other ticks only react (potions, dodge, leash, heals,
 * the running fight, arrivals). Priority, first that applies wins:
 *
 *  1 potions + dodge telegraphs (per-hero thresholds from AutoConfig)
 *  2 leash: beyond leashTeleport, stuck 60 ticks or far for 200 ticks while
 *    more than 6 tiles away -> `regroup` op; beyond leashRange -> walk to the
 *    formation spot, nothing else
 *  3 town: the follower's own town routine (heal, sell, repair, buy, smith,
 *    craft, gamble, stash; never quests or travel), then gather
 *  4 heal an ally below 50 % with a heal that has allyRadius (Mend)
 *  5 fight foes in the assist radius (8 tiles of the leader, 5 of itself, or
 *    attacking a member): focus fire, then protect, then sticky, then nearest
 *  6 revive (PartyConfig.revive): the designated reviver of a downed member
 *  7 loot within 4 tiles (filter + pickupRarity), close to its spot
 *  8 equip (side action), then follow the formation spot
 *
 * Followers never travel and never open portals: the leader's transitions
 * move the whole party (invariant I2).
 */
import type { Entity, SystemDef, World } from "@gamez/kernel";
import { PICKUP_RANGE } from "../actions.ts";
import {
  Ai,
  AreaTag,
  AutoState,
  Casting,
  Dash,
  Dead,
  Intent,
  Loot,
  Pos,
  Reviving,
} from "../components.ts";
import { SYSTEM } from "../ids.ts";
import { lootVisible } from "../loot.ts";
import {
  actingLeaderOf,
  aliveMembers,
  isPartyHero,
  partyMembers,
  partyWiped,
} from "../party/shared.ts";
import { heroOf, lootFilterOf, partyStateOf, RES, type AreaState } from "../resources.ts";
import { partyProtoOf, rarityRank } from "../rules.ts";
import { KIND, type ItemBaseProto } from "../types.ts";
import { dodgeStep } from "./dodge.ts";
import { fightStep, foeOf, isStunned, pickTarget, scanFoes, type Foe } from "./fight.ts";
import { distributeGear } from "./gear.ts";
import {
  AutoMate,
  formationSpot,
  healAllyStep,
  lifePctOf,
  mateOf,
  partyConfigOf,
  reviveStep,
  reviveTargetOf,
  type AutoMateValue,
} from "./party.ts";
import { tileDist, walkTo } from "./route.ts";
import { equipStep, potionStep } from "./think.ts";
import { skipTownStep, townStep } from "./town.ts";
import {
  AutoLeave,
  bagFits,
  beltHasRoom,
  d2To,
  FIGHT_LINGER_TICKS,
  isIgnored,
  makeAutoCtx,
  moveTo,
  pushCmd,
  setIntent,
  setPlan,
  stopIntent,
  STUCK_TICKS,
  TOWN_STEPS,
  type AutoCtx,
} from "./util.ts";

const TILE = 256;

/** Full re-plan period of a follower (staggered by slot). */
export const FOLLOW_REPLAN_TICKS = 8;
/** Follow orders are re-sent at most this often unless the leader moved more than FOLLOW_LEAD_MOVED tiles. */
export const FOLLOW_REPATH_TICKS = 10;
export const FOLLOW_LEAD_MOVED = 2;
/** Assist radius (sub): foes this close to the acting leader... */
export const ASSIST_LEADER_RANGE = 8 * TILE;
/** ...or this close to the follower itself are fought. */
export const ASSIST_SELF_RANGE = 5 * TILE;
/** Protect: a foe attacking a member below this life % is preferred. */
export const PROTECT_PCT = 60;
/** Followers pick up loot within this many sub of themselves... */
export const FOLLOW_LOOT_RANGE = 4 * TILE;
/** ...and at most spread + this many tiles from their formation spot. */
export const FOLLOW_LOOT_SLACK = 3;
/** Leash: stuck this long while farther than LEASH_NEAR from the leader -> regroup. */
export const LEASH_STUCK_TICKS = 60;
export const LEASH_NEAR = 6 * TILE;
/** Leash: farther than LEASH_NEAR this long (outside town and fights) -> regroup. */
export const LEASH_FAR_TICKS = 200;
/** A regroup op is re-sent at most this often. */
export const REGROUP_RETRY_TICKS = 20;
/** Gear distribution runs every this many ticks (party only). */
export const GEAR_TICKS = 20;

/** Follower foe scan radius (sub) on re-plans: the assist rule never needs more. */
export const FOLLOW_SCAN_RANGE = 10 * TILE;
/** Between re-plans a fighting follower scans this close (sub), plus its focus. */
export const FOLLOW_NEAR_RANGE = 4 * TILE;

/** The close foes (FOLLOW_NEAR_RANGE) plus the current focus wherever it stands. */
function closeFoes(c: AutoCtx): Foe[] {
  const out = scanFoes(c, FOLLOW_NEAR_RANGE);
  const f = c.st.focus;
  if (f !== 0 && !out.some((x) => x.e === f)) {
    const foe = foeOf(c, f);
    if (foe && foe.dist <= FOLLOW_SCAN_RANGE) out.push(foe);
  }
  return out;
}

/** Town steps of a follower: its own errands; quests and the way out are the leader's. */
export const FOLLOWER_TOWN_STEPS: readonly string[] = TOWN_STEPS.filter(
  (s) => s !== "quests" && s !== "return",
);

/** Chebyshev distance (sub) from the context's hero to (x, y). */
function chebTo(c: AutoCtx, x: number, y: number): number {
  return Math.max(Math.abs(x - c.hx), Math.abs(y - c.hy));
}

/** The acting leader's current target: the target of its skill intent (auto or manual), or 0. */
function leaderTarget(world: World, leader: Entity): Entity {
  const intent = world.get(leader, Intent);
  if (intent && intent.kind === "skill" && intent.target !== 0) return intent.target;
  return 0;
}

/** True while the leader fights: a skill intent, or its leader brain saw a foe in the last few ticks. */
function leaderFighting(world: World, leader: Entity, tick: number): boolean {
  if (world.get(leader, Intent)?.kind === "skill") return true;
  const st = world.get(leader, AutoState);
  return st !== undefined && st.plan === "fight" && tick - st.foeAt < FIGHT_LINGER_TICKS;
}

/** True while the follower's auto skill intent targets its living focus (an attack in progress). */
function attacking(c: AutoCtx): boolean {
  const f = c.st.focus;
  if (f === 0 || !c.world.exists(f) || c.world.has(f, Dead)) return false;
  const cur = c.world.get(c.hero, Intent);
  return cur !== undefined && cur.kind === "skill" && cur.source === "auto" && cur.target === f;
}

/** True when foe `e` is striking or charging a party member right now. */
function attackingMember(world: World, e: Entity): boolean {
  const ai = world.get(e, Ai);
  if (!ai || ai.target === 0) return false;
  if (ai.state !== "attack" && ai.state !== "charge") return false;
  return isPartyHero(world, ai.target);
}

/**
 * The foes this follower engages (docs/design/party.md §6.2 step 4): within
 * ASSIST_LEADER_RANGE of the acting leader, within ASSIST_SELF_RANGE of
 * itself, or attacking a member. Keeps the order of `foes`.
 */
export function assistFoes(c: AutoCtx, foes: readonly Foe[], leader: Entity): Foe[] {
  const lp = c.world.get(leader, Pos);
  const r2 = ASSIST_LEADER_RANGE * ASSIST_LEADER_RANGE;
  return foes.filter((f) => {
    if (f.dist <= ASSIST_SELF_RANGE) return true;
    if (lp) {
      const dx = f.x - lp.x;
      const dy = f.y - lp.y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return attackingMember(c.world, f.e);
  });
}

/**
 * Target choice (docs/design/party.md §6.4): the leader's target (focus
 * fire), else the foe attacking the weakest member below PROTECT_PCT, else
 * the current focus (sticky), else the best by targetScore.
 */
export function chooseFollowerTarget(c: AutoCtx, targets: readonly Foe[], leader: Entity): Foe {
  const cfg = partyConfigOf(c.world);
  if (cfg.focusFire) {
    const lt = leaderTarget(c.world, leader);
    const hit = lt !== 0 ? targets.find((f) => f.e === lt) : undefined;
    if (hit) return hit;
  }
  return pickFollowerTarget(c, targets);
}

/** Protect, sticky, then the best by targetScore (rules 2-4 of chooseFollowerTarget). */
function pickFollowerTarget(c: AutoCtx, targets: readonly Foe[]): Foe {
  // Protect: the weakest standing member below PROTECT_PCT.
  let weak = 0;
  let weakPct = PROTECT_PCT;
  for (const e of aliveMembers(c.world)) {
    const p = lifePctOf(c.world, e);
    if (p < weakPct) {
      weakPct = p;
      weak = e;
    }
  }
  if (weak !== 0) {
    let best: Foe | null = null;
    for (const f of targets) {
      if (c.world.get(f.e, Ai)?.target !== weak) continue;
      if (!best || f.dist < best.dist) best = f;
    }
    if (best) return best;
  }
  const sticky = c.st.focus !== 0 ? targets.find((f) => f.e === c.st.focus) : undefined;
  if (sticky) return sticky;
  return pickTarget(c, targets);
}

/** Loot within this distance (sub) is picked up directly with the pickup op. */
const PICK_REACH = PICKUP_RANGE - 32;

/** Nearest loot within FOLLOW_LOOT_RANGE that passes the filters and stays near the spot, or 0. */
function followerLoot(c: AutoCtx, spotX: number, spotY: number): Entity {
  const pickRank = rarityRank(c.cfg.pickupRarity);
  const filter = lootFilterOf(c.world);
  const slack = (partyConfigOf(c.world).spread + FOLLOW_LOOT_SLACK) * TILE;
  let best = 0;
  let bestD = FOLLOW_LOOT_RANGE * FOLLOW_LOOT_RANGE + 1;
  for (const e of c.world.query(Loot, Pos, AreaTag)) {
    if (c.world.read(e, AreaTag).depth !== c.depth) continue;
    const p = c.world.read(e, Pos);
    const d = d2To(c, p.x, p.y);
    if (d >= bestD) continue;
    if (spotX >= 0) {
      const sx = (spotX << 8) + 128;
      const sy = (spotY << 8) + 128;
      if (Math.max(Math.abs(p.x - sx), Math.abs(p.y - sy)) > slack) continue;
    }
    if (isIgnored(c.st, p.x >> 8, p.y >> 8)) continue;
    const l = c.world.read(e, Loot);
    if (!lootVisible(filter, c.reg, l)) continue;
    let ok = false;
    if (l.kind === "gold") ok = c.cfg.pickupGold;
    else if (l.kind === "potion") ok = c.cfg.pickupPotions && beltHasRoom(c, l.potion);
    else if (l.item) {
      const base = c.reg.get<ItemBaseProto>(KIND.itemBase, l.item.base);
      const wanted = base?.gem !== undefined || rarityRank(l.item.rarity) >= pickRank;
      ok = wanted && bagFits(c, base?.size.w ?? 1, base?.size.h ?? 1);
    }
    if (!ok) continue;
    best = e;
    bestD = d;
  }
  return best;
}

function lootStep(c: AutoCtx, m: AutoMateValue): boolean {
  const e = followerLoot(c, m.spotX, m.spotY);
  if (e === 0) return false;
  c.st.focus = e;
  const l = c.world.read(e, Loot);
  setPlan(c, "loot", l.item?.name ?? l.kind);
  const p = c.world.read(e, Pos);
  if (d2To(c, p.x, p.y) <= PICK_REACH * PICK_REACH) {
    pushCmd(c, { op: "pickup", target: e });
    stopIntent(c);
    // A refused pickup (full bag, belt) is not retried from this spot.
    c.st.ignore.push({ x: p.x >> 8, y: p.y >> 8 });
    while (c.st.ignore.length > 32) c.st.ignore.shift();
    return true;
  }
  setIntent(c, { kind: "pickup", target: e });
  return true;
}

/**
 * Walks to the formation spot when it is more than one tile away; re-sends
 * the order every FOLLOW_REPATH_TICKS or when the leader moved more than
 * FOLLOW_LEAD_MOVED tiles. `force`: the leash (always re-plan the spot).
 */
export function followStep(c: AutoCtx, leader: Entity, m: AutoMateValue, force = false): void {
  const lp = c.world.read(leader, Pos);
  const lx = lp.x >> 8;
  const ly = lp.y >> 8;
  const moved = m.leadX < 0 || tileDist(lx, ly, m.leadX, m.leadY) > FOLLOW_LEAD_MOVED;
  const stale = c.tick - m.moveAt >= FOLLOW_REPATH_TICKS;
  if (moved || stale || force || m.spotX < 0) {
    const spot = formationSpot(c, leader);
    m.spotX = spot.x;
    m.spotY = spot.y;
  }
  if (tileDist(c.tx, c.ty, m.spotX, m.spotY) <= 1) {
    // In place: stand (an auto move toward the old spot would drift).
    setPlan(c, "none", "follow");
    const cur = c.world.get(c.hero, Intent);
    if (cur && cur.kind === "move" && cur.source === "auto") stopIntent(c);
    return;
  }
  if (!moved && !stale && !force) return;
  m.leadX = lx;
  m.leadY = ly;
  m.moveAt = c.tick;
  setPlan(c, "explore", "follow");
  const sx = m.spotX;
  const sy = m.spotY;
  walkTo(c, sx, sy, () => moveTo(c, sx, sy), false);
}

/**
 * Leash (step 2). True when it took over this tick (regroup pushed, or the
 * follower walks back beyond leashRange).
 */
function leashStep(c: AutoCtx, leader: Entity, m: AutoMateValue, fighting: boolean): boolean {
  const proto = partyProtoOf(c.reg);
  const lp = c.world.read(leader, Pos);
  const d = chebTo(c, lp.x, lp.y);
  const far = d > LEASH_NEAR;
  if (!far || fighting || c.depth === 0) m.farSince = -1;
  else if (m.farSince < 0) m.farSince = c.tick;
  const stuck = far && !fighting && c.tick - m.stillAt >= LEASH_STUCK_TICKS;
  const tooLong = m.farSince >= 0 && c.tick - m.farSince >= LEASH_FAR_TICKS;
  if (d > proto.leashTeleport || stuck || tooLong) {
    if (c.tick >= m.regroupAt) {
      m.regroupAt = c.tick + REGROUP_RETRY_TICKS;
      pushCmd(c, { op: "regroup" });
      m.stillAt = c.tick;
      m.farSince = -1;
      m.spotX = -1;
      stopIntent(c);
      setPlan(c, "recover", "regroup");
      return true;
    }
  }
  if (d > proto.leashRange) {
    followStep(c, leader, m, c.tick - m.moveAt >= FOLLOW_REPATH_TICKS);
    return true;
  }
  return false;
}

/** Fresh area for a follower: per-area memory and its own town errands. */
function onFollowerArea(c: AutoCtx): void {
  const st = c.st;
  st.ignore = [];
  st.frontierX = -1;
  st.frontierY = -1;
  st.focus = 0;
  st.stuck = 0;
  st.lastTileX = c.tx;
  st.lastTileY = c.ty;
  st.todo = c.depth === 0 ? [...FOLLOWER_TOWN_STEPS] : [];
  st.plan = "none";
}

/** Removes the leader-only town steps a former leader may still have queued. */
function followerTodo(c: AutoCtx): void {
  const todo = c.st.todo;
  if (todo.includes("return") || todo.includes("quests"))
    c.st.todo = todo.filter((s) => s !== "return" && s !== "quests");
}

/**
 * One follower's tick (`slot` staggers the full re-plan). `leader` is the
 * acting leader (standing, not this follower).
 */
export function followerTick(c: AutoCtx, leader: Entity, slot: number): void {
  const { world, st } = c;
  const area = world.getResource<AreaState>(RES.area)?.enteredAt ?? 0;
  const prev = world.get(c.hero, AutoMate);
  const m = mateOf(c);
  if (!prev || prev.area !== area) onFollowerArea(c);
  // A former leader: its travel commitment is not a follower's.
  if (world.has(c.hero, AutoLeave)) world.remove(c.hero, AutoLeave);
  followerTodo(c);
  const due = (c.tick + slot) % FOLLOW_REPLAN_TICKS === 0;
  c.due = due;
  // Stuck detection (leash, town errands): the tile it last stood on and since when.
  if (c.tx !== m.stillX || c.ty !== m.stillY) {
    m.stillX = c.tx;
    m.stillY = c.ty;
    m.stillAt = c.tick;
  }

  const fighting = st.plan === "fight";
  // Still executing an attack on a living focus: no rescan before the next re-plan.
  const engaged = fighting && !due && attacking(c);
  // Full scans on re-plans and when the leader starts a fight; between re-plans a fight only
  // looks at what is close (area counts, kiting) plus its focus.
  const wide =
    c.depth > 0 && (due || (!engaged && !fighting && leaderFighting(world, leader, c.tick)));
  const near = c.depth > 0 && !wide && !engaged && fighting;
  const foes = wide ? scanFoes(c, FOLLOW_SCAN_RANGE) : near ? closeFoes(c) : [];
  const scan = wide || near;
  potionStep(c, foes, foes.length > 0 || engaged);
  if (world.has(c.hero, Casting) || world.has(c.hero, Dash) || isStunned(c)) {
    m.stillAt = c.tick;
    return;
  }
  if (dodgeStep(c)) return;
  // Channelling a revive: classic.party cancels it on any move or cast.
  if (world.has(c.hero, Reviving)) {
    m.stillAt = c.tick;
    return;
  }
  // Town errands lead anywhere in town: no leash before they are done.
  if ((c.depth > 0 || st.todo.length === 0) && leashStep(c, leader, m, fighting)) return;

  if (c.depth === 0) {
    // Town: the follower's own errands (purse gold), then gather near the leader.
    if (st.todo.length > 0) {
      // Stuck on the way to an NPC: skip that errand (like the leader's trackStuck).
      if (c.tick - m.stillAt >= STUCK_TICKS) {
        m.stillAt = c.tick;
        skipTownStep(c);
      }
      if (townStep(c)) return;
    }
    if (due) equipStep(c);
    followStep(c, leader, m);
    return;
  }

  if (healAllyStep(c)) return;

  if (engaged) {
    st.foeAt = c.tick;
    return;
  }
  if (scan) {
    // Focus fire reaches past the assist radius: the leader's target anywhere in the scan.
    const lt = partyConfigOf(world).focusFire ? leaderTarget(world, leader) : 0;
    const focus = lt !== 0 ? foes.find((f) => f.e === lt) : undefined;
    const targets = focus ? [focus] : assistFoes(c, foes, leader);
    if (targets.length > 0) {
      st.foeAt = c.tick;
      const t = focus ?? chooseFollowerTarget(c, targets, leader);
      fightStep(c, foes, [t]);
      return;
    }
  }
  // Fight hysteresis (a foe that just left the scan often comes back at once).
  if (fighting && c.tick - st.foeAt < FIGHT_LINGER_TICKS) return;
  if (fighting) {
    st.focus = 0;
    setPlan(c, "none", "fight over");
  }

  if (partyConfigOf(world).revive) {
    const target = reviveTargetOf(c);
    if (target !== 0 && reviveStep(c, target)) return;
  }

  if (!due) {
    // Between re-plans: keep walking to the loot / spot already chosen.
    if (st.plan === "loot" && st.focus !== 0 && world.has(st.focus, Loot)) {
      const p = world.read(st.focus, Pos);
      if (d2To(c, p.x, p.y) <= PICK_REACH * PICK_REACH) {
        pushCmd(c, { op: "pickup", target: st.focus });
        stopIntent(c);
        st.focus = 0;
      }
      return;
    }
    followStep(c, leader, m);
    return;
  }
  if (foes.length === 0 && lootStep(c, m)) return;
  equipStep(c);
  followStep(c, leader, m);
}

/**
 * The follower system. Runs for every standing follower in slot order; the
 * acting leader is skipped while the leader brain drives it (leaderMode
 * "full" / "defend"). Gear distribution (gear.ts) runs once every
 * GEAR_TICKS for the whole party.
 */
export const partySystem: SystemDef = {
  ...SYSTEM.autoParty,
  run(world, ctx) {
    const party = partyStateOf(world);
    if (!party) return;
    const members = partyMembers(world);
    if (members.length <= 1 || partyWiped(world)) return;
    const hero = heroOf(world);
    const leader = actingLeaderOf(world);
    if (leader === 0 || !world.has(leader, Pos)) return;
    members.forEach((e, slot) => {
      // The controlled hero is the player's or the leader brain's; so is a standing acting leader.
      if (e === hero || e === leader || world.has(e, Dead)) return;
      if (!world.has(e, Pos) || !world.has(e, Intent)) return;
      followerTick(makeAutoCtx(world, ctx, e), leader, slot);
    });
    if (ctx.tick % GEAR_TICKS === GEAR_TICKS - 1) distributeGear(world, ctx);
  },
};
