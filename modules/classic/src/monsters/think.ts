/**
 * classic.monsters.think (update 200, owner: T4 monster builder): the AI of
 * every awake monster of the current area (design §8.2). Attacks and skills
 * are issued only as CastOrder (classic.combat validates and casts); movement
 * only as Mover.goalX/goalY or Mover.path (classic.core.movement moves).
 *
 * Throttle: a monster thinks every THINK_EVERY ticks (staggered by id), and
 * every tick while it is inside attack range of its target. Monsters chasing
 * the hero follow the hero distance field (see field.ts); other moves use A*
 * (findPath) at most once per PATH_EVERY ticks per monster and at most
 * SEARCHES_PER_TICK searches per tick in total.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { findPath } from "@gamez/world";
import {
  Ai,
  type AiStateName,
  AreaTag,
  Casting,
  CombatStats,
  type CombatStatsValue,
  Dash,
  Dead,
  Faction,
  Life,
  Monster,
  Mover,
  Pos,
} from "../components.ts";
import { emit } from "../events.ts";
import { angleVec, dist2, scaleTo, tileCenter, tiles, within } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth, heroOf } from "../resources.ts";
import { bossPhase } from "../rules.ts";
import { type SpatialGrid, gridOf } from "../spatial.ts";
import { KIND, type MonsterProto, type SkillProto, type Team } from "../types.ts";
import {
  getAreaMap,
  lineOfSight,
  walkableAt,
  walkableSub,
  type ClassicMap,
} from "../world/maps.ts";
import { enterPhases, hasPhases, pendingTelegraphs, rotationSkills } from "./boss.ts";
import { type DistanceField, fieldDistance, heroField as heroFieldOf, nextStep } from "./field.ts";
import { modProtos } from "./spawn.ts";
import {
  type AggroState,
  LOSE_CONTACT_TICKS,
  THINK_EVERY,
  aggroOf,
  bodyRadius,
  canOrder,
  followPath,
  isEnemyOf,
  isLive,
  isStunned,
  liveMinionsOf,
  orderCast,
  skillOf,
  skillReady,
  steerDirect,
  stopMover,
} from "./util.ts";

/** A* searches allowed per tick across all monsters. */
const SEARCHES_PER_TICK = 4;
/** Minimum ticks between A* searches of one monster. */
const PATH_EVERY = 40;
/** Node budget of one A* search. */
const PATH_NODES = 2000;
/** Ticks between charger dashes. */
const CHARGE_COOLDOWN = 100;
/** Summoners only raise while their target is this close (sub). */
const SUMMON_REACH = tiles(9);
/** Tanks slam as every 4th attack (design §8.2). */
const TANK_SLAM_EVERY = 4;

interface Env {
  world: World;
  ctx: SimContext;
  map: ClassicMap;
  grid: SpatialGrid;
  tick: number;
  /** The hero entity, or 0. */
  heroE: Entity;
  /** Hero distance field of this tick (null when the hero is not live). Shared by every chaser. */
  heroField: DistanceField | null;
  aggro: AggroState;
  budget: { left: number };
}

interface Pt {
  x: number;
  y: number;
}

/** One monster being thought about this tick. Copied state; written back once. */
interface Unit {
  e: Entity;
  pos: Pt;
  home: Pt;
  proto: Readonly<MonsterProto>;
  cs: CombatStatsValue;
  /** Team this monster fights. */
  enemy: Team;
  mods: readonly string[];
  basicId: string;
  /** Chosen target (0 = none) and its position (= pos when none). */
  target: Entity;
  tpos: Pt;
  d2: number;
  isHeroTarget: boolean;
  repathAt: number;
  specialAt: number;
  /** Ai.count (see the component). */
  count: number;
}

export const monstersThinkSystem: SystemDef = {
  ...SYSTEM.monstersThink,
  run(world, ctx) {
    // Every monster has the full set of components; the query only narrows to them.
    const monsters = world.query(Monster);
    if (monsters.length === 0) return;
    const depth = currentDepth(world);
    const map = getAreaMap(world, ctx.registry);
    const heroE = heroOf(world);
    const heroField =
      heroE !== 0 && isLive(world, heroE)
        ? (() => {
            const hp = world.read(heroE, Pos);
            return heroFieldOf(map, hp.x >> 8, hp.y >> 8);
          })()
        : null;
    const env: Env = {
      world,
      ctx,
      map,
      grid: gridOf(world),
      tick: ctx.tick,
      heroE,
      heroField,
      aggro: aggroOf(world),
      budget: { left: SEARCHES_PER_TICK },
    };
    for (const e of monsters) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      thinkOne(env, e);
    }
  },
};

function isActive(s: AiStateName): boolean {
  return s === "chase" || s === "attack" || s === "kite" || s === "charge" || s === "flee";
}

function thinkOne(env: Env, e: Entity): void {
  const { world, ctx, tick } = env;
  const ai = world.read(e, Ai);
  if (ai.state === "sleep" || world.has(e, Dead) || world.has(e, Dash)) return;
  const mon = world.read(e, Monster);
  const proto = ctx.registry.get<MonsterProto>(KIND.monster, mon.proto);
  if (proto === undefined) return;
  const cs = world.read(e, CombatStats);
  const p = world.read(e, Pos);
  const pos: Pt = { x: p.x, y: p.y };
  const enemy: Team = world.read(e, Faction).team === "monster" ? "hero" : "monster";

  // Throttle: units inside attack range think every tick, others every THINK_EVERY ticks.
  const cur = isLive(world, ai.target) ? ai.target : 0;
  const curPos = cur !== 0 ? world.read(cur, Pos) : undefined;
  const engaged =
    curPos !== undefined &&
    within(pos.x, pos.y, curPos.x, curPos.y, cs.attackRange + bodyRadius(world, cur));
  if (!engaged && (e + tick) % THINK_EVERY !== 0) return;

  const active = isActive(ai.state);
  const radius =
    proto.behaviour === "totem" ? Math.max(proto.aggroRange, cs.attackRange) : proto.aggroRange;
  const key = String(e);
  let last = env.aggro.last[key];
  // Combat engaged us (state chase without a memory entry): count it as contact now.
  if (last === undefined && active) last = tick;
  const recent = last !== undefined && tick - last < LOSE_CONTACT_TICKS;
  const found = acquire(env, e, pos, enemy, radius, cur, recent);
  if (found.near > 0) last = tick;

  const target = found.target;
  const tp = target !== 0 ? world.read(target, Pos) : undefined;
  const tpos: Pt = tp !== undefined ? { x: tp.x, y: tp.y } : pos;
  const u: Unit = {
    e,
    pos,
    home: { x: ai.homeX, y: ai.homeY },
    proto,
    cs,
    enemy,
    mods: mon.mods,
    basicId: proto.skills[0] ?? "",
    target,
    tpos,
    d2: tp !== undefined ? dist2(pos.x, pos.y, tpos.x, tpos.y) : Infinity,
    isHeroTarget: target !== 0 && target === env.heroE,
    repathAt: ai.repathAt,
    specialAt: ai.specialAt,
    count: ai.count,
  };
  // Wave A boss phases are entered even while the boss is busy (casting, stunned).
  if (proto.behaviour === "boss" && hasPhases(proto)) {
    u.count = enterPhases(world, ctx, e, proto, u.count);
  }

  let state: AiStateName;
  if (world.has(e, Casting) || isStunned(world, ctx, e)) {
    // Busy: keep the state, no orders and no movement.
    state = ai.state;
  } else if (target !== 0 && tp !== undefined) {
    state = tryBlink(env, u) ? "chase" : think(env, u);
  } else {
    state = idleOrReturn(env, u, ai.state, recent);
  }

  // Write only what changed (the Ai write clones every field). thinkAt is informational:
  // the throttle is the staggered modulus above.
  if (
    state !== ai.state ||
    target !== ai.target ||
    u.repathAt !== ai.repathAt ||
    u.specialAt !== ai.specialAt ||
    u.count !== ai.count
  ) {
    world.update(e, Ai, {
      state,
      target,
      thinkAt: tick + THINK_EVERY,
      repathAt: u.repathAt,
      specialAt: u.specialAt,
      count: u.count,
    });
  }
  if (isActive(state)) env.aggro.last[key] = last ?? tick;
  else delete env.aggro.last[key];
}

/**
 * Target choice: the hero when it is in range (else the nearest enemy); the
 * current target is kept unless another enemy is 50 % closer. With no enemy in
 * range, a recent contact keeps the current target (or the hero for monsters
 * fighting the hero) for LOSE_CONTACT_TICKS.
 */
function acquire(
  env: Env,
  e: Entity,
  pos: Pt,
  enemy: Team,
  radius: number,
  cur: Entity,
  recent: boolean,
): { target: Entity; near: number } {
  const { world } = env;
  // Fast path: the hero is the preferred target, so while it is alive and in range
  // the answer is the hero without a grid search (same result as the full search).
  if (cur !== 0 && cur === env.heroE && enemy === "hero" && isEnemyOf(world, cur, enemy)) {
    const hp = world.read(cur, Pos);
    if (within(pos.x, pos.y, hp.x, hp.y, radius)) return { target: cur, near: 1 };
  }
  let near = 0;
  let best: Entity = 0;
  let bestD = Infinity;
  let hero: Entity = 0;
  for (const c of env.grid.query(pos.x, pos.y, radius)) {
    if (c === e || world.get(c, Faction)?.team !== enemy || !isEnemyOf(world, c, enemy)) continue;
    near++;
    const p = world.read(c, Pos);
    const d = dist2(pos.x, pos.y, p.x, p.y);
    if (c === env.heroE) hero = c;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  let pick: Entity = hero !== 0 ? hero : best;
  if (pick !== 0 && cur !== 0 && cur !== pick && isEnemyOf(world, cur, enemy)) {
    const cp = world.read(cur, Pos);
    const pp = world.read(pick, Pos);
    // Keep the current target unless it is more than 50 % farther (squared: 4 d_cur <= 9 d_pick).
    if (4 * dist2(pos.x, pos.y, cp.x, cp.y) <= 9 * dist2(pos.x, pos.y, pp.x, pp.y)) pick = cur;
  }
  if (pick !== 0) return { target: pick, near };
  if (recent) {
    if (cur !== 0 && isEnemyOf(world, cur, enemy)) return { target: cur, near };
    if (enemy === "hero" && env.heroE !== 0 && isEnemyOf(world, env.heroE, enemy)) {
      return { target: env.heroE, near };
    }
  }
  return { target: 0, near };
}

function think(env: Env, u: Unit): AiStateName {
  switch (u.proto.behaviour) {
    case "archer":
      return ranged(env, u, false);
    case "caster":
      return ranged(env, u, true);
    case "summoner":
      return summoner(env, u);
    case "tank":
      return tank(env, u);
    case "charger":
      return charger(env, u);
    case "exploder":
      return exploder(env, u);
    case "boss":
      return boss(env, u);
    case "totem":
      return totem(env, u);
    case "swarm":
      return swarm(env, u);
    default:
      return rusher(env, u);
  }
}

/** Without a target: walk home after losing contact, else stand still. */
function idleOrReturn(env: Env, u: Unit, prev: AiStateName, recent: boolean): AiStateName {
  const returning = prev === "return" || (isActive(prev) && !recent);
  if (returning) {
    if (within(u.pos.x, u.pos.y, u.home.x, u.home.y, tiles(1))) {
      stopMover(env.world, u.e);
      return "idle";
    }
    moveTo(env, u, u.home.x, u.home.y, false);
    return "return";
  }
  stopMover(env.world, u.e);
  return "idle";
}

/** Attack from where we stand: stop and order the skill when it is ready. */
function strike(env: Env, u: Unit, skillId: string): AiStateName {
  stopMover(env.world, u.e);
  if (skillId !== "" && canOrder(env.world, u.e) && skillReady(env.world, u.e, skillId, env.tick)) {
    issue(env, u, skillId);
    if (u.proto.behaviour === "tank") u.count++;
  }
  return "attack";
}

/** Orders a skill at the right point: self skills at the caster, point skills at the target, others at the target. */
function issue(env: Env, u: Unit, skillId: string): void {
  const sk = skillOf(env.ctx, skillId);
  if (sk === undefined) return;
  if (sk.target === "self") {
    orderCast(env.world, u.e, skillId, 0, u.pos.x, u.pos.y);
  } else if (sk.target === "point") {
    orderCast(env.world, u.e, skillId, 0, u.tpos.x, u.tpos.y);
  } else if (u.target !== 0) {
    orderCast(env.world, u.e, skillId, u.target, u.tpos.x, u.tpos.y);
  }
}

/** Melee chase: walk in, strike when in reach. */
function rusher(env: Env, u: Unit): AiStateName {
  const reach = u.cs.attackRange + bodyRadius(env.world, u.target);
  if (within(u.pos.x, u.pos.y, u.tpos.x, u.tpos.y, reach)) return strike(env, u, u.basicId);
  moveTo(env, u, u.tpos.x, u.tpos.y, u.isHeroTarget);
  return "chase";
}

/** Like rusher, but approaches from an angle that depends on the id, so packs surround. */
function swarm(env: Env, u: Unit): AiStateName {
  const reach = u.cs.attackRange + bodyRadius(env.world, u.target);
  if (within(u.pos.x, u.pos.y, u.tpos.x, u.tpos.y, reach)) return strike(env, u, u.basicId);
  if (u.d2 > tiles(3) * tiles(3)) {
    moveTo(env, u, u.tpos.x, u.tpos.y, u.isHeroTarget);
    return "chase";
  }
  const [ox, oy] = angleVec((u.e % 8) * 8, tiles(1.2));
  steerDirect(env.world, u.e, u.tpos.x + ox, u.tpos.y + oy);
  return "chase";
}

/** Keeps its distance: steps away when too close, shoots when in range and in line of sight. */
function ranged(env: Env, u: Unit, caster: boolean): AiStateName {
  const { world, map } = env;
  const keep = u.proto.keepDistance > 0 ? u.proto.keepDistance : tiles(4);
  if (caster && u.d2 <= tiles(1.2) * tiles(1.2)) {
    // Casters that are caught in melee fall back to their home.
    moveTo(env, u, u.home.x, u.home.y, false);
    return "flee";
  }
  const kite = Math.floor((keep * 60) / 100);
  if (u.d2 < kite * kite) {
    const [vx, vy] = scaleTo(u.pos.x - u.tpos.x, u.pos.y - u.tpos.y, tiles(2));
    const gx = u.pos.x + vx;
    const gy = u.pos.y + vy;
    if (walkableSub(map, gx, gy)) {
      steerDirect(world, u.e, gx, gy);
      return "kite";
    }
  }
  const reach = u.cs.attackRange + bodyRadius(world, u.target);
  if (
    within(u.pos.x, u.pos.y, u.tpos.x, u.tpos.y, reach) &&
    lineOfSight(map, u.pos.x, u.pos.y, u.tpos.x, u.tpos.y)
  ) {
    return strike(env, u, u.basicId);
  }
  moveTo(env, u, u.tpos.x, u.tpos.y, u.isHeroTarget);
  return "chase";
}

/**
 * Keeps its distance and raises minions when it has fewer than its maximum
 * alive, but only while its target is within SUMMON_REACH and in line of
 * sight (no endless raising against a hero that cannot reach it).
 */
function summoner(env: Env, u: Unit): AiStateName {
  const raiseId = u.proto.skills.find((id) => skillOf(env.ctx, id)?.shape === "summon") ?? "";
  const raise = skillOf(env.ctx, raiseId);
  if (
    raise?.summon !== undefined &&
    u.specialAt <= env.tick &&
    u.d2 <= SUMMON_REACH * SUMMON_REACH &&
    lineOfSight(env.map, u.pos.x, u.pos.y, u.tpos.x, u.tpos.y) &&
    canOrder(env.world, u.e) &&
    skillReady(env.world, u.e, raiseId, env.tick) &&
    liveMinionsOf(env.world, u.e) < raise.summon.max
  ) {
    stopMover(env.world, u.e);
    issue(env, u, raiseId);
    u.specialAt = env.tick + Math.max(20, raise.cooldown);
    return "attack";
  }
  return ranged(env, u, false);
}

/** Slow chase; slams when two or more enemies crowd it, or as every 4th attack (design §8.2). */
function tank(env: Env, u: Unit): AiStateName {
  const reach = u.cs.attackRange + bodyRadius(env.world, u.target);
  if (!within(u.pos.x, u.pos.y, u.tpos.x, u.tpos.y, reach)) {
    moveTo(env, u, u.tpos.x, u.tpos.y, u.isHeroTarget);
    return "chase";
  }
  const slam = u.proto.skills.slice(1).find((id) => skillOf(env.ctx, id)?.shape === "nova") ?? "";
  const slamRange = tiles(1.6) + bodyRadius(env.world, u.target);
  if (
    slam !== "" &&
    within(u.pos.x, u.pos.y, u.tpos.x, u.tpos.y, slamRange) &&
    canOrder(env.world, u.e) &&
    skillReady(env.world, u.e, slam, env.tick)
  ) {
    const crowd = countEnemies(env, u.pos, tiles(1.6), u.enemy);
    if (crowd >= 2 || u.count >= TANK_SLAM_EVERY - 1) {
      stopMover(env.world, u.e);
      issue(env, u, slam);
      u.count = 0;
      return "attack";
    }
  }
  return strike(env, u, u.basicId);
}

/** Charges from 3 to 7 tiles in line of sight when ready; otherwise rushes. */
function charger(env: Env, u: Unit): AiStateName {
  const dash = u.proto.skills.find((id) => skillOf(env.ctx, id)?.shape === "dash") ?? "";
  if (
    dash !== "" &&
    u.d2 >= tiles(3) * tiles(3) &&
    u.d2 <= tiles(7) * tiles(7) &&
    u.specialAt <= env.tick &&
    canOrder(env.world, u.e) &&
    skillReady(env.world, u.e, dash, env.tick) &&
    lineOfSight(env.map, u.pos.x, u.pos.y, u.tpos.x, u.tpos.y)
  ) {
    stopMover(env.world, u.e);
    issue(env, u, dash);
    u.specialAt = env.tick + CHARGE_COOLDOWN;
    return "charge";
  }
  return rusher(env, u);
}

/** Rushes and bursts when adjacent (the burst is its basic attack and its death skill). */
function exploder(env: Env, u: Unit): AiStateName {
  if (within(u.pos.x, u.pos.y, u.tpos.x, u.tpos.y, tiles(1.2))) return strike(env, u, u.basicId);
  moveTo(env, u, u.tpos.x, u.tpos.y, u.isHeroTarget);
  return "chase";
}

/**
 * Bosses without phases summon once per life threshold crossed (66 % and
 * 33 %, Ai.count holds the thresholds done) before anything else. Bosses with
 * MonsterProto.phases summon through their phases instead (./boss.ts) and
 * rotate their skills plus the skills of the phases done. Either way they
 * cast their best ready skill (priority, then order): self skills when
 * enemies are close, targeted skills when in range and line of sight.
 * Telegraphed skills wait while one of the boss's own telegraphs is pending,
 * and a pending line telegraph (rush) holds the boss still. A phased boss
 * also casts the summon skills of its rotation (cooldown, below their max),
 * and no boss fires a multi-missile fan at a target within FAN_MIN_GAP.
 * Otherwise rush and strike. Every boss attack skill has a cooldown, so the
 * rotation rotates.
 */
function boss(env: Env, u: Unit): AiStateName {
  const phased = hasPhases(u.proto);
  const ids = phased ? rotationSkills(u.proto, u.count) : u.proto.skills.slice(1);
  const options: { id: string; sk: Readonly<SkillProto>; i: number }[] = [];
  ids.forEach((id, i) => {
    const sk = skillOf(env.ctx, id);
    if (sk !== undefined) options.push({ id, sk, i });
  });
  options.sort((a, b) => b.sk.ai.priority - a.sk.ai.priority || a.i - b.i);
  const pending = options.some((o) => o.sk.telegraph !== undefined)
    ? pendingTelegraphs(env.world, u.e)
    : { any: false, line: false };
  if (pending.line) {
    // Hold the lane: the rush starts from where the line was marked.
    stopMover(env.world, u.e);
    return "attack";
  }
  if (canOrder(env.world, u.e)) {
    if (!phased) {
      const life = env.world.read(u.e, Life);
      const phase = bossPhase(life.hp, life.max);
      if (u.count < phase) {
        const call = options.find((o) => o.sk.shape === "summon" && o.sk.summon !== undefined);
        if (call === undefined || liveMinionsOf(env.world, u.e) >= call.sk.summon!.max) {
          // Nothing to call (or the room is full): the phase passes.
          u.count = phase;
        } else if (skillReady(env.world, u.e, call.id, env.tick)) {
          stopMover(env.world, u.e);
          issue(env, u, call.id);
          u.count++;
          return "attack";
        }
      }
    }
    for (const o of options) {
      if (!skillReady(env.world, u.e, o.id, env.tick)) continue;
      if (o.sk.shape === "summon") {
        // A phased boss casts the summon skills of its rotation (Skarn's Call the Brood) on
        // their cooldown while it has foes and room; the others summon at thresholds (above).
        if (!phased || o.sk.summon === undefined || u.target === 0) continue;
        if (liveMinionsOf(env.world, u.e) >= o.sk.summon.max) continue;
        stopMover(env.world, u.e);
        issue(env, u, o.id);
        return "attack";
      }
      if (o.sk.telegraph !== undefined && pending.any) continue;
      if (o.sk.target === "self") {
        if (countEnemies(env, u.pos, o.sk.radius ?? tiles(2), u.enemy) > 0) {
          stopMover(env.world, u.e);
          issue(env, u, o.id);
          return "attack";
        }
        continue;
      }
      const range = o.sk.range > 0 ? o.sk.range : u.cs.attackRange;
      const reach = range + bodyRadius(env.world, u.target);
      // A fan is aimed from range: point-blank every missile of it hits the same foe (the
      // Hollow King's seven-missile Volley took a level-28 rogue from 70 % to dead in one tick).
      if ((o.sk.projectile?.count ?? 1) > 1 && u.d2 <= fanMinDist2(env.world, u)) continue;
      if (
        within(u.pos.x, u.pos.y, u.tpos.x, u.tpos.y, reach) &&
        lineOfSight(env.map, u.pos.x, u.pos.y, u.tpos.x, u.tpos.y)
      ) {
        stopMover(env.world, u.e);
        issue(env, u, o.id);
        return "attack";
      }
    }
  }
  return rusher(env, u);
}

/** A boss never fires a multi-missile fan at a target this close (sub, between body edges). */
export const FAN_MIN_GAP = tiles(2);

/** Squared centre distance (sub²) under which `u` holds its fans (FAN_MIN_GAP between bodies). */
function fanMinDist2(world: World, u: Unit): number {
  const d = FAN_MIN_GAP + bodyRadius(world, u.e) + bodyRadius(world, u.target);
  return d * d;
}

/** Never moves; shoots its first skill at the nearest enemy in range. */
function totem(env: Env, u: Unit): AiStateName {
  stopMover(env.world, u.e);
  const reach = u.cs.attackRange + bodyRadius(env.world, u.target);
  if (within(u.pos.x, u.pos.y, u.tpos.x, u.tpos.y, reach)) return strike(env, u, u.basicId);
  return "idle";
}

/**
 * Blinkers (mod "blinking") teleport next to their target every blinkEvery
 * ticks when far away. Returns true when it blinked.
 */
function tryBlink(env: Env, u: Unit): boolean {
  const every = blinkPeriod(env, u.mods);
  if (every <= 0 || u.d2 <= tiles(2) * tiles(2) || (u.e + env.tick) % every !== 0) return false;
  const tx = u.tpos.x >> 8;
  const ty = u.tpos.y >> 8;
  let best: Pt | null = null;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = tx + dx;
      const ny = ty + dy;
      if (!walkableAt(env.map, nx, ny)) continue;
      const cx = tileCenter(nx);
      const cy = tileCenter(ny);
      const d = dist2(cx, cy, u.pos.x, u.pos.y);
      if (d < bestD) {
        bestD = d;
        best = { x: cx, y: cy };
      }
    }
  }
  if (best === null) return false;
  env.world.update(u.e, Pos, { x: best.x, y: best.y });
  env.grid.move(u.e, best.x, best.y);
  stopMover(env.world, u.e);
  emit(env.ctx, {
    type: "classic.effect",
    effect: "fx.phase_step",
    x: best.x,
    y: best.y,
    radius: 0,
    points: [],
  });
  return true;
}

function blinkPeriod(env: Env, mods: readonly string[]): number {
  let every = 0;
  for (const m of modProtos(env.ctx.registry, mods)) {
    if (m.blinkEvery > 0 && (every === 0 || m.blinkEvery < every)) every = m.blinkEvery;
  }
  return every;
}

function countEnemies(env: Env, pos: Pt, r: number, enemy: Team): number {
  let n = 0;
  for (const c of env.grid.query(pos.x, pos.y, r)) {
    if (isEnemyOf(env.world, c, enemy)) n++;
  }
  return n;
}

/**
 * Moves toward (tx, ty). Hero chases use the hero distance field when the
 * monster stands on it; otherwise an A* path (budgeted) or direct steering.
 */
function moveTo(env: Env, u: Unit, tx: number, ty: number, toHero: boolean): void {
  const { world, map, tick } = env;
  const mtx = u.pos.x >> 8;
  const mty = u.pos.y >> 8;
  const field = env.heroField;
  if (toHero && field !== null) {
    const d = fieldDistance(field, mtx, mty);
    if (d !== undefined && d > 0) {
      const step = nextStep(map, field, mtx, mty);
      if (step !== null) {
        steerDirect(world, u.e, tileCenter(step.x), tileCenter(step.y));
        return;
      }
    }
  }
  if (world.read(u.e, Mover).path.length > 0 && tick < u.repathAt) return;
  if (tick >= u.repathAt && env.budget.left > 0) {
    env.budget.left--;
    u.repathAt = tick + PATH_EVERY;
    const path = findPath(map, { x: mtx, y: mty }, { x: tx >> 8, y: ty >> 8 }, PATH_NODES);
    if (path !== null && path.length > 0) {
      followPath(world, u.e, path);
      return;
    }
  }
  steerDirect(world, u.e, tx, ty);
}
