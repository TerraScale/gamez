import { describe, expect, it } from "vite-plus/test";
import { tileToScreen } from "@gamez/world";
import {
  clampAnimRate,
  floatStagger,
  frameFromProgress,
  hitKnockback,
  projectileAngle,
  visibleHeight,
} from "../../src/client/render/anim-math.ts";

describe("frameFromProgress", () => {
  it("maps progress to floor(p * n), clamped to the last frame", () => {
    expect(frameFromProgress(0, 4)).toBe(0);
    expect(frameFromProgress(0.24, 4)).toBe(0);
    expect(frameFromProgress(0.25, 4)).toBe(1);
    // The classic scene puts the hit at 0.5: frame 2 of a 4-frame swing (the peak lean).
    expect(frameFromProgress(0.5, 4)).toBe(2);
    expect(frameFromProgress(0.74, 4)).toBe(2);
    expect(frameFromProgress(0.75, 4)).toBe(3);
    expect(frameFromProgress(1, 4)).toBe(3);
    expect(frameFromProgress(7, 4)).toBe(3);
  });

  it("is safe for single frames and bad input", () => {
    expect(frameFromProgress(0.9, 1)).toBe(0);
    expect(frameFromProgress(0.9, 0)).toBe(0);
    expect(frameFromProgress(Number.NaN, 4)).toBe(0);
    expect(frameFromProgress(-1, 4)).toBe(0);
  });
});

describe("projectileAngle", () => {
  it("follows the screen projection of the tile-space velocity", () => {
    // +x and -y together move straight right on screen (iso).
    expect(projectileAngle(1, -1)).toBeCloseTo(0, 9);
    // +x +y moves straight down.
    expect(projectileAngle(1, 1)).toBeCloseTo(Math.PI / 2, 9);
    expect(Math.abs(projectileAngle(-1, 1))).toBeCloseTo(Math.PI, 9);
    const s = tileToScreen(64, 0);
    expect(projectileAngle(64, 0)).toBeCloseTo(Math.atan2(s.sy, s.sx), 9);
    // Only the direction matters.
    expect(projectileAngle(3, 0)).toBeCloseTo(projectileAngle(300, 0), 9);
  });

  it("is 0 for a zero or invalid vector", () => {
    expect(projectileAngle(0, 0)).toBe(0);
    expect(projectileAngle(Number.NaN, 1)).toBe(0);
  });
});

describe("hit flash and clip rate", () => {
  it("knocks back 2 px early, 1 px late, against the facing", () => {
    expect(hitKnockback(0, false)).toBe(0);
    expect(hitKnockback(1, false)).toBe(-2);
    expect(hitKnockback(1, true)).toBe(2);
    expect(hitKnockback(0.25, false)).toBe(-1);
  });

  it("clamps animRate to 0.6..1.8 and defaults to 1", () => {
    expect(clampAnimRate(undefined)).toBe(1);
    expect(clampAnimRate(0)).toBe(1);
    expect(clampAnimRate(Number.NaN)).toBe(1);
    expect(clampAnimRate(0.2)).toBe(0.6);
    expect(clampAnimRate(3)).toBe(1.8);
    expect(clampAnimRate(1.25)).toBe(1.25);
  });
});

describe("floatStagger", () => {
  it("leaves the first float alone and spreads the next ones sideways and up", () => {
    expect(floatStagger(0)).toEqual({ dx: 0, dy: 0 });
    const a = floatStagger(1);
    const b = floatStagger(2);
    expect(a.dx).toBeGreaterThan(0);
    expect(b.dx).toBeLessThan(0);
    expect(b.dy).toBeLessThan(a.dy);
    expect(a.dy).toBeLessThan(0);
  });

  it("is deterministic and bounded (cycles every four steps)", () => {
    for (let k = 1; k < 40; k++) {
      const o = floatStagger(k);
      expect(Math.abs(o.dx)).toBeLessThanOrEqual(24);
      expect(o.dy).toBeGreaterThanOrEqual(-60);
      expect(o).toEqual(floatStagger(k));
    }
    expect(floatStagger(5).dy).toBe(floatStagger(1).dy);
  });
});

describe("visibleHeight", () => {
  it("measures from the anchor to the first visible row of a trimmed frame", () => {
    // 87 px tall frame, feet at 0.85, 8 transparent rows trimmed from the top.
    expect(visibleHeight(0.85, 87, 8)).toBeCloseTo(0.85 * 87 - 8, 9);
    expect(visibleHeight(1, 40, 0)).toBe(40);
    expect(visibleHeight(1, 4, 0)).toBe(8);
  });
});
