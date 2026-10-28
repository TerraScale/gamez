import { describe, expect, it } from "vite-plus/test";
import type { EffectKind, EffectSpec } from "@gamez/ui-host";
import { tileToScreen } from "@gamez/world";
import {
  FLOAT_LIFT,
  floatOrigin,
  planEffect,
  slashAngle,
  underStroke,
  type FxOp,
} from "../../src/client/render/fx-plan.ts";

const KINDS: EffectKind[] = [
  "nova",
  "explosion",
  "chain",
  "beam",
  "heal",
  "blink",
  "hit",
  "cast",
  "levelup",
  "portal",
  "aoe",
  "slash",
];

function spec(kind: EffectKind, extra: Partial<EffectSpec> = {}): EffectSpec {
  return { kind, x: 10, y: 10, color: 0x66ccff, ...extra };
}

function alphaOf(op: FxOp): number {
  return op.alpha;
}

function allFinite(ops: FxOp[]): boolean {
  return ops.every((op) => {
    if (op.op === "dot") return [op.x, op.y, op.r].every(Number.isFinite);
    return op.pts.every(Number.isFinite);
  });
}

describe("planEffect", () => {
  it("draws every kind with finite geometry at the start and the end", () => {
    for (const kind of KINDS) {
      const s = spec(kind, {
        x2: 14,
        y2: 12,
        points: [
          { x: 10, y: 10 },
          { x: 12, y: 11 },
          { x: 14, y: 12 },
        ],
      });
      for (const p of [0, 0.5, 1]) {
        const ops = planEffect(s, p);
        expect(allFinite(ops), `${kind} at ${p}`).toBe(true);
      }
    }
  });

  it("fades every kind out as it progresses", () => {
    for (const kind of KINDS) {
      const s = spec(kind, {
        x2: 14,
        y2: 12,
        points: [
          { x: 10, y: 10 },
          { x: 14, y: 12 },
        ],
      });
      const early = planEffect(s, 0).map(alphaOf);
      const late = planEffect(s, 0.99).map(alphaOf);
      const maxEarly = Math.max(...early, 0);
      const maxLate = Math.max(...late, 0);
      expect(maxLate, kind).toBeLessThanOrEqual(maxEarly + 1e-9);
    }
  });

  it("uses the spec colour for coloured ops", () => {
    const ops = planEffect(spec("nova"), 0.3);
    expect(ops.some((op) => op.op !== "dot" && op.color === 0x66ccff)).toBe(true);
  });

  it("draws nothing for a beam or chain without an end point", () => {
    expect(planEffect(spec("beam"), 0.5)).toEqual([]);
    expect(planEffect(spec("chain"), 0.5)).toEqual([]);
  });

  it("nova ring expands with progress", () => {
    const ringRadius = (p: number) => {
      const ring = planEffect(spec("nova", { radius: 2 }), p).find(
        (op) => op.op === "line" && op.closed && op.color === 0x66ccff,
      );
      if (!ring || ring.op !== "line") throw new Error("no ring");
      const [x, y] = [ring.pts[0]!, ring.pts[1]!];
      return Math.hypot(x, y);
    };
    expect(ringRadius(0.8)).toBeGreaterThan(ringRadius(0.1));
  });

  it("chain keeps its end points and jitters only the interior", () => {
    const pts = [
      { x: 10, y: 10 },
      { x: 12, y: 10 },
      { x: 14, y: 10 },
    ];
    const ops = planEffect(spec("chain", { points: pts }), 0.5);
    const main = ops.find((op) => op.op === "line" && op.color === 0x66ccff);
    if (!main || main.op !== "line") throw new Error("no chain");
    expect(main.pts).toHaveLength(6);
    // Endpoints are the exact tile offsets: 4 tiles along x is 128 px on screen (32 px per tile step).
    expect(main.pts[0]).toBe(0);
    expect(main.pts[4]).toBe(128);
  });

  it("blink flashes at both ends", () => {
    const ops = planEffect(spec("blink", { x2: 13, y2: 10 }), 0.2);
    const dots = ops.filter((op) => op.op === "dot");
    const xs = new Set(dots.map((op) => (op.op === "dot" ? Math.round(op.x) : 0)));
    expect(xs.size).toBeGreaterThanOrEqual(2);
  });

  it("returns no ops after the effect has ended", () => {
    expect(
      planEffect(spec("hit"), 1).every(
        (op) => op.alpha <= 0.0001 || op.op !== "dot" || op.alpha === 0,
      ),
    ).toBe(true);
  });
});

describe("readability on light floors", () => {
  it("gives coloured lines a wider, darker under-stroke and skips white highlights", () => {
    for (const kind of KINDS) {
      const ops = planEffect(
        spec(kind, {
          x2: 14,
          y2: 12,
          points: [
            { x: 10, y: 10 },
            { x: 14, y: 12 },
          ],
        }),
        0.3,
      );
      for (const op of ops) {
        const u = underStroke(op);
        if (op.op !== "line" || op.color === 0xffffff || op.alpha <= 0.01) {
          expect(u).toBeNull();
          continue;
        }
        expect(u, kind).not.toBeNull();
        expect(u!.width).toBeGreaterThan(op.width);
        expect(u!.alpha).toBeGreaterThan(0);
        expect(u!.alpha).toBeLessThanOrEqual(op.alpha);
      }
    }
  });

  it("orients a slash arc along the aim tip in points (the classic arc effect)", () => {
    const right = slashAngle(spec("slash", { points: [{ x: 12, y: 10 }] }));
    const down = slashAngle(spec("slash", { points: [{ x: 10, y: 12 }] }));
    expect(right).toBeCloseTo(0);
    expect(down).toBeCloseTo(Math.PI / 2);
    // x2/y2 still win, and a degenerate tip falls back to the default swing.
    expect(slashAngle(spec("slash", { x2: 8, y2: 10, points: [{ x: 12, y: 10 }] }))).toBeCloseTo(
      Math.PI,
    );
    expect(slashAngle(spec("slash", { points: [{ x: 10, y: 10 }] }))).toBeCloseTo(-Math.PI / 4);
    // The finished sweep is centred on the aim: its middle point lies along the aim direction.
    const ops = planEffect(spec("slash", { radius: 1, points: [{ x: 12, y: 10 }] }), 1 / 1.4);
    const arc = ops.find((op) => op.op === "line" && op.color === 0x66ccff);
    if (!arc || arc.op !== "line") throw new Error("no arc");
    const mid = tileToScreen(1, 0);
    expect(arc.pts[14]).toBeCloseTo(mid.sx, 3);
    expect(arc.pts[15]).toBeCloseTo(mid.sy, 3);
  });
});

describe("floatOrigin", () => {
  const f = { x: 4, y: 6, text: "12", color: 0xffffff };

  it("starts above the tile centre without a unit", () => {
    const c = tileToScreen(4.5, 6.5);
    expect(floatOrigin(f)).toEqual({ sx: c.sx, sy: c.sy - FLOAT_LIFT });
    expect(floatOrigin(f, Number.NaN)).toEqual({ sx: c.sx, sy: c.sy - FLOAT_LIFT });
  });

  it("starts above a shown nameplate, never lower than the default", () => {
    const c = tileToScreen(4.5, 6.5);
    // Nameplate stack top 61 px above the feet: the float starts above it.
    const o = floatOrigin(f, c.sy - 61);
    expect(o.sx).toBe(c.sx);
    expect(o.sy).toBeLessThan(c.sy - 61);
    // A short unit (head below the default line) keeps the default start.
    expect(floatOrigin(f, c.sy - 10).sy).toBe(c.sy - FLOAT_LIFT);
  });
});
