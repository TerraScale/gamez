import type { TilePos } from "@gamez/protocol";
import { walkAt, type Walk } from "@gamez/world";
import { describe, expect, it } from "vite-plus/test";
import { continueWalk, MAX_POSE_PATH } from "../../src/server/presence/pose.ts";

/**
 * Regression for the wave B QA finding "remote avatars snap about 1 tile at
 * each pose update": replays a hero walking a tile route, reports poses the way
 * modules/classic/src/client/presence/pose.ts does (floored tile + tiles
 * ahead, every 250 ms) and samples the drawn position every frame.
 */

const SPEED = 3; // tiles per second
const FRAME_MS = 16;
const POSE_MS = 250;
const LATENCY_MS = 60;

interface Hero {
  /** Continuous position in tiles (tile t spans [t, t+1); centre t + 0.5). */
  at(ms: number): { x: number; y: number; nextIndex: number };
}

/** A hero walking tile centre to tile centre along `route` from t = 0. */
function walker(route: TilePos[], speed = SPEED): Hero {
  return {
    at(ms) {
      let remaining = (ms / 1000) * speed;
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1]!;
        const b = route[i]!;
        const seg = Math.hypot(b.x - a.x, b.y - a.y);
        if (remaining < seg) {
          const t = remaining / seg;
          return { x: a.x + 0.5 + (b.x - a.x) * t, y: a.y + 0.5 + (b.y - a.y) * t, nextIndex: i };
        }
        remaining -= seg;
      }
      const end = route[route.length - 1]!;
      return { x: end.x + 0.5, y: end.y + 0.5, nextIndex: route.length };
    },
  };
}

/** Same rules as readPose: floored tile, then the remaining route without that tile. */
function poseOf(route: TilePos[], hero: Hero, ms: number) {
  const p = hero.at(ms);
  const pos = { x: Math.floor(p.x), y: Math.floor(p.y) };
  const path: TilePos[] = [];
  let prev = pos;
  for (let i = p.nextIndex; i < route.length && path.length < MAX_POSE_PATH; i++) {
    const t = route[i]!;
    if (t.x === prev.x && t.y === prev.y) continue;
    path.push(t);
    prev = t;
  }
  return { pos, path, speed: SPEED };
}

type Apply = (old: Walk, pose: ReturnType<typeof poseOf>, now: number) => Walk;

const restart: Apply = (_old, pose, now) => ({ ...pose, pathStartedAt: now });
const continued: Apply = (old, pose, now) => continueWalk(old, pose, now);

/** Largest per-frame jump of the drawn avatar beyond what the walk speed allows (tiles). */
function maxExcess(
  route: TilePos[],
  apply: Apply,
): { excess: number; end: { x: number; y: number } } {
  const hero = walker(route);
  let walk: Walk = { pos: route[0]!, path: [], pathStartedAt: 0, speed: SPEED };
  const duration = 1000 * (route.length + 2);
  let last = walkAt(walk, 0);
  let excess = 0;
  let nextPose = 0;
  for (let t = FRAME_MS; t <= duration; t += FRAME_MS) {
    while (nextPose + LATENCY_MS <= t) {
      walk = apply(walk, poseOf(route, hero, nextPose), nextPose + LATENCY_MS);
      nextPose += POSE_MS;
    }
    const now = walkAt(walk, t);
    const step = Math.hypot(now.x - last.x, now.y - last.y);
    excess = Math.max(excess, step - (SPEED * FRAME_MS) / 1000);
    last = now;
  }
  return { excess, end: { x: last.x, y: last.y } };
}

function line(from: TilePos, dx: number, dy: number, n: number): TilePos[] {
  const out: TilePos[] = [];
  for (let i = 0; i <= n; i++) out.push({ x: from.x + dx * i, y: from.y + dy * i });
  return out;
}

const ROUTES: Record<string, TilePos[]> = {
  "north (-y)": line({ x: 35, y: 50 }, 0, -1, 10),
  "east (+x)": line({ x: 30, y: 40 }, 1, 0, 10),
  "west (-x)": line({ x: 45, y: 40 }, -1, 0, 10),
  diagonal: line({ x: 30, y: 30 }, -1, -1, 8),
  "L turn": [...line({ x: 30, y: 46 }, 1, 0, 5), ...line({ x: 35, y: 45 }, 0, -1, 5)],
  "turn back": [...line({ x: 30, y: 46 }, 1, 0, 4), ...line({ x: 33, y: 46 }, -1, 0, 4)],
};

describe("continueWalk: remote avatars never jump", () => {
  it("the old restart-at-receipt behaviour does jump (the bug this guards)", () => {
    expect(maxExcess(ROUTES["north (-y)"]!, restart).excess).toBeGreaterThan(0.5);
  });

  for (const [name, route] of Object.entries(ROUTES)) {
    it(`no drawn step above speed * dt walking ${name}`, () => {
      const { excess, end } = maxExcess(route, continued);
      expect(excess).toBeLessThan(0.02);
      // And it still ends on the hero's final tile.
      const last = route[route.length - 1]!;
      expect(end.x).toBeCloseTo(last.x, 5);
      expect(end.y).toBeCloseTo(last.y, 5);
    });
  }
});

describe("continueWalk: cases", () => {
  const base: Walk = {
    pos: { x: 10, y: 10 },
    path: [{ x: 11, y: 10 }],
    pathStartedAt: 0,
    speed: 2,
  };

  it("keeps the segment timeline when the route continues past its end tile", () => {
    const w = continueWalk(
      base,
      {
        pos: { x: 10, y: 10 },
        path: [
          { x: 11, y: 10 },
          { x: 12, y: 10 },
        ],
        speed: 2,
      },
      250,
    );
    expect(w).toEqual({
      pos: { x: 10, y: 10 },
      path: [
        { x: 11, y: 10 },
        { x: 12, y: 10 },
      ],
      pathStartedAt: 0,
      speed: 2,
    });
  });

  it("reverses on the spot when the hero turned back", () => {
    const w = continueWalk(base, { pos: { x: 10, y: 10 }, path: [{ x: 9, y: 10 }], speed: 2 }, 250);
    expect(w.pos).toEqual({ x: 11, y: 10 });
    expect(w.path).toEqual([
      { x: 10, y: 10 },
      { x: 9, y: 10 },
    ]);
    expect(walkAt(w, 250).x).toBeCloseTo(10.5, 5);
    expect(walkAt(w, 500).x).toBeCloseTo(10, 5);
  });

  it("snaps when the pose is far from the drawn avatar (teleport)", () => {
    const w = continueWalk(base, { pos: { x: 40, y: 40 }, path: [], speed: 4 }, 250);
    expect(w).toEqual({ pos: { x: 40, y: 40 }, path: [], pathStartedAt: 250, speed: 4 });
  });

  it("steps onto the route from a standing avatar next to it", () => {
    const standing: Walk = { pos: { x: 10, y: 10 }, path: [], pathStartedAt: 0, speed: 2 };
    const w = continueWalk(
      standing,
      { pos: { x: 10, y: 9 }, path: [{ x: 10, y: 8 }], speed: 2 },
      100,
    );
    expect(w).toEqual({
      pos: { x: 10, y: 10 },
      path: [
        { x: 10, y: 9 },
        { x: 10, y: 8 },
      ],
      pathStartedAt: 100,
      speed: 2,
    });
  });

  it("a standing pose on the avatar's tile stays put", () => {
    const standing: Walk = { pos: { x: 10, y: 10 }, path: [], pathStartedAt: 0, speed: 2 };
    expect(continueWalk(standing, { pos: { x: 10, y: 10 }, path: [], speed: 2 }, 100)).toEqual({
      pos: { x: 10, y: 10 },
      path: [],
      pathStartedAt: 100,
      speed: 2,
    });
  });
});
