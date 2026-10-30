/**
 * QA round 2 regressions (real content, every classic module):
 *  - Idle heroes take the stairs down: once the descend plan is committed,
 *    only close foes (or attackers) and close loot interrupt the walk
 *    (seed 4242 used to stay on depth 1 for good);
 *  - "Deeper Still" (reqLevel 4) is accepted: a quest the hero now
 *    qualifies for is a town-trip reason;
 *  - Cleave (an arc skill) emits one classic.effect per swing, hit or miss.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { pushCommand } from "../src/bus.ts";
import { Level } from "../src/components.ts";
import { BALANCE } from "../src/content/balance.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { currentDepth, dungeonOf, heroOf, RES, type QuestState } from "../src/resources.ts";
import { xpAtLevel } from "../src/rules.ts";

const SEED = 4242;
const RATS = "classic.quest.rats_in_the_cellar";
const DEEPER = "classic.quest.deeper_still";
const CLEAVE = "classic.skill.cleave";
const loaded = loadMode(mode, modules);

function startIdle(classId: string, seed = SEED): Sim {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch("classic.newHero", { classId, name: "Qa" }, null);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const control = sim.dispatch("classic.setControl", { mode: "idle" }, null);
  expect(control.ok, JSON.stringify(control.error)).toBe(true);
  return sim;
}

/** Steps one tick at a time until `done(event)` matches or `budget` ticks pass; records every event. */
function stepUntil(
  sim: Sim,
  budget: number,
  done: (e: ClassicEvent) => boolean,
  seen: ClassicEvent[] = [],
): ClassicEvent | undefined {
  for (let i = 0; i < budget; i++) {
    for (const raw of sim.step(1) as GameEvent[]) {
      const e = raw as ClassicEvent;
      seen.push(e);
      if (done(e)) return e;
    }
  }
  return undefined;
}

describe("QA r2: Idle takes the stairs down", () => {
  it("an Idle warrior (seed 4242) reaches depth 2, accepting Deeper Still on the way", () => {
    const sim = startIdle("classic.warrior");
    const seen: ClassicEvent[] = [];
    // Before the fix: 0 descents in 6000+ ticks (fights within 12 tiles always preempted it).
    // Now about 7300 ticks: two town trips and real fights on a 128x128 level.
    const down = stepUntil(
      sim,
      9000,
      (e) => e.type === "classic.area.changed" && e.depth >= 2,
      seen,
    );
    expect(down, "never reached depth 2 in 9000 ticks").toBeDefined();
    expect(dungeonOf(sim.world).deepest).toBeGreaterThanOrEqual(2);
    // It got there by the descend plan (the stairs), not by a waypoint.
    expect(seen.some((e) => e.type === "classic.auto.plan" && e.plan === "descend")).toBe(true);
    // Deeper Still (reqLevel 4) was accepted on a quest trip once the hero qualified.
    expect(seen.some((e) => e.type === "classic.quest.accepted" && e.quest === DEEPER)).toBe(true);
    expect(seen.some((e) => e.type === "classic.auto.plan" && e.note === "quest")).toBe(true);

    // Cleave swings: one classic.effect per fired cast, hit or miss.
    const casts = seen.filter((e) => e.type === "classic.cast" && e.skill === CLEAVE);
    const swings = seen.filter(
      (e) => e.type === "classic.effect" && e.effect === "fx.cleave",
    ) as Extract<ClassicEvent, { type: "classic.effect" }>[];
    expect(casts.length).toBeGreaterThan(0);
    // A cast interrupted before its hit tick (stun, death, area change) never fires.
    expect(swings.length).toBeLessThanOrEqual(casts.length);
    expect(swings.length).toBeGreaterThanOrEqual(Math.floor(casts.length / 2));
    for (const s of swings) {
      expect(s.points).toHaveLength(1);
      expect(s.radius).toBeGreaterThan(0);
    }
  }, 180_000);
});

describe("QA r2: Deeper Still is accepted", () => {
  it("a level 4 hero in the dungeon with Deeper Still available goes to town and accepts it", () => {
    const sim = startIdle("classic.rogue");
    const inDungeon = stepUntil(sim, 4000, (e) => e.type === "classic.area.changed" && e.depth > 0);
    expect(inDungeon, "hero never reached the dungeon").toBeDefined();
    // Level 4 now, Rats already turned in: only Deeper Still (reqLevel 4) is open.
    const hero = heroOf(sim.world);
    pushCommand(sim.world, { op: "grantXp", amount: xpAtLevel(BALANCE, 4), reason: "test" });
    sim.step(1);
    expect(sim.world.read(hero, Level).level).toBeGreaterThanOrEqual(4);
    const qs: QuestState = { active: [], completed: [RATS] };
    sim.world.setResource(RES.quests, qs);

    const seen: ClassicEvent[] = [];
    const accepted = stepUntil(
      sim,
      4000,
      (e) => e.type === "classic.quest.accepted" && e.quest === DEEPER,
      seen,
    );
    expect(accepted, "Deeper Still was never accepted").toBeDefined();
    expect(seen.some((e) => e.type === "classic.auto.plan" && e.note === "quest")).toBe(true);
    expect(currentDepth(sim.world)).toBe(0);
    const active = sim.world.getResource<QuestState>(RES.quests)!.active;
    expect(active.some((a) => a.id === DEEPER)).toBe(true);

    // No ping-pong: the hero goes back down and makes no further quest trip.
    const after: ClassicEvent[] = [];
    stepUntil(sim, 3000, () => false, after);
    expect(after.some((e) => e.type === "classic.area.changed" && e.depth > 0)).toBe(true);
    expect(after.some((e) => e.type === "classic.auto.plan" && e.note === "quest")).toBe(false);
  }, 180_000);
});
