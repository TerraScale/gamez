import { describe, expect, it } from "vite-plus/test";
import {
  MAX_POSE_PATH,
  sanitiseAppearance,
  sanitisePose,
  sanitiseTag,
} from "../../src/server/presence/pose.ts";

const BOUNDS = { width: 72, height: 72 };

function pose(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { pos: { x: 36, y: 46 }, path: [{ x: 37, y: 46 }], speed: 4, ...over };
}

describe("sanitisePose: accepted poses", () => {
  it("keeps a valid pose with tag and appearance", () => {
    const r = sanitisePose(pose({ appearance: "unit.hero.warrior", tag: "Lv 12 Warrior" }), BOUNDS);
    expect(r).toEqual({
      ok: true,
      pose: {
        pos: { x: 36, y: 46 },
        path: [{ x: 37, y: 46 }],
        speed: 4,
        appearance: "unit.hero.warrior",
        tag: "Lv 12 Warrior",
      },
    });
  });

  it("accepts a standing pose and the bounds corners", () => {
    const r = sanitisePose({ pos: { x: 71, y: 0 }, path: [], speed: 1 }, BOUNDS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pose.pos).toEqual({ x: 71, y: 0 });
  });

  it("accepts a path of exactly MAX_POSE_PATH tiles", () => {
    const path = Array.from({ length: MAX_POSE_PATH }, (_, i) => ({ x: i, y: 0 }));
    expect(sanitisePose({ pos: { x: 0, y: 0 }, path, speed: 4 }, BOUNDS).ok).toBe(true);
  });

  it("does not add a tag property when there is none", () => {
    const r = sanitisePose(pose(), BOUNDS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pose).not.toHaveProperty("tag");
  });
});

describe("sanitisePose: rejected poses", () => {
  it.each([
    ["pos out of bounds (x)", pose({ pos: { x: 72, y: 0 } })],
    ["pos negative", pose({ pos: { x: -1, y: 0 } })],
    ["path tile out of bounds", pose({ path: [{ x: 1, y: 80 }] })],
  ])("%s -> out-of-bounds", (_, raw) => {
    expect(sanitisePose(raw, BOUNDS)).toEqual({ ok: false, reason: "out-of-bounds" });
  });

  it("too long a path -> path-too-long", () => {
    const path = Array.from({ length: MAX_POSE_PATH + 1 }, () => ({ x: 1, y: 1 }));
    expect(sanitisePose(pose({ path }), BOUNDS)).toEqual({ ok: false, reason: "path-too-long" });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "pose"],
    ["fractional pos", pose({ pos: { x: 1.5, y: 2 } })],
    ["string pos", pose({ pos: { x: "1", y: 2 } })],
    ["missing pos", { path: [], speed: 4 }],
    ["path not an array", pose({ path: "nope" })],
    ["path tile not an object", pose({ path: [7] })],
    ["path tile fractional", pose({ path: [{ x: 2.5, y: 2 }] })],
    ["speed missing", { pos: { x: 1, y: 1 }, path: [] }],
    ["speed NaN", pose({ speed: Number.NaN })],
    ["speed string", pose({ speed: "fast" })],
  ])("%s -> bad-pose", (_, raw) => {
    expect(sanitisePose(raw, BOUNDS)).toEqual({ ok: false, reason: "bad-pose" });
  });
});

describe("sanitisePose: clamps and cosmetics", () => {
  it.each([
    [0, 1],
    [-5, 1],
    [0.2, 1],
    [4, 4],
    [12, 12],
    [50, 12],
  ])("speed %s becomes %s", (speed, want) => {
    const r = sanitisePose(pose({ speed }), BOUNDS);
    expect(r.ok && r.pose.speed).toBe(want);
  });

  it("replaces an invalid appearance with unit.hero", () => {
    for (const appearance of ["unit.hero.Warrior", "hero.png", "unit.hero/../x", 7, null]) {
      const r = sanitisePose(pose({ appearance }), BOUNDS);
      expect(r.ok && r.pose.appearance).toBe("unit.hero");
    }
  });

  it("keeps appearance ids up to 64 chars and rejects longer ones", () => {
    const fits = `unit.hero.${"a".repeat(54)}`;
    const tooLong = `unit.hero.${"a".repeat(60)}`;
    expect(fits.length).toBe(64);
    expect(sanitiseAppearance(fits)).toBe(fits);
    expect(sanitiseAppearance(tooLong)).toBe("unit.hero");
  });

  it("strips control characters from tags and drops an empty result", () => {
    expect(sanitiseTag("a\u0000b\u007fc\u0085d\n")).toBe("abcd");
    expect(sanitiseTag("\u0001\u0002")).toBeUndefined();
    expect(sanitiseTag(42)).toBeUndefined();
  });

  it("truncates tags to 40 code points without splitting emoji", () => {
    const tag = "🎲".repeat(45);
    const clean = sanitiseTag(tag);
    expect(clean).toBe("🎲".repeat(40));
    expect(Array.from(clean ?? "")).toHaveLength(40);
  });

  it("keeps a 40-char tag as it is", () => {
    const tag = "T".repeat(40);
    expect(sanitiseTag(tag)).toBe(tag);
  });
});
