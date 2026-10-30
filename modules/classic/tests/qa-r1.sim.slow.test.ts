/**
 * QA round 1 regressions (real content, every classic module):
 *  - a finished quest is turned in on a town trip, and the hero goes back down;
 *  - a headless Idle rogue (seed 4242) completes "Rats in the Cellar" within a bounded budget;
 *  - Auto drinks life potions only below its threshold, and every drink restores
 *    exactly the potion's amount (capped at max).
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Life } from "../src/components.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { currentDepth, heroOf, RES, type QuestState } from "../src/resources.ts";

const RATS = "classic.quest.rats_in_the_cellar";
const SEED = 4242;
const loaded = loadMode(mode, modules);

function startAuto(classId: string, seed = SEED): Sim {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch("classic.newHero", { classId, name: "Qa" }, null);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const control = sim.dispatch("classic.setControl", { mode: "idle" }, null);
  expect(control.ok, JSON.stringify(control.error)).toBe(true);
  return sim;
}

/** Steps one tick at a time until `done(event)` matches an event or `budget` ticks pass. */
function stepUntil(
  sim: Sim,
  budget: number,
  done: (e: ClassicEvent) => boolean,
  seen: ClassicEvent[] = [],
): { found: ClassicEvent | undefined; tick: number } {
  for (let i = 0; i < budget; i++) {
    const events = sim.step(1) as GameEvent[];
    for (const raw of events) {
      const e = raw as ClassicEvent;
      seen.push(e);
      if (done(e)) return { found: e, tick: sim.tick };
    }
  }
  return { found: undefined, tick: sim.tick };
}

describe("QA r1: quests are turned in on a town trip", () => {
  it("a finished quest sends Auto to town, the quest is completed, and the hero goes back down", () => {
    const sim = startAuto("classic.rogue");
    // Into the dungeon first (the controller leaves town on its own).
    const down = stepUntil(sim, 4000, (e) => e.type === "classic.area.changed" && e.depth > 0);
    expect(down.found, "hero never reached the dungeon").toBeDefined();
    expect(currentDepth(sim.world)).toBeGreaterThan(0);

    // The quest is finished in the field but not yet turned in.
    const qs: QuestState = { active: [{ id: RATS, progress: 20, done: true }], completed: [] };
    sim.world.setResource(RES.quests, qs);

    const seen: ClassicEvent[] = [];
    const turnIn = stepUntil(
      sim,
      8000,
      (e) => e.type === "classic.quest.completed" && e.quest === RATS,
      seen,
    );
    expect(turnIn.found, "finished quest was never turned in").toBeDefined();
    // The trip was a quest trip (the plan note says so) and it happened in town.
    expect(seen.some((e) => e.type === "classic.auto.plan" && e.note.includes("quest"))).toBe(true);
    expect(currentDepth(sim.world)).toBe(0);

    // And after the turn-in the hero went back into the dungeon.
    const back = stepUntil(sim, 3000, (e) => e.type === "classic.area.changed" && e.depth > 0);
    expect(back.found, "hero did not go back to the dungeon").toBeDefined();
    expect(sim.world.getResource<QuestState>(RES.quests)!.completed).toContain(RATS);
    expect(heroOf(sim.world)).not.toBe(0);
  }, 120_000);
});

describe("QA r1: headless Idle rogue completes Rats in the Cellar", () => {
  it("completes the quest within the tick budget (seed 4242)", () => {
    const sim = startAuto("classic.rogue");
    const seen: ClassicEvent[] = [];
    const done = stepUntil(
      sim,
      12_000,
      (e) => e.type === "classic.quest.completed" && e.quest === RATS,
      seen,
    );
    expect(done.found, "Rats in the Cellar not completed in 12 000 ticks").toBeDefined();
    // Bounded: about 10 sim minutes at 20 Hz.
    expect(done.tick).toBeLessThanOrEqual(12_000);
    expect(sim.world.getResource<QuestState>(RES.quests)!.completed).toContain(RATS);
  }, 180_000);
});

describe("QA r1: Auto potion use", () => {
  it("drinks only below the 50 % default and restores exactly the potion amount, capped at max", () => {
    const sim = startAuto("classic.rogue");
    let drinks = 0;
    let refused = 0;
    for (let i = 0; i < 6000; i++) {
      const events = sim.step(1) as GameEvent[];
      const hero = heroOf(sim.world);
      const life = hero === 0 ? undefined : sim.world.get(hero, Life);
      for (const raw of events) {
        const e = raw as ClassicEvent;
        if (e.type === "classic.command.failed" && e.code === "potion_useless") refused++;
        if (e.type !== "classic.potion" || e.kind !== "life") continue;
        drinks++;
        expect(life, "a drink without a hero").toBeDefined();
        const max = life!.max;
        // Below the configured threshold (strictly), at the moment of the drink.
        expect(e.lifeBefore * 100, `drink at ${e.lifeBefore}/${max}`).toBeLessThan(50 * max);
        // Exactly the potion amount, capped at max.
        expect(e.lifeAfter).toBe(Math.min(max, e.lifeBefore + e.amount));
      }
    }
    expect(drinks).toBeGreaterThan(0);
    // Auto never asks for a useless drink.
    expect(refused).toBe(0);
  }, 180_000);
});
