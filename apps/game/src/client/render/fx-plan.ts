import { tileToScreen } from "@gamez/world";
import type { EffectSpec, FloatTextSpec } from "@gamez/ui-host";
import { clamp01, hash01 } from "./fx-math.ts";

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

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Screen offset of a tile-space offset (tileToScreen is linear, so offsets map directly). */
function tileVec(dx: number, dy: number): { x: number; y: number } {
  const v = tileToScreen(dx, dy);
  return { x: v.sx, y: v.sy };
}

/** Flat screen points of a circle drawn on the ground (an iso ellipse), radius in tiles. */
function groundCircle(r: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (TAU * i) / n;
    const v = tileVec(r * Math.cos(a), r * Math.sin(a));
    out.push(v.x, v.y);
  }
  return out;
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

/** Ops for one effect at progress p in [0, 1]. Empty when the spec cannot be drawn. */
export function planEffect(spec: EffectSpec, progress: number): FxOp[] {
  const t = clamp01(progress);
  const k = 1 - t;
  const c = spec.color;
  const R = spec.radius ?? 1.5;
  const ops: FxOp[] = [];

  switch (spec.kind) {
    case "nova": {
      const rr = R * (0.12 + 0.88 * easeOut(t));
      ops.push({ op: "fill", pts: groundCircle(rr * 0.85, 24), color: c, alpha: 0.18 * k });
      ops.push({
        op: "line",
        pts: groundCircle(rr, 32),
        closed: true,
        width: 1 + 3 * k,
        color: c,
        alpha: 0.9 * k,
      });
      ops.push({
        op: "line",
        pts: groundCircle(rr * 0.6, 24),
        closed: true,
        width: 1,
        color: WHITE,
        alpha: 0.5 * k,
      });
      break;
    }
    case "explosion": {
      const burst = R * (0.25 + 0.75 * Math.min(1, t * 1.6));
      ops.push({ op: "fill", pts: groundCircle(burst, 16), color: c, alpha: 0.55 * k });
      for (let i = 0; i < 10; i++) {
        const a = (TAU * i) / 10 + hash01(i, 7) * 0.3;
        const d = R * (0.2 + 0.9 * t);
        const v = tileVec(d * Math.cos(a), d * Math.sin(a));
        ops.push({ op: "dot", x: v.x, y: v.y, r: 1.5 + 3 * k, color: c, alpha: k });
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
          pts: groundCircle(0.2 + 0.25 * t, 16),
          closed: true,
          width: 2,
          color: c,
          alpha: k,
        });
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
        pts: groundCircle(0.4 + 0.6 * t, 24),
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
        pts: groundCircle(R * 0.9, 24),
        color: c,
        alpha: 0.25 * (1 - 0.5 * t),
      });
      for (let s = 0; s < 3; s++) {
        const pts: number[] = [];
        for (let j = 0; j < 24; j++) {
          const u = j / 23;
          const a = u * 2 * TAU + t * TAU + (s * TAU) / 3;
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
      ops.push({ op: "fill", pts: groundCircle(rr, 28), color: c, alpha: 0.22 * k + 0.04 });
      ops.push({
        op: "line",
        pts: groundCircle(rr, 28),
        closed: true,
        width: 2,
        color: c,
        alpha: 0.7 * k + 0.1,
      });
      break;
    }
    case "slash": {
      const base = hasEnd(spec)
        ? Math.atan2((spec.y2 ?? spec.y) - spec.y, (spec.x2 ?? spec.x) - spec.x)
        : -Math.PI / 4;
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
  }
  return ops;
}

/** Stage text placement: the float starts above the tile centre's head line. */
export function floatOrigin(spec: FloatTextSpec): { sx: number; sy: number } {
  const v = tileToScreen(spec.x + 0.5, spec.y + 0.5);
  return { sx: v.sx, sy: v.sy - 24 };
}
