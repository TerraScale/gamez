/**
 * Classic melee bench (docs/design/party.md §12, ADR 0010 §7): the cost of
 * one `sim.step(1)` of the real classic mode (every module, no bench
 * overrides) with 300 awake monsters around a solo hero and a party of four.
 *
 * Each case builds the fight once, snapshots it, and then runs REPEATS
 * measured repeats from that snapshot: WARMUP untimed ticks, then TICKS timed
 * ticks (heroes healed outside the timed step). Every repeat must end on the
 * same sim hash, and the hash is printed so a perf change can prove it did
 * not change behaviour (compare it before and after).
 *
 * Run with `node --experimental-transform-types tools/bench/src/melee.ts`.
 * Env: MELEE_REPEATS (3), MELEE_TICKS (600), MELEE_WARMUP (200),
 * BENCH_RESULTS=<name> writes results/<name>.json instead of melee.json.
 */
import { createSim, loadMode } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import { areaMonsters, fight, healAll } from "./classic-fight.ts";
import { fmt, writeResults } from "./lib.ts";

const REPEATS = Number(process.env.MELEE_REPEATS ?? 3);
const TICKS = Number(process.env.MELEE_TICKS ?? 600);
const WARMUP = Number(process.env.MELEE_WARMUP ?? 200);
const WINDOW = 25;
const SEED = 31;

const loaded = loadMode(classic.mode, classic.modules);

interface Repeat {
  meanMs: number;
  bestWindowMs: number;
  hash: string;
}

interface Row {
  case: string;
  heroes: number;
  monsters: number;
  repeats: Repeat[];
  medianMeanMs: number;
  medianBestWindowMs: number;
  hash: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
};

function runCase(name: string, size: number): Row {
  const base = fight(loaded, size, SEED);
  const snap = base.snapshot();
  const monsters = areaMonsters(base).length;
  const repeats: Repeat[] = [];
  for (let r = 0; r < REPEATS; r++) {
    const sim = createSim(loaded, { seed: SEED, from: snap });
    for (let i = 0; i < WARMUP; i++) {
      healAll(sim);
      sim.step(1);
    }
    let total = 0;
    let best = Infinity;
    let win = 0;
    for (let i = 0; i < TICKS; i++) {
      healAll(sim);
      const t0 = performance.now();
      sim.step(1);
      const ms = performance.now() - t0;
      total += ms;
      win += ms;
      if ((i + 1) % WINDOW === 0) {
        best = Math.min(best, win / WINDOW);
        win = 0;
      }
    }
    repeats.push({ meanMs: total / TICKS, bestWindowMs: best, hash: sim.hash() });
  }
  const hash = repeats[0]!.hash;
  if (repeats.some((r) => r.hash !== hash)) throw new Error(`${name}: repeats diverged`);
  return {
    case: name,
    heroes: classic.partySize(base.world),
    monsters,
    repeats,
    medianMeanMs: median(repeats.map((r) => r.meanMs)),
    medianBestWindowMs: median(repeats.map((r) => r.bestWindowMs)),
    hash,
  };
}

const rows = [runCase("solo hero + 300 monsters", 1), runCase("4 heroes + 300 monsters", 4)];

console.log(
  `\n### Classic melee, every module (${REPEATS} repeats x ${TICKS} ticks after ${WARMUP} warm-up)\n`,
);
console.log(
  "| Case | Heroes | Monsters | Mean ms/tick per repeat | Median mean | Median best 25-tick | Hash |",
);
console.log("|---|---:|---:|---|---:|---:|---|");
for (const r of rows)
  console.log(
    `| ${r.case} | ${r.heroes} | ${r.monsters} | ${r.repeats.map((x) => fmt(x.meanMs, 3)).join(" / ")} | ` +
      `${fmt(r.medianMeanMs, 3)} | ${fmt(r.medianBestWindowMs, 3)} | \`${r.hash}\` |`,
  );
writeResults(process.env.BENCH_RESULTS ?? "melee", { repeats: REPEATS, ticks: TICKS, rows });
