import { describe, expect, it } from "vite-plus/test";
import { MAX_COMPANIONS, type CompanionPose, type EntityState } from "@gamez/protocol";
import {
  MAX_COMPANION_NAME,
  poseState,
  sameStanding,
  sanitiseCompanions,
  sanitisePose,
  type CleanPose,
} from "../../src/server/presence/pose.ts";

const BOUNDS = { width: 72, height: 72 };
const NOW = 1_000_000;

const lyra: CompanionPose = { appearance: "unit.hero.rogue", name: "Lyra", dx: 1, dy: 0 };
const mira: CompanionPose = { appearance: "unit.hero.sorcerer", name: "Mira", dx: -2, dy: 2 };
const brask: CompanionPose = { appearance: "unit.hero.warrior", name: "Brask", dx: 0, dy: -1 };

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { appearance: "unit.hero.rogue", name: "Lyra", dx: 1, dy: 0, ...over };
}

describe("sanitiseCompanions: accepted entries", () => {
  it("keeps good entries as they are, in report order", () => {
    expect(sanitiseCompanions([lyra, mira])).toEqual([lyra, mira]);
  });

  it("returns [] for an empty list and for a non-array", () => {
    expect(sanitiseCompanions([])).toEqual([]);
    expect(sanitiseCompanions("not a list")).toEqual([]);
    expect(sanitiseCompanions(undefined)).toEqual([]);
  });

  it("trims names, removes control characters and cuts to 24 code points", () => {
    const [a] = sanitiseCompanions([raw({ name: "  Lyra\u0007  " })]);
    expect(a?.name).toBe("Lyra");
    const [b] = sanitiseCompanions([raw({ name: "x".repeat(30) })]);
    expect(b?.name).toHaveLength(MAX_COMPANION_NAME);
    const [c] = sanitiseCompanions([raw({ name: "🎲".repeat(30) })]);
    expect(Array.from(c!.name)).toHaveLength(MAX_COMPANION_NAME);
  });

  it("clamps offsets to -4..4 and rounds them to whole tiles", () => {
    const [a] = sanitiseCompanions([raw({ dx: 9, dy: -9 })]);
    expect(a).toMatchObject({ dx: 4, dy: -4 });
    const [b] = sanitiseCompanions([raw({ dx: 1.4, dy: -2.6 })]);
    expect(b).toMatchObject({ dx: 1, dy: -3 });
  });
});

describe("sanitiseCompanions: dropped entries", () => {
  it.each([
    ["appearance not a hero", raw({ appearance: "unit.npc.healer" })],
    ["appearance with upper case", raw({ appearance: "unit.hero.Rogue" })],
    ["appearance too long", raw({ appearance: `unit.hero.${"a".repeat(60)}` })],
    ["appearance missing", raw({ appearance: undefined })],
    ["name empty", raw({ name: "" })],
    ["name only blanks", raw({ name: "   " })],
    ["name missing", raw({ name: undefined })],
    ["name not a string", raw({ name: 42 })],
    ["dx not a number", raw({ dx: "1" })],
    ["dy NaN", raw({ dy: Number.NaN })],
    ["dy infinite", raw({ dy: Number.POSITIVE_INFINITY })],
    ["entry not a record", "Lyra"],
    ["entry null", null],
  ])("%s", (_, bad) => {
    expect(sanitiseCompanions([bad])).toEqual([]);
  });

  it("keeps the good entries around the bad ones", () => {
    expect(sanitiseCompanions([raw({ name: "" }), lyra, raw({ appearance: "x" }), mira])).toEqual([
      lyra,
      mira,
    ]);
  });
});

describe("sanitiseCompanions: the cap", () => {
  it("keeps at most MAX_COMPANIONS valid entries", () => {
    const list = [lyra, mira, brask, { ...lyra, name: "Extra" }, { ...mira, name: "More" }];
    const out = sanitiseCompanions(list);
    expect(MAX_COMPANIONS).toBe(3);
    expect(out).toEqual([lyra, mira, brask]);
  });

  it("does not let dropped entries use up the cap", () => {
    const list = [
      raw({ name: "" }),
      raw({ appearance: "x" }),
      lyra,
      mira,
      brask,
      { ...lyra, name: "Z" },
    ];
    expect(sanitiseCompanions(list)).toEqual([lyra, mira, brask]);
  });
});

describe("sanitisePose: the companions field", () => {
  const base = { pos: { x: 36, y: 46 }, path: [], speed: 4 };

  it("is absent when the report carries no companions (unchanged)", () => {
    const r = sanitisePose(base, BOUNDS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pose).not.toHaveProperty("companions");
  });

  it("is [] when the report sends an empty list (clear)", () => {
    const r = sanitisePose({ ...base, companions: [] }, BOUNDS);
    expect(r.ok && r.pose.companions).toEqual([]);
  });

  it("carries the sanitised list", () => {
    const r = sanitisePose({ ...base, companions: [lyra, { ...mira, dx: 99 }] }, BOUNDS);
    expect(r.ok && r.pose.companions).toEqual([lyra, { ...mira, dx: 4 }]);
  });

  it("treats a non-array companions value as absent", () => {
    const r = sanitisePose({ ...base, companions: "lots" }, BOUNDS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pose).not.toHaveProperty("companions");
  });
});

/** A standing avatar (no path) of the given companions. */
function standing(companions?: CompanionPose[]): EntityState {
  const s: EntityState = {
    id: "classic-town:a",
    kind: "player",
    name: "Ann",
    appearance: "unit.hero.warrior",
    pos: { x: 56, y: 36 },
    path: [],
    pathStartedAt: NOW - 60_000,
    speed: 4,
    tag: "Lv 1 Warrior",
  };
  if (companions !== undefined) s.companions = companions;
  return s;
}

function pose(over: Partial<CleanPose> = {}): CleanPose {
  return {
    pos: { x: 56, y: 36 },
    path: [],
    speed: 4,
    appearance: "unit.hero.warrior",
    tag: "Lv 1 Warrior",
    ...over,
  };
}

describe("poseState: the chunk's avatar state after a pose", () => {
  it("keeps the previous companions when the pose has no list", () => {
    const old = standing([lyra, mira]);
    const next = poseState(old, pose(), NOW);
    expect(next.companions).toEqual([lyra, mira]);
  });

  it("replaces the list when the pose carries one", () => {
    const next = poseState(standing([lyra]), pose({ companions: [brask] }), NOW);
    expect(next.companions).toEqual([brask]);
  });

  it("clears the list when the pose sends []", () => {
    const next = poseState(standing([lyra, mira]), pose({ companions: [] }), NOW);
    expect(next.companions).toEqual([]);
  });

  it("leaves companions absent when neither side has any", () => {
    const next = poseState(standing(), pose(), NOW);
    expect(next).not.toHaveProperty("companions");
  });

  it("replaces the tag and look as before, and keeps the list in the same state", () => {
    const next = poseState(standing([lyra]), pose({ tag: "Lv 2 Warrior" }), NOW);
    expect(next.tag).toBe("Lv 2 Warrior");
    expect(next.companions).toEqual([lyra]);
  });
});

describe("sameStanding: companions count as a change", () => {
  it("is false when the companions change while the avatar stands still", () => {
    const old = standing([lyra]);
    expect(sameStanding(old, poseState(old, pose({ companions: [lyra, mira] }), NOW), NOW)).toBe(
      false,
    );
    expect(sameStanding(old, poseState(old, pose({ companions: [] }), NOW), NOW)).toBe(false);
    expect(
      sameStanding(old, poseState(old, pose({ companions: [{ ...lyra, dx: 2 }] }), NOW), NOW),
    ).toBe(false);
  });

  it("is true for a keepalive that repeats the same companions", () => {
    const old = standing([lyra, mira]);
    expect(sameStanding(old, poseState(old, pose({ companions: [lyra, mira] }), NOW), NOW)).toBe(
      true,
    );
  });

  it("treats an absent list and an empty one as the same drawing", () => {
    expect(
      sameStanding(standing(), poseState(standing(), pose({ companions: [] }), NOW), NOW),
    ).toBe(true);
  });
});
