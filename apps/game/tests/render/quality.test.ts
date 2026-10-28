import { describe, expect, it } from "vite-plus/test";
import {
  burstKey,
  burstKeyIn,
  burstScale,
  flashMatrix,
  flashMix,
  frameDeltaMs,
  FRAME_DELTA_MAX_MS,
  SHAKE_MAX_PX,
  shakeOffset,
} from "../../src/client/render/fx-math.ts";
import {
  glowEnabled,
  lightTextureSize,
  parseQuality,
  qualityResolution,
  shakeEnabled,
  segmentFactor,
} from "../../src/client/render/quality.ts";

describe("quality presets", () => {
  it("resolution: low 1, medium at most 1.5, high at most 2, never below 1 nor above the device ratio", () => {
    expect(qualityResolution("low", 3)).toBe(1);
    expect(qualityResolution("medium", 2)).toBe(1.5);
    expect(qualityResolution("medium", 1)).toBe(1);
    expect(qualityResolution("high", 3)).toBe(2);
    expect(qualityResolution("high", 1.5)).toBe(1.5);
    expect(qualityResolution("high", 0)).toBe(1);
    expect(qualityResolution("high", Number.NaN)).toBe(1);
  });

  it("glow, shake and light texture follow the quality", () => {
    expect(glowEnabled("low")).toBe(false);
    expect(glowEnabled("medium")).toBe(true);
    expect(shakeEnabled("low")).toBe(false);
    expect(shakeEnabled("high")).toBe(true);
    expect(lightTextureSize("low")).toBe(128);
    expect(lightTextureSize("high")).toBe(256);
    expect(segmentFactor("low")).toBeLessThan(segmentFactor("high"));
  });

  it("parses stored values and defaults to high", () => {
    expect(parseQuality("low")).toBe("low");
    expect(parseQuality("medium")).toBe("medium");
    expect(parseQuality("auto")).toBe("high");
    expect(parseQuality(undefined)).toBe("high");
  });
});

describe("frame delta (wall clock)", () => {
  it("is the real step between two frames", () => {
    expect(frameDeltaMs(1016, 1000, 16)).toBe(16);
    expect(frameDeltaMs(1100, 1000, 16)).toBe(100);
  });

  it("keeps slow frames: a 180 ms frame is 180 ms, not Pixi's 100 ms clamp", () => {
    expect(frameDeltaMs(1180, 1000, 100)).toBe(180);
  });

  it("clamps very long gaps (a backgrounded tab) at 1000 ms", () => {
    expect(FRAME_DELTA_MAX_MS).toBe(1000);
    expect(frameDeltaMs(9000, 1000, 16)).toBe(1000);
  });

  it("uses the Pixi step for the first frame and never goes negative", () => {
    expect(frameDeltaMs(1000, 0, 16)).toBe(16);
    expect(frameDeltaMs(1000, 0, Number.NaN)).toBe(0);
    expect(frameDeltaMs(900, 1000, 16)).toBe(0);
    expect(frameDeltaMs(1000, 1000, 16)).toBe(0);
  });
});

describe("camera shake", () => {
  it("starts at full strength and decays to zero at its duration", () => {
    const mag = (e: number) => {
      const o = shakeOffset(6, 400, e);
      return Math.hypot(o.dx, o.dy);
    };
    expect(mag(0)).toBeCloseTo(6, 9);
    expect(mag(200)).toBeLessThan(mag(0));
    expect(mag(350)).toBeLessThan(mag(200));
    expect(mag(400)).toBe(0);
    expect(mag(500)).toBe(0);
  });

  it("clamps the strength and ignores non-positive input", () => {
    const o = shakeOffset(500, 400, 0);
    expect(Math.hypot(o.dx, o.dy)).toBeLessThanOrEqual(SHAKE_MAX_PX + 1e-9);
    expect(shakeOffset(0, 400, 0)).toEqual({ dx: 0, dy: 0 });
    expect(shakeOffset(6, 0, 0)).toEqual({ dx: 0, dy: 0 });
    expect(shakeOffset(6, 400, -1)).toEqual({ dx: 0, dy: 0 });
  });

  it("is deterministic for the same elapsed time", () => {
    expect(shakeOffset(6, 400, 123)).toEqual(shakeOffset(6, 400, 123));
  });
});

describe("hit flash", () => {
  it("mixes towards the flash colour and keeps alpha", () => {
    const id = flashMatrix(0xffffff, 0);
    expect(id[0]).toBe(1);
    expect(id[4]).toBe(0);
    expect(id[18]).toBe(1);
    const white = flashMatrix(0xffffff, 1);
    expect(white[0]).toBe(0);
    expect(white[4]).toBe(1);
    expect(white[9]).toBe(1);
    expect(white[14]).toBe(1);
    expect(white[18]).toBe(1);
    const red = flashMatrix(0xff0000, 0.5);
    expect(red[4]).toBe(0.5);
    expect(red[9]).toBe(0);
  });

  it("peaks at 0.7 and is zero without a flash", () => {
    expect(flashMix(0)).toBe(0);
    expect(flashMix(1)).toBeCloseTo(0.7, 9);
    expect(flashMix(2)).toBeCloseTo(0.7, 9);
  });
});

describe("burst animations", () => {
  it("keys the burst by its sprite and selects it only when the manifest has it", () => {
    expect(burstKey("fx.frost_ring")).toBe("fx.frost_ring.burst");
    expect(burstKey(undefined)).toBeNull();
    expect(burstKey("")).toBeNull();
    const has = new Set(["fx.frost_ring.burst"]);
    expect(burstKeyIn("fx.frost_ring", (k) => has.has(k))).toBe("fx.frost_ring.burst");
    expect(burstKeyIn("fx.other", (k) => has.has(k))).toBeNull();
    expect(burstKeyIn(undefined, () => true)).toBeNull();
  });

  it("scales so a radius of one tile is half a 64 px tile width (64 px of art per tile)", () => {
    expect(burstScale(1, 64)).toBe(0.5);
    expect(burstScale(2, 64)).toBe(1);
    expect(burstScale(0, 64)).toBe(0.5);
  });
});
