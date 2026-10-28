import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_ISO, screenToTile, tileToScreen } from "../src/iso.ts";

describe("iso projection", () => {
  it("projects known tiles to the expected screen coordinates", () => {
    expect(tileToScreen(0, 0)).toEqual({ sx: 0, sy: 0 });
    expect(tileToScreen(1, 0)).toEqual({ sx: 32, sy: 16 });
    expect(tileToScreen(0, 1)).toEqual({ sx: -32, sy: 16 });
    expect(tileToScreen(3, 2)).toEqual({ sx: 32, sy: 80 });
  });

  it("screenToTile inverts tileToScreen", () => {
    const tiles = [
      [0, 0],
      [1, 0],
      [0, 1],
      [3, 2],
      [10, 4],
      [7.5, 2.25],
    ] as const;
    for (const [x, y] of tiles) {
      const { sx, sy } = tileToScreen(x, y);
      const back = screenToTile(sx, sy);
      expect(back.x).toBeCloseTo(x, 10);
      expect(back.y).toBeCloseTo(y, 10);
    }
  });

  it("floors the centre of a tile back to that tile", () => {
    const tiles = [
      [0, 0],
      [5, 9],
      [12, 3],
      [47, 47],
    ] as const;
    for (const [x, y] of tiles) {
      const c = tileToScreen(x + 0.5, y + 0.5);
      const t = screenToTile(c.sx, c.sy);
      expect(Math.floor(t.x)).toBe(x);
      expect(Math.floor(t.y)).toBe(y);
    }
  });

  it("respects custom metrics", () => {
    const m = { tileWidth: 32, tileHeight: 16 };
    const { sx, sy } = tileToScreen(4, 1, m);
    expect(sx).toBe(48);
    expect(sy).toBe(40);
    const back = screenToTile(sx, sy, m);
    expect(back.x).toBeCloseTo(4, 10);
    expect(back.y).toBeCloseTo(1, 10);
    expect(DEFAULT_ISO.tileWidth).toBe(64);
  });
});
