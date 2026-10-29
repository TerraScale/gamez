import { describe, expect, it } from "vite-plus/test";
import { floatPose } from "../../src/client/render/fx-math.ts";
import {
  FLOAT_BAND_GAP,
  FLOAT_STACK_CAP,
  floatRestY,
  floatsToDrop,
  isPickupFloat,
  PICKUP_LIFT,
  type FloatBand,
} from "../../src/client/render/float-layout.ts";

// The hero's nameplate: centred at x 0, 60 px wide, top at -60 (above the feet).
const HERO: FloatBand = { x: 0, top: -60, w: 60 };

describe("floatRestY (floats never cover the hero's nameplate)", () => {
  it("leaves a float alone when there is no band", () => {
    expect(floatRestY(-10, 0, 10, null)).toBe(-10);
  });

  it("leaves a float alone when it is horizontally clear of the band", () => {
    // Half widths 10 + 30 = 40 < 80 px apart: clear.
    expect(floatRestY(-10, 80, 10, HERO)).toBe(-10);
  });

  it("leaves a float alone while it is already above the band", () => {
    expect(floatRestY(-70, 0, 10, HERO)).toBe(-70);
  });

  it("holds a float that would cover the band at the band's top edge", () => {
    expect(floatRestY(-40, 0, 10, HERO)).toBe(HERO.top - FLOAT_BAND_GAP);
  });

  it("keeps the float box entirely above the band over its whole life", () => {
    for (const start of [-40, -55, -59, -60, -20, 0]) {
      const life = 900;
      let prev = Number.POSITIVE_INFINITY;
      for (let t = 0; t <= life; t += 15) {
        const pose = floatPose(t, life);
        const y = floatRestY(start + pose.dy, 0, 12, HERO);
        // The baseline (box bottom) never reaches the band while they overlap.
        expect(y).toBeLessThanOrEqual(HERO.top - FLOAT_BAND_GAP);
        // A float never moves back down.
        expect(y).toBeLessThanOrEqual(prev);
        prev = y;
      }
    }
  });

  it("releases a float when the band moves away (hero walks off)", () => {
    const moved: FloatBand = { x: 200, top: HERO.top, w: 60 };
    expect(floatRestY(-40, 0, 10, moved)).toBe(-40);
  });

  it("pushes a float up when the band moves up under it (hero walks north)", () => {
    const risen: FloatBand = { x: 0, top: -80, w: 60 };
    expect(floatRestY(-40, 0, 10, risen)).toBe(-80 - FLOAT_BAND_GAP);
  });
});

describe("floatsToDrop (cap on floats stacked on one spot)", () => {
  it("drops nothing below the cap and makes room for the new float at it", () => {
    expect(floatsToDrop(0)).toBe(0);
    expect(floatsToDrop(FLOAT_STACK_CAP - 1)).toBe(0);
    expect(floatsToDrop(FLOAT_STACK_CAP)).toBe(1);
    expect(floatsToDrop(FLOAT_STACK_CAP + 3)).toBe(4);
  });

  it("never leaves more than the cap alive once the new float is added", () => {
    for (let alive = 0; alive <= 20; alive++) {
      const after = alive - floatsToDrop(alive, FLOAT_STACK_CAP) + 1;
      expect(after).toBeLessThanOrEqual(FLOAT_STACK_CAP);
    }
  });
});

describe("pickup floats (gold)", () => {
  it("recognises '+N gold' and nothing else", () => {
    expect(isPickupFloat("+10 gold")).toBe(true);
    expect(isPickupFloat("+1250 gold")).toBe(true);
    expect(isPickupFloat("11")).toBe(false);
    expect(isPickupFloat("Miss")).toBe(false);
    expect(isPickupFloat("goldfish")).toBe(false);
  });

  it("lifts above the sprites of its tile", () => {
    expect(PICKUP_LIFT).toBeGreaterThan(0);
  });
});
