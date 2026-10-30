/**
 * Quest-blocking balance (quest fix, round 1): the gameplay that kept Auto
 * and Idle heroes from finishing the boss and depth quests, on the real
 * classic content with every module (plus classic.debug for the grants).
 *
 * - The warrior used to stall at depths 3-4 (34 deaths and 2 depth-4 boss
 *   kills in 8 seeds x 36 000 ticks): it burnt its small mana pool on
 *   single-target cleaves (no Rallying Cry or Mend left) and opened with a
 *   2-7 short sword. Now: 7 deaths, 5 kills, 5 runs at depth 6+.
 * - Boss fights: a level-appropriate hero of each class kills Morrow
 *   (depth 4), and a hero at the quest level kills Vessa (depth 12) and the
 *   Hollow King (16) and turns The Ninth Flame and Crown of Hollows in (the
 *   measured numbers are with those tests; Skarn is in quests.bosses.test.ts).
 * - Browser QA: `spawnBoss` + `woundBosses: 1` in one grant failed with "no
 *   living boss" (the spawn is queued) and rolled the spawn back with it, so
 *   QA wounded nothing and watched a full-life boss. The wound now waits for
 *   the queued boss, and the spawn tile is always one the hero can walk to.
 *
 * Budgets are the measured ticks plus a margin; content and the Auto
 * controller change in parallel, so they are not exact.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { pushTransition } from "../src/bus.ts";
import { Level } from "../src/components.ts";
import { debugModules, mode, modules } from "../src/index.ts";
import { heroOf } from "../src/resources.ts";
import { grant } from "./support/boss-quests.ts";
const debugLoaded = loadMode(mode, [...modules, ...debugModules]);

const WARDEN = "classic.monster.boss_warden";

describe("determinism", () => {
  function script(): Sim {
    const sim = createSim(debugLoaded, { seed: 2026 });
    sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Pin" }, null);
    sim.dispatch("classic.setControl", { mode: "auto" }, null);
    sim.step(600);
    pushTransition(sim.world, { to: 2, via: "stairsDown" });
    sim.step(2);
    grant(sim, { levels: 6 });
    grant(sim, { spawnBoss: WARDEN, woundBosses: 20 });
    sim.step(400);
    return sim;
  }

  it("the same seed and script give the same hash (pinned)", () => {
    const a = script();
    const b = script();
    expect(a.hash()).toBe(b.hash());
    expect(a.world.read(heroOf(a.world), Level).level).toBeGreaterThanOrEqual(7);
    // Re-pinned for classic.debug 0.5.0 (wearGear): the debug module version is in the hash.
    expect(a.hash()).toBe("5b9f46d95c65bf50");
  }, 120_000);
});
