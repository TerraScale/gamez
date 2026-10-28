import type { TilePos } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { findPath } from "../src/path.ts";
import { makeMap, openMap } from "./fixtures.ts";

function pathCost(from: TilePos, path: TilePos[]): number {
  let cost = 0;
  let prev = from;
  for (const p of path) {
    cost += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return cost;
}

describe("findPath", () => {
  it("walks a straight line excluding the start tile", () => {
    const map = openMap(5, 1);
    expect(findPath(map, { x: 0, y: 0 }, { x: 4, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
    ]);
  });

  it("takes a pure diagonal when the target is on the diagonal", () => {
    const map = openMap(4, 4);
    expect(findPath(map, { x: 0, y: 0 }, { x: 3, y: 3 })).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it("routes around a wall and reaches the target at optimal cost", () => {
    const map = makeMap([".....", "..#..", "..#..", "..#..", "....."]);
    const from = { x: 0, y: 2 };
    const to = { x: 4, y: 2 };
    const path = findPath(map, from, to);
    expect(path).not.toBeNull();
    const steps = path ?? [];
    expect(steps.at(-1)).toEqual(to);
    for (const p of steps) {
      expect(map.walkable[p.y * map.width + p.x]).toBe(1);
    }
    // Crossing column x=2 must happen at y=0 or y=4: (2,0) costs 2+sqrt(2) from each side.
    expect(pathCost(from, steps)).toBeCloseTo(4 + 2 * Math.SQRT2, 10);
  });

  it("never cuts a wall corner diagonally", () => {
    const map = makeMap([".#", ".."]);
    // Direct diagonal (0,0)->(1,1) would clip the blocked corner at (1,0).
    expect(findPath(map, { x: 0, y: 0 }, { x: 1, y: 1 })).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it("returns null when the target is walled in", () => {
    const map = makeMap([".....", ".###.", ".#.#.", ".###.", "....."]);
    expect(findPath(map, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });

  it("returns null when the target tile is blocked", () => {
    const map = makeMap(["...", ".#.", "..."]);
    expect(findPath(map, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it("returns null when the target is out of bounds", () => {
    const map = openMap(3, 3);
    const from = { x: 0, y: 0 };
    expect(findPath(map, from, { x: -1, y: 0 })).toBeNull();
    expect(findPath(map, from, { x: 0, y: -1 })).toBeNull();
    expect(findPath(map, from, { x: 3, y: 0 })).toBeNull();
    expect(findPath(map, from, { x: 0, y: 3 })).toBeNull();
  });

  it("returns [] when from equals to", () => {
    const map = openMap(3, 3);
    expect(findPath(map, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });

  it("is deterministic and returns the exact expected path on an asymmetric map", () => {
    const map = makeMap(["......", ".####.", "......", "##....", "......"]);
    const from = { x: 0, y: 0 };
    const to = { x: 5, y: 4 };
    const first = findPath(map, from, to);
    for (let i = 0; i < 5; i++) {
      expect(findPath(map, from, to)).toEqual(first);
    }
    // Down the left edge, across row 2, then two diagonals: cost 5 + 2*sqrt(2).
    expect(first).toEqual([
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 4 },
      { x: 5, y: 4 },
    ]);
    expect(pathCost(from, first ?? [])).toBeCloseTo(5 + 2 * Math.SQRT2, 10);
  });

  it("returns null once the node budget is exhausted", () => {
    const map = openMap(48, 48);
    const from = { x: 0, y: 0 };
    const to = { x: 47, y: 47 };
    expect(findPath(map, from, to, 5)).toBeNull();
    expect(findPath(map, from, to)).not.toBeNull();
  });

  it("crosses a 48x48 open map diagonally", () => {
    const map = openMap(48, 48);
    const started = performance.now();
    const path = findPath(map, { x: 0, y: 47 }, { x: 47, y: 0 });
    const ms = performance.now() - started;
    console.log(`findPath 48x48 cross-diagonal: ${ms.toFixed(2)} ms`);
    expect(path).not.toBeNull();
    expect(path).toHaveLength(47);
    expect(pathCost({ x: 0, y: 47 }, path ?? [])).toBeCloseTo(47 * Math.SQRT2, 10);
  });
});
