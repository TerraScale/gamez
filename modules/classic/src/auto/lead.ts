/**
 * Party rules of the LEADER brain (docs/design/party.md §6.1), used by
 * think.ts and town.ts only when AutoCtx.party is set (a party of two or
 * more), so the solo controller is unchanged:
 *
 * - downedStep: never go on while a member is downed. Its designated
 *   reviver (party.ts reviverFor) revives it; the leader stays close. After
 *   REVIVE_GIVEUP_TICKS without a revive (at once with PartyConfig.revive
 *   off) the party goes to town, which revives every downed member.
 * - reviveRetreat: the same give-up in the middle of a fight (downedStep
 *   only runs once the fight is over): with a town portal scroll the party
 *   leaves for town.
 * - gatherWait: in a dungeon, a short bounded wait while a follower lags
 *   more than GATHER_TILES behind (then a cooldown).
 * - partyReturnWait: the town "return" step waits until every standing
 *   follower finished its own errands and stands within RETURN_GATHER_TILES,
 *   for at most RETURN_WAIT_TICKS.
 *
 * Every wait is bounded, so the leader can never deadlock on its followers.
 */
import type { Entity } from "@gamez/kernel";
import { AutoState, Dead, Pos } from "../components.ts";
import { aliveMembers } from "../party/shared.ts";
import { RES, type AreaState } from "../resources.ts";
import { isRiftDepth } from "../rules.ts";
import { travel } from "./dungeon.ts";
import {
  AutoMate,
  downedMembers,
  mateOf,
  partyConfigOf,
  reviveStep,
  reviveTargetOf,
  tilesTo,
} from "./party.ts";
import { walkTo } from "./route.ts";
import {
  inReach,
  leaving,
  moveTo,
  nearestInteractable,
  purseScrolls,
  REPLAN_TICKS,
  setIntent,
  setPlan,
  stopIntent,
  type AutoCtx,
} from "./util.ts";

/** A downed member not revived within this long (20 s) sends the party to town. */
export const REVIVE_GIVEUP_TICKS = 400;
/** The leader stays within this many tiles of a downed member someone else revives. */
export const REVIVE_STAY_TILES = 3;
/** Town: the leader waits at most this long (30 s) for the followers' errands. */
export const RETURN_WAIT_TICKS = 600;
/** Town: followers this close (tiles; at least 2 x spread + 2, their formation spots) count as gathered. */
export const RETURN_GATHER_TILES = 4;
/** Dungeon: a follower farther than this (tiles) makes the leader wait... */
export const GATHER_TILES = 8;
/** ...for at most this long, then not again for GATHER_COOLDOWN_TICKS. */
export const GATHER_WAIT_TICKS = 100;
export const GATHER_COOLDOWN_TICKS = 300;

/** True when a member is downed (party only). */
export function anyDowned(c: AutoCtx): boolean {
  return c.party && downedMembers(c.world).length > 0;
}

/** Tick the longest-downed member went down (c.tick when nobody is down). */
function downedSince(c: AutoCtx, downed: readonly Entity[]): number {
  let oldest = c.tick;
  for (const e of downed) oldest = Math.min(oldest, c.world.read(e, Dead).at);
  return oldest;
}

/**
 * Mid-fight revive give-up (leader, "full" mode): a member has been down
 * for REVIVE_GIVEUP_TICKS while the fight goes on (nobody can revive with
 * foes near), so the party portals to town, which revives every downed
 * member. Needs a scroll and no rift, like the other retreats; without one
 * the fight goes on and downedStep takes over when it ends. True when the
 * town portal went out.
 */
export function reviveRetreat(c: AutoCtx): boolean {
  if (!c.party || c.depth === 0 || isRiftDepth(c.depth) || purseScrolls(c) <= 0) return false;
  if (c.st.plan === "toTown") return false;
  // A travel command went out less than REPLAN_TICKS ago.
  if (c.st.thinkAt - c.tick > REPLAN_TICKS) return false;
  const downed = downedMembers(c.world);
  if (downed.length === 0 || c.tick - downedSince(c, downed) < REVIVE_GIVEUP_TICKS) return false;
  c.due = true;
  if (!travel(c, { op: "townPortal" })) return false;
  setPlan(c, "toTown", "revive in town");
  return true;
}

/** To town to revive the downed: a scroll, else this level's waypoint. False when neither works. */
function townForRevive(c: AutoCtx): boolean {
  if (isRiftDepth(c.depth)) return false;
  if (purseScrolls(c) > 0) {
    if (travel(c, { op: "townPortal" })) setPlan(c, "toTown", "revive in town");
    return true;
  }
  const wp = nearestInteractable(c, "waypoint");
  if (wp === 0) return false;
  const same = c.st.focus === wp && c.st.plan === "toTown";
  c.st.focus = wp;
  setPlan(c, "toTown", "revive in town (waypoint)");
  if (inReach(c, wp)) travel(c, { op: "waypoint", depth: 0 });
  else {
    const p = c.world.read(wp, Pos);
    walkTo(c, p.x >> 8, p.y >> 8, () => setIntent(c, { kind: "interact", target: wp }), same);
  }
  return true;
}

/**
 * A member is downed in a dungeon: revive it (when this hero is its
 * reviver), else stay close to it; after REVIVE_GIVEUP_TICKS go to town
 * (`allowTown`: not in "defend" mode). True when it acted (nothing else
 * runs: no exploring, no stairs).
 */
export function downedStep(c: AutoCtx, allowTown: boolean): boolean {
  if (!c.party || c.depth === 0) return false;
  const downed = downedMembers(c.world);
  if (downed.length === 0) return false;
  const oldest = downedSince(c, downed);
  // PartyConfig.revive off: nobody revives in the field, the downed recover in town.
  const revive = partyConfigOf(c.world).revive;
  const giveUp = !revive || c.tick - oldest >= REVIVE_GIVEUP_TICKS;
  if (allowTown && giveUp && townForRevive(c)) return true;
  const target = revive ? reviveTargetOf(c) : 0;
  if (target !== 0 && reviveStep(c, target)) return true;
  // Someone else revives (or a foe is near it): stay close to the first downed member.
  const d = downed[0]!;
  const p = c.world.read(d, Pos);
  if (tilesTo(c, d) > REVIVE_STAY_TILES) {
    setPlan(c, "recover", "stay with the downed");
    moveTo(c, p.x >> 8, p.y >> 8);
  } else {
    setPlan(c, "none", "waiting for a revive");
    stopIntent(c);
  }
  return true;
}

/**
 * Dungeon: waits (bounded) while a standing follower is more than
 * GATHER_TILES away. Not while leaving the level (the transition takes the
 * whole party along). True while waiting.
 */
export function gatherWait(c: AutoCtx): boolean {
  if (!c.party || c.depth === 0 || leaving(c)) return false;
  const m = mateOf(c);
  if (c.tick < m.gatherNext) return false;
  const far = aliveMembers(c.world).some((e) => e !== c.hero && tilesTo(c, e) > GATHER_TILES);
  if (!far) {
    m.gatherFrom = -1;
    return false;
  }
  if (m.gatherFrom < 0) m.gatherFrom = c.tick;
  if (c.tick - m.gatherFrom >= GATHER_WAIT_TICKS) {
    m.gatherFrom = -1;
    m.gatherNext = c.tick + GATHER_COOLDOWN_TICKS;
    return false;
  }
  setPlan(c, "none", "waiting for the party");
  stopIntent(c);
  return true;
}

/**
 * Town "return" step (party): true while the leader still waits for a
 * standing follower that has errands left, has not run in this area yet, or
 * stands farther than RETURN_GATHER_TILES. At most RETURN_WAIT_TICKS.
 */
export function partyReturnWait(c: AutoCtx): boolean {
  if (!c.party) return false;
  const area = c.world.getResource<AreaState>(RES.area)?.enteredAt ?? 0;
  // Formation spots lie up to 2 x spread tiles away (plus the walkable-tile search).
  const gather = Math.max(RETURN_GATHER_TILES, 2 * partyConfigOf(c.world).spread + 2);
  const ready = aliveMembers(c.world).every((e) => {
    if (e === c.hero) return true;
    const st = c.world.get(e, AutoState);
    const mate = c.world.get(e, AutoMate);
    if (!st || !mate || mate.area !== area) return false;
    return st.todo.length === 0 && tilesTo(c, e) <= gather;
  });
  if (ready) return false;
  const m = mateOf(c);
  if (m.returnFrom < 0) m.returnFrom = c.tick;
  if (c.tick - m.returnFrom >= RETURN_WAIT_TICKS) return false;
  setPlan(c, "town", "waiting for the party");
  stopIntent(c);
  return true;
}
