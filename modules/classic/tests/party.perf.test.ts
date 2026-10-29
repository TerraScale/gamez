/**
 * Party performance (docs/design/party.md §12): 4 heroes + 300 awake
 * monsters with classic.core + combat + monsters + world, one sim.step(1)
 * per tick (a transaction per tick, like the game loop). Every hero keeps
 * attacking (repeat skill intents) and every monster converges on a member,
 * so ~190 monsters are in melee contact: a worst case.
 *
 * Budget: 2 ms mean per tick on an idle dev box. The shared box runs other
 * workflows, so the numbers are logged (mean over 400 ticks, best 25-tick
 * window, and the same scenario with ONE hero for reference). The best
 * window must stay under the 2 ms budget times the measured load scale
 * (support/perf.ts, never below 1) with 1.5x slack, and the party must cost
 * at most 2.5x the solo hero in the same scenario.
 */
import type { Entity, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Ai, Intent, Monster, Mover } from "../src/components.ts";
import {
  spawnTestHero,
  spawnTestMonster,
  spawnTestParty,
  testSim,
  useOpenMap,
} from "./support/harness.ts";
import { loadScale } from "./support/perf.ts";

const MODULES = ["classic.core", "classic.combat", "classic.monsters", "classic.world"];
const LIFE = 10_000_000;

/** The scenario with `heroes` heroes (1 = solo, no party resource). */
function scenario(heroes: number): { sim: Sim; members: Entity[]; monsters: Entity[] } {
  const sim = testSim(MODULES, { seed: 11 });
  useOpenMap(sim, 1, 96);
  const spots: [number, number][] = [
    [44, 44],
    [48, 44],
    [44, 48],
    [48, 48],
  ];
  const members =
    heroes === 1
      ? [spawnTestHero(sim.world, { x: 44, y: 44, depth: 1, life: LIFE })]
      : spawnTestParty(
          sim.world,
          spots.slice(0, heroes).map(([x, y]) => ({ x, y, depth: 1, life: LIFE })),
        );
  // 300 awake monsters in four groups around the party (each group nearest one member).
  const corners: [number, number][] = [
    [30, 30],
    [56, 30],
    [30, 56],
    [56, 56],
  ];
  for (let i = 0; i < 300; i++) {
    const [cx, cy] = corners[i % 4]!;
    const k = Math.floor(i / 4);
    spawnTestMonster(sim.world, {
      x: cx + (k % 9),
      y: cy + Math.floor(k / 9),
      depth: 1,
      life: LIFE,
      pack: 1 + (i % 4),
    });
  }
  const monsters = sim.world.query(Monster);
  // Each hero hacks at a monster of its own group until the end (repeat intents).
  members.forEach((h, i) =>
    sim.world.add(h, Intent, {
      kind: "skill",
      source: "auto",
      at: sim.tick,
      skill: "test.skill.strike",
      target: monsters[i]!,
      x: 0,
      y: 0,
      repeat: true,
    }),
  );
  return { sim, members, monsters };
}

/** Mean and best-window ms per sim.step(1) over `windows` x `per` ticks. */
function measure(sim: Sim, windows: number, per: number): { mean: number; best: number } {
  let total = 0;
  let best = Infinity;
  for (let w = 0; w < windows; w++) {
    const started = performance.now();
    for (let i = 0; i < per; i++) sim.step(1);
    const ms = performance.now() - started;
    total += ms;
    best = Math.min(best, ms / per);
  }
  return { mean: total / (windows * per), best };
}

describe("party performance", () => {
  it(
    "steps 4 heroes + 300 awake monsters within budget (2 ms x load scale x 1.5)",
    { timeout: 60_000 },
    () => {
      const party = scenario(4);
      expect(party.sim.world.query(Mover).length).toBe(304);
      // Warm up: the JIT, the first fields, everybody engaged.
      party.sim.step(60);
      const engaged = party.monsters.filter((m) =>
        party.members.includes(party.sim.world.read(m, Ai).target),
      ).length;
      const targeted = new Set(party.monsters.map((m) => party.sim.world.read(m, Ai).target));
      targeted.delete(0);
      const before = loadScale();
      const p = measure(party.sim, 16, 25);
      const scale = Math.max(before, loadScale());

      const solo = scenario(1);
      solo.sim.step(60);
      const s = measure(solo.sim, 16, 25);

      // Logged on purpose: the numbers reported for the party budget.
      console.log(
        `classic party perf: 4 heroes + 300 monsters mean ${p.mean.toFixed(3)} ms/tick ` +
          `(best 25-tick window ${p.best.toFixed(3)} ms) over 400 ticks, ${engaged} engaged on ` +
          `${targeted.size} members; same scenario solo: mean ${s.mean.toFixed(3)} ms ` +
          `(best ${s.best.toFixed(3)} ms); load scale ${scale.toFixed(2)}\n`,
      );
      expect(engaged).toBeGreaterThan(150);
      expect(targeted.size).toBe(4);
      // Budget 2 ms, scaled by the box's measured load, with 1.5x slack.
      expect(p.best).toBeLessThan(2 * 1.5 * scale);
      // Load-independent: a party of four costs at most 2.5x one hero in the same fight.
      expect(p.mean).toBeLessThan(s.mean * 2.5);
    },
  );
});
