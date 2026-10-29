/**
 * Party bench (docs/design/party.md §12; T-auto): what a party of heroes
 * costs per sim tick, with the real classic mode (every module, real
 * content). Two parts:
 *
 *  1. Idle play: a fresh founder plus 0..3 recruits (warrior, rogue,
 *     sorcerer, warrior) on Full Idle from town for TICKS ticks; mean ms per
 *     sim.step(1) over the whole run (town errands, travel, exploring,
 *     fights), kills, deepest depth.
 *  2. Worst-case fight: the party Idle in its first dungeon level, topped up
 *     to 300 awake monsters around it (life raised so none die, heroes
 *     healed outside the timed step so nobody leaves). Mean and best 25-tick
 *     window over 400 ticks, for 1 and 4 heroes, plus the time spent inside
 *     the auto systems (kernel "wrap" timers: the AI's own cost), and the
 *     same world with both brains disabled (heroes idle: no AI and no hero
 *     combat either).
 *
 * Budget: 4 heroes + 300 monsters <= 2 ms mean per tick on an idle dev box.
 *
 * Run with `node --experimental-transform-types tools/bench/src/party.ts`
 * (also part of run-all.ts). Writes tools/bench/results/party.json and prints
 * markdown tables (copied to docs/bench/2026-10-party.md).
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
import * as classic from "@gamez/mode-classic";
import { fmt, writeResults } from "./lib.ts";

const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer", "classic.warrior"];
const NAMES = ["Brannoc", "Ysolde", "Corvin", "Maelis"];
const TICKS = Number(process.env.PARTY_BENCH_TICKS ?? 6000);
const SEED = 2026;
const MONSTERS = 300;
const BIG = 1_000_000;

/** Wall time inside each auto system (bench instrumentation; kernel "wrap" overrides). */
const aiMs: Record<string, number> = {};
const AI_SYSTEMS = [
  classic.SYSTEM.autoThink.id,
  classic.SYSTEM.autoParty.id,
  classic.SYSTEM.autoAllocate.id,
];
const real: LoadedMode = (() => {
  const timer = defineModule({
    id: "bench.timer",
    version: "0.0.0",
    deps: ["classic.auto"],
    overrides: AI_SYSTEMS.map((target): Override => ({
      kind: "system",
      target,
      op: "wrap",
      with(_world, _ctx, next) {
        const t0 = performance.now();
        next();
        aiMs[target] = (aiMs[target] ?? 0) + performance.now() - t0;
      },
    })),
  });
  return loadMode(defineMode({ ...classic.mode, modules: [...classic.mode.modules, timer.id] }), [
    ...classic.modules,
    timer,
  ]);
})();
const noBrains: LoadedMode = (() => {
  const off = defineModule({
    id: "bench.nobrains",
    version: "0.0.0",
    deps: ["classic.auto"],
    overrides: [
      { kind: "system", target: classic.SYSTEM.autoThink.id, op: "disable" },
      { kind: "system", target: classic.SYSTEM.autoParty.id, op: "disable" },
    ],
  });
  return loadMode(defineMode({ ...classic.mode, modules: [...classic.mode.modules, off.id] }), [
    ...classic.modules,
    off,
  ]);
})();

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(`${what} failed`);
}

function setPurse(sim: Sim, gold: number): void {
  sim.world.update(classic.purseOf(sim.world), classic.Wallet, { gold });
}

/** Founder + recruits (bought slots, cheat gold), Full Idle. */
function party(size: number, seed = SEED): Sim {
  const sim = createSim(real, { seed });
  must(
    sim.dispatch(classic.ACTION.newHero, { classId: CLASSES[0], name: NAMES[0] }, null).ok,
    "newHero",
  );
  sim.step(2);
  const gold = sim.world.read(classic.purseOf(sim.world), classic.Wallet).gold;
  for (let i = 1; i < size; i++) {
    setPurse(sim, 1_000_000);
    must(sim.dispatch(classic.ACTION.partyBuySlot, {}, null).ok, "buySlot");
    must(
      sim.dispatch(classic.ACTION.partyRecruit, { classId: CLASSES[i], name: NAMES[i] }, null).ok,
      "recruit",
    );
    sim.step(2);
  }
  setPurse(sim, gold);
  must(sim.dispatch(classic.ACTION.setControl, { mode: "idle" }, null).ok, "setControl");
  return sim;
}

interface IdleRow {
  heroes: number;
  ticks: number;
  meanMs: number;
  kills: number;
  deepest: number;
}

function idleRun(size: number): IdleRow {
  const sim = party(size);
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) sim.step(1);
  const ms = performance.now() - t0;
  const stats = sim.world.getResource<classic.RunStats>(classic.RES.stats)!;
  return {
    heroes: size,
    ticks: TICKS,
    meanMs: ms / TICKS,
    kills: stats.kills,
    deepest: classic.dungeonOf(sim.world).deepest,
  };
}

function areaMonsters(sim: Sim): Entity[] {
  const d = classic.currentDepth(sim.world);
  return sim.world
    .query(classic.Monster, classic.Faction, classic.AreaTag)
    .filter(
      (e) =>
        sim.world.read(e, classic.AreaTag).depth === d &&
        sim.world.read(e, classic.Faction).team === "monster" &&
        !sim.world.has(e, classic.Dead),
    );
}

/** The party Idle in its first dungeon level, topped up to MONSTERS awake monsters. */
function fight(size: number): Sim {
  const sim = party(size, 31);
  for (let i = 0; i < 8000 && classic.currentDepth(sim.world) === 0; i++) sim.step(1);
  if (classic.currentDepth(sim.world) === 0) throw new Error("never left town");
  sim.step(40);
  const depth = classic.currentDepth(sim.world);
  const map = classic.getAreaMap(sim.world, sim.loaded.registry);
  const lp = sim.world.read(classic.actingLeaderOf(sim.world), classic.Pos);
  const lx = lp.x >> 8;
  const ly = lp.y >> 8;
  const taken = new Set<number>();
  for (const e of sim.world.query(classic.Pos, classic.AreaTag)) {
    if (sim.world.read(e, classic.AreaTag).depth !== depth) continue;
    const p = sim.world.read(e, classic.Pos);
    taken.add((p.y >> 8) * map.width + (p.x >> 8));
  }
  const existing = areaMonsters(sim);
  const level = existing.length > 0 ? sim.world.read(existing[0]!, classic.Monster).level : 1;
  let need = MONSTERS - existing.length;
  const ids = ["classic.monster.husk", "classic.monster.gnawling", "classic.monster.bonefletcher"];
  for (let r = 4; r <= 30 && need > 0; r++) {
    for (let y = ly - r; y <= ly + r && need > 0; y++) {
      for (let x = lx - r; x <= lx + r && need > 0; x++) {
        if (Math.max(Math.abs(x - lx), Math.abs(y - ly)) !== r || (x + y) % 2 !== 0) continue;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        const k = y * map.width + x;
        if (map.walkable[k] !== 1 || taken.has(k)) continue;
        taken.add(k);
        classic.busOf(sim.world).spawns.push({
          monster: ids[need % ids.length]!,
          x: classic.tileCenter(x),
          y: classic.tileCenter(y),
          depth,
          level,
          rarity: "normal",
          mods: [],
          pack: 900_000 + need,
          name: "",
          owner: 0,
          team: "monster",
          until: 0,
          awake: true,
        });
        need--;
      }
    }
  }
  sim.step(1);
  for (const e of areaMonsters(sim)) sim.world.update(e, classic.Life, { hp: BIG, max: BIG });
  sim.step(60);
  return sim;
}

function healAll(sim: Sim): void {
  for (const e of classic.partyMembers(sim.world)) {
    const l = sim.world.read(e, classic.Life);
    if (!sim.world.has(e, classic.Dead) && l.hp < l.max)
      sim.world.update(e, classic.Life, { hp: l.max });
  }
}

interface FightRow {
  case: string;
  heroes: number;
  monsters: number;
  meanMs: number;
  bestWindowMs: number;
  /** Mean ms per tick inside classic.auto.think / .party / .allocate. */
  thinkMs: number;
  followersMs: number;
  allocateMs: number;
}

function timeFight(name: string, sim: Sim): FightRow {
  for (const k of Object.keys(aiMs)) delete aiMs[k];
  let total = 0;
  let best = Infinity;
  for (let w = 0; w < 16; w++) {
    let ms = 0;
    for (let i = 0; i < 25; i++) {
      healAll(sim);
      const t0 = performance.now();
      sim.step(1);
      ms += performance.now() - t0;
    }
    total += ms;
    best = Math.min(best, ms / 25);
  }
  return {
    case: name,
    heroes: classic.partySize(sim.world),
    monsters: areaMonsters(sim).length,
    meanMs: total / 400,
    bestWindowMs: best,
    thinkMs: (aiMs[AI_SYSTEMS[0]!] ?? 0) / 400,
    followersMs: (aiMs[AI_SYSTEMS[1]!] ?? 0) / 400,
    allocateMs: (aiMs[AI_SYSTEMS[2]!] ?? 0) / 400,
  };
}

const idle = [1, 2, 3, 4].map(idleRun);
console.log(`\n### Idle play from town (${TICKS} ticks, seed ${SEED}, every module)\n`);
console.log("| Heroes | Mean ms/tick | Kills | Deepest |");
console.log("|---:|---:|---:|---:|");
for (const r of idle)
  console.log(`| ${r.heroes} | ${fmt(r.meanMs, 3)} | ${r.kills} | ${r.deepest} |`);

const four = fight(4);
const relabelled = createSim(noBrains, {
  seed: 31,
  from: { ...four.snapshot(), contentHash: noBrains.contentHash },
});
const rows: FightRow[] = [
  timeFight("solo hero + 300 monsters", fight(1)),
  timeFight("4 heroes + 300 monsters", four),
  timeFight("4 heroes + 300 monsters, party brains disabled", relabelled),
];
console.log("\n### Worst-case fight (300 awake monsters, 400 ticks, every module)\n");
console.log(
  "| Case | Heroes | Monsters | Mean ms/tick | Best 25-tick window ms | Leader think ms | Followers ms | Allocate ms |",
);
console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
for (const r of rows)
  console.log(
    `| ${r.case} | ${r.heroes} | ${r.monsters} | ${fmt(r.meanMs, 3)} | ${fmt(r.bestWindowMs, 3)} | ` +
      `${fmt(r.thinkMs, 3)} | ${fmt(r.followersMs, 3)} | ${fmt(r.allocateMs, 3)} |`,
  );
writeResults("party", { idle, fight: rows });
