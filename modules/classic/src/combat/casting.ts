/**
 * classic.combat.casting (update 400): fires each Casting once at hitAt and
 * frees the unit at endAt (the Casting is removed at endAt - 1 so a new cast
 * can start on tick endAt). Pulse skills fire every pulse.every ticks,
 * pulse.count times. Dead or stunned casters lose their cast.
 *
 * Shapes (docs/design/classic.md §7.3, §20): melee, arc, projectile, nova,
 * aoeTarget, chain, dash, blink, summon, self, pulse. Exploders
 * (MonsterProto.behaviour "exploder") die after firing their onDeathSkill.
 *
 * Wave A:
 * - Skills with SkillProto.telegraph place their danger zones instead of
 *   hitting (./telegraphs.ts); the cast itself ends normally.
 * - Hero casts apply their skill modifiers (bonus.ts skillModsOf, read once
 *   per firing): damagePct on every damage packet of the cast (weapon and
 *   flat parts, projectiles, chains, pulses, areas), radiusPct on nova /
 *   aoeTarget / pulse / self radii, arc reach and projectile explosions,
 *   extraProjectiles, extraPierce, extraBounces, durationPct on applied
 *   statuses, buffs and summon lifetimes, extraSummons on count and max.
 *   Units without BonusStats (monsters) take the unmodified path.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, pushHit, pushSpawn } from "../bus.ts";
import {
  Casting,
  CombatStats,
  Dash,
  Dead,
  Life,
  Monster,
  Mover,
  Pos,
  Summoned,
  type CombatStatsValue,
} from "../components.ts";
import { emit } from "../events.ts";
import { angleDiff, angleOf, angleVec, isqrt, pct, scaleTo, tiles, toTile } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth } from "../resources.ts";
import type { SkillModTotals } from "../rules.ts";
import { gridOf, type SpatialGrid } from "../spatial.ts";
import { KIND, type MonsterProto, type SkillProto, type Team } from "../types.ts";
import { getAreaMap, walkableAt, type ClassicMap } from "../world/maps.ts";
import { canStand, inArea, isStunned } from "../core/units.ts";
import {
  alliesInRadius,
  BASIC_PROJECTILE_RADIUS,
  BASIC_PROJECTILE_SPEED,
  bodyRadius,
  castMods,
  enemiesInRadius,
  extraProjectiles,
  grow,
  hitStatuses,
  isBasic,
  isEnemyOf,
  isLiveUnit,
  makeHit,
  MELEE_SLACK,
  rollCrit,
  rollDamage,
  rollPct,
  scaleDamage,
  skillOf,
  teamOf,
  wake,
} from "./common.ts";
import { killUnit } from "./death.ts";
import { spawnProjectiles, type ProjectileSpec } from "./projectiles.ts";
import { applyStatus } from "./statuses.ts";
import { placeTelegraphs } from "./telegraphs.ts";

/** Default blink reach when the skill has no range (tiles). */
const BLINK_DEFAULT = tiles(8);
/** Summons beyond the first are placed on a ring of this radius (sub). */
const SUMMON_RING = 160;

/** Tile-space angle step of each iso facing (inverse of fixed.facingOf). */
const FACING_ANGLE: Record<string, number> = {
  se: 0,
  s: 8,
  sw: 16,
  w: 24,
  nw: 32,
  n: 40,
  ne: 48,
  e: 56,
};

interface Fire {
  world: World;
  ctx: SimContext;
  grid: SpatialGrid;
  map: ClassicMap;
  depth: number;
  caster: Entity;
  team: Team;
  skillId: string;
  skill: Readonly<SkillProto>;
  rank: number;
  stats: CombatStatsValue | undefined;
  /** Caster position now. */
  px: number;
  py: number;
  /** Aim point (the live target's position, else the order point). */
  tx: number;
  ty: number;
  /** Target entity when it is still a live unit, else 0. */
  target: Entity;
  /** Skill modifiers of the cast (heroes with BonusStats), else null. */
  mods: SkillModTotals | null;
}

export const castingSystem: SystemDef = {
  ...SYSTEM.combatCasting,
  run(world, ctx) {
    const casters = world.query(Casting);
    if (casters.length === 0) return;
    const depth = currentDepth(world);
    const tick = ctx.tick;
    let grid: SpatialGrid | null = null;
    let map: ClassicMap | null = null;
    for (const e of casters) {
      if (!inArea(world, e, depth)) continue;
      // An earlier caster this tick may have stunned or killed this one.
      const c = world.get(e, Casting);
      if (!c) continue;
      if (world.has(e, Dead) || isStunned(world, ctx.registry, e, tick) || !world.has(e, Pos)) {
        world.remove(e, Casting);
        continue;
      }
      const skill = skillOf(ctx.registry, c.skill);
      if (!skill) {
        world.remove(e, Casting);
        continue;
      }
      const due =
        skill.shape === "pulse"
          ? c.pulses < Math.max(1, skill.pulse?.count ?? 1) &&
            tick >= c.hitAt + c.pulses * Math.max(1, skill.pulse?.every ?? 1)
          : !c.fired && tick >= c.hitAt;
      if (due) {
        grid ??= gridOf(world);
        map ??= getAreaMap(world, ctx.registry);
        const f = fireContext(world, ctx, grid, map, depth, e, c, skill);
        if (skill.shape === "pulse") {
          c.pulses++;
          if (c.pulses >= Math.max(1, skill.pulse?.count ?? 1)) c.fired = true;
          area(f, f.px, f.py, radiusOf(f));
        } else {
          c.fired = true;
          fire(f);
        }
        exploderRule(world, ctx, e, c.skill);
      }
      if (world.has(e, Casting) && tick >= c.endAt - 1) world.remove(e, Casting);
    }
  },
};

function fireContext(
  world: World,
  ctx: SimContext,
  grid: SpatialGrid,
  map: ClassicMap,
  depth: number,
  e: Entity,
  c: { skill: string; rank: number; target: Entity; x: number; y: number },
  skill: Readonly<SkillProto>,
): Fire {
  const p = world.read(e, Pos);
  let tx = c.x;
  let ty = c.y;
  let target: Entity = 0;
  if (skill.target === "self") {
    tx = p.x;
    ty = p.y;
  } else if (c.target !== 0 && isLiveUnit(world, c.target, depth)) {
    target = c.target;
    const tp = world.read(target, Pos);
    tx = tp.x;
    ty = tp.y;
  }
  return {
    world,
    ctx,
    grid,
    map,
    depth,
    caster: e,
    team: teamOf(world, e) ?? "monster",
    skillId: c.skill,
    skill,
    rank: Math.max(1, c.rank),
    stats: world.get(e, CombatStats),
    px: p.x,
    py: p.y,
    tx,
    ty,
    target,
    mods: castMods(world, ctx.registry, e, c.skill),
  };
}

function fire(f: Fire): void {
  if (f.skill.telegraph) {
    placeTelegraphs({
      world: f.world,
      ctx: f.ctx,
      map: f.map,
      depth: f.depth,
      caster: f.caster,
      team: f.team,
      skillId: f.skillId,
      skill: f.skill,
      rank: f.rank,
      px: f.px,
      py: f.py,
      tx: f.tx,
      ty: f.ty,
      aim: aimAngle(f),
      reach: reachOf(f),
      damage: () => rollDamage(f.world, f.ctx, f.caster, f.skill, f.rank, f.mods?.damagePct ?? 0),
    });
    return;
  }
  switch (f.skill.shape) {
    case "melee":
      return fireMelee(f);
    case "arc":
      return fireArc(f);
    case "projectile":
      return fireProjectile(f);
    case "nova":
    case "pulse":
      return area(f, f.px, f.py, radiusOf(f));
    case "aoeTarget":
      return area(f, f.tx, f.ty, radiusOf(f));
    case "chain":
      return fireChain(f);
    case "dash":
      return fireDash(f);
    case "blink":
      return fireBlink(f);
    case "summon":
      return fireSummon(f);
    case "self":
      return fireSelf(f);
  }
}

/** The cast's damage packet (with the damagePct modifier). */
function damageOf(f: Fire) {
  return rollDamage(f.world, f.ctx, f.caster, f.skill, f.rank, f.mods?.damagePct ?? 0);
}

/** Statuses of the cast's hits (with the durationPct modifier). */
function statusesOf(f: Fire) {
  return hitStatuses(f.world, f.ctx.registry, f.caster, f.skill, f.rank, f.mods?.durationPct ?? 0);
}

/** Pushes one rolled hit of the cast's skill on `t`. */
function hit(f: Fire, t: Entity, opts: { knockback?: number; damagePct?: number } = {}): void {
  let d = damageOf(f);
  if (opts.damagePct !== undefined) d = scaleDamage(d, opts.damagePct);
  pushHit(
    f.world,
    makeHit(f.caster, t, f.skillId, d, {
      canMiss: f.skill.canMiss,
      crit: rollCrit(f.ctx.rng, f.stats),
      statuses: statusesOf(f),
      knockback: opts.knockback ?? 0,
    }),
  );
}

/** Melee reach (skill range, else the attack range); arc reach grows with radiusPct. */
function reachOf(f: Fire): number {
  const r = f.skill.range > 0 ? f.skill.range : (f.stats?.attackRange ?? 0);
  return f.skill.shape === "arc" ? grow(r, f.mods?.radiusPct ?? 0) : r;
}

/** Area radius of nova / aoeTarget / pulse / self skills (radiusPct). */
function radiusOf(f: Fire): number {
  return grow(f.skill.radius ?? 0, f.mods?.radiusPct ?? 0);
}

function fireMelee(f: Fire): void {
  if (isBasic(f.skill) && f.stats && f.stats.attackProjectile !== "") {
    // Ranged weapon: the basic attack fires the weapon's projectile instead.
    const count = 1 + (f.mods?.extraProjectiles ?? 0);
    return shoot(f, {
      speed: BASIC_PROJECTILE_SPEED,
      count,
      spread: count > 1 ? 3 : 0,
      pierce: f.mods?.extraPierce ?? 0,
      radius: BASIC_PROJECTILE_RADIUS,
      maxRange: Math.max(256, f.stats.attackRange),
      sprite: f.stats.attackProjectile,
      explodeRadius: 0,
    });
  }
  const t = f.target;
  if (t === 0 || !isEnemyOf(f.world, t, f.team, f.depth)) return;
  const tp = f.world.read(t, Pos);
  const reach = reachOf(f) + bodyRadius(f.world, t) + MELEE_SLACK;
  const dx = tp.x - f.px;
  const dy = tp.y - f.py;
  if (dx * dx + dy * dy > reach * reach) return;
  hit(f, t);
}

function aimAngle(f: Fire): number {
  if (f.tx !== f.px || f.ty !== f.py) return angleOf(f.tx - f.px, f.ty - f.py);
  return FACING_ANGLE[f.world.get(f.caster, Mover)?.facing ?? "s"] ?? 8;
}

/**
 * Every enemy within reach inside the cone is hit. One classic.effect per
 * swing, hit or miss, centred on the caster with radius = reach and one
 * point: the aim tip (caster + reach along the aim), so the client can
 * orient the slash.
 */
function fireArc(f: Fire): void {
  const aim = aimAngle(f);
  const half = f.skill.arc ?? 8;
  const reach = reachOf(f);
  const [ax, ay] = angleVec(aim, reach);
  emit(f.ctx, {
    type: "classic.effect",
    effect: f.skill.effect,
    x: f.px,
    y: f.py,
    radius: reach,
    points: [{ x: f.px + ax, y: f.py + ay }],
  });
  for (const t of enemiesInRadius(f.world, f.grid, f.px, f.py, reach, f.team, f.depth)) {
    const tp = f.world.read(t, Pos);
    const inCone =
      (tp.x === f.px && tp.y === f.py) || angleDiff(angleOf(tp.x - f.px, tp.y - f.py), aim) <= half;
    if (inCone) hit(f, t);
  }
}

function shoot(f: Fire, spec: ProjectileSpec): void {
  let dx = f.tx - f.px;
  let dy = f.ty - f.py;
  if (dx === 0 && dy === 0) [dx, dy] = angleVec(aimAngle(f), 1024);
  spawnProjectiles(f.world, {
    skill: f.skillId,
    rank: f.rank,
    owner: f.caster,
    team: f.team,
    x: f.px,
    y: f.py,
    dirX: dx,
    dirY: dy,
    depth: f.depth,
    canMiss: f.skill.canMiss,
    spec,
    damage: () => damageOf(f),
    target: f.target,
  });
}

function fireProjectile(f: Fire): void {
  const pj = f.skill.projectile;
  if (!pj) return;
  const extra = f.mods
    ? Math.max(0, f.mods.extraProjectiles)
    : extraProjectiles(f.world, f.ctx.registry, f.caster);
  shoot(f, {
    speed: pj.speed,
    count: pj.count + extra,
    spread: pj.spread > 0 || pj.count + extra <= 1 ? pj.spread : 3,
    pierce: pj.pierce + Math.max(0, f.mods?.extraPierce ?? 0),
    radius: pj.radius,
    maxRange: pj.maxRange > 0 ? pj.maxRange : Math.max(256, f.skill.range),
    sprite: pj.sprite,
    explodeRadius: grow(pj.explodeRadius ?? 0, f.mods?.radiusPct ?? 0),
  });
}

/** Every enemy within `r` of (x, y) is hit; one classic.effect ring. */
function area(f: Fire, x: number, y: number, r: number): void {
  for (const t of enemiesInRadius(f.world, f.grid, x, y, r, f.team, f.depth)) hit(f, t);
  emit(f.ctx, { type: "classic.effect", effect: f.skill.effect, x, y, radius: r, points: [] });
}

/** Closest live enemy within r of (x, y) not in `skip` (ties -> lower id), or 0. */
function nearestEnemy(f: Fire, x: number, y: number, r: number, skip: readonly Entity[]): Entity {
  let best = 0;
  let bestD = Infinity;
  for (const t of enemiesInRadius(f.world, f.grid, x, y, r, f.team, f.depth, skip)) {
    const tp = f.world.read(t, Pos);
    const d = (tp.x - x) * (tp.x - x) + (tp.y - y) * (tp.y - y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function fireChain(f: Fire): void {
  const ch = f.skill.chain ?? { bounces: 0, range: tiles(4), falloffPct: 0 };
  let cur =
    f.target !== 0 && isEnemyOf(f.world, f.target, f.team, f.depth)
      ? f.target
      : nearestEnemy(f, f.tx, f.ty, ch.range, []);
  if (cur === 0) return;
  const base = damageOf(f);
  const crit = rollCrit(f.ctx.rng, f.stats);
  const statuses = statusesOf(f);
  const bounces = ch.bounces + Math.max(0, f.mods?.extraBounces ?? 0);
  const done: Entity[] = [];
  const points: { x: number; y: number }[] = [{ x: f.px, y: f.py }];
  let keep = 100;
  for (let i = 0; i <= bounces && cur !== 0; i++) {
    const d = keep === 100 ? base : scaleDamage(base, keep);
    pushHit(
      f.world,
      makeHit(f.caster, cur, f.skillId, d, { canMiss: f.skill.canMiss, crit, statuses }),
    );
    done.push(cur);
    const cp = f.world.read(cur, Pos);
    points.push({ x: cp.x, y: cp.y });
    keep = pct(keep, 100 - ch.falloffPct);
    cur = i < bounces ? nearestEnemy(f, cp.x, cp.y, ch.range, done) : 0;
  }
  emit(f.ctx, {
    type: "classic.effect",
    effect: f.skill.effect,
    x: f.px,
    y: f.py,
    radius: 0,
    points,
  });
}

function fireDash(f: Fire): void {
  const ds = f.skill.dash ?? { speed: 120, maxRange: Math.max(256, f.skill.range) };
  let dx = f.tx - f.px;
  let dy = f.ty - f.py;
  let len = isqrt(dx * dx + dy * dy);
  if (f.target !== 0 && len > 0) {
    // Stop at the target's body, not inside it.
    const stopAt = Math.max(0, len - bodyRadius(f.world, f.caster) - bodyRadius(f.world, f.target));
    [dx, dy] = scaleTo(dx, dy, stopAt);
    len = stopAt;
  }
  if (len > ds.maxRange) {
    [dx, dy] = scaleTo(dx, dy, ds.maxRange);
    len = ds.maxRange;
  }
  const speed = Math.max(1, ds.speed);
  f.world.add(f.caster, Dash, {
    skill: f.skillId,
    rank: f.rank,
    target: f.target,
    tx: f.px + dx,
    ty: f.py + dy,
    speed,
    until: f.ctx.tick + Math.ceil(len / speed) + 2,
  });
}

function fireBlink(f: Fire): void {
  const maxR = f.skill.range > 0 ? f.skill.range : BLINK_DEFAULT;
  let dx = f.tx - f.px;
  let dy = f.ty - f.py;
  let len = isqrt(dx * dx + dy * dy);
  if (len > maxR) {
    [dx, dy] = scaleTo(dx, dy, maxR);
    len = maxR;
  }
  const r = bodyRadius(f.world, f.caster);
  // Walk back from the clamped point toward the caster to the first spot the body fits.
  for (let back = 0; back < len; back += 64) {
    const [bx, by] = back === 0 ? [dx, dy] : scaleTo(dx, dy, len - back);
    const x = f.px + bx;
    const y = f.py + by;
    if (!canStand(f.map, x, y, r)) continue;
    const p = f.world.read(f.caster, Pos);
    p.x = x;
    p.y = y;
    if (!f.world.has(f.caster, Dead)) f.grid.move(f.caster, x, y);
    const m = f.world.get(f.caster, Mover);
    if (m) {
      if (m.path.length > 0) m.path = [];
      m.goalX = -1;
      m.goalY = -1;
    }
    emit(f.ctx, {
      type: "classic.effect",
      effect: f.skill.effect,
      x,
      y,
      radius: 0,
      points: [
        { x: f.px, y: f.py },
        { x, y },
      ],
    });
    return;
  }
}

function fireSummon(f: Fire): void {
  const sm = f.skill.summon;
  if (!sm || !f.ctx.registry.has(KIND.monster, sm.monster)) return;
  const w = f.world;
  let alive = 0;
  for (const s of w.query(Summoned, Monster)) {
    if (w.read(s, Summoned).owner !== f.caster || w.has(s, Dead)) continue;
    if (w.read(s, Monster).proto === sm.monster && inArea(w, s, f.depth)) alive++;
  }
  for (const req of busOf(w).spawns) {
    if (req.owner === f.caster && req.monster === sm.monster) alive++;
  }
  const extra = Math.max(0, f.mods?.extraSummons ?? 0);
  const n = Math.min(sm.count + extra, sm.max + extra - alive);
  if (n <= 0) return;
  let x = f.px;
  let y = f.py;
  if (f.skill.target !== "self") {
    let dx = f.tx - f.px;
    let dy = f.ty - f.py;
    if (f.skill.range > 0 && dx * dx + dy * dy > f.skill.range * f.skill.range) {
      [dx, dy] = scaleTo(dx, dy, f.skill.range);
    }
    if (walkableAt(f.map, toTile(f.px + dx), toTile(f.py + dy))) {
      x = f.px + dx;
      y = f.py + dy;
    }
  }
  const level = f.stats?.level ?? 1;
  const until = sm.duration > 0 ? f.ctx.tick + grow(sm.duration, f.mods?.durationPct ?? 0) : 0;
  const pack = w.get(f.caster, Monster)?.pack ?? 0;
  for (let i = 0; i < n; i++) {
    let sx = x;
    let sy = y;
    if (n > 1) {
      const [ox, oy] = angleVec(Math.floor((i * 64) / n), SUMMON_RING);
      if (canStand(f.map, x + ox, y + oy, 80)) {
        sx = x + ox;
        sy = y + oy;
      }
    }
    pushSpawn(w, {
      monster: sm.monster,
      x: sx,
      y: sy,
      depth: f.depth,
      level,
      rarity: "summon",
      mods: [],
      pack,
      name: "",
      owner: f.caster,
      team: f.team,
      until,
      awake: true,
    });
  }
  emit(f.ctx, { type: "classic.effect", effect: f.skill.effect, x, y, radius: 0, points: [] });
}

function fireSelf(f: Fire): void {
  const w = f.world;
  const s = f.skill;
  const r1 = f.rank - 1;
  const radius = s.radius ? radiusOf(f) : 0;
  const durPct = f.mods?.durationPct ?? 0;
  if (s.heal) {
    const life = w.get(f.caster, Life);
    if (life) {
      const amount = pct(life.max, s.heal.pct + s.heal.pctPerRank * r1) + s.heal.flat;
      const actual = Math.max(0, Math.min(amount, life.max - life.hp));
      life.hp += actual;
      emit(f.ctx, { type: "classic.heal", target: f.caster, amount: actual, x: f.px, y: f.py });
    }
  }
  if (s.buff) {
    const power = s.buff.power + s.buff.powerPerRank * r1;
    const allies = radius ? alliesInRadius(w, f.grid, f.px, f.py, radius, f.team, f.depth) : [];
    if (!allies.includes(f.caster)) allies.unshift(f.caster);
    const duration = grow(s.buff.duration, durPct);
    for (const a of allies) {
      applyStatus(w, f.ctx, a, { id: s.buff.status, duration, power }, f.caster);
    }
  }
  if (s.status && radius) {
    const st = s.status;
    const power = st.power + st.powerPerRank * r1;
    const duration = grow(st.duration, durPct);
    for (const t of enemiesInRadius(w, f.grid, f.px, f.py, radius, f.team, f.depth)) {
      if (!rollPct(f.ctx.rng, st.chancePct)) continue;
      applyStatus(w, f.ctx, t, { id: st.id, duration, power }, f.caster);
      wake(w, t, f.caster);
    }
  }
  emit(f.ctx, {
    type: "classic.effect",
    effect: s.effect,
    x: f.px,
    y: f.py,
    radius,
    points: [],
  });
}

/** §20: an exploder that fired its onDeathSkill dies by its own hand (no credit). */
function exploderRule(world: World, ctx: SimContext, e: Entity, skill: string): void {
  const mon = world.get(e, Monster);
  if (!mon) return;
  const proto = ctx.registry.get<MonsterProto>(KIND.monster, mon.proto);
  if (proto?.behaviour === "exploder" && proto.onDeathSkill === skill) killUnit(world, ctx, e, e);
}
