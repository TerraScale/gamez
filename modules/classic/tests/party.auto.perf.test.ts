/**
 * Party AI performance (T-auto, docs/design/party.md §12): the full classic
 * mode (every module, real content), four recruited heroes on Full Idle in a
 * real dungeon level, topped up to 300 awake monsters around the party (life
 * raised so none die, heroes healed before every tick so nobody leaves:
 * a sustained worst-case fight). One sim.step(1) per tick, like the game.
 *
 * Budget: 2 ms mean per tick on an idle dev box for the core sim (party.perf
 * asserts it). With every module and this sustained 300-monster melee the idle
 * box measures about 2.3 ms best window and 2.6 ms mean (ADR 0007), so this
 * test asserts the best 25-tick window under 2x the budget times the measured
 * load scale (support/perf.ts), the auto systems under 1 ms times the scale,
 * and logs the real numbers:
 * the mean over 400 ticks, the best 25-tick window, the time spent inside
 * the auto systems (kernel "wrap" overrides with a timer), and the same world
 * with the party brains disabled (heroes idle: no AI and no hero combat).
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type Entity,
  type LoadedMode,
  type Override,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import type { SpawnRequest } from "../src/bus.ts";
import { busOf } from "../src/bus.ts";
import { AreaTag, Dead, Faction, Life, Monster, Pos, Wallet } from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { SYSTEM } from "../src/ids.ts";
import { mode, modules } from "../src/index.ts";
import { actingLeaderOf, partyMembers, purseOf } from "../src/party/shared.ts";
import { currentDepth } from "../src/resources.ts";
import { monsterLevel } from "../src/rules.ts";
import { getAreaMap, walkableAt } from "../src/world/maps.ts";
import { loadScale } from "./support/perf.ts";

const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer", "classic.warrior"];
const NAMES = ["Brannoc", "Ysolde", "Corvin", "Maelis"];
const MONSTERS = 300;
const BIG = 1_000_000;

/** Wall time spent inside each auto system (test-only instrumentation, not sim state). */
const aiMs: Record<string, number> = {};
/** The classic mode with the three auto systems wrapped by a timer (no behaviour change). */
const full: LoadedMode = (() => {
  const timed = (target: string): Override => ({
    kind: "system",
    target,
    op: "wrap",
    with(_world, _ctx, next) {
      const t0 = performance.now();
      next();
      aiMs[target] = (aiMs[target] ?? 0) + performance.now() - t0;
    },
  });
  const timer = defineModule({
    id: "perf.timer",
    version: "0.0.0",
    deps: ["classic.auto"],
    overrides: [
      timed(SYSTEM.autoThink.id),
      timed(SYSTEM.autoParty.id),
      timed(SYSTEM.autoAllocate.id),
    ],
  });
  return loadMode(defineMode({ ...mode, modules: [...mode.modules, "perf.timer"] }), [
    ...modules,
    timer,
  ]);
})();
/** The same mode with both party brains switched off (reference cost without the AI). */
function noBrains(): LoadedMode {
  const off = defineModule({
    id: "perf.nobrains",
    version: "0.0.0",
    deps: ["classic.auto"],
    overrides: [
      { kind: "system", target: SYSTEM.autoThink.id, op: "disable" },
      { kind: "system", target: SYSTEM.autoParty.id, op: "disable" },
    ],
  });
  return loadMode(defineMode({ ...mode, modules: [...mode.modules, "perf.nobrains"] }), [
    ...modules,
    off,
  ]);
}

function setPurse(sim: Sim, gold: number): void {
  sim.world.update(purseOf(sim.world), Wallet, { gold });
}

/** Four heroes recruited in town, Idle until they stand in a dungeon level. */
function partyInDungeon(seed: number): Sim {
  const sim = createSim(full, { seed });
  expect(sim.dispatch("classic.newHero", { classId: CLASSES[0], name: NAMES[0] }, null).ok).toBe(
    true,
  );
  sim.step(2);
  for (let i = 1; i < CLASSES.length; i++) {
    setPurse(sim, 1_000_000);
    expect(sim.dispatch("classic.party.buySlot", {}, null).ok).toBe(true);
    expect(
      sim.dispatch("classic.party.recruit", { classId: CLASSES[i], name: NAMES[i] }, null).ok,
    ).toBe(true);
    sim.step(2);
  }
  setPurse(sim, 500);
  expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
  for (let i = 0; i < 8000 && currentDepth(sim.world) === 0; i++) sim.step(1);
  expect(currentDepth(sim.world)).toBeGreaterThan(0);
  sim.step(40);
  return sim;
}

function areaMonsters(sim: Sim): Entity[] {
  const d = currentDepth(sim.world);
  return sim.world
    .query(Monster, Faction, AreaTag)
    .filter(
      (e) =>
        sim.world.read(e, AreaTag).depth === d &&
        sim.world.read(e, Faction).team === "monster" &&
        !sim.world.has(e, Dead),
    );
}

/** Spawns awake monsters on free walkable tiles 4..30 tiles from the leader up to MONSTERS. */
function topUp(sim: Sim): void {
  const depth = currentDepth(sim.world);
  const map = getAreaMap(sim.world, sim.loaded.registry);
  const lp = sim.world.read(actingLeaderOf(sim.world), Pos);
  const lx = lp.x >> 8;
  const ly = lp.y >> 8;
  const taken = new Set<number>();
  for (const e of sim.world.query(Pos, AreaTag)) {
    if (sim.world.read(e, AreaTag).depth !== depth) continue;
    const p = sim.world.read(e, Pos);
    taken.add((p.y >> 8) * map.width + (p.x >> 8));
  }
  let need = MONSTERS - areaMonsters(sim).length;
  const ids = ["classic.monster.husk", "classic.monster.gnawling", "classic.monster.bonefletcher"];
  for (let r = 4; r <= 30 && need > 0; r++) {
    for (let y = ly - r; y <= ly + r && need > 0; y++) {
      for (let x = lx - r; x <= lx + r && need > 0; x++) {
        if (Math.max(Math.abs(x - lx), Math.abs(y - ly)) !== r) continue;
        if (!walkableAt(map, x, y) || taken.has(y * map.width + x)) continue;
        if ((x + y) % 2 !== 0) continue;
        taken.add(y * map.width + x);
        const req: SpawnRequest = {
          monster: ids[need % ids.length]!,
          x: tileCenter(x),
          y: tileCenter(y),
          depth,
          level: monsterLevel(Math.min(depth, 12)),
          rarity: "normal",
          mods: [],
          pack: 900_000 + need,
          name: "",
          owner: 0,
          team: "monster",
          until: 0,
          awake: true,
        };
        busOf(sim.world).spawns.push(req);
        need--;
      }
    }
  }
  sim.step(1);
  for (const e of areaMonsters(sim)) sim.world.update(e, Life, { hp: BIG, max: BIG });
}

/** Heals every member to full (outside the timed step) so nobody leaves the fight. */
function healAll(sim: Sim): void {
  for (const e of partyMembers(sim.world)) {
    const l = sim.world.read(e, Life);
    if (!sim.world.has(e, Dead) && l.hp < l.max) sim.world.update(e, Life, { hp: l.max });
  }
}

function measure(sim: Sim, windows: number, per: number): { mean: number; best: number } {
  let total = 0;
  let best = Infinity;
  for (let w = 0; w < windows; w++) {
    let ms = 0;
    for (let i = 0; i < per; i++) {
      healAll(sim);
      const t0 = performance.now();
      sim.step(1);
      ms += performance.now() - t0;
    }
    total += ms;
    best = Math.min(best, ms / per);
  }
  return { mean: total / (windows * per), best };
}

describe("party AI performance (all modules)", () => {
  it("4 heroes + 300 monsters on Idle within budget (2 ms x load scale x 2, AI < 1 ms)", () => {
    const sim = partyInDungeon(31);
    const depth = currentDepth(sim.world);
    topUp(sim);
    expect(areaMonsters(sim).length).toBeGreaterThanOrEqual(MONSTERS - 20);
    sim.step(60);
    for (const k of Object.keys(aiMs)) delete aiMs[k];
    const before = loadScale();
    const p = measure(sim, 16, 25);
    const scale = Math.max(before, loadScale());
    const per = (id: string): number => (aiMs[id] ?? 0) / 400;
    const ai = per(SYSTEM.autoThink.id) + per(SYSTEM.autoParty.id) + per(SYSTEM.autoAllocate.id);
    const stayed = currentDepth(sim.world) === depth;
    const left = areaMonsters(sim).length;

    // Reference: the same fight (this very world, relabelled) without the two brains.
    const off = noBrains();
    const base = createSim(off, {
      seed: 31,
      from: { ...sim.snapshot(), contentHash: off.contentHash },
    });
    base.step(20);
    const b = measure(base, 16, 25);
    console.log(
      `PARTYPERF all modules, 4 heroes + ${left} monsters (depth ${depth}, stayed ${stayed}): ` +
        `mean ${p.mean.toFixed(3)} ms/tick (best 25-tick window ${p.best.toFixed(3)} ms) over ` +
        `400 ticks, of which the auto systems ${ai.toFixed(3)} ms (leader think ` +
        `${per(SYSTEM.autoThink.id).toFixed(3)}, followers ${per(SYSTEM.autoParty.id).toFixed(3)}, ` +
        `allocate ${per(SYSTEM.autoAllocate.id).toFixed(3)}); ` +
        `the same world with the brains disabled (heroes idle, so no hero combat either): ` +
        `mean ${b.mean.toFixed(3)} ms (best ${b.best.toFixed(3)} ms); load scale ${scale.toFixed(2)}`,
    );
    expect(stayed, "the party stayed in the fight").toBe(true);
    // The mean swings with the box's load, so the asserted figure is the best 25-tick
    // window against the budget scaled by the measured load (2x: every module, worst case).
    expect(p.best).toBeLessThan(2 * 2 * scale);
    // The party AI itself (timed inside its systems) stays well under the 2 ms budget.
    expect(ai).toBeLessThan(1 * scale);
  }, 600_000);
});
