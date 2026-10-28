import { describe, expect, it } from "vite-plus/test";
import { FrameStats } from "../../src/client/render/stats.ts";
import { clampZoom, wheelZoom, ZOOM_MAX, ZOOM_MIN } from "../../src/client/render/camera.ts";
import { groundFallbackColour, wallColour } from "../../src/client/render/palette.ts";

describe("FrameStats", () => {
  it("reports 60 fps for 60 frames of 16.7 ms", () => {
    const s = new FrameStats();
    for (let i = 0; i < 40; i++) s.frame(1000 / 60, 1);
    expect(s.fps).toBeCloseTo(60, 0);
  });

  it("averages the draw time", () => {
    const s = new FrameStats();
    s.frame(16, 4);
    expect(s.drawMs).toBe(4);
    s.frame(16, 14);
    expect(s.drawMs).toBeGreaterThan(4);
    expect(s.drawMs).toBeLessThan(14);
  });
});

describe("zoom", () => {
  it("clamps to 0.5..2 and treats non-finite values as 1", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(1.25)).toBe(1.25);
  });

  it("wheel up zooms in, wheel down zooms out, symmetrically", () => {
    const up = wheelZoom(1, -100);
    const down = wheelZoom(1, 100);
    expect(up).toBeGreaterThan(1);
    expect(down).toBeLessThan(1);
    expect(up * down).toBeCloseTo(1, 9);
    expect(wheelZoom(ZOOM_MAX, -1000)).toBe(ZOOM_MAX);
  });
});

describe("palette", () => {
  it("gives void and unknown ground dark fallbacks", () => {
    expect(groundFallbackColour("tile.void")).toBeLessThan(0x202020);
    expect(groundFallbackColour("tile.mystery")).toBeLessThan(0x333333);
  });

  it("tints walls by theme and falls back to a neutral colour", () => {
    const colours = ["wall.crypt", "wall.cave", "wall.forge", "wall.abyss"].map(wallColour);
    expect(new Set(colours).size).toBe(4);
    expect(wallColour("wall.dungeon")).toBe(wallColour("wall.other"));
  });
});
