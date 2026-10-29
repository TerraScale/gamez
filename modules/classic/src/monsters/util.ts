/**
 * Shared helpers of classic.monsters (owner: T4 monster builder). Pure
 * functions of the world, the registry and the tick. Cast orders and Mover
 * writes go through here so every system uses the same rules.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import {
  Body,
  CastOrder,
  Casting,
  Dash,
  Dead,
  Faction,
  Mover,
  Pos,
  SkillBook,
  Statuses,
  Summoned,
} from "../components.ts";
import { KIND, type SkillProto, type StatusProto } from "../types.ts";

/** Resource key of the aggro memory (last contact tick per engaged monster). */
export const AGGRO_KEY = "classic.monsters.aggro";
/** Ticks without contact after which an engaged monster gives up and returns home. */
export const LOSE_CONTACT_TICKS = 100;
/** Think throttle of monsters out of attack range: every N ticks, staggered by entity id. */
export const THINK_EVERY = 4;

/**
 * Party threat (docs/design/party.md §7.1): after a member's hit turns a
 * monster on it, the monster keeps that target at least this many ticks
 * (no other threat switch, no "3 tiles closer" switch).
 */
export const THREAT_HOLD = 40;

export interface AggroState {
  /** Last tick each engaged monster had contact, keyed by entity id (string). */
  last: Record<string, number>;
  /**
   * Party only (absent in solo games): tick until which a monster's threat
   * target is locked, keyed by entity id (string). Created by the first
   * threat switch of a party of 2+.
   */
  threat?: Record<string, number>;
}

/** The aggro memory of this world (created on first use when setup did not run). */
export function aggroOf(world: World): AggroState {
  const a = world.getResource<AggroState>(AGGRO_KEY);
  if (a !== undefined) return a;
  world.setResource<AggroState>(AGGRO_KEY, { last: {} });
  return world.getResource<AggroState>(AGGRO_KEY)!;
}

/**
 * Records a threat switch of `monster` at `tick` unless one is still locked.
 * Returns true when the caller may retarget the monster now.
 */
export function noteThreat(world: World, monster: Entity, tick: number): boolean {
  const aggro = aggroOf(world);
  const key = String(monster);
  const until = aggro.threat?.[key];
  if (until !== undefined && until > tick) return false;
  if (aggro.threat === undefined) aggro.threat = {};
  aggro.threat[key] = tick + THREAT_HOLD;
  return true;
}

/** True while `monster`'s threat target is locked (party only). Drops an expired lock. */
export function threatLocked(aggro: AggroState, monster: Entity, tick: number): boolean {
  const t = aggro.threat;
  if (t === undefined) return false;
  const key = String(monster);
  const until = t[key];
  if (until === undefined) return false;
  if (until > tick) return true;
  delete t[key];
  return false;
}

/** Forgets the aggro memory of a destroyed monster. */
export function forgetAggro(world: World, monster: Entity): void {
  const aggro = aggroOf(world);
  const key = String(monster);
  delete aggro.last[key];
  if (aggro.threat !== undefined && aggro.threat[key] !== undefined) delete aggro.threat[key];
}

export function skillOf(ctx: SimContext, id: string): Readonly<SkillProto> | undefined {
  if (id === "") return undefined;
  return ctx.registry.get<SkillProto>(KIND.skill, id);
}

/** A unit that can be targeted: exists, has a position and is not dead. */
export function isLive(world: World, e: Entity): boolean {
  return e !== 0 && world.exists(e) && world.has(e, Pos) && !world.has(e, Dead);
}

/** Live unit of the given team. */
export function isEnemyOf(world: World, e: Entity, team: string): boolean {
  if (!isLive(world, e)) return false;
  return world.get(e, Faction)?.team === team;
}

export function bodyRadius(world: World, e: Entity): number {
  return e === 0 ? 0 : (world.get(e, Body)?.radius ?? 0);
}

/** True when the skill's cooldown has passed (absent cooldown = ready). */
export function skillReady(world: World, e: Entity, skill: string, tick: number): boolean {
  const sb = world.get(e, SkillBook);
  if (!sb) return false;
  const cd = sb.cooldowns.find((c) => c.skill === skill);
  return cd === undefined || cd.readyAt <= tick;
}

/** A unit may receive a new cast order: not casting, dashing, dead or already ordered. */
export function canOrder(world: World, e: Entity): boolean {
  return (
    !world.has(e, Casting) && !world.has(e, CastOrder) && !world.has(e, Dash) && !world.has(e, Dead)
  );
}

export function orderCast(
  world: World,
  e: Entity,
  skill: string,
  target: Entity,
  x: number,
  y: number,
): void {
  const v = { skill, target, x, y };
  if (world.has(e, CastOrder)) world.update(e, CastOrder, v);
  else world.add(e, CastOrder, v);
}

export function isStunned(world: World, ctx: SimContext, e: Entity): boolean {
  const st = world.get(e, Statuses);
  if (!st) return false;
  for (const s of st.list) {
    if (ctx.registry.get<StatusProto>(KIND.status, s.id)?.kind === "stun") return true;
  }
  return false;
}

/** Live units that `owner` summoned. */
export function liveMinionsOf(world: World, owner: Entity): number {
  let n = 0;
  for (const e of world.query(Summoned)) {
    if (world.read(e, Summoned).owner === owner && !world.has(e, Dead)) n++;
  }
  return n;
}

/** Stops a unit: clears its direct goal and path (no write when already stopped). */
export function stopMover(world: World, e: Entity): void {
  const m = world.peek(e, Mover)!;
  if (m.goalX < 0 && m.path.length === 0) return;
  world.update(e, Mover, { goalX: -1, goalY: -1, path: [] });
}

/** Direct steering toward a sub position (clears any path). No write when unchanged. */
export function steerDirect(world: World, e: Entity, x: number, y: number): void {
  const m = world.peek(e, Mover)!;
  if (m.goalX === x && m.goalY === y && m.path.length === 0) return;
  // Only the goal changes when there is no path (avoids cloning an empty path).
  if (m.path.length === 0) world.update(e, Mover, { goalX: x, goalY: y });
  else world.update(e, Mover, { goalX: x, goalY: y, path: [] });
}

/** Follows a computed A* path (tile waypoints); clears the direct goal. */
export function followPath(world: World, e: Entity, path: { x: number; y: number }[]): void {
  world.update(e, Mover, { path, goalX: -1, goalY: -1 });
}
