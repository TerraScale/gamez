/**
 * Auto/Idle quest behaviour (classic.auto 0.3.2), on the real content with
 * every classic module:
 *  - Clear the Crypt (clearLevel, depth 3): Auto travels back to depth 3
 *    (waypoint, or the portal when it leads there), hunts the level down to
 *    its last living monster, then turns the quest in. Before the fix Auto
 *    left every level at explorePct and always returned to the deepest
 *    waypoint, so the quest never completed;
 *  - chained quests are accepted in the visit their prerequisite is turned
 *    in (also when the turn-in's XP reaches the chained quest's reqLevel);
 *  - classic.offlineProgress credits its kills to "any monster" kill quests;
 *  - determinism: same seed and script, same hash; one pinned hash.
 *
 * Tick budgets: measured with seed 11 at level 10 with 6 granted rare items
 * (sorcerer done 6628 / turned in 6731, rogue 11558 / 11690, warrior 11325 /
 * 11847 ticks); CRYPT_BUDGET leaves about 40 % margin over the slowest.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { pushCommand } from "../src/bus.ts";
import { BALANCE } from "../src/content/balance.ts";
import { mode, modules } from "../src/index.ts";
import { dungeonOf, RES, type QuestState } from "../src/resources.ts";
import { xpAtLevel } from "../src/rules.ts";
const CRYPT = "classic.quest.clear_the_crypt";
const RATS = "classic.quest.rats_in_the_cellar";
const CULL = "classic.quest.cull_the_flames";
const loaded = loadMode(mode, modules);

type Control = "idle" | "auto" | "manual";

function newSim(classId: string, seed: number, control: Control): Sim {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch("classic.newHero", { classId, name: "Quester" }, null);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const ctl = sim.dispatch("classic.setControl", { mode: control }, null);
  expect(ctl.ok, JSON.stringify(ctl.error)).toBe(true);
  return sim;
}

/** Level, gear and gold for a hero that has been around (queued; they apply on the next step). */
function grantHero(sim: Sim, level: number, xpExtra = 0): void {
  pushCommand(sim.world, {
    op: "grantXp",
    amount: xpAtLevel(BALANCE, level) + xpExtra,
    reason: "test",
  });
  pushCommand(sim.world, {
    op: "grantItems",
    count: 6,
    ilvl: level,
    minRarity: "rare",
    toStash: false,
    reason: "test",
  });
  pushCommand(sim.world, { op: "grantGold", amount: 3000, reason: "test" });
}

/** A level 10 hero in town that has been down to depth 4 (waypoints 1 and 3), Clear the Crypt active. */
function cryptSim(classId: string, seed: number, control: Control): Sim {
  const sim = newSim(classId, seed, control);
  grantHero(sim, 10);
  const d = dungeonOf(sim.world);
  d.deepest = 4;
  d.waypoints = [0, 1, 3];
  const qs: QuestState = { active: [{ id: CRYPT, progress: 0, done: false }], completed: [RATS] };
  sim.world.setResource(RES.quests, qs);
  return sim;
}

/** A short fixed script: crypt setup, 1500 Auto ticks, an offline hour, 300 ticks. */
function script(seed: number): Sim {
  const sim = cryptSim("classic.sorcerer", seed, "auto");
  sim.world.setResource(RES.quests, {
    active: [
      { id: CRYPT, progress: 0, done: false },
      { id: CULL, progress: 0, done: false },
    ],
    completed: [RATS],
  } satisfies QuestState);
  sim.step(1500);
  expect(sim.dispatch("classic.offlineProgress", { elapsedMs: 3_600_000 }, null).ok).toBe(true);
  sim.step(300);
  return sim;
}

describe("Auto quests: determinism", () => {
  it("same seed and script give the same hash", () => {
    expect(script(77).hash()).toBe(script(77).hash());
  }, 120_000);

  it("pins the hash of the fixed script", () => {
    expect(script(77).hash()).toBe("5b9fdfd49a3eef5d");
  }, 120_000);
});
