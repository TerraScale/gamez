/**
 * classic.core.movement (update 300): advances every Mover of the current
 * area. docs/design/classic.md §5.
 *
 * Skipped: Dead, Dash holders (combat moves them), sleeping monsters
 * (Ai.state "sleep"), stunned units, and units casting anything but a
 * "pulse" skill. Effective speed = Mover.speed x CombatStats.moveSpeed% x
 * (100 - strongest slow)% (min 1 when the base speed is > 0).
 *
 * Steps per unit: follow `path` toward tile centres (popping waypoints that
 * are reached, carrying the leftover distance) or steer toward goalX/goalY;
 * wall collision on the body's four corner points with X-then-Y axis sliding;
 * soft separation from overlapping solid units (max speed/2, never into a
 * wall, monsters push the hero at most a quarter of that); `moving`, `facing`
 * and `blocked` updates; gridOf(world).move.
 *
 * Hot path (300+ units per tick): separation uses a flat per-call index of
 * the solid bodies of the area (typed arrays bucketed by 2-tile cells,
 * updated as units move) instead of one grid query per unit, so it stays
 * exact and deterministic without Map lookups per neighbour. The index is a
 * scratch buffer rebuilt from the world on every call (no state survives).
 */
import type { Entity, FrozenRegistry, SystemDef, World } from "@gamez/kernel";
import {
  Ai,
  AreaTag,
  Body,
  Casting,
  CombatStats,
  Dash,
  Dead,
  Monster,
  Mover,
  Pos,
  Statuses,
  type MoverValue,
} from "../components.ts";
import { COS64, SIN64, facingOf, isqrt, tileCenter } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth, heroOf } from "../resources.ts";
import { gridOf } from "../spatial.ts";
import { KIND, type SkillProto } from "../types.ts";
import { getAreaMap, walkableSub, type ClassicMap } from "../world/maps.ts";
import { canStand, statusProto } from "./units.ts";

/** Separation index cell size (sub). Must exceed the largest query radius + one tick of movement. */
const CELL = 512;
const CELL_SHIFT = 9;

/**
 * Scratch index of solid bodies (rebuilt by every movementSystem.run; holds
 * no state between calls).
 */
class BodyIndex {
  n = 0;
  ids = new Int32Array(64);
  xs = new Int32Array(64);
  ys = new Int32Array(64);
  rs = new Int32Array(64);
  monster = new Uint8Array(64);
  next = new Int32Array(64);
  head = new Int32Array(0);
  cols = 1;
  rows = 1;

  reset(widthTiles: number, heightTiles: number): void {
    this.n = 0;
    this.cols = Math.max(1, Math.ceil((widthTiles * 256) / CELL));
    this.rows = Math.max(1, Math.ceil((heightTiles * 256) / CELL));
    const cells = this.cols * this.rows;
    if (this.head.length < cells) this.head = new Int32Array(cells);
    this.head.fill(-1, 0, cells);
  }

  cellOf(x: number, y: number): number {
    let cx = x >> CELL_SHIFT;
    let cy = y >> CELL_SHIFT;
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  add(e: Entity, x: number, y: number, r: number, isMonster: boolean): void {
    if (this.n === this.ids.length) this.grow();
    const i = this.n++;
    this.ids[i] = e;
    this.xs[i] = x;
    this.ys[i] = y;
    this.rs[i] = r;
    this.monster[i] = isMonster ? 1 : 0;
    const c = this.cellOf(x, y);
    this.next[i] = this.head[c]!;
    this.head[c] = i;
  }

  private grow(): void {
    const size = this.ids.length * 2;
    const g32 = (a: Int32Array) => {
      const b = new Int32Array(size);
      b.set(a);
      return b;
    };
    this.ids = g32(this.ids);
    this.xs = g32(this.xs);
    this.ys = g32(this.ys);
    this.rs = g32(this.rs);
    this.next = g32(this.next);
    const m = new Uint8Array(size);
    m.set(this.monster);
    this.monster = m;
  }
}

const index = new BodyIndex();

/** Slow (0..90) of a unit from one pass over its statuses; -1 = stunned. */
function statusEffect(world: World, registry: FrozenRegistry, e: Entity, tick: number): number {
  const st = world.get(e, Statuses);
  if (!st || st.list.length === 0) return 0;
  let slow = 0;
  for (const s of st.list) {
    if (s.until <= tick) continue;
    const kind = statusProto(registry, s.id)?.kind;
    if (kind === "stun") return -1;
    if (kind === "slow" && s.power > slow) slow = s.power;
  }
  return slow > 90 ? 90 : slow;
}

/** Effective speed in sub per tick for a base speed, move-speed percent and slow percent. */
export function effectiveSpeed(base: number, moveSpeedPct: number, slow: number): number {
  if (base <= 0) return 0;
  let s = Math.floor((base * moveSpeedPct) / 100);
  if (slow > 0) s = Math.floor((s * (100 - slow)) / 100);
  return s < 1 ? 1 : s;
}

function fits(map: ClassicMap, x: number, y: number, r: number, strict: boolean): boolean {
  return strict ? canStand(map, x, y, r) : walkableSub(map, x, y);
}

/** -1 when the unit may not walk this tick, else its slow percent. `alive`: known not Dead. */
function stillAndSlow(
  world: World,
  registry: FrozenRegistry,
  e: Entity,
  tick: number,
  alive: boolean,
): number {
  if ((!alive && world.has(e, Dead)) || world.has(e, Dash)) return -1;
  const ai = world.get(e, Ai);
  if (ai !== undefined && ai.state === "sleep") return -1;
  const slow = statusEffect(world, registry, e, tick);
  if (slow < 0) return -1;
  const cast = world.has(e, Casting) ? world.get(e, Casting) : undefined;
  if (cast !== undefined && registry.get<SkillProto>(KIND.skill, cast.skill)?.shape !== "pulse") {
    return -1;
  }
  return slow;
}

export const movementSystem: SystemDef = {
  ...SYSTEM.coreMovement,
  run(world, ctx) {
    const movers = world.query(Mover);
    if (movers.length === 0) return;
    const registry = ctx.registry;
    const depth = currentDepth(world);
    const map = getAreaMap(world, registry);
    const tick = ctx.tick;

    // Solid live bodies of this area (what the spatial grid holds, solid only), by ascending id.
    index.reset(map.width, map.height);
    for (const e of world.query(Body)) {
      const b = world.read(e, Body);
      if (!b.solid || b.radius <= 0) continue;
      const a = world.get(e, AreaTag);
      if (a === undefined || a.depth !== depth || world.has(e, Dead)) continue;
      const p = world.get(e, Pos);
      if (p === undefined) continue;
      index.add(e, p.x, p.y, b.radius, world.has(e, Monster));
    }

    const hero = heroOf(world);
    const grid = gridOf(world);
    let cursor = 0;
    for (const e of movers) {
      // Both lists ascend by id: walk the index alongside the movers.
      while (cursor < index.n && index.ids[cursor]! < e) cursor++;
      const slot = cursor < index.n && index.ids[cursor] === e ? cursor : -1;
      if (slot < 0) {
        const a = world.get(e, AreaTag);
        if (a === undefined || a.depth !== depth || !world.has(e, Pos)) continue;
      }
      const m = world.read(e, Mover);
      const wants = m.path.length > 0 || m.goalX >= 0;
      // Idle units only move when pushed: skip every other read unless they overlap someone.
      if (!wants && (slot < 0 || !overlapping(slot))) {
        if (m.moving) m.moving = false;
        continue;
      }
      const slow = m.speed > 0 ? stillAndSlow(world, registry, e, tick, slot >= 0) : -1;
      let speed = 0;
      if (slow >= 0) {
        // CombatStats only matters (and is only read) when the unit walks.
        const stats = wants ? world.get(e, CombatStats) : undefined;
        speed = effectiveSpeed(m.speed, stats ? stats.moveSpeed : 100, slow);
      }
      if (speed <= 0) {
        if (m.moving) m.moving = false;
        continue;
      }
      const p = world.read(e, Pos);
      const r = slot >= 0 ? index.rs[slot]! : (world.get(e, Body)?.radius ?? 0);
      if (moveUnit(map, slot, m, p, r, speed, e === hero)) grid.move(e, p.x, p.y);
    }
  },
};

/** Moves one unit in place. Returns true when its position changed. */
function moveUnit(
  map: ClassicMap,
  self: number,
  m: MoverValue,
  p: { x: number; y: number },
  r: number,
  speed: number,
  isHero: boolean,
): boolean {
  const px = p.x;
  const py = p.y;
  // Bodies already overlapping a wall (spawned badly, knocked) use a centre-only test.
  const strict = canStand(map, px, py, r);

  // ---- 1. desired step (path, else goal)
  const path = m.path;
  const wants = path.length > 0 || m.goalX >= 0;
  let tx = px;
  let ty = py;
  let popped = 0;
  let goalReached = false;
  let budget = speed;
  while (budget > 0 && popped < path.length) {
    const wp = path[popped]!;
    const dx = tileCenter(wp.x) - tx;
    const dy = tileCenter(wp.y) - ty;
    const d = isqrt(dx * dx + dy * dy);
    if (d <= budget) {
      tx += dx;
      ty += dy;
      budget -= d;
      popped++;
    } else {
      tx += Math.trunc((dx * budget) / d);
      ty += Math.trunc((dy * budget) / d);
      budget = 0;
    }
  }
  if (budget > 0 && popped === path.length && m.goalX >= 0) {
    const dx = m.goalX - tx;
    const dy = m.goalY - ty;
    const d = isqrt(dx * dx + dy * dy);
    if (d <= budget) {
      tx = m.goalX;
      ty = m.goalY;
      goalReached = true;
    } else {
      tx += Math.trunc((dx * budget) / d);
      ty += Math.trunc((dy * budget) / d);
    }
  }

  // ---- 2. walls: full step, else X only, else Y only
  let nx = px;
  let ny = py;
  // A wall slide (only one axis fits) is not full progress: it counts as blocked below.
  let fullStep = false;
  if (tx !== px || ty !== py) {
    if (fits(map, tx, ty, r, strict)) {
      fullStep = true;
      nx = tx;
      ny = ty;
      if (popped > 0) path.splice(0, popped);
      if (goalReached) {
        m.goalX = -1;
        m.goalY = -1;
      }
    } else if (tx !== px && fits(map, tx, py, r, strict)) {
      nx = tx;
    } else if (ty !== py && fits(map, px, ty, r, strict)) {
      ny = ty;
    }
  }
  const moved = nx !== px || ny !== py;

  // ---- 3. soft separation
  let fx = nx;
  let fy = ny;
  if (self >= 0) {
    const push = separation(self, nx, ny, r, speed, isHero);
    if (push !== 0) {
      const qx = pushX;
      const qy = pushY;
      const sx = nx + qx;
      const sy = ny + qy;
      if (fits(map, sx, sy, r, strict)) {
        fx = sx;
        fy = sy;
      } else if (qx !== 0 && fits(map, sx, ny, r, strict)) {
        fx = sx;
      } else if (qy !== 0 && fits(map, nx, sy, r, strict)) {
        fy = sy;
      }
    }
    index.xs[self] = fx;
    index.ys[self] = fy;
  }

  // ---- 4. bookkeeping
  if (m.moving !== moved) m.moving = moved;
  if (moved) {
    const f = facingOf(nx - px, ny - py, m.facing);
    if (f !== m.facing) m.facing = f;
  }
  if (fullStep) {
    if (m.blocked !== 0) m.blocked = 0;
  } else if (wants) {
    // Stuck or sliding along a wall: the hero executor re-paths after BLOCKED_REPATH ticks.
    m.blocked++;
  }
  if (fx === px && fy === py) return false;
  p.x = fx;
  p.y = fy;
  return true;
}

/** True when body `self` overlaps another solid body of the index. */
function overlapping(self: number): boolean {
  const x = index.xs[self]!;
  const y = index.ys[self]!;
  const r = index.rs[self]!;
  const cx = x >> CELL_SHIFT;
  const cy = y >> CELL_SHIFT;
  for (let gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= index.rows) continue;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= index.cols) continue;
      for (let i = index.head[gy * index.cols + gx]!; i >= 0; i = index.next[i]!) {
        if (i === self) continue;
        const minD = r + index.rs[i]!;
        const dx = x - index.xs[i]!;
        const dy = y - index.ys[i]!;
        if (dx * dx + dy * dy < minD * minD) return true;
      }
    }
  }
  return false;
}

/** Output of separation() (scratch, overwritten by every call). */
let pushX = 0;
let pushY = 0;

/**
 * Push of body `self` at (x, y) away from overlapping solid neighbours, into
 * pushX/pushY: each overlap pushes by half of it, the total is capped at
 * speed/2; for the hero, pushes from monsters are capped separately at a
 * quarter of that. Returns 1 when the push is non-zero, else 0.
 */
function separation(
  self: number,
  x: number,
  y: number,
  r: number,
  speed: number,
  isHero: boolean,
): number {
  pushX = 0;
  pushY = 0;
  const limit = speed >> 1;
  if (limit <= 0 || r <= 0) return 0;
  const e = index.ids[self]!;
  const cx = x >> CELL_SHIFT;
  const cy = y >> CELL_SHIFT;
  let ax = 0;
  let ay = 0;
  let bx = 0;
  let by = 0;
  for (let gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= index.rows) continue;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= index.cols) continue;
      for (let i = index.head[gy * index.cols + gx]!; i >= 0; i = index.next[i]!) {
        if (i === self) continue;
        const minD = r + index.rs[i]!;
        let dx = x - index.xs[i]!;
        let dy = y - index.ys[i]!;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD) continue;
        let d = isqrt(d2);
        let overlap = minD - d;
        if (d === 0) {
          // Exactly stacked: split along a deterministic direction (opposite for the pair).
          const n = index.ids[i]!;
          const lo = e < n ? e : n;
          const a = ((lo * 13) % 32) + (e === lo ? 0 : 32);
          dx = COS64[a]!;
          dy = SIN64[a]!;
          d = 1024;
          overlap = minD;
        }
        const push = Math.max(1, (overlap + 1) >> 1);
        const qx = Math.trunc((dx * push) / d);
        const qy = Math.trunc((dy * push) / d);
        if (isHero && index.monster[i] === 1) {
          bx += qx;
          by += qy;
        } else {
          ax += qx;
          ay += qy;
        }
      }
    }
  }
  capInto(ax, ay, limit);
  const sx = pushX;
  const sy = pushY;
  capInto(bx, by, limit >> 2);
  pushX += sx;
  pushY += sy;
  return pushX !== 0 || pushY !== 0 ? 1 : 0;
}

/** Writes (x, y) capped to length `max` into pushX/pushY. */
function capInto(x: number, y: number, max: number): void {
  if ((x === 0 && y === 0) || max <= 0) {
    pushX = 0;
    pushY = 0;
    return;
  }
  const l2 = x * x + y * y;
  if (l2 <= max * max) {
    pushX = x;
    pushY = y;
    return;
  }
  const l = isqrt(l2);
  pushX = Math.trunc((x * max) / l);
  pushY = Math.trunc((y * max) / l);
}
