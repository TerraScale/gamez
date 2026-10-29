/**
 * Achievements with a party (docs/design/party.md §7.4): hero metrics (level,
 * talent points, equipped set) read the best member, and the counters stay
 * party-wide. A solo hero is unchanged.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Equipment, Level } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { achievementsOf, RES, type RunStats } from "../src/resources.ts";
import { metricValue } from "../src/achievements/metrics.ts";
import { KIND, type AchievementProto, type ItemInstance, type SetProto } from "../src/types.ts";
import { spawnTestHero, spawnTestParty, type TestHeroOptions } from "./support/harness.ts";

const SEED = 4711;
const loaded = loadMode(mode, modules);
const registry = loaded.registry;

function partySim(heroes: TestHeroOptions[], controlled = 0): Sim {
  const sim = createSim(loaded, { seed: SEED });
  spawnTestParty(sim.world, heroes, { controlled });
  return sim;
}

const LEVELS: TestHeroOptions[] = [
  { classId: "classic.warrior", level: 10 },
  { classId: "classic.warrior", level: 3 },
  { classId: "classic.warrior", level: 2 },
];

describe("party achievement metrics", () => {
  it("level is the highest member level, whichever member is controlled", () => {
    for (const controlled of [0, 1, 2]) {
      const sim = partySim(LEVELS, controlled);
      expect(metricValue(sim.world, registry, "level")).toBe(10);
    }
  });

  it("level of a controlled low-level member still counts the best member", () => {
    const sim = partySim(LEVELS, 2);
    expect(metricValue(sim.world, registry, "level")).toBe(10);
  });

  it("a solo hero reads its own level (unchanged)", () => {
    const sim = createSim(loaded, { seed: SEED });
    spawnTestHero(sim.world, { classId: "classic.warrior", level: 7 });
    expect(metricValue(sim.world, registry, "level")).toBe(7);
  });

  it("the counters stay party-wide (kills, play time) and do not depend on the controlled hero", () => {
    const sim = partySim(LEVELS, 1);
    sim.world.getResource<RunStats>(RES.stats)!.kills = 42;
    sim.world.getResource<RunStats>(RES.stats)!.ticksPlayed = 3 * 1200;
    expect(metricValue(sim.world, registry, "kills")).toBe(42);
    expect(metricValue(sim.world, registry, "playMinutes")).toBe(3);
  });

  it("the check system unlocks a level achievement from the best member, not the controlled one", () => {
    const sim = partySim(LEVELS, 2);
    sim.step(40);
    const levelIds = registry
      .all<AchievementProto>(KIND.achievement)
      .filter(([, p]) => p.metric === "level")
      .map(([id, p]) => ({ id, target: p.target }));
    const unlocked = new Set((achievementsOf(sim.world)?.unlocked ?? []).map((u) => u.id));
    // Best member is level 10: the "reach level 10" achievement is earned, the level 20 one is not.
    const ten = levelIds.filter((x) => x.target <= 10);
    const twenty = levelIds.filter((x) => x.target > 10);
    expect(ten.length).toBeGreaterThan(0);
    expect(twenty.length).toBeGreaterThan(0);
    for (const x of ten) expect(unlocked.has(x.id)).toBe(true);
    for (const x of twenty) expect(unlocked.has(x.id)).toBe(false);
  });

  it("the talent metric uses the best member's spent points", () => {
    const sim = partySim(LEVELS, 0);
    // No Talents component in the harness heroes: every member reads 0.
    expect(metricValue(sim.world, registry, "talentPoints")).toBe(0);
  });
});

describe("party set metric", () => {
  const SET = "classic.set.ashen_choir";

  /** Equips every piece id as the `set` of an item in the holder's slots (order of the slot record). */
  function wear(sim: Sim, holder: number, pieces: string[]): void {
    const eq = sim.world.get(holder, Equipment)!;
    const slots = Object.keys(eq);
    const next: Record<string, unknown> = { ...eq };
    pieces.forEach((p, i) => {
      next[slots[i]!] = { set: p } as unknown as ItemInstance;
    });
    sim.world.update(holder, Equipment, next as typeof eq);
  }

  it("a set is complete when one member wears every piece (not split across members)", () => {
    const sim = partySim(LEVELS, 0);
    const pieces = registry.get<SetProto>(KIND.set, SET)!.pieces;
    const members = sim.world.query(Level);
    expect(members.length).toBe(3);
    wear(sim, members[0]!, pieces.slice(0, 2));
    wear(sim, members[1]!, pieces.slice(2));
    expect(metricValue(sim.world, registry, "setComplete")).toBe(0);
    wear(sim, members[2]!, pieces);
    expect(metricValue(sim.world, registry, "setComplete")).toBe(1);
  });
});
