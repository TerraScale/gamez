import { describe, expect, it } from "vite-plus/test";
import { tileToScreen } from "@gamez/world";
import {
  CHUNK_TILES,
  chunkCount,
  chunkInRange,
  chunkRange,
  inViewRect,
  viewRect,
  visibleTileRect,
} from "../../src/client/render/chunks.ts";

/** Tile index-space centre of a tile, as the renderer draws it. */
function centreOf(tx: number, ty: number) {
  return tileToScreen(tx + 0.5, ty + 0.5);
}

describe("viewRect and visibleTileRect", () => {
  it("is centred on the camera and halves in size when zoom doubles", () => {
    const r1 = viewRect(100, 50, 800, 600, 1);
    expect(r1.x0 + r1.x1).toBeCloseTo(200, 9);
    expect(r1.x1 - r1.x0).toBe(800);
    const r2 = viewRect(100, 50, 800, 600, 2);
    expect(r2.x1 - r2.x0).toBe(400);
    expect(r2.y1 - r2.y0).toBe(300);
  });

  it("covers the tiles around the camera centre", () => {
    const c = centreOf(64, 64);
    const t = visibleTileRect(viewRect(c.sx, c.sy, 800, 600, 1));
    expect(Math.floor(t.x0)).toBeLessThanOrEqual(64);
    expect(Math.floor(t.x1)).toBeGreaterThanOrEqual(64);
    expect(Math.floor(t.y0)).toBeLessThanOrEqual(64);
    expect(Math.floor(t.y1)).toBeGreaterThanOrEqual(64);
    // A 800x600 view shows well under the whole 128-tile map.
    expect(t.x1 - t.x0).toBeLessThan(40);
  });
});

describe("chunkRange", () => {
  const map = { w: 128, h: 128 };

  it("returns the chunks of the visible tiles plus the margin", () => {
    const tiles = { x0: 40.2, y0: 40.2, x1: 44.9, y1: 44.9 };
    const r = chunkRange(tiles, map.w, map.h, 1);
    // Tiles 40..44 are chunk 2; with one chunk of margin that is chunks 1..3.
    expect(r).toEqual({ cx0: 1, cy0: 1, cx1: 3, cy1: 3 });
    expect(chunkCount(r)).toBe(9);
  });

  it("clamps to the map edges", () => {
    const r = chunkRange({ x0: -20, y0: -20, x1: 3, y1: 3 }, map.w, map.h, 2);
    expect(r.cx0).toBe(0);
    expect(r.cy0).toBe(0);
    const far = chunkRange({ x0: 120, y0: 120, x1: 300, y1: 300 }, map.w, map.h, 1);
    expect(far.cx1).toBe(Math.ceil(map.w / CHUNK_TILES) - 1);
    expect(far.cy1).toBe(7);
  });

  it("is empty for a view that lies entirely off the map", () => {
    const r = chunkRange({ x0: 500, y0: 500, x1: 510, y1: 510 }, map.w, map.h, 0);
    expect(chunkCount(r)).toBe(0);
    expect(chunkInRange(r, 0, 0)).toBe(false);
  });

  it("is empty for an empty map", () => {
    expect(chunkCount(chunkRange({ x0: 0, y0: 0, x1: 5, y1: 5 }, 0, 0, 1))).toBe(0);
  });

  it("keeps a wider range for the destroy margin than for the build margin", () => {
    const tiles = { x0: 64, y0: 64, x1: 66, y1: 66 };
    const build = chunkRange(tiles, map.w, map.h, 1);
    const keep = chunkRange(tiles, map.w, map.h, 2);
    expect(chunkInRange(build, 4, 4)).toBe(true);
    expect(chunkInRange(keep, 2, 2)).toBe(true);
    expect(chunkInRange(build, 2, 2)).toBe(false);
  });
});

describe("inViewRect", () => {
  it("culls points outside the rectangle, honouring the pad", () => {
    const r = { x0: 0, y0: 0, x1: 100, y1: 100 };
    expect(inViewRect(50, 50, r, 0)).toBe(true);
    expect(inViewRect(-5, 50, r, 0)).toBe(false);
    expect(inViewRect(-5, 50, r, 10)).toBe(true);
    expect(inViewRect(50, 120, r, 10)).toBe(false);
  });
});
