import { describe, expect, it } from "vite-plus/test";
import {
  barFill,
  clamp01,
  effectDuration,
  entityTint,
  floatFontSize,
  floatPose,
  hash01,
  lightLayout,
  mixTint,
  pulseAmount,
} from "../../src/client/render/fx-math.ts";

describe("floatPose", () => {
  it("starts at the origin and fully visible", () => {
    expect(floatPose(0, 900)).toEqual({ dy: 0, alpha: 1 });
  });

  it("rises about 40 px and fades to zero by the end of its life", () => {
    const end = floatPose(900, 900);
    expect(end.dy).toBeCloseTo(-40, 9);
    expect(end.alpha).toBe(0);
    const mid = floatPose(450, 900);
    expect(mid.dy).toBeLessThan(0);
    expect(mid.dy).toBeGreaterThan(-40);
    expect(mid.alpha).toBe(1);
  });

  it("clamps past the end of its life", () => {
    expect(floatPose(5000, 900)).toEqual({ dy: -40, alpha: 0 });
  });
});

describe("floatFontSize", () => {
  it("maps the three sizes to growing font sizes", () => {
    expect(floatFontSize("s")).toBeLessThan(floatFontSize("m"));
    expect(floatFontSize("m")).toBeLessThan(floatFontSize("l"));
    expect(floatFontSize(undefined)).toBe(floatFontSize("m"));
  });
});

describe("effectDuration", () => {
  it("uses the kind default when none is given", () => {
    expect(effectDuration("nova", undefined)).toBeGreaterThanOrEqual(400);
    expect(effectDuration("nova", undefined)).toBeLessThanOrEqual(700);
  });

  it("clamps requested durations to 150..3000 ms", () => {
    expect(effectDuration("nova", 10)).toBe(150);
    expect(effectDuration("nova", 90_000)).toBe(3000);
    expect(effectDuration("nova", 512.4)).toBe(512);
    expect(effectDuration("nova", Number.NaN)).toBe(effectDuration("nova", undefined));
  });
});

describe("tint", () => {
  it("mixes channels and rounds to integers", () => {
    expect(mixTint(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mixTint(0x112233, 0x112233, 0.9)).toBe(0x112233);
    expect(mixTint(0x000000, 0xff0000, 1)).toBe(0xff0000);
    expect(mixTint(0x000000, 0xffffff, 7)).toBe(0xffffff);
  });

  it("brightens highlighted entities and leaves plain ones untouched", () => {
    expect(entityTint(0x404040, false, 0, 0)).toBe(0x404040);
    expect(entityTint(0x404040, true, 0, 0)).not.toBe(0x404040);
  });

  it("pulses the status colour in and out", () => {
    const low = entityTint(0xffffff, false, 0x3366ff, 0);
    const high = entityTint(0xffffff, false, 0x3366ff, 1);
    expect(low).not.toBe(0xffffff);
    expect(high).not.toBe(low);
  });

  it("pulse amount stays within 0..1", () => {
    for (let t = 0; t < 2000; t += 37) {
      const v = pulseAmount(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("small helpers", () => {
  it("clamps to the unit interval", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.25)).toBe(0.25);
  });

  it("bar fill is 0..1 and NaN counts as empty", () => {
    expect(barFill(1.5)).toBe(1);
    expect(barFill(-0.2)).toBe(0);
    expect(barFill(Number.NaN)).toBe(0);
    expect(barFill(0.4)).toBe(0.4);
  });

  it("hash01 is deterministic and in [0, 1)", () => {
    expect(hash01(3, 9)).toBe(hash01(3, 9));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const h = hash01(i, 7);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      seen.add(h);
    }
    expect(seen.size).toBeGreaterThan(190);
  });
});

describe("lightLayout", () => {
  it("makes the transparent circle exactly the light radius", () => {
    const layout = lightLayout(160, 400, 300, 800, 600);
    // The texture is transparent to 32 px of its 128 px half-size.
    expect(32 * layout.scale).toBeCloseTo(160, 9);
  });

  it("covers the stage with the sprite square plus the outside rectangles, without overlap", () => {
    const sw = 800;
    const sh = 600;
    const cx = 400;
    const cy = 300;
    const layout = lightLayout(90, cx, cy, sw, sh);
    const h = 128 * layout.scale;
    // Sample a grid of stage points; each must be inside the square or exactly one rectangle.
    for (let x = 1; x < sw; x += 37) {
      for (let y = 1; y < sh; y += 29) {
        const inSquare = Math.abs(x - cx) <= h && Math.abs(y - cy) <= h;
        const hits = layout.rects.filter(
          (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h,
        ).length;
        expect(inSquare ? hits : hits).toBe(inSquare ? 0 : 1);
      }
    }
  });

  it("drops the outside rectangles when the square covers the whole stage", () => {
    const layout = lightLayout(2000, 400, 300, 800, 600);
    expect(layout.rects).toEqual([]);
  });

  it("handles a light centred off stage without negative sizes", () => {
    const layout = lightLayout(50, -500, 300, 800, 600);
    for (const r of layout.rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
  });
});
