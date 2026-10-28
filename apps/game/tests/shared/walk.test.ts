import type { TileMap } from "@gamez/world";
import { describe, expect, it } from "vite-plus/test";
import { MAX_PATH_STEPS, planWalk, walkAt, walkEnd } from "../../src/shared/walk.ts";

/** Open w x h grid with optional blocked tiles. */
function grid(w: number, h: number, blocked: [number, number][] = []): TileMap {
  const walkable = Array.from({ length: w * h }, () => 1);
  for (const [x, y] of blocked) walkable[y * w + x] = 0;
  return {
    id: "test",
    width: w,
    height: h,
    ground: walkable.map(() => "tile.grass"),
    objects: walkable.map(() => null),
    walkable,
    spawn: { x: 0, y: 0 },
  };
}

const walker = {
  pos: { x: 0, y: 0 },
  path: [
    { x: 1, y: 0 },
    { x: 2, y: 0 },
  ],
  pathStartedAt: 1000,
  speed: 4,
};

describe("walkAt", () => {
  it("reports the current segment and fractional position", () => {
    const at = walkAt(walker, 1000 + 375); // 1.5 tiles in
    expect(at).toMatchObject({ x: 1.5, y: 0, from: { x: 1, y: 0 }, next: { x: 2, y: 0 } });
    expect(at.segElapsed).toBeCloseTo(0.125);
    expect(at.done).toBe(false);
  });

  it("stands at the last tile once the walk is over", () => {
    const at = walkAt(walker, 5000);
    expect(at).toMatchObject({ x: 2, y: 0, from: { x: 2, y: 0 }, next: null, done: true });
    expect(walkEnd(walker)).toEqual({ x: 2, y: 0 });
  });
});

describe("planWalk", () => {
  const map = grid(8, 8, [[4, 4]]);

  it("continues the current segment before turning, without snapping", () => {
    const now = 1000 + 375; // halfway between (1,0) and (2,0)
    const plan = planWalk(map, walker, { x: 2, y: 3 }, now);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.walk.pos).toEqual({ x: 1, y: 0 });
    expect(plan.walk.path[0]).toEqual({ x: 2, y: 0 });
    expect(plan.walk.path.at(-1)).toEqual({ x: 2, y: 3 });
    // Same position as before the redirect at `now`.
    const at = walkAt({ ...plan.walk, speed: walker.speed }, now);
    expect(at.x).toBeCloseTo(1.5);
    expect(at.y).toBeCloseTo(0);
  });

  it("starts from the resting tile when standing", () => {
    const plan = planWalk(map, { ...walker, path: [], pathStartedAt: 0 }, { x: 0, y: 2 }, 50);
    expect(plan).toEqual({
      ok: true,
      walk: {
        pos: { x: 0, y: 0 },
        path: [
          { x: 0, y: 1 },
          { x: 0, y: 2 },
        ],
        pathStartedAt: 50,
      },
    });
  });

  it("rejects blocked, out-of-bounds and fractional targets", () => {
    const still = { ...walker, path: [] };
    expect(planWalk(map, still, { x: 4, y: 4 }, 0)).toEqual({ ok: false, reason: "blocked" });
    expect(planWalk(map, still, { x: 9, y: 0 }, 0)).toEqual({ ok: false, reason: "blocked" });
    expect(planWalk(map, still, { x: 1.5, y: 0 }, 0)).toEqual({ ok: false, reason: "blocked" });
  });

  it("rejects unreachable targets", () => {
    const walled = grid(5, 5, [
      [2, 0],
      [2, 1],
      [2, 2],
      [2, 3],
      [2, 4],
    ]);
    const still = { ...walker, path: [] };
    expect(planWalk(walled, still, { x: 4, y: 0 }, 0)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("rejects paths longer than the limit", () => {
    const long = grid(MAX_PATH_STEPS + 10, 1);
    const still = { ...walker, path: [] };
    const plan = planWalk(long, still, { x: MAX_PATH_STEPS + 5, y: 0 }, 0);
    expect(plan).toEqual({ ok: false, reason: "too-far" });
  });
});
