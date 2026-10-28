/**
 * Telegraph dodging (wave-A.md §6.1, §8): a live monster telegraph is a
 * GroundEffect with `once: true` and team "monster" that hits every enemy
 * overlapping its zone at `nextAt`. When the hero stands inside one (plus a
 * safety margin) the controller walks to the nearest walkable tile outside
 * every live zone, right after potions and before anything else.
 *
 * Zone geometry follows classic.combat (circle: distance <= radius + body;
 * cone: within length + body and the angle within `arc`; line: distance to
 * the segment <= width/2 + body), all integer maths.
 */
import { AreaTag, Body, GroundEffect, Pos } from "../components.ts";
import { angleDiff, angleOf, angleVec } from "../fixed.ts";
import { lineOfSight, walkableAt } from "../world/maps.ts";
import { moveTo, setPlan, type AutoCtx } from "./util.ts";

/** Extra distance (sub) kept from a zone's edge. */
export const DODGE_MARGIN = 64;
/** Escape tiles are searched within this many tiles of the hero. */
export const DODGE_SEARCH_TILES = 6;
/** Default line width (sub) when a telegraph has none (classic.combat's default). */
const LINE_WIDTH = 256;
/** Default hero body radius (sub). */
const HERO_BODY = 96;

export interface Zone {
  x: number;
  y: number;
  shape: "circle" | "cone" | "line";
  radius: number;
  angle: number;
  arc: number;
  length: number;
  width: number;
  fireAt: number;
}

/** Live monster telegraphs of the current area (ascending ids). */
export function liveZones(c: AutoCtx): Zone[] {
  const out: Zone[] = [];
  for (const e of c.world.query(GroundEffect, Pos, AreaTag)) {
    if (c.world.read(e, AreaTag).depth !== c.depth) continue;
    const g = c.world.read(e, GroundEffect);
    if (g.once !== true || g.team !== "monster" || g.nextAt < c.tick) continue;
    const p = c.world.read(e, Pos);
    out.push({
      x: p.x,
      y: p.y,
      shape: g.shape ?? "circle",
      radius: g.radius,
      angle: g.angle ?? 0,
      arc: g.arc ?? 8,
      length: g.length ?? 0,
      width: g.width ?? LINE_WIDTH,
      fireAt: g.nextAt,
    });
  }
  return out;
}

function nearSegment(
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
  const cross = rx * dy - ry * dx;
  return cross * cross <= r * r * len2;
}

/** True when a body of radius `body` at (x, y) overlaps `z` (grown by `margin`). */
export function inZone(z: Zone, x: number, y: number, body: number, margin: number): boolean {
  const dx = x - z.x;
  const dy = y - z.y;
  const d2 = dx * dx + dy * dy;
  switch (z.shape) {
    case "circle": {
      const r = z.radius + body + margin;
      return d2 <= r * r;
    }
    case "cone": {
      const r = z.length + body + margin;
      if (d2 > r * r) return false;
      if (dx === 0 && dy === 0) return true;
      // Close to the apex the body overlaps whatever its angle.
      if (d2 <= (body + margin) * (body + margin)) return true;
      return angleDiff(angleOf(dx, dy), z.angle) <= z.arc + 1;
    }
    case "line": {
      const [lx, ly] = angleVec(z.angle, z.length);
      return nearSegment(x, y, z.x, z.y, lx, ly, Math.floor(z.width / 2) + body + margin);
    }
  }
}

function heroBody(c: AutoCtx): number {
  return c.world.get(c.hero, Body)?.radius ?? HERO_BODY;
}

/** The nearest walkable tile (in sight) whose centre is outside every zone, or null. */
export function escapeTile(c: AutoCtx, zones: readonly Zone[]): { x: number; y: number } | null {
  const body = heroBody(c);
  let best: { x: number; y: number } | null = null;
  let bestD = Number.MAX_SAFE_INTEGER;
  for (let r = 1; r <= DODGE_SEARCH_TILES; r++) {
    for (let ty = c.ty - r; ty <= c.ty + r; ty++) {
      for (let tx = c.tx - r; tx <= c.tx + r; tx++) {
        if (Math.max(Math.abs(tx - c.tx), Math.abs(ty - c.ty)) !== r) continue;
        if (!walkableAt(c.map, tx, ty)) continue;
        const px = (tx << 8) + 128;
        const py = (ty << 8) + 128;
        const dx = px - c.hx;
        const dy = py - c.hy;
        const d = dx * dx + dy * dy;
        if (d >= bestD) continue;
        if (zones.some((z) => inZone(z, px, py, body, DODGE_MARGIN))) continue;
        if (!lineOfSight(c.map, c.hx, c.hy, px, py)) continue;
        best = { x: tx, y: ty };
        bestD = d;
      }
    }
    // The first ring with a safe tile wins (its nearest tile).
    if (best) return best;
  }
  return best;
}

/**
 * Step 3b: steps out of a live monster telegraph the hero stands in. True
 * when it ordered a move (nothing else runs this tick).
 */
export function dodgeStep(c: AutoCtx): boolean {
  if (c.depth === 0) return false;
  const zones = liveZones(c);
  if (zones.length === 0) return false;
  const body = heroBody(c);
  if (!zones.some((z) => inZone(z, c.hx, c.hy, body, DODGE_MARGIN))) return false;
  const tile = escapeTile(c, zones);
  if (!tile) return false;
  setPlan(c, "recover", "dodge");
  moveTo(c, tile.x, tile.y);
  return true;
}
