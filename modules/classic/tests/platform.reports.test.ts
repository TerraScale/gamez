/**
 * classicReports (wave-B.md §4): the classic_hero and leaderboard_rift rows
 * produced from a verified classic world. Pure and deterministic.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";
import { classicReports, riftKey, type ClassicRiftReport } from "../src/platform/reports.ts";
import { RES, type RiftRecord, type RiftState } from "../src/resources.ts";

const SEED = 2026;
const loaded = loadMode(mode, modules);
const registry = loaded.registry;

function started(): Sim {
  const sim = createSim(loaded, { seed: SEED });
  expect(
    sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Tester" }, null).ok,
  ).toBe(true);
  expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
  return sim;
}

function record(over: Partial<RiftRecord> & { run: number }): RiftRecord {
  return {
    level: 2,
    ticks: 1000,
    score: 100,
    deaths: 0,
    completed: true,
    reason: "",
    heroLevel: 5,
    classId: "classic.warrior",
    heroName: "Tester",
    worldSeed: SEED,
    endTick: 5000,
    ...over,
  };
}

function riftState(history: RiftRecord[], best: RiftRecord | null): RiftState {
  return {
    unlocked: true,
    maxCompleted: 1,
    best,
    history,
    active: null,
    nextRun: 10,
  };
}

describe("classicReports", () => {
  it("returns nothing before a hero exists", () => {
    const sim = createSim(loaded, { seed: SEED });
    expect(classicReports(sim.world, registry)).toEqual([]);
  });

  it("emits the hero row from a playing world", () => {
    const sim = started();
    sim.step(400);
    const rows = classicReports(sim.world, registry);
    const hero = rows.find((r) => r.table === "classic_hero");
    expect(hero?.key).toBe("hero");
    expect(hero?.data).toMatchObject({
      heroName: "Tester",
      classId: "classic.warrior",
      riftBestLevel: 0,
      riftBestScore: 0,
    });
    const d = hero!.data;
    for (const v of Object.values(d)) {
      expect(
        typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null,
      ).toBe(true);
      if (typeof v === "number") expect(Number.isInteger(v)).toBe(true);
    }
    expect(d.playTicks).toBe(400);
  });

  it("is deterministic: same seed and script give identical rows", () => {
    const a = started();
    const b = started();
    a.step(600);
    b.step(600);
    expect(classicReports(a.world, registry)).toEqual(classicReports(b.world, registry));
    expect(JSON.stringify(classicReports(a.world, registry))).toBe(
      JSON.stringify(classicReports(b.world, registry)),
    );
  });

  it("pins the hero row after a fixed script", () => {
    const sim = started();
    sim.step(400);
    const hero = classicReports(sim.world, registry).find((r) => r.table === "classic_hero");
    expect(hero?.data).toEqual(PINNED_HERO);
  });

  it("emits one rift row per history record, keyed by world seed and run", () => {
    const sim = started();
    const history = [
      record({ run: 3, score: 300, completed: true }),
      record({ run: 2, score: 50, completed: false, reason: "death", deaths: 1 }),
    ];
    sim.world.setResource(RES.rift, riftState(history, history[0]!));
    const rows = classicReports(sim.world, registry).filter((r) => r.table === "leaderboard_rift");
    expect(rows.map((r) => r.key)).toEqual([`run:${SEED}:3`, `run:${SEED}:2`]);
    expect(riftKey(SEED, 3)).toBe(`run:${SEED}:3`);
    expect(rows[0]!.data).toEqual({
      heroName: "Tester",
      classId: "classic.warrior",
      heroLevel: 5,
      riftLevel: 2,
      score: 300,
      ticks: 1000,
      deaths: 0,
      completed: true,
      run: 3,
      endTick: 5000,
    } satisfies ClassicRiftReport);
    expect(rows[1]!.data.completed).toBe(false);
  });

  it("reports the best completed run on the hero row", () => {
    const sim = started();
    const best = record({ run: 4, level: 3, score: 900 });
    sim.world.setResource(RES.rift, riftState([best], best));
    const hero = classicReports(sim.world, registry).find((r) => r.table === "classic_hero");
    expect(hero?.data).toMatchObject({ riftBestLevel: 3, riftBestScore: 900 });
  });

  it("keeps the best run in a rift row even when it left the history", () => {
    const sim = started();
    const best = record({ run: 1, score: 999 });
    const recent = [record({ run: 9, score: 10 })];
    sim.world.setResource(RES.rift, riftState(recent, best));
    const keys = classicReports(sim.world, registry)
      .filter((r) => r.table === "leaderboard_rift")
      .map((r) => r.key);
    expect(keys).toEqual([`run:${SEED}:9`, `run:${SEED}:1`]);
  });

  it("does not count an incomplete best run as the hero's rift best", () => {
    const sim = started();
    const best = record({ run: 5, completed: false, score: 0 });
    sim.world.setResource(RES.rift, riftState([best], best));
    const hero = classicReports(sim.world, registry).find((r) => r.table === "classic_hero");
    expect(hero?.data).toMatchObject({ riftBestLevel: 0, riftBestScore: 0 });
  });
});

/** Pinned hero row: warrior "Tester", 400 auto ticks, seed 2026. */
const PINNED_HERO = {
  heroName: "Tester",
  classId: "classic.warrior",
  level: 1,
  xp: 28,
  deepestDepth: 1,
  riftBestLevel: 0,
  riftBestScore: 0,
  playTicks: 400,
  kills: 2,
  deaths: 0,
};
