/**
 * Shared harness for the benchmark scripts. Bench code is not sim code, so
 * wall-clock timers are fine here. Each measurement warms up, then repeats
 * the workload until both a minimum iteration count and a minimum total time
 * are reached, and reports the median.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Timing {
  /** Row label, e.g. "kernel World". */
  name: string;
  /** Unit of `units` per call, e.g. "entities", "records", "ticks". */
  unit: string;
  /** Units processed by one call of the measured function. */
  unitsPerCall: number;
  iterations: number;
  medianMs: number;
  meanMs: number;
  minMs: number;
  /** units / second, from the median call time. */
  throughput: number;
  /** Optional extra numbers (heap bytes, snapshot size...). */
  extra?: Record<string, number | string>;
}

export interface MeasureOptions {
  warmup?: number;
  minIterations?: number;
  minTimeMs?: number;
  maxIterations?: number;
}

const DEFAULTS: Required<MeasureOptions> = {
  warmup: 2,
  minIterations: 5,
  minTimeMs: 1000,
  maxIterations: 200,
};

function summarize(
  name: string,
  unit: string,
  unitsPerCall: number,
  times: number[],
  extra?: Timing["extra"],
): Timing {
  const sorted = [...times].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const meanMs = times.reduce((s, t) => s + t, 0) / times.length;
  return {
    name,
    unit,
    unitsPerCall,
    iterations: times.length,
    medianMs,
    meanMs,
    minMs: sorted[0]!,
    throughput: unitsPerCall / (medianMs / 1000),
    extra,
  };
}

/** Times a synchronous function. `setup` runs before each call and is not timed. */
export function measure<A>(
  name: string,
  unit: string,
  unitsPerCall: number,
  fn: (input: A) => void,
  setup: () => A,
  opts: MeasureOptions = {},
): Timing {
  const o = { ...DEFAULTS, ...opts };
  for (let i = 0; i < o.warmup; i++) fn(setup());
  const times: number[] = [];
  const started = performance.now();
  while (
    times.length < o.maxIterations &&
    (times.length < o.minIterations || performance.now() - started < o.minTimeMs)
  ) {
    const input = setup();
    const t0 = performance.now();
    fn(input);
    times.push(performance.now() - t0);
  }
  return summarize(name, unit, unitsPerCall, times);
}

/** Times an async function the same way. */
export async function measureAsync<A>(
  name: string,
  unit: string,
  unitsPerCall: number,
  fn: (input: A) => Promise<void>,
  setup: () => A,
  opts: MeasureOptions = {},
): Promise<Timing> {
  const o = { ...DEFAULTS, ...opts };
  for (let i = 0; i < o.warmup; i++) await fn(setup());
  const times: number[] = [];
  const started = performance.now();
  while (
    times.length < o.maxIterations &&
    (times.length < o.minIterations || performance.now() - started < o.minTimeMs)
  ) {
    const input = setup();
    const t0 = performance.now();
    await fn(input);
    times.push(performance.now() - t0);
  }
  return summarize(name, unit, unitsPerCall, times);
}

const here = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(here, "..", "results");

/** Writes the rows of one bench to tools/bench/results/<name>.json. */
export function writeResults(name: string, data: unknown): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
}

/** Formats a number with grouping and a fixed number of decimals. */
export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const d = abs >= 100 ? 0 : digits;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Prints a markdown table of timings. */
export function printTable(title: string, rows: Timing[]): void {
  console.log(`\n### ${title}\n`);
  console.log("| Case | Units/call | Median ms | Units/s | Iterations |");
  console.log("|---|---:|---:|---:|---:|");
  for (const r of rows) {
    console.log(
      `| ${r.name} | ${fmt(r.unitsPerCall, 0)} ${r.unit} | ${fmt(r.medianMs, 3)} | ${fmt(r.throughput, 0)} ${r.unit}/s | ${r.iterations} |`,
    );
  }
}
