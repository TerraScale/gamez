import { describe, expect, it } from "vite-plus/test";
import {
  appearanceCandidates,
  firstMatch,
  hasFacingSuffix,
  isDeathKey,
  resolveAction,
  shouldFlip,
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

describe("cast and hit stand-ins", () => {
  it("tries cast, then attack, then idle for each prefix", () => {
    expect(appearanceCandidates("unit.hero.warrior", "cast", "e").slice(0, 7)).toEqual([
      "unit.hero.warrior.cast.e",
      "unit.hero.warrior.cast",
      "unit.hero.warrior.attack.e",
      "unit.hero.warrior.attack",
      "unit.hero.warrior.idle.e",
      "unit.hero.warrior.idle",
      "unit.hero.warrior",
    ]);
  });

  it("resolves a cast to the attack clip when no cast clip exists", () => {
    const art = new Set(["unit.hero.warrior.attack", "unit.hero.warrior.idle"]);
    const c = appearanceCandidates("unit.hero.warrior", "cast", "sw", "unit.hero");
    expect(firstMatch(c, (k) => (art.has(k) ? k : null))?.key).toBe("unit.hero.warrior.attack");
  });

  it("resolves a hit to the hit clip, else idle (the flash makes it read)", () => {
    const withHit = new Set(["unit.monster.x.hit", "unit.monster.x.idle"]);
    const c = appearanceCandidates("unit.monster.x", "hit", "s");
    expect(firstMatch(c, (k) => (withHit.has(k) ? k : null))?.key).toBe("unit.monster.x.hit");
    expect(firstMatch(c, (k) => (k === "unit.monster.x.idle" ? k : null))?.key).toBe(
      "unit.monster.x.idle",
    );
    expect(c).not.toContain("unit.monster.x.attack");
  });
});

describe("shouldFlip", () => {
  it("mirrors facing-less art for the screen-left facings only", () => {
    expect(shouldFlip("unit.hero.walk", "w", "unit")).toBe(true);
    expect(shouldFlip("unit.hero.walk", "sw", "unit")).toBe(true);
    expect(shouldFlip("unit.hero.walk", "nw", "npc")).toBe(true);
    for (const f of ["n", "ne", "e", "se", "s"] as const) {
      expect(shouldFlip("unit.hero.walk", f, "unit")).toBe(false);
    }
  });

  it("never mirrors facing-specific clips, single sprites or unresolved bodies", () => {
    expect(shouldFlip("unit.hero.walk.w", "w", "unit")).toBe(false);
    expect(shouldFlip("loot.item.sword", "w", "loot")).toBe(false);
    expect(shouldFlip("fx.arrow", "w", "projectile")).toBe(false);
    expect(shouldFlip("prop.stash", "w", "prop")).toBe(false);
    expect(shouldFlip("", "w", "unit")).toBe(false);
  });

  it("recognises facing suffixes", () => {
    expect(hasFacingSuffix("a.walk.ne")).toBe(true);
    expect(hasFacingSuffix("a.walk")).toBe(false);
    expect(hasFacingSuffix("news")).toBe(false);
  });
});
