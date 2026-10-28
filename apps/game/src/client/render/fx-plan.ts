import { tileToScreen } from "@gamez/world";
import type { EffectSpec, FloatTextSpec, GraphicsQualityLevel } from "@gamez/ui-host";
import { clamp01, hash01 } from "./fx-math.ts";
import { glowEnabled, segmentFactor } from "./quality.ts";

/**
 * Pure geometry for one-shot effects. `planEffect` turns an EffectSpec and a
 * progress value p (0..1) into screen-space draw ops relative to the effect's
 * origin, which the Pixi layer executes with a pooled Graphics. Nothing here
 * touches Pixi, so the shapes are unit-tested.
 */
export type FxOp =
  | { op: "line"; pts: number[]; closed: boolean; width: number; color: number; alpha: number }
  | { op: "fill"; pts: number[]; color: number; alpha: number }
  | { op: "dot"; x: number; y: number; r: number; color: number; alpha: number };

const TAU = Math.PI * 2;
const WHITE = 0xffffff;

/** Telegraphs fill for this share of their life, then flash until they fire. */
export const TELEGRAPH_FILL_END = 0.85;

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Screen offset of a tile-space offset (tileToScreen is linear, so offsets map directly). */
function tileVec(dx: number, dy: number): { x: number; y: number } {
  const v = tileToScreen(dx, dy);
  return { x: v.sx, y: v.sy };
}

/**
 * Flat screen points of a circle drawn on the ground (an iso ellipse), radius
 * in tiles. `q` scales the segment count at low quality.
 */
function groundCircle(r: number, n: number, q: GraphicsQualityLevel = "high"): number[] {
  const seg = segments(n, q);
  const out: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (TAU * i) / seg;
    const v = tileVec(r * Math.cos(a), r * Math.sin(a));
    out.push(v.x, v.y);
  }
  return out;
}

function segments(n: number, q: GraphicsQualityLevel): number {
  return Math.max(6, Math.round(n * segmentFactor(q)));
}

/**
 * Flat screen points of a path through tile positions, relative to (ox, oy).
 * Interior points get deterministic jitter that changes a few times per effect.
 */
function jitteredPath(
  pts: readonly { x: number; y: number }[],
  ox: number,
  oy: number,
  t: number,
  amp: number,
): number[] {
  const out: number[] = [];
  const phase = Math.floor(t * 12);
  const last = pts.length - 1;
  for (let i = 0; i <= last; i++) {
    const p = pts[i];
    if (!p) continue;
    const v = tileVec(p.x - ox, p.y - oy);
    let jx = 0;
    let jy = 0;
    if (i > 0 && i < last) {
      const j = (hash01(i, phase) - 0.5) * 2 * amp * (1 - t);
      jx = j;
      jy = j * 0.5;
    }
    out.push(v.x + jx, v.y + jy);
  }
  return out;
}

/** Sample points on the tile segment a→b (inclusive), for jittered beams. */
function segmentPoints(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  n: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    out.push({ x: ax + (bx - ax) * u, y: ay + (by - ay) * u });
  }
  return out;
}

function hasEnd(spec: EffectSpec): boolean {
  return spec.x2 !== undefined && spec.y2 !== undefined;
}

/**
 * Aim of a slash/arc in tile space (radians): the end point when given, else
 * the aim tip in `points` (the classic arc effect sends [{x, y}] = the tip; a
 * longer list uses its last point), else a fixed up-right swing.
 */
export function slashAngle(spec: EffectSpec): number {
  if (hasEnd(spec)) {
    const dx = (spec.x2 ?? spec.x) - spec.x;
    const dy = (spec.y2 ?? spec.y) - spec.y;
    if (dx !== 0 || dy !== 0) return Math.atan2(dy, dx);
  }
  const pts = spec.points;
  const tip = pts && pts.length > 0 ? pts[pts.length - 1] : undefined;
  if (tip) {
    const dx = tip.x - spec.x;
    const dy = tip.y - spec.y;
    if (dx !== 0 || dy !== 0) return Math.atan2(dy, dx);
  }
  return -Math.PI / 4;
}

// ---------------------------------------------------------------------------
// Telegraphs: ground danger zones (boss attacks) in tile space.
// ---------------------------------------------------------------------------

export type TelegraphShape = "circle" | "cone" | "line";

/**
 * Shape of a telegraph: a line when it has an angle, a length and a width; a
 * cone when it has an angle and a half-width (`arc`); else a circle.
 */
export function telegraphShape(spec: EffectSpec): TelegraphShape {
  if (spec.angle !== undefined && spec.length !== undefined && spec.width !== undefined) {
    return "line";
  }
  if (spec.angle !== undefined && spec.arc !== undefined) return "cone";
  return "circle";
}

/**
 * Outline of a telegraph in TILE space, as offsets from the zone origin (x, y).
 * `grow` 0..1 scales the shape from its origin (the fill grows over the
 * telegraph's life). Cones and lines are exact: a cone is the apex plus the
 * arc at its radius; a line is the rectangle from the origin along `angle`.
 */
export function telegraphTilePoints(spec: EffectSpec, grow = 1): { x: number; y: number }[] {
  const g = Math.max(0, Math.min(1, grow));
  const shape = telegraphShape(spec);
  if (shape === "circle") {
    const r = (spec.radius ?? 1.5) * g;
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < 32; i++) {
      const a = (TAU * i) / 32;
      out.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    return out;
  }
  if (shape === "cone") {
    const a0 = spec.angle ?? 0;
    const half = spec.arc ?? Math.PI / 4;
    const r = (spec.length ?? spec.radius ?? 3) * g;
    const out: { x: number; y: number }[] = [{ x: 0, y: 0 }];
    const n = 16;
    for (let i = 0; i <= n; i++) {
      const a = a0 - half + (2 * half * i) / n;
      out.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    return out;
  }
  const a = spec.angle ?? 0;
  const len = (spec.length ?? spec.radius ?? 3) * g;
  const hw = (spec.width ?? 1) / 2;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const nx = -dy * hw;
  const ny = dx * hw;
  return [
    { x: nx, y: ny },
    { x: dx * len + nx, y: dy * len + ny },
    { x: dx * len - nx, y: dy * len - ny },
    { x: -nx, y: -ny },
  ];
}

/** Screen-space flat points of a telegraph outline at grow (relative to the origin). */
function telegraphScreen(spec: EffectSpec, grow: number): number[] {
  const tile = telegraphTilePoints(spec, grow);
  const out: number[] = [];
  for (const p of tile) {
    const v = tileVec(p.x, p.y);
    out.push(v.x, v.y);
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Ops for one effect at progress p in [0, 1]. Empty when the spec cannot be drawn. */
export function planEffect(
  spec: EffectSpec,
  progress: number,
  quality: GraphicsQualityLevel = "high",
): FxOp[] {
  const t = clamp01(progress);
  const k = 1 - t;
  const c = spec.color;
  const R = spec.radius ?? 1.5;
  const glow = glowEnabled(quality);
  const ops: FxOp[] = [];

  switch (spec.kind) {
    case "nova": {
      const rr = R * (0.12 + 0.88 * easeOut(t));
      ops.push({
        op: "fill",
        pts: groundCircle(rr * 0.85, 24, quality),
        color: c,
        alpha: 0.18 * k,
      });
      ops.push({
        op: "line",
        pts: groundCircle(rr, 32, quality),
        closed: true,
        width: 1 + 3 * k,
        color: c,
        alpha: 0.9 * k,
      });
      ops.push({
        op: "line",
        pts: groundCircle(rr * 0.6, 24, quality),
        closed: true,
        width: 1,
        color: WHITE,
        alpha: 0.5 * k,
      });
      if (glow) {
        ops.push({
          op: "line",
          pts: groundCircle(rr * 1.02, 32, quality),
          closed: true,
          width: 7 + 6 * k,
          color: c,
          alpha: 0.22 * k,
        });
      }
      break;
    }
    case "explosion": {
      const burst = R * (0.25 + 0.75 * Math.min(1, t * 1.6));
      ops.push({ op: "fill", pts: groundCircle(burst, 16, quality), color: c, alpha: 0.55 * k });
      // Flash: a white core that dies in the first quarter of the life.
      if (t < 0.25) {
        const f = 1 - t / 0.25;
        ops.push({
          op: "fill",
          pts: groundCircle(R * 0.7 * (0.6 + 0.4 * f), 14, quality),
          color: WHITE,
          alpha: 0.7 * f,
        });
      }
      // Debris: dots flung out and falling back to the ground.
      for (let i = 0; i < 10; i++) {
        const a = (TAU * i) / 10 + hash01(i, 7) * 0.3;
        const d = R * (0.2 + 0.9 * t);
        const v = tileVec(d * Math.cos(a), d * Math.sin(a));
        // Debris arcs up and back down over the life.
        ops.push({ op: "dot", x: v.x, y: v.y - 24 * t * k, r: 1.5 + 3 * k, color: c, alpha: k });
      }
      ops.push({ op: "dot", x: 0, y: 0, r: 2 + 10 * k, color: WHITE, alpha: 0.8 * k });
      break;
    }
    case "chain": {
      const pts = spec.points && spec.points.length >= 2 ? spec.points : null;
      const path =
        pts ??
        (hasEnd(spec)
          ? [
              { x: spec.x, y: spec.y },
              { x: spec.x2 ?? spec.x, y: spec.y2 ?? spec.y },
            ]
          : null);
      if (!path || path.length < 2) break;
      const flat = jitteredPath(path, spec.x, spec.y, t, 6);
      ops.push({
        op: "line",
        pts: flat,
        closed: false,
        width: 2 + 2 * k,
        color: c,
        alpha: 0.4 + 0.5 * k,
      });
      if (glow) {
        // Glow: a wide soft stroke under the zigzag.
        ops.push({ op: "line", pts: flat, closed: false, width: 7, color: c, alpha: 0.2 * k });
      }
      ops.push({ op: "line", pts: flat, closed: false, width: 1, color: WHITE, alpha: 0.8 * k });
      break;
    }
    case "beam": {
      if (!hasEnd(spec)) break;
      const path = segmentPoints(spec.x, spec.y, spec.x2 ?? spec.x, spec.y2 ?? spec.y, 6);
      const flat = jitteredPath(path, spec.x, spec.y, t, 4);
      ops.push({
        op: "line",
        pts: flat,
        closed: false,
        width: 3 + 3 * k,
        color: c,
        alpha: 0.5 + 0.4 * k,
      });
      if (glow) {
        ops.push({ op: "line", pts: flat, closed: false, width: 10, color: c, alpha: 0.18 * k });
      }
      ops.push({ op: "line", pts: flat, closed: false, width: 1, color: WHITE, alpha: 0.9 * k });
      break;
    }
    case "heal": {
      ops.push({ op: "dot", x: 0, y: 0, r: 4 + 10 * k, color: c, alpha: 0.2 * k });
      for (let i = 0; i < 7; i++) {
        const a = (TAU * i) / 7 + hash01(i, 3) * TAU;
        const rise = t * 48 * (0.6 + 0.4 * hash01(i, 5));
        ops.push({
          op: "dot",
          x: Math.cos(a) * 12 * R,
          y: -rise + Math.sin(a) * 4,
          r: 1 + 2.5 * k,
          color: c,
          alpha: k,
        });
      }
      break;
    }
    case "blink": {
      const ends = hasEnd(spec)
        ? [{ x: 0, y: 0 }, tileVec((spec.x2 ?? spec.x) - spec.x, (spec.y2 ?? spec.y) - spec.y)]
        : [{ x: 0, y: 0 }];
      for (const e of ends) {
        ops.push({ op: "dot", x: e.x, y: e.y, r: 4 + 14 * k, color: c, alpha: 0.85 * k });
        ops.push({ op: "dot", x: e.x, y: e.y, r: 2 + 4 * k, color: WHITE, alpha: k });
        ops.push({
          op: "line",
          pts: groundCircle(0.2 + 0.25 * t, 16, quality),
          closed: true,
          width: 2,
          color: c,
          alpha: k,
        });
        // Swirl: two spiral arms that unwind as the blink fades.
        if (quality !== "low") {
          for (let arm = 0; arm < 2; arm++) {
            const pts: number[] = [];
            for (let j = 0; j <= 10; j++) {
              const u = j / 10;
              const a = u * TAU * 1.5 + t * TAU + arm * Math.PI;
              const r = 0.05 + 0.3 * u * (0.5 + 0.5 * t);
              const v = tileVec(r * Math.cos(a), r * Math.sin(a));
              pts.push(e.x + v.x, e.y + v.y);
            }
            ops.push({ op: "line", pts, closed: false, width: 1.5, color: c, alpha: 0.8 * k });
          }
        }
      }
      break;
    }
    case "hit": {
      const len = 4 + 10 * t;
      for (let i = 0; i < 6; i++) {
        const a = (TAU * i) / 6 + 0.3;
        ops.push({
          op: "line",
          pts: [0, 0, Math.cos(a) * len, Math.sin(a) * len * 0.6],
          closed: false,
          width: 0.5 + 2 * k,
          color: c,
          alpha: k,
        });
      }
      ops.push({ op: "dot", x: 0, y: 0, r: 1 + 3 * k, color: WHITE, alpha: k });
      break;
    }
    case "cast": {
      ops.push({ op: "dot", x: 0, y: 0, r: 6 + 14 * t, color: c, alpha: 0.8 * k });
      ops.push({ op: "dot", x: 0, y: 0, r: 3 * k, color: WHITE, alpha: 0.9 * k });
      break;
    }
    case "levelup": {
      const top = -(40 + 90 * Math.min(1, t * 1.5));
      ops.push({
        op: "fill",
        pts: [-9, 0, 9, 0, 9, top, -9, top],
        color: c,
        alpha: 0.45 * k,
      });
      ops.push({
        op: "line",
        pts: groundCircle(0.4 + 0.6 * t, 24, quality),
        closed: true,
        width: 2,
        color: c,
        alpha: k,
      });
      for (let i = 0; i < 4; i++) {
        const y = top * (0.3 + 0.2 * i + 0.1 * t);
        ops.push({
          op: "dot",
          x: (i % 2 === 0 ? -1 : 1) * 12,
          y,
          r: 2 + 2 * k,
          color: WHITE,
          alpha: k,
        });
      }
      break;
    }
    case "portal": {
      ops.push({
        op: "fill",
        pts: groundCircle(R * 0.9, 24, quality),
        color: c,
        alpha: 0.25 * (1 - 0.5 * t),
      });
      const arms = quality === "low" ? 2 : 3;
      for (let s = 0; s < arms; s++) {
        const pts: number[] = [];
        for (let j = 0; j < 24; j++) {
          const u = j / 23;
          const a = u * 2 * TAU + t * TAU + (s * TAU) / arms;
          const r = R * (0.15 + 0.85 * (1 - u)) * (1 - 0.2 * t);
          const v = tileVec(r * Math.cos(a), r * Math.sin(a));
          pts.push(v.x, v.y);
        }
        ops.push({ op: "line", pts, closed: false, width: 2.2, color: c, alpha: 0.9 * k });
      }
      break;
    }
    case "aoe": {
      const rr = R * Math.min(1, 0.3 + t * 1.4);
      ops.push({
        op: "fill",
        pts: groundCircle(rr, 28, quality),
        color: c,
        alpha: 0.22 * k + 0.04,
      });
      ops.push({
        op: "line",
        pts: groundCircle(rr, 28, quality),
        closed: true,
        width: 2,
        color: c,
        alpha: 0.7 * k + 0.1,
      });
      break;
    }
    case "slash": {
      const base = slashAngle(spec);
      const start = base - 0.9;
      const sweep = 1.8 * Math.min(1, t * 1.4);
      const arc = (radius: number): number[] => {
        const out: number[] = [];
        for (let i = 0; i <= 14; i++) {
          const a = start + (sweep * i) / 14;
          const v = tileVec(radius * Math.cos(a), radius * Math.sin(a));
          out.push(v.x, v.y);
        }
        return out;
      };
      ops.push({
        op: "line",
        pts: arc(R),
        closed: false,
        width: 1 + 5 * k,
        color: c,
        alpha: 0.95 * k,
      });
      if (glow) {
        ops.push({ op: "line", pts: arc(R), closed: false, width: 9, color: c, alpha: 0.2 * k });
      }
      ops.push({
        op: "line",
        pts: arc(R * 0.7),
        closed: false,
        width: 1,
        color: WHITE,
        alpha: 0.6 * k,
      });
      break;
    }
    case "telegraph": {
      // Fill grows to the full shape by TELEGRAPH_FILL_END, pulses, then flashes until it fires.
      const grow = easeOut(Math.min(1, t / TELEGRAPH_FILL_END));
      const flash =
        t >= TELEGRAPH_FILL_END ? (t - TELEGRAPH_FILL_END) / (1 - TELEGRAPH_FILL_END) : 0;
      const pulse = 0.5 + 0.5 * Math.sin(t * TAU * 4);
      const outline = telegraphScreen(spec, 1);
      const fillPts = telegraphScreen(spec, grow);
      ops.push({ op: "fill", pts: fillPts, color: c, alpha: 0.16 + 0.22 * grow });
      ops.push({
        op: "line",
        pts: outline,
        closed: true,
        width: 1.5 + pulse,
        color: c,
        alpha: 0.45 + 0.4 * pulse,
      });
      if (flash > 0) {
        ops.push({ op: "fill", pts: outline, color: WHITE, alpha: 0.6 * flash });
      }
      break;
    }
    case "aura": {
      // A lingering ring that fades in and out over its life.
      const a = Math.sin(Math.PI * t);
      const rr = R * (0.92 + 0.08 * Math.sin(t * TAU * 2));
      ops.push({ op: "fill", pts: groundCircle(rr * 0.9, 24, quality), color: c, alpha: 0.12 * a });
      ops.push({
        op: "line",
        pts: groundCircle(rr, 32, quality),
        closed: true,
        width: 2,
        color: c,
        alpha: 0.7 * a,
      });
      ops.push({
        op: "line",
        pts: groundCircle(rr * 0.55, 20, quality),
        closed: true,
        width: 1,
        color: c,
        alpha: 0.35 * a,
      });
      break;
    }
    case "burst":
      // Particles only (see ParticleLayer); a brief core flash keeps the impact readable.
      if (t < 0.2) {
        ops.push({
          op: "dot",
          x: 0,
          y: 0,
          r: 4 + 6 * (1 - t / 0.2),
          color: WHITE,
          alpha: 0.7 * (1 - t / 0.2),
        });
      }
      break;
  }
  return ops;
}

/** Default float start above the tile centre (px), and the gap kept above a unit's nameplate. */
export const FLOAT_LIFT = 24;
export const FLOAT_NAME_GAP = 2;

/**
 * Float text placement: above the tile centre's head line, or, when the float
 * belongs to a unit with something drawn over its head (`headTop` = world-local
 * y of the top of its nameplate stack, health bar or head; NaN = none), just
 * above that, so damage numbers never cover a name. Never lower than the
 * default.
 */
export function floatOrigin(spec: FloatTextSpec, headTop = Number.NaN): { sx: number; sy: number } {
  const v = tileToScreen(spec.x + 0.5, spec.y + 0.5);
  const base = v.sy - FLOAT_LIFT;
  const sy = Number.isFinite(headTop) ? Math.min(base, headTop - FLOAT_NAME_GAP) : base;
  return { sx: v.sx, sy };
}

/** Dark under-stroke drawn beneath coloured effect lines so they read on light floors too. */
export const UNDER_COLOUR = 0x000000;
export const UNDER_EXTRA_PX = 2;
export const UNDER_ALPHA = 0.4;
/** Coloured effect lines are drawn at least this wide (px), so their hue reads over the under-stroke. */
export const LINE_MIN_PX = 1.5;

/**
 * Width and opacity of the dark under-stroke for a line op, or null for none
 * (white highlight lines, which sit inside a coloured line, and invisible ops).
 */
export function underStroke(op: FxOp): { width: number; alpha: number } | null {
  if (op.op !== "line" || op.color === WHITE || op.alpha <= 0.01) return null;
  const width = Math.max(LINE_MIN_PX, op.width);
  return { width: width + UNDER_EXTRA_PX, alpha: Math.min(1, op.alpha * UNDER_ALPHA) };
}
