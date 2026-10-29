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
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { pushCommand } from "../src/bus.ts";
import { Level } from "../src/components.ts";
import { BALANCE } from "../src/content/balance.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { currentDepth, dungeonOf, heroOf, RES, type QuestState } from "../src/resources.ts";
import { xpAtLevel } from "../src/rules.ts";

const CRYPT = "classic.quest.clear_the_crypt";
const RATS = "classic.quest.rats_in_the_cellar";
const DEEPER = "classic.quest.deeper_still";
const NINTH = "classic.quest.into_the_ninth";
const CULL = "classic.quest.cull_the_flames";
const ASH = "classic.quest.ash_and_ember";
const loaded = loadMode(mode, modules);

/** Ticks within which a level 10 hero completes and turns in Clear the Crypt (see the header). */
const CRYPT_BUDGET = 16_000;

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

function quests(sim: Sim): QuestState {
  return sim.world.getResource<QuestState>(RES.quests)!;
}

/** Steps one tick at a time until `done(event)` matches or `budget` ticks pass; records every event with its tick. */
function stepUntil(
  sim: Sim,
  budget: number,
  done: (e: ClassicEvent) => boolean,
  seen: { tick: number; e: ClassicEvent }[] = [],
): ClassicEvent | undefined {
  for (let i = 0; i < budget; i++) {
    for (const raw of sim.step(1) as GameEvent[]) {
      const e = raw as ClassicEvent;
      seen.push({ tick: sim.tick, e });
      if (done(e)) return e;
    }
  }
  return undefined;
}

describe("Auto quests: Clear the Crypt", () => {
  const cases: [string, Control][] = [
    ["classic.sorcerer", "auto"],
    ["classic.sorcerer", "idle"],
    ["classic.rogue", "auto"],
    ["classic.rogue", "idle"],
    ["classic.warrior", "idle"],
  ];
  for (const [classId, control] of cases) {
    it(`${classId} (${control}) goes back to depth 3, clears it and turns the quest in`, () => {
      const sim = cryptSim(classId, 11, control);
      const seen: { tick: number; e: ClassicEvent }[] = [];
      const turned = stepUntil(
        sim,
        CRYPT_BUDGET,
        (e) => e.type === "classic.quest.completed" && e.quest === CRYPT,
        seen,
      );
      expect(turned, `Clear the Crypt not turned in within ${CRYPT_BUDGET} ticks`).toBeDefined();
      // It went to depth 3 (not the deepest waypoint) and finished the quest there.
      const first = seen.find((s) => s.e.type === "classic.area.changed" && s.e.depth > 0);
      expect(first?.e.type === "classic.area.changed" && first.e.depth).toBe(3);
      const done = seen.find((s) => s.e.type === "classic.quest.done" && s.e.quest === CRYPT);
      expect(done).toBeDefined();
      // Every level-3 visit before the clear stayed on depth 3 (no voluntary descent).
      const before = seen.filter(
        (s) => s.tick <= done!.tick && s.e.type === "classic.area.changed",
      );
      for (const s of before)
        if (s.e.type === "classic.area.changed") expect([0, 3]).toContain(s.e.depth);
      const qs = quests(sim);
      expect(qs.completed).toContain(CRYPT);
      expect(qs.active.some((a) => a.id === CRYPT)).toBe(false);
      expect(currentDepth(sim.world)).toBe(0);
    }, 300_000);
  }

  it("waits (no objective trip) while depth 3 is too strong for the hero", () => {
    // Level 1 hero: monster level 4 > 1 + 2. It goes to depth 1 by the stairs as usual.
    const sim = newSim("classic.sorcerer", 5, "auto");
    const d = dungeonOf(sim.world);
    d.deepest = 4;
    d.waypoints = [0, 1, 3];
    sim.world.setResource(RES.quests, {
      active: [{ id: CRYPT, progress: 0, done: false }],
      completed: [],
    } satisfies QuestState);
    const arrived = stepUntil(sim, 2000, (e) => e.type === "classic.area.changed" && e.depth > 0);
    expect(arrived?.type === "classic.area.changed" && arrived.depth).toBe(1);
  }, 60_000);

  it("respects autoDescend off: no objective trip, exploration as configured", () => {
    const sim = cryptSim("classic.sorcerer", 11, "auto");
    const cfg = sim.dispatch("classic.setAutoConfig", { config: { autoDescend: false } }, null);
    expect(cfg.ok, JSON.stringify(cfg.error)).toBe(true);
    const arrived = stepUntil(sim, 2000, (e) => e.type === "classic.area.changed" && e.depth > 0);
    // Without the objective the return step picks the deepest suitable waypoint.
    expect(arrived?.type === "classic.area.changed" && arrived.depth).toBe(3);
    // ...but it never hunts the level down: the plan note "clear level" never appears.
    const seen: { tick: number; e: ClassicEvent }[] = [];
    stepUntil(sim, 1500, () => false, seen);
    expect(seen.some((s) => s.e.type === "classic.auto.plan" && s.e.note === "clear level")).toBe(
      false,
    );
  }, 60_000);
});

describe("Auto quests: chained quests in one visit", () => {
  it("turns in Deeper Still and accepts Into the Ninth in the same town visit", () => {
    const sim = newSim("classic.rogue", 21, "idle");
    // Level 15, 100 XP short of 16: the 300 XP of Deeper Still makes Into the Ninth (16) available.
    pushCommand(sim.world, {
      op: "grantXp",
      amount: xpAtLevel(BALANCE, 16) - 100,
      reason: "test",
    });
    const d = dungeonOf(sim.world);
    d.deepest = 6;
    d.waypoints = [0, 1, 3, 5];
    sim.world.setResource(RES.quests, {
      active: [{ id: DEEPER, progress: 6, done: true }],
      completed: [RATS],
    } satisfies QuestState);
    sim.step(1);
    const hero = heroOf(sim.world);
    expect(sim.world.read(hero, Level).level).toBe(15);

    const seen: { tick: number; e: ClassicEvent }[] = [];
    const accepted = stepUntil(
      sim,
      3000,
      (e) => e.type === "classic.quest.accepted" && e.quest === NINTH,
      seen,
    );
    expect(accepted, "Into the Ninth was not accepted").toBeDefined();
    const completed = seen.find(
      (s) => s.e.type === "classic.quest.completed" && s.e.quest === DEEPER,
    );
    expect(completed, "Deeper Still was not turned in").toBeDefined();
    const acceptedAt = seen[seen.length - 1]!.tick;
    // One batch: same tick, and no area change between (still the first town visit).
    expect(acceptedAt).toBe(completed!.tick);
    expect(seen.some((s) => s.e.type === "classic.area.changed")).toBe(false);
    expect(currentDepth(sim.world)).toBe(0);
    expect(sim.world.read(hero, Level).level).toBeGreaterThanOrEqual(16);
    const qs = quests(sim);
    expect(qs.completed).toContain(DEEPER);
    expect(qs.active.some((a) => a.id === NINTH)).toBe(true);
  }, 60_000);
});

describe("Auto quests: offline progress", () => {
  it("credits offline kills to Cull the Flames (min(200, kills)); other quests unchanged", () => {
    const sim = newSim("classic.warrior", 31, "manual");
    grantHero(sim, 10);
    sim.step(1);
    sim.world.setResource(RES.quests, {
      active: [
        { id: ASH, progress: 3, done: false },
        { id: CULL, progress: 7, done: false },
        { id: DEEPER, progress: 2, done: false },
      ],
      completed: [RATS],
    } satisfies QuestState);
    const r = sim.dispatch("classic.offlineProgress", { elapsedMs: 3_600_000 }, null);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const events = r.events as ClassicEvent[];
    const summary = events.find((e) => e.type === "classic.offline.summary");
    expect(summary?.type).toBe("classic.offline.summary");
    const kills = summary?.type === "classic.offline.summary" ? summary.kills : 0;
    expect(kills).toBeGreaterThan(0);
    const qs = quests(sim);
    const cull = qs.active.find((a) => a.id === CULL)!;
    expect(cull.progress).toBe(Math.min(200, 7 + kills));
    expect(cull.done).toBe(7 + kills >= 200);
    expect(qs.active.find((a) => a.id === ASH)).toEqual({ id: ASH, progress: 3, done: false });
    expect(qs.active.find((a) => a.id === DEEPER)).toEqual({
      id: DEEPER,
      progress: 2,
      done: false,
    });
    expect(
      events.some(
        (e) =>
          e.type === "classic.quest.progress" && e.quest === CULL && e.progress === cull.progress,
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "classic.quest.done" && e.quest === CULL)).toBe(cull.done);
    expect(events.some((e) => e.type === "classic.quest.progress" && e.quest !== CULL)).toBe(false);
  });

  it("leaves a finished Cull the Flames alone (no event, no change)", () => {
    const sim = newSim("classic.sorcerer", 32, "manual");
    grantHero(sim, 10);
    sim.step(1);
    sim.world.setResource(RES.quests, {
      active: [{ id: CULL, progress: 200, done: true }],
      completed: [],
    } satisfies QuestState);
    const r = sim.dispatch("classic.offlineProgress", { elapsedMs: 600_000 }, null);
    expect(r.ok).toBe(true);
    expect((r.events as ClassicEvent[]).some((e) => e.type.startsWith("classic.quest."))).toBe(
      false,
    );
    expect(quests(sim).active).toEqual([{ id: CULL, progress: 200, done: true }]);
  });
});

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
    expect(script(77).hash()).toBe("b7343025a0ad23fc");
  }, 120_000);
});
