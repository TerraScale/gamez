import { describe, expect, it } from "vite-plus/test";
import { tileToScreen } from "@gamez/world";
import { pickTile, smoothToward } from "../../src/client/render/camera.ts";

describe("pickTile", () => {
  it("returns the tile under a tile centre, with and without an offset", () => {
    const centre = tileToScreen(2.5, 3.5);
    expect(pickTile(centre.sx, centre.sy, 0, 0, 48, 48)).toEqual({ x: 2, y: 3 });
    expect(pickTile(centre.sx + 100, centre.sy + 50, 100, 50, 48, 48)).toEqual({ x: 2, y: 3 });
  });

  it("returns null outside the map", () => {
    const outLeft = tileToScreen(-0.5, 0.5);
    expect(pickTile(outLeft.sx, outLeft.sy, 0, 0, 48, 48)).toBeNull();
    const outRight = tileToScreen(48.5, 0.5);
    expect(pickTile(outRight.sx, outRight.sy, 0, 0, 48, 48)).toBeNull();
  });

  it("returns the last tile inside the map", () => {
    const c = tileToScreen(47.5, 47.5);
    expect(pickTile(c.sx, c.sy, 0, 0, 48, 48)).toEqual({ x: 47, y: 47 });
  });
});

describe("smoothToward", () => {
  it("is frame-rate independent", () => {
    const oneStep = smoothToward(0, 100, 16, 8);
    const twoSteps = smoothToward(smoothToward(0, 100, 8, 8), 100, 8, 8);
    expect(twoSteps).toBeCloseTo(oneStep, 9);
  });

  it("stays put at dt 0 and approaches the target", () => {
    expect(smoothToward(10, 50, 0, 8)).toBe(10);
    expect(smoothToward(0, 100, 10_000, 8)).toBeCloseTo(100, 6);
  });
});
