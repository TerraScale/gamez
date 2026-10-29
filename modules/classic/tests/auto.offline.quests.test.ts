/**
 * Offline progress and quests (design §15.4 and §16 rule (d)), on the real
 * classic catalog and every classic module.
 *
 * The rule under test (auto/offline.ts creditOfflineKills): the offline kills
 * are spread over the monsters of the offline depth (depthMonsterIds, n of
 * them):
 *  - target "*" gains every kill;
 *  - a named target in that list gains floor(kills / n);
 *  - a named target outside it gains 0;
 *  - progress is capped at the quest count; reachDepth, killBoss and clearLevel
 *    never change offline.
 *
 * Quests are accepted through the real classic.acceptQuest, with the hero
 * placed in reach of Captain Hale (as quests.all.test.ts does). The offline
 * depth is the deepest waypoint whose monster level fits the hero (level 10):
 * depth 5 (caves, tier 1) is set through the waypoints. Caves hold gnawlings
 * but not ash seers, so one named target is in the list and one is not.
 */
import { createSim, loadMode, type Entity, type Sim, type World } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { pushCommand, pushTransition } from "../src/bus.ts";
import { Level, Npc, Pos } from "../src/components.ts";
import { BALANCE } from "../src/content/balance.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { placeNear } from "../src/monsters/spawn.ts";
import { depthMonsterIds } from "../src/auto/offline.ts";
import {
  currentDepth,
  dungeonOf,
  heroOf,
  questsOf,
  RES,
  type QuestState,
} from "../src/resources.ts";
import { xpAtLevel } from "../src/rules.ts";
import { gridOf } from "../src/spatial.ts";
import { getAreaMap } from "../src/world/maps.ts";
import { KIND, type QuestProto } from "../src/types.ts";

const SEED = 4242;
const HALE = "classic.npc.captain_hale";
const RATS = "classic.quest.rats_in_the_cellar";
const DEEPER = "classic.quest.deeper_still";
const WARDENS = "classic.quest.wardens_rest";
const CRYPT = "classic.quest.clear_the_crypt";
const CULL = "classic.quest.cull_the_flames";
const ASH = "classic.quest.ash_and_ember";
const GNAWLING = "classic.monster.gnawling";
const ASH_SEER = "classic.monster.ash_seer";
/** Waypoint depth that the offline progress uses (caves, tier 1). */
const OFFLINE_DEPTH = 5;
const HOUR = 3_600_000;

const loaded = loadMode(mode, modules);
const quest = (id: string): QuestProto => loaded.registry.require<QuestProto>(KIND.quest, id);

/** Offline kill quest test setup: a level 10 hero in town, waypoints up to depth 5. */
function newSim(seed = SEED, classId = "classic.warrior"): Sim {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch(ACTION.newHero, { classId, name: "Quester" }, null);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const ctl = sim.dispatch(ACTION.setControl, { mode: "manual" }, null);
  expect(ctl.ok, JSON.stringify(ctl.error)).toBe(true);
  sim.step(2);
  const hero = heroOf(sim.world);
  pushCommand(sim.world, {
    op: "grantXp",
    amount: xpAtLevel(BALANCE, 10) - sim.world.read(hero, Level).xp,
    reason: "test",
  });
  sim.step(1);
  expect(sim.world.read(hero, Level).level).toBeGreaterThanOrEqual(10);
  dungeonOf(sim.world).waypoints = [0, 1, OFFLINE_DEPTH];
  return sim;
}

/** Moves the hero to town and into reach of Captain Hale. */
function nearHale(sim: Sim): void {
  const world: World = sim.world;
  if (currentDepth(world) !== 0) {
    pushTransition(world, { to: 0, via: "stairsUp" });
    sim.step(1);
  }
  let hale: Entity | undefined;
  for (const e of world.query(Npc, Pos)) if (world.read(e, Npc).proto === HALE) hale = e;
  expect(hale, "Captain Hale is in the town").toBeDefined();
  const p = world.read(hale!, Pos);
  const at = placeNear(getAreaMap(world, sim.loaded.registry), p.x + 128, p.y);
  world.update(heroOf(world), Pos, at);
  gridOf(world).move(heroOf(world), at.x, at.y);
}

/** Accepts a quest near Hale through the real action; expects success. */
function accept(sim: Sim, id: string): void {
  nearHale(sim);
  const res = sim.dispatch(ACTION.acceptQuest, { quest: id }, null);
  expect(res.ok, `accept ${id}: ${res.error?.code} ${res.error?.message}`).toBe(true);
  sim.step(1);
}

function activeOf(sim: Sim, id: string) {
  const a = questsOf(sim.world).active.find((q) => q.id === id);
  expect(a, `${id} is active`).toBeDefined();
  return a!;
}

/** Runs the offline action and returns its events and summary kills. */
function offline(sim: Sim, elapsedMs: number) {
  const r = sim.dispatch(ACTION.offlineProgress, { elapsedMs }, null);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  const events = r.events as ClassicEvent[];
  const summary = events.find((e) => e.type === "classic.offline.summary");
  expect(summary?.type).toBe("classic.offline.summary");
  const kills = summary?.type === "classic.offline.summary" ? summary.kills : -1;
  return { events, kills };
}

describe("Offline quests: the rule (d) credit", () => {
  it("'*' target (Cull the Flames) gains every offline kill, capped at 200 and done", () => {
    const sim = newSim();
    accept(sim, CULL);
    const before = activeOf(sim, CULL).progress;
    const { events, kills } = offline(sim, HOUR);
    expect(kills).toBe(480);
    const cull = activeOf(sim, CULL);
    expect(cull.progress).toBe(Math.min(quest(CULL).count, before + 480));
    expect(cull.done).toBe(before + 480 >= quest(CULL).count);
    expect(
      events.some(
        (e) =>
          e.type === "classic.quest.progress" && e.quest === CULL && e.progress === cull.progress,
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "classic.quest.done" && e.quest === CULL)).toBe(cull.done);
  });

  it("named target in the offline depth's list gains floor(kills / n), capped and done (pinned, seed 4242)", () => {
    const sim = newSim();
    accept(sim, RATS);
    // Depth 5 has 6 monsters (gnawling among them). An hour is 480 model kills, so the
    // share is floor(480 / 6) = 80, and Rats in the Cellar (count 20) caps at 20 and is done.
    expect(depthMonsterIds(sim.loaded.registry, OFFLINE_DEPTH)).toHaveLength(6);
    expect(depthMonsterIds(sim.loaded.registry, OFFLINE_DEPTH)).toContain(GNAWLING);
    const { events, kills } = offline(sim, HOUR);
    expect(kills).toBe(480);
    expect(quest(RATS).count).toBe(20);
    expect(activeOf(sim, RATS)).toEqual({ id: RATS, progress: 20, done: true });
    expect(events).toContainEqual({
      type: "classic.quest.progress",
      quest: RATS,
      progress: 20,
      count: 20,
    });
    expect(events).toContainEqual({ type: "classic.quest.done", quest: RATS });
  });

  it("named target in the list, below the cap, gains exactly floor(kills / n) (pinned, seed 4242)", () => {
    const sim = newSim();
    accept(sim, RATS);
    // Ten minutes: 80 model kills at depth 5, a share of floor(80 / 6) = 13 (under the count of 20).
    const { events, kills } = offline(sim, 600_000);
    expect(kills).toBe(80);
    const rats = activeOf(sim, RATS);
    expect(rats).toEqual({ id: RATS, progress: 13, done: false });
    expect(
      events.some(
        (e) => e.type === "classic.quest.progress" && e.quest === RATS && e.progress === 13,
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "classic.quest.done")).toBe(false);
  });

  it("named target outside the offline depth's list (Ash and Ember) gains 0", () => {
    const sim = newSim();
    accept(sim, ASH);
    const ids = depthMonsterIds(sim.loaded.registry, OFFLINE_DEPTH);
    expect(ids).not.toContain(ASH_SEER);
    const before = activeOf(sim, ASH);
    const { events, kills } = offline(sim, HOUR);
    expect(kills).toBeGreaterThan(0);
    expect(activeOf(sim, ASH)).toEqual(before);
    expect(
      events.some(
        (e) => e.type.startsWith("classic.quest.") && (e as { quest?: string }).quest === ASH,
      ),
    ).toBe(false);
  });

  it("reachDepth (Deeper Still), killBoss (The Warden's Rest) and clearLevel (Clear the Crypt) are unchanged", () => {
    const sim = newSim();
    accept(sim, DEEPER);
    accept(sim, WARDENS);
    accept(sim, CRYPT);
    const before = [DEEPER, WARDENS, CRYPT].map((id) => activeOf(sim, id));
    const { events, kills } = offline(sim, HOUR);
    expect(kills).toBeGreaterThan(0);
    expect([DEEPER, WARDENS, CRYPT].map((id) => activeOf(sim, id))).toEqual(before);
    expect(events.some((e) => e.type === "classic.quest.progress")).toBe(false);
    expect(events.some((e) => e.type === "classic.quest.done")).toBe(false);
  });

  it("leaves a finished quest alone (no event, no change)", () => {
    const sim = newSim(SEED + 1);
    sim.world.setResource(RES.quests, {
      active: [
        { id: CULL, progress: 200, done: true },
        { id: RATS, progress: 20, done: true },
      ],
      completed: [],
    } satisfies QuestState);
    const { events } = offline(sim, HOUR);
    expect(events.some((e) => e.type.startsWith("classic.quest."))).toBe(false);
    expect(questsOf(sim.world).active).toEqual([
      { id: CULL, progress: 200, done: true },
      { id: RATS, progress: 20, done: true },
    ]);
  });
});

describe("Offline quests: rejection", () => {
  it("invalid offlineProgress payloads return ok:false and leave the hash unchanged", () => {
    const sim = newSim();
    accept(sim, CULL);
    accept(sim, RATS);
    const hash = sim.hash();
    const bad: unknown[] = [
      { elapsedMs: 0 },
      { elapsedMs: -5 },
      { elapsedMs: 1.5 },
      { elapsedMs: "3600000" },
      { elapsedMs: 7 * 24 * 3600 * 1000 + 1 },
      { elapsedMs: HOUR, extra: 1 },
      null,
      [],
    ];
    for (const p of bad) {
      const r = sim.dispatch(ACTION.offlineProgress, p, null);
      expect(r.ok, JSON.stringify(p)).toBe(false);
    }
    expect(sim.hash()).toBe(hash);
  });
});

/** A fixed script: accept quests, run an offline hour, then a few ticks. */
function script(seed: number): Sim {
  const sim = newSim(seed);
  accept(sim, RATS);
  accept(sim, CULL);
  accept(sim, ASH);
  sim.step(200);
  expect(sim.dispatch(ACTION.offlineProgress, { elapsedMs: HOUR }, null).ok).toBe(true);
  sim.step(100);
  return sim;
}

describe("Offline quests: determinism", () => {
  it("same seed and script give the same hash", () => {
    expect(script(77).hash()).toBe(script(77).hash());
  }, 120_000);

  it("the scripted run finishes with the same quest state", () => {
    const a = script(78);
    const b = script(78);
    expect(questsOf(a.world)).toEqual(questsOf(b.world));
    expect(a.hash()).toBe(b.hash());
    // Sanity: the script actually moved quest progress (a kill quest was credited).
    expect(questsOf(a.world).active.some((q) => q.progress > 0)).toBe(true);
  }, 120_000);
});
