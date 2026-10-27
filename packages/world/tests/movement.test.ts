import type { TilePos } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { pathDuration, positionAlong } from "../src/path.ts";

const from: TilePos = { x: 0, y: 0 };
// Diagonal (sqrt(2)) then straight (1): total length sqrt(2) + 1.
const path: TilePos[] = [
  { x: 1, y: 1 },
  { x: 2, y: 1 },
];
const total = Math.SQRT2 + 1;

describe("pathDuration", () => {
  it("sums segment lengths divided by speed", () => {
    expect(pathDuration(from, path, 1)).toBeCloseTo(total, 10);
    expect(pathDuration(from, path, 2)).toBeCloseTo(total / 2, 10);
  });

  it("is zero for an empty path", () => {
    expect(pathDuration(from, [], 3)).toBe(0);
  });
});

describe("positionAlong", () => {
  it("starts at the origin", () => {
    const p = positionAlong(from, path, 1, 0);
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.y).toBeCloseTo(0, 10);
    expect(p.done).toBe(false);
  });

  it("is halfway along the diagonal segment at half its length", () => {
    const p = positionAlong(from, path, 1, Math.SQRT2 / 2);
    expect(p.x).toBeCloseTo(0.5, 10);
    expect(p.y).toBeCloseTo(0.5, 10);
    expect(p.done).toBe(false);
  });

  it("is partway through the second segment after the diagonal", () => {
    const p = positionAlong(from, path, 1, Math.SQRT2 + 0.5);
    expect(p.x).toBeCloseTo(1.5, 10);
    expect(p.y).toBeCloseTo(1, 10);
    expect(p.done).toBe(false);
  });

  it("reports done at the final tile once elapsed exceeds the duration", () => {
    const p = positionAlong(from, path, 1, 10);
    expect(p).toEqual({ x: 2, y: 1, done: true });
  });

  it("returns the origin as done for an empty path", () => {
    expect(positionAlong(from, [], 1, 5)).toEqual({ x: 0, y: 0, done: true });
  });

  it("clamps negative elapsed time to the start", () => {
    const p = positionAlong(from, path, 1, -5);
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.y).toBeCloseTo(0, 10);
    expect(p.done).toBe(false);
  });
});
