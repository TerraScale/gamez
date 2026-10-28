import { describe, expect, it } from "vite-plus/test";
import type { EntityState } from "@gamez/protocol";
import {
  MAX_POSE_PATH,
  continueWalk,
  sameStanding,
  sanitiseAppearance,
  sanitisePose,
  sanitisePoseTag,
  sanitiseTag,
} from "../../src/server/presence/pose.ts";
import { BLOCK_WORDS } from "../../src/server/chat/words.ts";
import { presenceWorld } from "../../src/shared/worlds.ts";
import { PRESENCE_TAG_WORDS, presenceTag } from "@gamez/mode-classic";
import { latencyTag, parseLatencyTag } from "../../../../tools/loadtest/src/tag.ts";

const BOUNDS = { width: 72, height: 72, tagWords: PRESENCE_TAG_WORDS };

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

describe("sameStanding: keepalive poses", () => {
  const NOW = 1_000_000;
  const standing: EntityState = {
    id: "classic-town:a",
    kind: "player",
    name: "A",
    appearance: "unit.hero.warrior",
    pos: { x: 56, y: 36 },
    path: [],
    pathStartedAt: NOW - 60_000,
    speed: 4,
    tag: "Lv 1 Warrior",
  };
  const next = (raw: Record<string, unknown>, old = standing): EntityState => {
    const check = sanitisePose(raw, BOUNDS);
    if (!check.ok) throw new Error(check.reason);
    const state: EntityState = { ...old, ...continueWalk(old, check.pose, NOW) };
    state.appearance = check.pose.appearance;
    delete state.tag;
    if (check.pose.tag !== undefined) state.tag = check.pose.tag;
    return state;
  };
  const still = { pos: { x: 56, y: 36 }, path: [], speed: 4, appearance: "unit.hero.warrior" };

  it("is true for the same tile, look and tag", () => {
    expect(sameStanding(standing, next({ ...still, tag: "Lv 1 Warrior" }), NOW)).toBe(true);
  });

  it("is false for the first pose after a join (no tag yet)", () => {
    const joined: EntityState = { ...standing };
    delete joined.tag;
    expect(sameStanding(joined, next({ ...still, tag: "Lv 1 Warrior" }, joined), NOW)).toBe(false);
  });

  it("is false when the tile, tag, look or path changes", () => {
    expect(
      sameStanding(standing, next({ ...still, pos: { x: 57, y: 36 }, tag: "Lv 1 Warrior" }), NOW),
    ).toBe(false);
    expect(sameStanding(standing, next({ ...still, tag: "Lv 2 Warrior" }), NOW)).toBe(false);
    expect(
      sameStanding(standing, next({ ...still, appearance: "unit.hero", tag: "Lv 1 Warrior" }), NOW),
    ).toBe(false);
    expect(
      sameStanding(
        standing,
        next({ ...still, path: [{ x: 57, y: 36 }], tag: "Lv 1 Warrior" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is false while the old walk is still under way", () => {
    const walking: EntityState = { ...standing, path: [{ x: 57, y: 36 }], pathStartedAt: NOW };
    expect(sameStanding(walking, next({ ...still, tag: "Lv 1 Warrior" }, walking), NOW)).toBe(
      false,
    );
  });
});

describe("sanitisePoseTag: game-data vocabulary only (R11)", () => {
  const WORDS = PRESENCE_TAG_WORDS;
  const TOWN = presenceWorld("classic-town")!;

  it("the classic town world carries the classic class vocabulary", () => {
    expect(TOWN.tagWords).toBe(PRESENCE_TAG_WORDS);
    expect([...WORDS]).toEqual(["Hero", "Rogue", "Sorcerer", "Warrior"]);
  });

  it("relays the swarm's latency tag unchanged (the e2e loadtest measures delivery with it)", () => {
    const tag = latencyTag(1793200000000);
    expect(sanitisePoseTag(tag)).toBe(tag);
    const out = sanitisePose(pose({ tag }), TOWN);
    expect(out.ok && parseLatencyTag(out.pose.tag)).toBe(1793200000000);
  });

  it("keeps the tag the classic client builds, for every class and the fallback", () => {
    for (const word of WORDS) {
      for (const level of [1, 12, 99, 9999]) {
        const tag = presenceTag(level, word);
        expect(sanitisePoseTag(tag, WORDS)).toBe(tag);
      }
    }
    expect(presenceTag(3, undefined)).toBe("Lv 3 Hero");
    const r = sanitisePose(pose({ tag: "Lv 12 Warrior" }), TOWN);
    expect(r.ok && r.pose.tag).toBe("Lv 12 Warrior");
  });

  it.each([
    // Free text in the word slot, whether or not the word list knows it.
    `Lv 12 ${BLOCK_WORDS[0]}`,
    "Lv 12 kill yourself",
    "Lv 12 Idiot",
    "Lv 12 Damn Warrior",
    "Lv 7 Hero's Son",
    "Lv 2 Ann-Marie.",
    "Lv 12 warrior",
    "Lv 12 Warrior ",
    // Links, including TLDs the chat link check does not know.
    "Lv 12 https://example.com",
    "Lv 12 www.example.com",
    "Lv 12 scam.ru",
    "Lv 12 freegold.shop",
    "scam.ru",
    // Non-ASCII look-alikes (the reviewer's probes).
    "Lv 12 ｋｙｓ",
    "Lv 12 куѕ",
    "Lv 12 𝐤𝐲𝐬",
    "Lv 12 ｋｉｌｌｙｏｕｒｓｅｌｆ",
    "Lv 12 example.соm",
    "Lv 12 ｅｘａｍｐｌｅ.ｃｏｍ",
    "Lv 12 Wаrrior", // Cyrillic а
    "Lv 12 Ｗａｒｒｉｏｒ",
    "Ｌｖ １２ Warrior",
    "Lv １２ Warrior",
    // Symbols, emoji, markup, control characters.
    "Lv 12 Warrior 🔥",
    "★ Hero ★",
    "<b>Hero</b>",
    "Hero",
    "Lv\u0007 12 Warrior",
    "Lv 0 Warrior",
    "Lv 10000 Warrior",
    "Lv 012 Warrior",
    "lt-12a",
    "lt-",
  ])("drops %j", (tag) => {
    expect(sanitisePoseTag(tag, WORDS)).toBeUndefined();
    const r = sanitisePose(pose({ tag }), TOWN);
    expect(r).toEqual({
      ok: true,
      pose: { pos: { x: 36, y: 46 }, path: [{ x: 37, y: 46 }], speed: 4, appearance: "unit.hero" },
    });
  });

  it("drops every level tag in a world without a vocabulary", () => {
    expect(sanitisePoseTag("Lv 12 Warrior")).toBeUndefined();
    expect(sanitisePoseTag("Lv 12 Warrior", [])).toBeUndefined();
    const r = sanitisePose(pose({ tag: "Lv 12 Warrior" }), { width: 72, height: 72 });
    expect(r.ok && r.pose.tag).toBeUndefined();
  });

  it("drops non-strings and over-long tags", () => {
    expect(sanitisePoseTag(42, WORDS)).toBeUndefined();
    expect(sanitisePoseTag({ tag: "Lv 1 Rogue" }, WORDS)).toBeUndefined();
    expect(sanitisePoseTag(`lt-${"1".repeat(40)}`, WORDS)).toBeUndefined();
  });
});
