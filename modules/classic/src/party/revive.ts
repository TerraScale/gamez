/**
 * Reviving downed members (docs/design/party.md §4.2, §7.3). A living member
 * channels Reviving on a downed one for PartyProto.reviveTicks. The channel is
 * cancelled when the reviver moves, casts, takes a hit, dies, or the target
 * stops being downed or leaves range. A finished channel brings the target
 * back at reviveLifePct. Downed members also come back at full life in town
 * when the party is not wiped. The partyRevive system (post 610) also emits
 * classic.party.downed / wiped on the tick of a death.
 *
 * Reviving holds no life value, so the reviver's life at its last check is
 * kept in the resource REVIVE_HP (a list of { by, hp }). A drop means a hit
 * landed. The resource exists only while a channel runs, so solo worlds never
 * have it.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { ERR, fail, OK, type OpResult } from "../actions.ts";
import {
  Casting,
  Dead,
  Hero,
  Intent,
  Life,
  Mana,
  Mover,
  Pos,
  Reviving,
  Statuses,
} from "../components.ts";
import { emit } from "../events.ts";
import { pct, tileCenter, within } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { healFull } from "../progression/level.ts";
import { replace } from "../progression/util.ts";
import { currentDepth } from "../resources.ts";
import { partyProtoOf } from "../rules.ts";
import { getMap } from "../world/maps.ts";
import { freeTileNear } from "./recruit.ts";
import { actingLeaderOf, isPartyHero, partyMembers, partySize, partyWiped } from "./shared.ts";

/** Resource key of the reviver life snapshots (see the file header). */
export const REVIVE_HP = "classic.party.reviveHp";

interface ReviveHp {
  by: Entity;
  hp: number;
}

function hpList(world: World): ReviveHp[] {
  return world.getResource<ReviveHp[]>(REVIVE_HP) ?? [];
}

function setHp(world: World, by: Entity, hp: number): void {
  const list = hpList(world).filter((x) => x.by !== by);
  list.push({ by, hp });
  list.sort((a, b) => a.by - b.by);
  world.setResource(REVIVE_HP, list);
}

function clearHp(world: World, by: Entity): void {
  const list = hpList(world).filter((x) => x.by !== by);
  if (list.length === 0) world.deleteResource(REVIVE_HP);
  else world.setResource(REVIVE_HP, list);
}

/** Ends the channel of `reviver` (if any) and reports it. */
function cancelChannel(world: World, ctx: SimContext, reviver: Entity): void {
  const r = world.get(reviver, Reviving);
  if (!r) return;
  world.remove(reviver, Reviving);
  clearHp(world, reviver);
  if (world.exists(r.target)) {
    emit(ctx, { type: "classic.party.reviveCancelled", hero: r.target, by: reviver });
  }
}

/**
 * Ends every channel that involves `hero` (as reviver or as target). Used
 * when a member is dismissed (the entity is destroyed right after).
 */
export function cancelRevivesOf(world: World, ctx: SimContext, hero: Entity): void {
  for (const e of world.query(Reviving)) {
    if (e === hero) {
      world.remove(e, Reviving);
      clearHp(world, e);
    } else if (world.read(e, Reviving).target === hero) {
      cancelChannel(world, ctx, e);
    }
  }
}

/**
 * classic.party.revive op: `reviver` starts channelling on the downed member
 * `target`. Asking again for the same target keeps the original timer (the
 * interact command may be pushed every tick while the player holds it).
 */
export function execRevive(
  world: World,
  ctx: SimContext,
  reviver: Entity,
  target: Entity,
): OpResult {
  if (reviver === 0) return fail(ERR.noHero, "there is no hero yet");
  if (world.has(reviver, Dead)) return fail(ERR.dead, "the reviver is down");
  if (!isPartyHero(world, target) || target === reviver) {
    return fail(ERR.notMember, "not a party member");
  }
  if (!world.has(target, Dead)) return fail(ERR.notDowned, "that member is not down");
  const cur = world.get(reviver, Reviving);
  if (cur && cur.target === target) return OK;
  if (world.has(reviver, Casting)) return fail(ERR.busy, "casting a skill");
  const proto = partyProtoOf(ctx.registry);
  const rp = world.get(reviver, Pos);
  const tp = world.get(target, Pos);
  if (!rp || !tp || !within(rp.x, rp.y, tp.x, tp.y, proto.reviveRange)) {
    return fail(ERR.tooFar, "too far to revive");
  }
  const value = { target, startedAt: ctx.tick, until: ctx.tick + proto.reviveTicks };
  if (cur) world.update(reviver, Reviving, value);
  else world.add(reviver, Reviving, value);
  setHp(world, reviver, world.get(reviver, Life)?.hp ?? 0);
  emit(ctx, { type: "classic.party.reviving", hero: target, by: reviver, until: value.until });
  return OK;
}

/**
 * Brings a downed member back. `fullLife` (town): full life and mana.
 * Otherwise reviveLifePct of life and mana (a channel).
 */
function bringBack(
  world: World,
  ctx: SimContext,
  target: Entity,
  by: Entity,
  via: "ally" | "town",
  fullLife: boolean,
): void {
  world.remove(target, Dead);
  if (fullLife) {
    healFull(world, target);
  } else {
    const lifePct = partyProtoOf(ctx.registry).reviveLifePct;
    const life = world.get(target, Life);
    const mana = world.get(target, Mana);
    if (life) world.update(target, Life, { hp: Math.max(1, pct(life.max, lifePct)), acc: 0 });
    if (mana) world.update(target, Mana, { mp: pct(mana.max, lifePct), acc: 0 });
  }
  if (world.has(target, Statuses)) world.update(target, Statuses, { list: [] });
  const cur = world.get(target, Intent);
  replace(world, target, Intent, { kind: "idle", source: cur?.source ?? "manual", at: ctx.tick });
  emit(ctx, { type: "classic.party.revived", hero: target, by, via });
}

/** A finished channel: the target comes back and the other channels on it stop. */
function complete(world: World, ctx: SimContext, reviver: Entity, target: Entity): void {
  world.remove(reviver, Reviving);
  clearHp(world, reviver);
  for (const e of world.query(Reviving)) {
    if (world.read(e, Reviving).target === target) cancelChannel(world, ctx, e);
  }
  bringBack(world, ctx, target, reviver, "ally", false);
}

/** True when the channel must stop this tick. */
function mustCancel(world: World, ctx: SimContext, reviver: Entity, target: Entity): boolean {
  if (world.has(reviver, Dead)) return true;
  if (world.has(reviver, Casting)) return true;
  if (world.get(reviver, Mover)?.moving) return true;
  if (!world.exists(target) || !world.has(target, Dead)) return true;
  if (!isPartyHero(world, target)) return true;
  const rp = world.get(reviver, Pos);
  const tp = world.get(target, Pos);
  if (!rp || !tp) return true;
  if (!within(rp.x, rp.y, tp.x, tp.y, partyProtoOf(ctx.registry).reviveRange)) return true;
  const snap = hpList(world).find((x) => x.by === reviver);
  const hp = world.get(reviver, Life)?.hp;
  return snap !== undefined && hp !== undefined && hp < snap.hp;
}

/**
 * Downed members, in town and not wiped, come back at full life next to the
 * acting leader (slot order, free tiles around the leader).
 */
function townRevive(world: World, ctx: SimContext, members: Entity[]): void {
  if (currentDepth(world) !== 0 || partyWiped(world)) return;
  const downed = members.filter((e) => world.has(e, Dead));
  if (downed.length === 0) return;
  const leader = actingLeaderOf(world);
  const lp = world.get(leader, Pos);
  if (leader === 0 || !lp) return;
  const map = getMap(world, ctx.registry, 0);
  for (const e of downed) {
    const spot = freeTileNear(world, map, 0, lp.x >> 8, lp.y >> 8, e);
    if (spot && world.has(e, Pos)) {
      world.update(e, Pos, { x: tileCenter(spot.x), y: tileCenter(spot.y) });
    }
    if (world.has(e, Mover)) {
      world.update(e, Mover, { path: [], goalX: -1, goalY: -1, moving: false });
    }
    bringBack(world, ctx, e, 0, "town", true);
  }
}

/** Downed events of this tick: `wiped` once when every member is down, else `downed` per member. */
function deathEvents(world: World, ctx: SimContext, members: Entity[]): void {
  const newly = members.filter((e) => world.get(e, Dead)?.at === ctx.tick);
  if (newly.length === 0) return;
  if (partyWiped(world)) {
    emit(ctx, { type: "classic.party.wiped" });
    return;
  }
  for (const e of newly) {
    emit(ctx, { type: "classic.party.downed", hero: e, name: world.get(e, Hero)?.name ?? "" });
  }
}

/** classic.party.revive (post 610): death events, channels, town revive. */
export const partyRevive: SystemDef = {
  ...SYSTEM.partyRevive,
  run(world, ctx) {
    if (partySize(world) < 2) return;
    const members = partyMembers(world);
    deathEvents(world, ctx, members);
    for (const reviver of members) {
      const r = world.get(reviver, Reviving);
      if (!r) continue;
      if (mustCancel(world, ctx, reviver, r.target)) {
        cancelChannel(world, ctx, reviver);
        continue;
      }
      setHp(world, reviver, world.read(reviver, Life).hp);
      if (ctx.tick >= r.until) complete(world, ctx, reviver, r.target);
    }
    townRevive(world, ctx, members);
  },
};
