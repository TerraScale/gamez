/**
 * Telegraphs (wave A, docs/design/wave-A.md §6.1): monster skills with
 * SkillProto.telegraph do not hit when their cast fires. classic.combat.casting
 * calls placeTelegraphs(), which creates one GroundEffect entity per danger
 * zone (`once: true`, Pos = zone origin, AreaTag = current depth) and emits
 * classic.telegraph; classic.combat.effects calls fireTelegraph() at `nextAt`
 * (== until), which hits every enemy whose body overlaps the zone, emits
 * classic.effect and destroys the entity.
 *
 * - circle: nova -> around the caster; aoeTarget -> at the target point.
 *   `count` > 1 adds circles at ctx.rng points within 3 tiles of the target
 *   (re-rolled up to 4 times onto a walkable tile, else the target point).
 * - cone (arc skills): from the caster along the aim, half-width `skill.arc`
 *   steps, length `skill.range` (else the caster's attack range).
 * - line (dash skills): from the caster along the aim, length
 *   `dash.maxRange`, width `telegraph.width` (default 1 tile). When it fires
 *   the caster (if alive, free and in the area) dashes along it; the dash
 *   itself does not hit again (classic.combat.dashes skips telegraphed skills)
 *   and the line's hits carry the dash knockback.
 *
 * Damage is PRE-ROLLED at placement (rollDamage with the caster's stats at
 * that moment, one packet per zone) so a caster that dies before the zone
 * fires still deals it; telegraph hits never miss and never crit (they are
 * dodged by leaving the zone). The skill's status is rolled per target at
 * resolve time as usual.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { pushHit } from "../bus.ts";
import { AreaTag, Casting, Dash, Dead, GroundEffect, Pos } from "../components.ts";
import { emit } from "../events.ts";
import { angleDiff, angleOf, angleVec, isqrt, tiles } from "../fixed.ts";
import type { SkillProto, Team, Damage } from "../types.ts";
import type { SpatialGrid } from "../spatial.ts";
import { walkableSub, type ClassicMap } from "../world/maps.ts";
import { inArea, isStunned } from "../core/units.ts";
import {
  bodyRadius,
  DASH_KNOCKBACK,
  enemiesInRadius,
  hitStatuses,
  isEnemyOf,
  makeHit,
  MAX_BODY_RADIUS,
  skillOf,
} from "./common.ts";

type GroundEffectValue = ReturnType<typeof readGround>;
function readGround(world: World, e: Entity) {
  return world.read(e, GroundEffect);
}

/** Default line width (sub) when the telegraph has none. */
export const TELEGRAPH_LINE_WIDTH = 256;
/** Extra circles of a `count` telegraph land within this distance of the target point (sub). */
export const TELEGRAPH_SCATTER = tiles(3);

/** What casting knows about a firing cast (a subset of its Fire context). */
export interface TelegraphCast {
  world: World;
  ctx: SimContext;
  map: ClassicMap;
  depth: number;
  caster: Entity;
  team: Team;
  skillId: string;
  skill: Readonly<SkillProto>;
  rank: number;
  /** Caster position and aim point. */
  px: number;
  py: number;
  tx: number;
  ty: number;
  /** Aim angle (0..63) from the caster. */
  aim: number;
  /** Reach of arc skills (skill range, else the attack range). */
  reach: number;
  /** One pre-rolled damage packet per zone. */
  damage: () => Damage;
}

/** Places every zone of a telegraphed cast. Returns the created entities. */
export function placeTelegraphs(c: TelegraphCast): Entity[] {
  const tg = c.skill.telegraph;
  if (!tg) return [];
  const ticks = Math.max(1, tg.ticks);
  const out: Entity[] = [];
  if (tg.shape === "cone") {
    out.push(place(c, ticks, "cone", c.px, c.py, c.reach, c.aim, c.skill.arc ?? 8, c.reach, 0));
  } else if (tg.shape === "line") {
    const length = Math.max(256, c.skill.dash?.maxRange ?? c.skill.range);
    const width = Math.max(1, tg.width ?? TELEGRAPH_LINE_WIDTH);
    out.push(place(c, ticks, "line", c.px, c.py, 0, c.aim, 0, length, width));
  } else {
    const radius = c.skill.radius ?? 0;
    const atTarget = c.skill.shape === "aoeTarget";
    const ox = atTarget ? c.tx : c.px;
    const oy = atTarget ? c.ty : c.py;
    out.push(place(c, ticks, "circle", ox, oy, radius, 0, 0, 0, 0));
    const count = atTarget ? Math.max(1, tg.count ?? 1) : 1;
    for (let i = 1; i < count; i++) {
      const [x, y] = scatter(c, ox, oy);
      out.push(place(c, ticks, "circle", x, y, radius, 0, 0, 0, 0));
    }
  }
  return out;
}

/** A ctx.rng point within TELEGRAPH_SCATTER of (x, y) on a walkable tile (else (x, y)). */
function scatter(c: TelegraphCast, x: number, y: number): [number, number] {
  for (let tries = 0; tries < 4; tries++) {
    const a = c.ctx.rng.int(0, 63);
    const d = c.ctx.rng.int(tiles(1), TELEGRAPH_SCATTER);
    const [dx, dy] = angleVec(a, d);
    if (walkableSub(c.map, x + dx, y + dy)) return [x + dx, y + dy];
  }
  return [x, y];
}

function place(
  c: TelegraphCast,
  ticks: number,
  shape: "circle" | "cone" | "line",
  x: number,
  y: number,
  radius: number,
  angle: number,
  arc: number,
  length: number,
  width: number,
): Entity {
  const w = c.world;
  const tick = c.ctx.tick;
  const e = w.create();
  w.add(e, GroundEffect, {
    skill: c.skillId,
    rank: c.rank,
    owner: c.caster,
    team: c.team,
    radius,
    until: tick + ticks,
    nextAt: tick + ticks,
    every: 1,
    damage: c.damage(),
    effect: c.skill.effect,
    once: true,
    shape,
    angle,
    arc,
    length,
    width,
    placedAt: tick,
  });
  w.add(e, Pos, { x, y });
  w.add(e, AreaTag, { depth: c.depth });
  emit(c.ctx, {
    type: "classic.telegraph",
    entity: e,
    caster: c.caster,
    skill: c.skillId,
    effect: c.skill.effect,
    shape,
    x,
    y,
    radius,
    angle,
    arc,
    length,
    width,
    ticks,
    fireAt: tick + ticks,
  });
  return e;
}

/** Squared distance from (px, py) to the segment (ax, ay)-(ax + dx, ay + dy) compared with r. */
export function nearSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  r: number,
): boolean {
  const rx = px - ax;
  const ry = py - ay;
  const len2 = dx * dx + dy * dy;
  const dot = rx * dx + ry * dy;
  if (len2 === 0 || dot <= 0) return rx * rx + ry * ry <= r * r;
  if (dot >= len2) {
    const ex = px - (ax + dx);
    const ey = py - (ay + dy);
    return ex * ex + ey * ey <= r * r;
  }
  // Perpendicular distance: cross^2 / len2 <= r^2 (exact in integers at map scale).
  const cross = rx * dy - ry * dx;
  return cross * cross <= r * r * len2;
}

/**
 * Enemies of the zone's team whose body overlaps the zone (sorted by id):
 * circle dist <= radius + body; cone dist <= length + body and the angle to
 * the unit within `arc` of `angle`; line distance to the segment <= width/2 + body.
 */
export function zoneTargets(
  world: World,
  grid: SpatialGrid,
  g: GroundEffectValue,
  x: number,
  y: number,
  depth: number,
): Entity[] {
  const shape = g.shape ?? "circle";
  if (shape === "circle") return enemiesInRadius(world, grid, x, y, g.radius, g.team, depth);
  const angle = g.angle ?? 0;
  const length = g.length ?? 0;
  if (shape === "cone") {
    const arc = g.arc ?? 8;
    return enemiesInRadius(world, grid, x, y, length, g.team, depth).filter((t) => {
      const tp = world.read(t, Pos);
      if (tp.x === x && tp.y === y) return true;
      return angleDiff(angleOf(tp.x - x, tp.y - y), angle) <= arc;
    });
  }
  const [dx, dy] = angleVec(angle, length);
  const half = Math.floor((g.width ?? TELEGRAPH_LINE_WIDTH) / 2);
  const mx = x + Math.trunc(dx / 2);
  const my = y + Math.trunc(dy / 2);
  const out: Entity[] = [];
  for (const t of grid.query(mx, my, Math.ceil(length / 2) + half + MAX_BODY_RADIUS)) {
    if (!isEnemyOf(world, t, g.team, depth)) continue;
    const tp = world.read(t, Pos);
    if (nearSegment(tp.x, tp.y, x, y, dx, dy, half + bodyRadius(world, t))) out.push(t);
  }
  return out;
}

/**
 * Fires a telegraph: hits, the classic.effect, the line dash, then destroys
 * the entity. Called by classic.combat.effects when tick >= nextAt.
 */
export function fireTelegraph(
  world: World,
  ctx: SimContext,
  grid: SpatialGrid,
  e: Entity,
  depth: number,
): void {
  const g = world.read(e, GroundEffect);
  const p = world.read(e, Pos);
  const shape = g.shape ?? "circle";
  const skill = skillOf(ctx.registry, g.skill);
  const statuses = hitStatuses(world, ctx.registry, g.owner, skill, g.rank);
  const knockback = shape === "line" ? DASH_KNOCKBACK : 0;
  for (const t of zoneTargets(world, grid, g, p.x, p.y, depth)) {
    pushHit(
      world,
      makeHit(
        g.owner,
        t,
        g.skill,
        { ...g.damage },
        { canMiss: false, crit: false, statuses, knockback },
      ),
    );
  }
  const points: { x: number; y: number }[] = [];
  let radius = g.radius;
  if (shape !== "circle") {
    const length = g.length ?? 0;
    const [ax, ay] = angleVec(g.angle ?? 0, length);
    points.push({ x: p.x + ax, y: p.y + ay });
    radius = shape === "cone" ? length : Math.floor((g.width ?? TELEGRAPH_LINE_WIDTH) / 2);
  }
  emit(ctx, { type: "classic.effect", effect: g.effect, x: p.x, y: p.y, radius, points });
  if (shape === "line" && points.length > 0) dashAlong(world, ctx, g, points[0]!, depth);
  world.destroy(e);
}

/** The caster of a line telegraph rushes to the line's end (when it still can). */
function dashAlong(
  world: World,
  ctx: SimContext,
  g: GroundEffectValue,
  tip: { x: number; y: number },
  depth: number,
): void {
  const c = g.owner;
  if (c === 0 || !world.exists(c) || !world.has(c, Pos) || world.has(c, Dead)) return;
  if (!inArea(world, c, depth) || world.has(c, Dash) || world.has(c, Casting)) return;
  if (isStunned(world, ctx.registry, c, ctx.tick)) return;
  const skill = skillOf(ctx.registry, g.skill);
  const speed = Math.max(1, skill?.dash?.speed ?? 140);
  const cp = world.read(c, Pos);
  const len = isqrt((tip.x - cp.x) * (tip.x - cp.x) + (tip.y - cp.y) * (tip.y - cp.y));
  if (len === 0) return;
  world.add(c, Dash, {
    skill: g.skill,
    rank: g.rank,
    target: 0,
    tx: tip.x,
    ty: tip.y,
    speed,
    until: ctx.tick + Math.ceil(len / speed) + 2,
  });
}
