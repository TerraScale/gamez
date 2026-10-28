import { describe, expect, it } from "vite-plus/test";
import {
  classifyResolution,
  DebugTracker,
  sortedRecord,
  windowStats,
} from "../../src/client/render/debug.ts";

describe("classifyResolution", () => {
  it("separates exact, action-fallback, generic, fallback and primitive", () => {
    const a = "unit.monster.husk";
    expect(classifyResolution(a, "walk", "ne", "unit.monster.husk.walk")).toBe("exact");
    expect(classifyResolution(a, "walk", "ne", "unit.monster.husk.walk.ne")).toBe("exact");
    expect(classifyResolution(a, "idle", "s", "unit.monster.husk")).toBe("exact");
    expect(classifyResolution(a, "cast", "s", "unit.monster.husk.idle")).toBe("action-fallback");
    expect(classifyResolution(a, "walk", "s", "unit.monster.husk")).toBe("action-fallback");
    expect(classifyResolution(a, "walk", "s", "unit.monster.walk")).toBe("generic");
    expect(classifyResolution(a, "walk", "s", "unit.hero.walk")).toBe("fallback");
    expect(classifyResolution(a, "walk", "s", null)).toBe("primitive");
  });

  it("treats the bare sprite of single-sprite kinds as exact", () => {
    expect(classifyResolution("fx.arrow", "walk", "e", "fx.arrow", "projectile")).toBe("exact");
    expect(classifyResolution("loot.gold", "walk", "s", "loot.gold", "loot")).toBe("exact");
    expect(classifyResolution("unit.hero", "walk", "s", "unit.hero", "unit")).toBe(
      "action-fallback",
    );
  });
});

describe("windowStats", () => {
  it("averages and takes the 95th percentile of the filled part", () => {
    const buf = new Float32Array(8);
    buf.set([10, 20, 30, 40]);
    expect(windowStats(buf, 4)).toEqual({ avg: 25, p95: 40, max: 40 });
    expect(windowStats(buf, 0)).toEqual({ avg: 0, p95: 0, max: 0 });
  });
});

describe("DebugTracker", () => {
  it("records resolutions, missing appearances, effects and frames", () => {
    const t = new DebugTracker();
    t.resolved("unit.monster.x", "walk", "s", "unit.hero", "unit.hero.walk");
    t.resolved("unit.monster.y", "idle", "s", "", "unit.monster.y.idle");
    t.effect("nova", "fx.frost_ring", false);
    t.effect("hit", undefined, true);
    t.effect("nova", "fx.frost_ring", "anim");
    t.effect("explosion", "fx.blast", "sprite");
    for (let i = 0; i < 300; i++) t.frame(16, 2);
    expect(sortedRecord(t.anims)).toEqual({
      "unit.monster.x|walk|s": "unit.hero.walk (fallback)",
      "unit.monster.y|idle|s": "unit.monster.y.idle (exact)",
    });
    expect([...t.entityMissing]).toEqual(["unit.monster.x"]);
    expect(sortedRecord(t.effects)).toEqual({
      "explosion|fx.blast": "sprite",
      "hit|": "sprite",
      "nova|fx.frost_ring": "anim",
    });
    expect(t.effectsPlayed).toBe(4);
    expect(t.frameMs()).toEqual({ avg: 16, p95: 16, max: 16 });
    expect(t.tickMs()).toEqual({ avg: 2, p95: 2 });
  });
});
