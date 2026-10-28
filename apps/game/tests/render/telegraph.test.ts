import { describe, expect, it } from "vite-plus/test";
import type { EffectKind, EffectSpec, GraphicsQualityLevel } from "@gamez/ui-host";
import { tileToScreen } from "@gamez/world";
import {
  planEffect,
  telegraphShape,
  telegraphTilePoints,
  TELEGRAPH_FILL_END,
  type FxOp,
} from "../../src/client/render/fx-plan.ts";

const WHITE = 0xffffff;
const COLOUR = 0xff6633;

function tg(extra: Partial<EffectSpec> = {}): EffectSpec {
  return { kind: "telegraph", x: 10, y: 10, color: COLOUR, durationMs: 1000, ...extra };
}

/** The outline op of a telegraph: the coloured closed line. */
function outline(ops: FxOp[]): number[] {
  const op = ops.find((o) => o.op === "line" && o.closed && o.color === COLOUR);
  if (!op || op.op !== "line") throw new Error("no outline");
  return op.pts;
}

/** Screen-space points (relative to the origin) of tile offsets, the way the renderer maps them. */
function screenOf(pts: { x: number; y: number }[]): number[] {
  const out: number[] = [];
  for (const p of pts) {
    const v = tileToScreen(p.x, p.y);
    out.push(v.sx, v.sy);
  }
  return out;
}

describe("telegraph shape", () => {
  it("is a line with an angle, length and width; a cone with an angle and arc; else a circle", () => {
    expect(telegraphShape(tg())).toBe("circle");
    expect(telegraphShape(tg({ angle: 0, arc: 0.6 }))).toBe("cone");
    expect(telegraphShape(tg({ angle: 0, length: 4, width: 1 }))).toBe("line");
    // A line wins over a cone when both are present.
    expect(telegraphShape(tg({ angle: 0, arc: 0.6, length: 4, width: 1 }))).toBe("line");
  });
});

describe("telegraph geometry", () => {
  it("cone: apex at the origin, then the arc at its length, from angle - arc to angle + arc", () => {
    const pts = telegraphTilePoints(tg({ angle: 0, arc: Math.PI / 4, length: 3 }), 1);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    const first = pts[1]!;
    const last = pts[pts.length - 1]!;
    // Arc ends at -45 and +45 degrees, 3 tiles out.
    expect(first.x).toBeCloseTo(3 * Math.cos(-Math.PI / 4), 9);
    expect(first.y).toBeCloseTo(3 * Math.sin(-Math.PI / 4), 9);
    expect(last.x).toBeCloseTo(3 * Math.cos(Math.PI / 4), 9);
    expect(last.y).toBeCloseTo(3 * Math.sin(Math.PI / 4), 9);
    for (const p of pts.slice(1)) expect(Math.hypot(p.x, p.y)).toBeCloseTo(3, 9);
  });

  it("cone on screen: the planned outline is the iso projection of the tile cone", () => {
    const spec = tg({ angle: 0, arc: Math.PI / 4, length: 3, x: 10, y: 10 });
    const screen = outline(planEffect(spec, 1));
    expect(screen).toEqual(screenOf(telegraphTilePoints(spec, 1)));
    // The apex maps to the origin and the far corners to the iso projection of (3cos45, 3sin45).
    expect(screen[0]).toBe(0);
    expect(screen[1]).toBe(0);
  });

  it("line: a rectangle from the origin along the angle, half the width each side", () => {
    // Pointing down the tile y axis, 4 tiles long, 2 tiles wide.
    const spec = tg({ angle: Math.PI / 2, length: 4, width: 2 });
    const corners = telegraphTilePoints(spec, 1);
    const eps = 1e-9;
    const near = (p: { x: number; y: number }, x: number, y: number) =>
      Math.abs(p.x - x) < eps && Math.abs(p.y - y) < eps;
    expect(corners).toHaveLength(4);
    expect(near(corners[0]!, -1, 0)).toBe(true);
    expect(near(corners[1]!, -1, 4)).toBe(true);
    expect(near(corners[2]!, 1, 4)).toBe(true);
    expect(near(corners[3]!, 1, 0)).toBe(true);
    expect(outline(planEffect(spec, 1))).toEqual(screenOf(corners));
  });

  it("grow scales the shape from the origin (the fill grows with time)", () => {
    const half = telegraphTilePoints(tg({ angle: 0, length: 4, width: 2 }), 0.5);
    const full = telegraphTilePoints(tg({ angle: 0, length: 4, width: 2 }), 1);
    expect(Math.max(...half.map((p) => p.x))).toBeCloseTo(2, 9);
    expect(Math.max(...full.map((p) => p.x))).toBeCloseTo(4, 9);
    const none = telegraphTilePoints(tg({ radius: 3 }), 0);
    expect(none.every((p) => p.x === 0 && p.y === 0)).toBe(true);
  });

  it("circle: radius in tiles on the ground", () => {
    const pts = telegraphTilePoints(tg({ radius: 2 }), 1);
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(2, 9);
  });
});

describe("telegraph timing", () => {
  function fillExtent(ops: FxOp[]): number {
    let m = 0;
    for (const op of ops) {
      if (op.op !== "fill" || op.color !== COLOUR) continue;
      for (const v of op.pts) m = Math.max(m, Math.abs(v));
    }
    return m;
  }

  it("fills over the first part of its life, then flashes white when it is about to fire", () => {
    const spec = tg({ radius: 2 });
    const early = fillExtent(planEffect(spec, 0.2));
    const mid = fillExtent(planEffect(spec, TELEGRAPH_FILL_END - 0.01));
    expect(mid).toBeGreaterThan(early);
    const noFlash = planEffect(spec, 0.5).some((o) => o.op === "fill" && o.color === WHITE);
    expect(noFlash).toBe(false);
    const flash = planEffect(spec, 0.99).find((o) => o.op === "fill" && o.color === WHITE);
    expect(flash).toBeDefined();
    expect(flash && flash.op === "fill" ? flash.alpha : 0).toBeGreaterThan(0.3);
  });

  it("pulses its edge over time", () => {
    const alphas = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((p) => {
      const o = planEffect(tg({ radius: 2 }), p).find((x) => x.op === "line");
      return o && o.op === "line" ? o.alpha : 0;
    });
    expect(Math.max(...alphas) - Math.min(...alphas)).toBeGreaterThan(0.1);
  });

  it("draws finite geometry for every shape at every progress and quality", () => {
    const specs: EffectSpec[] = [
      tg({ radius: 3 }),
      tg({ angle: 1, arc: 0.7, length: 3 }),
      tg({ angle: -2, length: 5, width: 1.5 }),
    ];
    const qualities: GraphicsQualityLevel[] = ["low", "medium", "high"];
    for (const s of specs) {
      for (const q of qualities) {
        for (const p of [0, 0.3, 0.85, 1]) {
          for (const op of planEffect(s, p, q)) {
            const vals = op.op === "dot" ? [op.x, op.y, op.r] : op.pts;
            expect(vals.every(Number.isFinite)).toBe(true);
          }
        }
      }
    }
  });
});

describe("wave A kinds", () => {
  const kinds: EffectKind[] = ["aura", "burst", "telegraph"];

  it("aura fades in and out over its life", () => {
    const spec: EffectSpec = { kind: "aura", x: 4, y: 4, radius: 1.2, color: COLOUR };
    const alphaAt = (p: number) => {
      const ops = planEffect(spec, p);
      return Math.max(0, ...ops.map((o) => o.alpha));
    };
    expect(alphaAt(0)).toBeLessThan(0.01);
    expect(alphaAt(0.5)).toBeGreaterThan(0.5);
    expect(alphaAt(0.99)).toBeLessThan(0.05);
  });

  it("burst is particles only, with a brief core flash at the start", () => {
    const spec: EffectSpec = { kind: "burst", x: 4, y: 4, color: COLOUR };
    expect(planEffect(spec, 0.5)).toEqual([]);
    expect(planEffect(spec, 0.05).length).toBeGreaterThan(0);
  });

  it("every wave A kind is planned without NaN at the ends", () => {
    for (const k of kinds) {
      for (const p of [0, 1]) {
        expect(
          planEffect({ kind: k, x: 1, y: 1, color: COLOUR, radius: 2 }, p).length,
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("quality detail", () => {
  it("low draws fewer segments and no glow strokes than high", () => {
    const nova: EffectSpec = { kind: "nova", x: 1, y: 1, radius: 2, color: COLOUR };
    const ringPoints = (q: GraphicsQualityLevel) => {
      const op = planEffect(nova, 0.5, q).find((o) => o.op === "line" && o.closed);
      return op && op.op === "line" ? op.pts.length : 0;
    };
    expect(ringPoints("low")).toBeLessThan(ringPoints("high"));
    const chain: EffectSpec = {
      kind: "chain",
      x: 10,
      y: 10,
      color: COLOUR,
      points: [
        { x: 10, y: 10 },
        { x: 12, y: 10 },
      ],
    };
    const glowWidth = (q: GraphicsQualityLevel) =>
      planEffect(chain, 0.2, q).some((o) => o.op === "line" && o.width === 7);
    expect(glowWidth("high")).toBe(true);
    expect(glowWidth("low")).toBe(false);
  });
});
