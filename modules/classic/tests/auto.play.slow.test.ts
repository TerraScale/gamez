/**
 * Integration check of the full classic mode with real content: a new
 * warrior in Full Idle must play by itself (explore, fight, level up).
 * This needs every classic module (content, world, core, combat, monsters,
 * items, progression) to be implemented, not just classic.auto.
 */
import { createSim, loadMode } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Level } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { heroOf, RES, type RunStats } from "../src/resources.ts";

describe("classic idle play (integration)", () => {
  // Integration check: it needs every classic module (content, world, core,
  // combat, monsters, items, progression), not only classic.auto. If one of
  // them regresses this fails; switch it to `it.skip` only with a note saying
  // which module broke it.
  it("a new warrior in Full Idle kills monsters, gains XP and levels up", () => {
    const sim = createSim(loadMode(mode, modules), { seed: 2026 });
    const created = sim.dispatch(
      "classic.newHero",
      { classId: "classic.warrior", name: "Brask" },
      null,
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    for (let i = 0; i < 60; i++) sim.step(100);
    const hero = heroOf(sim.world);
    expect(hero).not.toBe(0);
    const lvl = sim.world.read(hero, Level);
    const stats = sim.world.getResource<RunStats>(RES.stats)!;
    expect(stats.kills).toBeGreaterThan(0);
    expect(lvl.xp).toBeGreaterThan(0);
    expect(lvl.level).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
