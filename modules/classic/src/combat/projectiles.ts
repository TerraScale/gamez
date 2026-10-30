/**
 * Projectiles (docs/design/classic.md §7.3): spawnProjectiles() used by
 * casting, and classic.combat.projectiles (update 500).
 *
 * Each tick a projectile moves (vx, vy) in sub-steps of at most 64 sub, stops
 * on walls, collides with enemy bodies through the grid (radius + body
 * radius, closest first), skips units it already hit, pierces `pierceLeft`
 * more targets, and expires after `rangeLeft`. With `explodeRadius` it
 * explodes (area hit + classic.effect) on impact, on walls and at max range.
 * Damage is pre-rolled at spawn; the crit is rolled at impact with the
 * owner's critPct (no crit when the owner is gone). A single explode-on-impact
 * projectile fired at a unit homes on it (HOMING_STEPS per tick), so slow
 * orbs still land on moving targets.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { pushHit } from "../bus.ts";
import { AreaTag, CombatStats, Dead, Pos, Projectile } from "../components.ts";
import { emit } from "../events.ts";
import {
  ANGLE_STEPS,
  COS64,
  SIN64,
  TRIG_ONE,
  angleOf,
  angleVec,
  isqrt,
  scaleTo,
  wrapAngle,
} from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth } from "../resources.ts";
import { gridOf, type SpatialGrid } from "../spatial.ts";
import type { Damage, Team } from "../types.ts";
import { getAreaMap, walkableSub } from "../world/maps.ts";
import {
  durationPctOf,
  enemiesInRadius,
  hitStatuses,
  makeHit,
  rollCrit,
  skillOf,
} from "./common.ts";

export interface ProjectileSpec {
  speed: number;
  count: number;
  /** Angle steps between adjacent projectiles. */
  spread: number;
  pierce: number;
  radius: number;
  maxRange: number;
  sprite: string;
  explodeRadius: number;
}

/** Rotates (x, y) by `steps` angle steps with the integer tables. */
export function rotate(x: number, y: number, steps: number): [number, number] {
  const a = wrapAngle(steps);
  const c = COS64[a]!;
  const s = SIN64[a]!;
  return [Math.trunc((x * c - y * s) / TRIG_ONE), Math.trunc((x * s + y * c) / TRIG_ONE)];
}

/** Symmetric angle offsets of `count` projectiles `spread` steps apart (truncated toward 0). */
export function spreadOffsets(count: number, spread: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.trunc(((2 * i - (count - 1)) * spread) / 2));
  return out;
}

/**
 * Spawns `spec.count` projectiles from (x, y) along (dirX, dirY) (any length,
 * non-zero). `damage` is called once per projectile.
 */
export function spawnProjectiles(
  world: World,
  o: {
    skill: string;
    rank: number;
    owner: Entity;
    team: Team;
    x: number;
    y: number;
    dirX: number;
    dirY: number;
    depth: number;
    canMiss: boolean;
    spec: ProjectileSpec;
    damage: () => Damage;
    /** Unit aimed at (0 = a point): single exploding projectiles home on it. */
    target?: Entity;
  },
): Entity[] {
  const out: Entity[] = [];
  const [bx, by] = scaleTo(o.dirX, o.dirY, TRIG_ONE);
  if (bx === 0 && by === 0) return out;
  const count = Math.max(1, o.spec.count);
  const home = count === 1 && o.spec.explodeRadius > 0 ? (o.target ?? 0) : 0;
  for (const off of spreadOffsets(count, o.spec.spread)) {
    const [rx, ry] = off === 0 ? [bx, by] : rotate(bx, by, off);
    const [vx, vy] = scaleTo(rx, ry, Math.max(1, o.spec.speed));
    const p = world.create();
    world.add(p, Projectile, {
      skill: o.skill,
      rank: o.rank,
      owner: o.owner,
      team: o.team,
      vx,
      vy,
      rangeLeft: Math.max(1, o.spec.maxRange),
      radius: Math.max(1, o.spec.radius),
      pierceLeft: Math.max(0, o.spec.pierce),
      damage: o.damage(),
      canMiss: o.canMiss,
      hit: [],
      sprite: o.spec.sprite,
      explodeRadius: Math.max(0, o.spec.explodeRadius),
      home,
    });
    world.add(p, Pos, { x: o.x, y: o.y });
    world.add(p, AreaTag, { depth: o.depth });
    out.push(p);
  }
  return out;
}

type ProjectileValue = ReturnType<typeof readProjectile>["pr"];
/**
 * A working copy of a projectile (shallow: steer() and collide() replace
 * fields and never mutate the nested damage or hit list). The system writes
 * back only the fields that changed, so a flying projectile costs a field
 * entry in the tick's undo log instead of a deep copy.
 */
function readProjectile(world: World, e: Entity) {
  const stored = world.peek(e, Projectile)!;
  return { stored, pr: { ...stored } };
}

function critFor(world: World, ctx: SimContext, owner: Entity): boolean {
  return world.exists(owner) && rollCrit(ctx.rng, world.peek(owner, CombatStats));
}

function explode(
  world: World,
  ctx: SimContext,
  grid: SpatialGrid,
  pr: ProjectileValue,
  x: number,
  y: number,
  depth: number,
): void {
  const skill = skillOf(ctx.registry, pr.skill);
  const statuses = hitStatuses(
    world,
    ctx.registry,
    pr.owner,
    skill,
    pr.rank,
    durationPctOf(world, ctx.registry, pr.owner, pr.skill),
  );
  const crit = critFor(world, ctx, pr.owner);
  for (const t of enemiesInRadius(world, grid, x, y, pr.explodeRadius, pr.team, depth)) {
    pushHit(
      world,
      makeHit(pr.owner, t, pr.skill, { ...pr.damage }, { canMiss: false, crit, statuses }),
    );
  }
  emit(ctx, {
    type: "classic.effect",
    effect: skill?.effect || pr.sprite,
    x,
    y,
    radius: pr.explodeRadius,
    points: [],
  });
}

export const projectilesSystem: SystemDef = {
  ...SYSTEM.combatProjectiles,
  run(world, ctx) {
    const list = world.query(Projectile, Pos, AreaTag);
    if (list.length === 0) return;
    const depth = currentDepth(world);
    const map = getAreaMap(world, ctx.registry);
    const grid = gridOf(world);
    for (const e of list) {
      if (world.peek(e, AreaTag)!.depth !== depth) continue;
      const { stored: was, pr } = readProjectile(world, e);
      const p = world.peek(e, Pos)!;
      if (pr.home !== 0) steer(world, ctx, pr, p, depth);
      const speed = Math.max(1, isqrt(pr.vx * pr.vx + pr.vy * pr.vy));
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(pr.vx), Math.abs(pr.vy)) / 64));
      let alive = true;
      let x = p.x;
      let y = p.y;
      for (let i = 1; i <= n && alive; i++) {
        // Exact sub-step positions along this tick's segment.
        const nx = p.x + Math.trunc((pr.vx * i) / n);
        const ny = p.y + Math.trunc((pr.vy * i) / n);
        if (!walkableSub(map, nx, ny)) {
          if (pr.explodeRadius > 0) explode(world, ctx, grid, pr, x, y, depth);
          alive = false;
          break;
        }
        x = nx;
        y = ny;
        alive = collide(world, ctx, grid, pr, x, y, depth);
      }
      if (!alive) {
        world.destroy(e);
        continue;
      }
      pr.rangeLeft -= speed;
      if (pr.rangeLeft <= 0) {
        if (pr.explodeRadius > 0) explode(world, ctx, grid, pr, x, y, depth);
        world.destroy(e);
        continue;
      }
      if (x !== p.x || y !== p.y) world.update(e, Pos, { x, y });
      writeBack(world, e, was, pr);
    }
  },
};

/** Writes the fields of the working copy `pr` that differ from the stored `was`. */
function writeBack(
  world: World,
  e: Entity,
  was: Readonly<ProjectileValue>,
  pr: ProjectileValue,
): void {
  const patch: Partial<ProjectileValue> = { rangeLeft: pr.rangeLeft };
  if (pr.vx !== was.vx || pr.vy !== was.vy) {
    patch.vx = pr.vx;
    patch.vy = pr.vy;
  }
  if (pr.home !== was.home) patch.home = pr.home;
  if (pr.pierceLeft !== was.pierceLeft) patch.pierceLeft = pr.pierceLeft;
  if (pr.hit !== was.hit) patch.hit = pr.hit;
  world.update(e, Projectile, patch);
}

/** Angle steps (of 64) a homing projectile turns per tick. */
export const HOMING_STEPS = 1;

/** Turns a homing projectile toward its target (drops the target once it is dead or gone). */
function steer(
  world: World,
  ctx: SimContext,
  pr: ProjectileValue,
  p: { x: number; y: number },
  depth: number,
): void {
  const t = pr.home;
  if (!world.exists(t) || world.has(t, Dead) || world.get(t, AreaTag)?.depth !== depth) {
    pr.home = 0;
    return;
  }
  const tp = world.get(t, Pos);
  if (!tp || (tp.x === p.x && tp.y === p.y)) return;
  const cur = angleOf(pr.vx, pr.vy);
  const want = angleOf(tp.x - p.x, tp.y - p.y);
  let d = wrapAngle(want - cur);
  if (d === 0) return;
  if (d > ANGLE_STEPS / 2) d -= ANGLE_STEPS;
  const turn = Math.max(-HOMING_STEPS, Math.min(HOMING_STEPS, d));
  // The skill's speed, not the current vector length (truncation would shrink it every turn).
  const speed =
    skillOf(ctx.registry, pr.skill)?.projectile?.speed ?? isqrt(pr.vx * pr.vx + pr.vy * pr.vy);
  [pr.vx, pr.vy] = angleVec(cur + turn, Math.max(1, speed));
}

/** Hits overlapping enemies at (x, y). Returns false when the projectile is used up. */
function collide(
  world: World,
  ctx: SimContext,
  grid: SpatialGrid,
  pr: ProjectileValue,
  x: number,
  y: number,
  depth: number,
): boolean {
  const cands = enemiesInRadius(world, grid, x, y, pr.radius, pr.team, depth, pr.hit);
  if (cands.length === 0) return true;
  if (pr.explodeRadius > 0) {
    explode(world, ctx, grid, pr, x, y, depth);
    return false;
  }
  const dist = (t: Entity): number => {
    const tp = world.peek(t, Pos)!;
    return (tp.x - x) * (tp.x - x) + (tp.y - y) * (tp.y - y);
  };
  cands.sort((a, b) => dist(a) - dist(b) || a - b);
  const skill = skillOf(ctx.registry, pr.skill);
  const durPct = durationPctOf(world, ctx.registry, pr.owner, pr.skill);
  for (const t of cands) {
    pushHit(
      world,
      makeHit(
        pr.owner,
        t,
        pr.skill,
        { ...pr.damage },
        {
          canMiss: pr.canMiss,
          crit: critFor(world, ctx, pr.owner),
          statuses: hitStatuses(world, ctx.registry, pr.owner, skill, pr.rank, durPct),
        },
      ),
    );
    pr.hit = [...pr.hit, t];
    if (pr.pierceLeft <= 0) return false;
    pr.pierceLeft--;
  }
  return true;
}
