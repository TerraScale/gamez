import { describe, expect, it } from "vite-plus/test";
import {
  appearanceCandidates,
  firstMatch,
  isDeathKey,
  resolveAction,
} from "../../src/client/render/appearance.ts";

describe("appearanceCandidates", () => {
  it("walks the documented chain for each prefix of a two-part id", () => {
    expect(appearanceCandidates("unit.hero", "walk", "ne")).toEqual([
      "unit.hero.walk.ne",
      "unit.hero.walk",
      "unit.hero.idle.ne",
      "unit.hero.idle",
      "unit.hero",
      "unit.walk.ne",
      "unit.walk",
      "unit.idle.ne",
      "unit.idle",
      "unit",
    ]);
  });

  it("tries every prefix from the full id down to the root, in order", () => {
    const c = appearanceCandidates("unit.monster.skeleton", "attack", "s");
    expect(c.slice(0, 5)).toEqual([
      "unit.monster.skeleton.attack.s",
      "unit.monster.skeleton.attack",
      "unit.monster.skeleton.idle.s",
      "unit.monster.skeleton.idle",
      "unit.monster.skeleton",
    ]);
    expect(c.indexOf("unit.monster.attack.s")).toBeGreaterThan(c.indexOf("unit.monster.skeleton"));
    expect(c.indexOf("unit.monster")).toBeGreaterThan(c.indexOf("unit.monster.skeleton.idle"));
    expect(c[c.length - 1]).toBe("unit");
  });

  it("appends the fallback chain after the whole primary chain", () => {
    const c = appearanceCandidates("unit.monster.skeleton", "walk", "e", "unit.hero");
    // The primary chain ends with its root "unit", so shared roots are not repeated.
    expect(c.indexOf("unit")).toBe(c.length - 6);
    expect(c.slice(c.indexOf("unit.hero.walk.e"))).toEqual([
      "unit.hero.walk.e",
      "unit.hero.walk",
      "unit.hero.idle.e",
      "unit.hero.idle",
      "unit.hero",
    ]);
  });

  it("has no duplicates when the action is idle or the fallback repeats the primary", () => {
    const c = appearanceCandidates("unit.hero", "idle", "s", "unit.hero");
    expect(new Set(c).size).toBe(c.length);
    expect(c.filter((k) => k === "unit.hero.idle.s")).toHaveLength(1);
  });

  it("returns nothing for an empty appearance", () => {
    expect(appearanceCandidates("", "idle", "n")).toEqual([]);
  });
});

describe("firstMatch", () => {
  it("returns the first candidate the lookup accepts", () => {
    const table: Record<string, number> = { "unit.hero.idle": 2, "unit.hero": 1 };
    const hit = firstMatch(
      ["unit.hero.walk", "unit.hero.idle", "unit.hero"],
      (k) => table[k] ?? null,
    );
    expect(hit).toEqual({ key: "unit.hero.idle", value: 2 });
  });

  it("returns null when nothing matches", () => {
    expect(firstMatch(["a", "b"], () => null)).toBeNull();
  });
});

describe("resolveAction", () => {
  it("prefers an explicit action, then death, then walk or idle", () => {
    expect(resolveAction("cast", true, true)).toBe("cast");
    expect(resolveAction(undefined, true, true)).toBe("death");
    expect(resolveAction(undefined, false, true)).toBe("walk");
    expect(resolveAction(undefined, undefined, false)).toBe("idle");
  });
});

describe("isDeathKey", () => {
  it("recognises death keys only", () => {
    expect(isDeathKey("unit.monster.zombie.death")).toBe(true);
    expect(isDeathKey("unit.monster.zombie.death.se")).toBe(true);
    expect(isDeathKey("unit.monster.zombie.idle")).toBe(false);
    expect(isDeathKey("unit.deathly")).toBe(false);
  });
});
