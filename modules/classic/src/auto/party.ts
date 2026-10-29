/**
 * Party helpers of the auto controller (docs/design/party.md §6), shared by
 * the leader brain (think.ts, SYSTEM.autoThink) and the follower brain
 * (follow.ts, SYSTEM.autoParty). Nothing here runs for a party of one: every
 * caller checks AutoCtx.party (or isParty) first, so the solo game stays
 * bit-identical.
 *
 * - AutoMate: per-member party memory (formation goal, leash, waits),
 *   created lazily on party members only and reset on every area change.
 * - Revives: one deterministic reviver per downed member (reviverFor), the
 *   walk + `revive` op (reviveStep), the safety check (foeNear).
 * - Formation: the walkable spot of a follower around the acting leader
 *   (formationSpot, rules.formationOffsets).
 * - Party needs: the town trip and retreat reasons of every member.
 */
import { defineComponent, type Entity, type World } from "@gamez/kernel";
import { Ai, Dead, Faction, Life, Mana, Mover, Pos, Reviving } from "../components.ts";
import { leaderMode, aliveMembers, actingLeaderOf, partyMembers, roleOf } from "../party/shared.ts";
import { DEFAULT_PARTY_CONFIG, heroOf, partyStateOf, RES, type AreaState } from "../resources.ts";
import { formationOffsets, partyProtoOf } from "../rules.ts";
import { gridOf } from "../spatial.ts";
import type { TilePos } from "../fixed.ts";
import { lineOfSight, walkableAt, type ClassicMap } from "../world/maps.ts";
import { barSkills } from "./fight.ts";
import { walkTo, tileDist } from "./route.ts";
import {
  beltCount,
  d2To,
  lifePct,
  makeAutoCtx,
  moveTo,
  pushCmd,
  setIntent,
  setPlan,
  stopIntent,
  type AutoCtx,
  type ValueOf,
} from "./util.ts";

const TILE = 256;

/**
 * Party memory of one member (owner classic.auto; party members only,
 * created lazily, reset when the area changes: `area` = AreaState.enteredAt
 * it belongs to).
 */
export const AutoMate = defineComponent<{
  area: number;
  /** Follower: last formation goal (tile) and the leader tile it was computed from. */
  spotX: number;
  spotY: number;
  leadX: number;
  leadY: number;
  /** Follower: tick of the last follow order (repath throttle). */
  moveAt: number;
  /** Follower leash: tile it last stood on, since when; since when it is far from the leader (-1 = not far). */
  stillX: number;
  stillY: number;
  stillAt: number;
  farSince: number;
  /** Next tick a regroup / revive op may be pushed (retry throttles). */
  regroupAt: number;
  reviveAt: number;
  /** Leader: dungeon wait for stragglers (since when, -1 = none) and the next tick it may wait again. */
  gatherFrom: number;
  gatherNext: number;
  /** Leader: town "return" step waiting for the followers since (-1 = not yet). */
  returnFrom: number;
}>("classic.autoMate");
export type AutoMateValue = ValueOf<typeof AutoMate>;

/** The member's AutoMate (created, or reset after an area change). Party only. */
export function mateOf(c: AutoCtx): AutoMateValue {
  const area = c.world.getResource<AreaState>(RES.area)?.enteredAt ?? 0;
  const cur = c.world.get(c.hero, AutoMate);
  if (cur && cur.area === area) return c.world.read(c.hero, AutoMate);
  const v = {
    area,
    spotX: -1,
    spotY: -1,
    leadX: -1,
    leadY: -1,
    moveAt: -1_000_000,
    stillX: c.tx,
    stillY: c.ty,
    stillAt: c.tick,
    farSince: -1,
    regroupAt: 0,
    reviveAt: 0,
    gatherFrom: -1,
    gatherNext: 0,
    returnFrom: -1,
  };
  c.world.add(c.hero, AutoMate, v);
  return c.world.read(c.hero, AutoMate);
}

/** The context of another member (its own AutoState, position and class). */
export function memberCtx(c: AutoCtx, e: Entity): AutoCtx {
  return makeAutoCtx(c.world, c.ctx, e);
}

/** Party AI options (DEFAULT_PARTY_CONFIG without a party resource). */
export function partyConfigOf(world: World) {
  return partyStateOf(world)?.config ?? DEFAULT_PARTY_CONFIG;
}

/** Distance (sub) between two entities with Pos (MAX_SAFE_INTEGER when one has none). */
export function distBetween(world: World, a: Entity, b: Entity): number {
  const pa = world.get(a, Pos);
  const pb = world.get(b, Pos);
  if (!pa || !pb) return Number.MAX_SAFE_INTEGER;
  return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
}

/** Squared distance (sub) from the context's hero to `e`. */
export function d2Of(c: AutoCtx, e: Entity): number {
  const p = c.world.get(e, Pos);
  if (!p) return Number.MAX_SAFE_INTEGER;
  const dx = p.x - c.hx;
  const dy = p.y - c.hy;
  return dx * dx + dy * dy;
}

/** Life % of any unit (100 without Life). */
export function lifePctOf(world: World, e: Entity): number {
  const l = world.get(e, Life);
  if (!l || l.max <= 0) return 100;
  return Math.floor((l.hp * 100) / l.max);
}

/** Downed members (slot order). */
export function downedMembers(world: World): Entity[] {
  return partyMembers(world).filter((e) => world.has(e, Dead));
}

/**
 * True when an awake, living monster-team unit stands within `range` (sub)
 * of (x, y). Spatial grid query (no allocation beyond the grid's result).
 */
export function foeNear(world: World, x: number, y: number, range: number): boolean {
  for (const e of gridOf(world).query(x, y, range)) {
    if (world.get(e, Faction)?.team !== "monster" || world.has(e, Dead)) continue;
    if ((world.get(e, Life)?.hp ?? 1) <= 0) continue;
    if (world.get(e, Ai)?.state === "sleep") continue;
    const p = world.get(e, Pos);
    if (!p) continue;
    const dx = p.x - x;
    const dy = p.y - y;
    if (dx * dx + dy * dy <= range * range) return true;
  }
  return false;
}

/** No awake foe this close (sub, 6 tiles) to a downed member: a revive may start. */
export const REVIVE_SAFE_RANGE = 6 * TILE;
/** A revive op is pushed this far (sub) inside PartyProto.reviveRange. */
const REVIVE_MARGIN = 96;
/** Revive ops are re-sent at most this often (a refused one emits command.failed). */
const REVIVE_RETRY_TICKS = 10;

/** True when the AI drives `e` this tick (followers always; the controlled hero only when the leader brain runs). */
function aiDriven(world: World, e: Entity, tick: number): boolean {
  if (e !== heroOf(world)) return true;
  return leaderMode(world, tick) !== "off";
}

/**
 * The one member that revives `target` (docs/design/party.md §6.2 step 5):
 * the standing, AI-driven member nearest to it (ties: slot order) that is
 * not channelling another revive. 0 when none can.
 */
export function reviverFor(world: World, target: Entity, tick: number): Entity {
  const tp = world.get(target, Pos);
  if (!tp) return 0;
  let best = 0;
  let bestD = Number.MAX_SAFE_INTEGER;
  for (const e of aliveMembers(world)) {
    if (!aiDriven(world, e, tick)) continue;
    const r = world.get(e, Reviving);
    if (r && r.target !== target) continue;
    const p = world.get(e, Pos);
    if (!p) continue;
    const dx = p.x - tp.x;
    const dy = p.y - tp.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** The downed member this hero is the designated reviver of (slot order), or 0. */
export function reviveTargetOf(c: AutoCtx): Entity {
  for (const d of downedMembers(c.world)) if (reviverFor(c.world, d, c.tick) === c.hero) return d;
  return 0;
}

/**
 * Walks to the downed `target` and pushes `revive` once within reach. False
 * when a foe is too close to it (fight first). The channel itself
 * (Reviving) is classic.party's: callers wait while it runs.
 */
export function reviveStep(c: AutoCtx, target: Entity): boolean {
  const p = c.world.get(target, Pos);
  if (!p) return false;
  if (foeNear(c.world, p.x, p.y, REVIVE_SAFE_RANGE)) return false;
  const reach = Math.max(64, partyProtoOf(c.reg).reviveRange - REVIVE_MARGIN);
  if (d2Of(c, target) <= reach * reach) {
    const m = mateOf(c);
    stopIntent(c);
    setPlan(c, "recover", "revive");
    if (c.tick >= m.reviveAt) {
      m.reviveAt = c.tick + REVIVE_RETRY_TICKS;
      pushCmd(c, { op: "revive", target });
    }
    return true;
  }
  const tx = p.x >> 8;
  const ty = p.y >> 8;
  const same = c.st.plan === "recover" && c.st.focus === target;
  c.st.focus = target;
  setPlan(c, "recover", "revive");
  walkTo(c, tx, ty, () => moveTo(c, tx, ty), same);
  return true;
}

/** Allies below this life % get an ally heal (Mend with allyRadius). */
export const HEAL_ALLY_PCT = 50;
/**
 * Heals an ally (docs/design/party.md §6.5): with a ready heal skill that
 * has allyRadius (Mend) and the mana for it, the standing member (other than
 * itself) with the lowest life below HEAL_ALLY_PCT gets healed: cast when
 * within the radius, else walk toward it. True when it acted.
 */
export function healAllyStep(c: AutoCtx): boolean {
  // The cheap part first: an ally in need (most ticks there is none).
  let ally = 0;
  let allyPct = HEAL_ALLY_PCT;
  for (const e of aliveMembers(c.world)) {
    if (e === c.hero) continue;
    const p = lifePctOf(c.world, e);
    if (p < allyPct) {
      allyPct = p;
      ally = e;
    }
  }
  if (ally === 0) return false;
  let heal: { id: string; radius: number; cost: number } | null = null;
  for (const o of barSkills(c)) {
    const r = o.proto.heal?.allyRadius ?? 0;
    if (r <= 0 || !o.ready) continue;
    heal = { id: o.id, radius: r, cost: o.cost };
    break;
  }
  if (!heal) return false;
  if ((c.world.get(c.hero, Mana)?.mp ?? 0) < heal.cost) return false;
  const ap = c.world.read(ally, Pos);
  // Stay a little inside the radius.
  const reach = Math.max(TILE, heal.radius - TILE / 2);
  if (d2To(c, ap.x, ap.y) <= reach * reach) {
    setPlan(c, "fight", "heal ally");
    setIntent(c, { kind: "skill", skill: heal.id, target: 0, x: c.hx, y: c.hy, repeat: false });
    return true;
  }
  setPlan(c, "recover", "heal ally");
  moveTo(c, ap.x >> 8, ap.y >> 8);
  return true;
}

// ---------------------------------------------------------------------------
// Formation
// ---------------------------------------------------------------------------

/** Rings searched around a formation spot for a walkable tile the leader can see. */
const SPOT_SEARCH = 3;

/**
 * The nearest walkable tile to (x, y) (rings 0..SPOT_SEARCH, fixed order)
 * with line of sight from (lx, ly), else the leader's tile.
 */
export function walkableSpot(
  map: ClassicMap,
  x: number,
  y: number,
  lx: number,
  ly: number,
): TilePos {
  const sees = (tx: number, ty: number): boolean =>
    walkableAt(map, tx, ty) &&
    lineOfSight(map, (lx << 8) + 128, (ly << 8) + 128, (tx << 8) + 128, (ty << 8) + 128);
  if (sees(x, y)) return { x, y };
  for (let r = 1; r <= SPOT_SEARCH; r++) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (sees(x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
  }
  return { x: lx, y: ly };
}

/**
 * The formation spot (tile) of the context's hero around `leader`:
 * formationOffsets(config.formation, config.spread, leader facing, roles of
 * the standing followers in slot order), then walkableSpot.
 */
export function formationSpot(c: AutoCtx, leader: Entity): TilePos {
  const lp = c.world.read(leader, Pos);
  const lx = lp.x >> 8;
  const ly = lp.y >> 8;
  // Same follower list as the transitions and regroup (world/party.ts): every member but the leader.
  const followers = partyMembers(c.world).filter((e) => e !== leader);
  const i = followers.indexOf(c.hero);
  if (i < 0) return { x: lx, y: ly };
  const cfg = partyConfigOf(c.world);
  const roles = followers.map((e) => roleOf(c.world, c.reg, e));
  const facing = c.world.get(leader, Mover)?.facing ?? "s";
  const off = formationOffsets(cfg.formation, cfg.spread, facing, roles)[i] ?? { dx: 0, dy: 0 };
  return walkableSpot(c.map, lx + off.dx, ly + off.dy, lx, ly);
}

// ---------------------------------------------------------------------------
// Party needs (leader brain)
// ---------------------------------------------------------------------------

/** Standing members other than the context's hero, as contexts (slot order). */
export function otherMemberCtxs(c: AutoCtx): AutoCtx[] {
  return aliveMembers(c.world)
    .filter((e) => e !== c.hero && c.world.has(e, Pos))
    .map((e) => memberCtx(c, e));
}

/**
 * Party retreat (docs/design/party.md §6.1): two or more standing members
 * below retreatPct with no life potion left.
 */
export function partyInDanger(c: AutoCtx): boolean {
  let n = 0;
  for (const e of aliveMembers(c.world)) {
    // Life first (cheap); the belt only for members below the retreat line.
    if (lifePctOf(c.world, e) >= c.cfg.retreatPct) continue;
    const m = e === c.hero ? c : memberCtx(c, e);
    if (lifePct(m) < c.cfg.retreatPct && beltCount(m, "life") === 0) n++;
  }
  return n >= 2;
}

/** The acting leader of the party (shared helper re-export for the brains). */
export function leaderOf(world: World): Entity {
  return actingLeaderOf(world);
}

/** Chebyshev tile distance from the context's hero to entity `e` (MAX for no Pos). */
export function tilesTo(c: AutoCtx, e: Entity): number {
  const p = c.world.get(e, Pos);
  if (!p) return Number.MAX_SAFE_INTEGER;
  return tileDist(c.tx, c.ty, p.x >> 8, p.y >> 8);
}
