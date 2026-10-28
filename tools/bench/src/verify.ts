/**
 * Wave B verification bench (docs/design/wave-B.md §2.4): what full replay
 * of every classic segment costs the InstanceDO.
 *
 *  1. Replay CPU per player-minute, real content (classic.modules), for the
 *     three classes: Auto at x1 (1200 ticks per wall minute, 40-tick segments
 *     = one per 2 s) and Full Idle at x8 (9600 ticks per wall minute,
 *     320-tick segments). The client side records with SegmentRecorder; the
 *     timed part is replaySegment() with expectHash on a sim restored from
 *     the start snapshot, exactly what VerifiedHost does per segment.
 *  2. At depth 1 / 5 / 10 (a QA-granted hero in Full Idle, so the debug
 *     module is loaded): snapshot JSON size and gzip size, snapshot(), hash()
 *     and restore (createSim from a snapshot: DO wake / resync) costs, and
 *     replay CPU per x1 player-minute at that depth.
 *  3. Segment frame sizes (JSON) for input-less Auto/Idle segments and a
 *     busy manual segment.
 *
 * Run with `node_modules/.bin/vp run --filter @gamez/bench bench:verify`.
 * Writes tools/bench/results/verify.json and prints markdown tables.
 */
import { gzipSync } from "node:zlib";
import {
  createSim,
  loadMode,
  replaySegment,
  SegmentRecorder,
  type LoadedMode,
  type RecordedSegment,
  type Sim,
  type SimSnapshot,
} from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import { fmt, measure, writeResults } from "./lib.ts";

const ACTOR = "local";
const TICKS_PER_MINUTE_X1 = 60 * classic.CLASSIC_HZ;
const policy = classic.mode.instance!.clientDriven!;
const real = loadMode(classic.mode, classic.modules);
const qa = loadMode({ ...classic.mode, modules: [...classic.mode.modules] }, [
  ...classic.modules,
  ...classic.debugModules,
]);
const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer"] as const;

interface Recording {
  start: SimSnapshot;
  segments: RecordedSegment[];
  ticks: number;
}

function newHero(loaded: LoadedMode, classId: string, seed: number): Sim {
  const sim = createSim(loaded, { seed });
  const ok = sim.dispatch(classic.ACTION.newHero, { classId, name: "Bench" }, ACTOR).ok;
  if (!ok) throw new Error(`newHero ${classId} failed`);
  return sim;
}

function control(sim: Sim, mode: "auto" | "idle" | "manual", speed = 1): void {
  if (!sim.dispatch(classic.ACTION.setControl, { mode }, ACTOR).ok) throw new Error("setControl");
  if (speed > 1 && !sim.dispatch(classic.ACTION.setSpeed, { speed }, ACTOR).ok)
    throw new Error("setSpeed");
}

/** Plays `ticks` on the client side, cutting a segment every `every` ticks. */
function record(sim: Sim, ticks: number, every: number): Recording {
  const start = sim.snapshot();
  const rec = new SegmentRecorder(sim.tick);
  const segments: RecordedSegment[] = [];
  for (let done = 0; done < ticks; done += every) {
    sim.step(every);
    segments.push(rec.cut(sim)!);
  }
  return { start, segments, ticks };
}

/** Server side: replays every segment with hash checks. Returns wall ms (single thread = CPU). */
function replayAll(loaded: LoadedMode, r: Recording): { ms: number; hashMs: number } {
  const sim = createSim(loaded, { seed: 0, from: r.start });
  let hashMs = 0;
  const t0 = performance.now();
  for (const seg of r.segments) {
    const out = replaySegment(sim, seg, {
      actor: ACTOR,
      maxTicks: policy.maxTicksPerSegment,
      maxInputs: policy.maxInputsPerSegment,
      serverOnly: new Set(policy.serverOnlyActions),
      speedOf: (w) => policy.speedOf(w),
      maxSpeed: policy.maxSpeed,
      expectHash: seg.hash,
    });
    if (!out.ok) throw new Error(`replay failed: ${out.code} ${out.message}`);
  }
  const ms = performance.now() - t0;
  // Hash share: one hash() per segment at the end state (approximation from the final state).
  const h0 = performance.now();
  for (let i = 0; i < r.segments.length; i++) sim.hash();
  hashMs = performance.now() - h0;
  return { ms, hashMs };
}

interface RateRow {
  case: string;
  ticks: number;
  segments: number;
  replayMs: number;
  /** Replay CPU ms per wall minute of this kind of play. */
  msPerPlayerMinute: number;
  /** Share of one core per concurrent player. */
  coreShare: number;
  hashSharePct: number;
}

function rate(name: string, loaded: LoadedMode, r: Recording, ticksPerMinute: number): RateRow {
  // Best of 2 runs (the host is shared and noisy).
  const runs = [replayAll(loaded, r), replayAll(loaded, r)];
  const best = runs.reduce((a, b) => (a.ms <= b.ms ? a : b));
  const minutes = r.ticks / ticksPerMinute;
  const msPerPlayerMinute = best.ms / minutes;
  return {
    case: name,
    ticks: r.ticks,
    segments: r.segments.length,
    replayMs: best.ms,
    msPerPlayerMinute,
    coreShare: msPerPlayerMinute / 60_000,
    hashSharePct: (100 * best.hashMs) / best.ms,
  };
}

// ---- 1. replay rate per class ---------------------------------------------

const rates: RateRow[] = [];
for (const classId of CLASSES) {
  const short = classId.replace("classic.", "");
  const auto = newHero(real, classId, 2026);
  control(auto, "auto");
  rates.push(rate(`${short} Auto x1`, real, record(auto, 2 * TICKS_PER_MINUTE_X1, 40), 1200));
  const idle = newHero(real, classId, 2026);
  control(idle, "idle", 8);
  rates.push(rate(`${short} Full Idle x8`, real, record(idle, 8 * TICKS_PER_MINUTE_X1, 320), 9600));
}

// ---- 2. depth profile (QA-granted hero) -------------------------------------

interface DepthRow {
  depth: number;
  tick: number;
  snapshotBytes: number;
  gzipBytes: number;
  snapshotMs: number;
  hashMs: number;
  restoreMs: number;
  msPerPlayerMinute: number;
}

const depths: DepthRow[] = [];
{
  const sim = newHero(qa, "classic.warrior", 11);
  const grant = sim.dispatch(
    "classic.debug.grant",
    { levels: 40, items: { count: 8, rarity: "rare", ilvl: 40 } },
    ACTOR,
  );
  if (!grant.ok) throw new Error(`grant failed: ${grant.error?.code}`);
  control(sim, "idle");
  for (const want of [1, 5, 10]) {
    let guard = 0;
    while (classic.currentDepth(sim.world) !== want && guard++ < 400) sim.step(250);
    if (classic.currentDepth(sim.world) !== want) {
      console.warn(`depth ${want} not reached (at ${classic.currentDepth(sim.world)})`);
      continue;
    }
    const snap = sim.snapshot();
    const json = JSON.stringify(snap);
    const snapT = measure(
      "snapshot",
      "calls",
      1,
      () => void sim.snapshot(),
      () => null,
      {
        minTimeMs: 300,
      },
    );
    const hashT = measure(
      "hash",
      "calls",
      1,
      () => void sim.hash(),
      () => null,
      {
        minTimeMs: 300,
      },
    );
    const restoreT = measure(
      "restore",
      "calls",
      1,
      () => void createSim(qa, { seed: 0, from: snap }),
      () => null,
      { minTimeMs: 300 },
    );
    // One x1 player-minute at this depth (Full Idle at x1: same per-tick cost as Auto).
    const fork = createSim(qa, { seed: 0, from: snap });
    const r = rate(`depth ${want}`, qa, record(fork, TICKS_PER_MINUTE_X1, 40), 1200);
    depths.push({
      depth: want,
      tick: sim.tick,
      snapshotBytes: json.length,
      gzipBytes: gzipSync(json).length,
      snapshotMs: snapT.medianMs,
      hashMs: hashT.medianMs,
      restoreMs: restoreT.medianMs,
      msPerPlayerMinute: r.msPerPlayerMinute,
    });
  }
}

// ---- 3. segment frames -------------------------------------------------------

const frame = (seg: RecordedSegment) =>
  JSON.stringify({ t: "segment", epoch: 12, seq: 345, ...seg }).length;
const frames: { case: string; bytes: number }[] = [];
{
  const sim = newHero(real, "classic.rogue", 5);
  control(sim, "auto");
  const a = record(sim, 40, 40).segments[0]!;
  frames.push({ case: "Auto x1, 40 ticks, no inputs", bytes: frame(a) });
  control(sim, "idle", 8);
  const b = record(sim, 320, 320).segments[0]!;
  frames.push({ case: "Full Idle x8, 320 ticks, no inputs", bytes: frame(b) });
  // Busy manual play: 2 inputs per tick-pair for 40 ticks (clicks/skills), recorded as the client would.
  const manual = newHero(real, "classic.rogue", 5);
  control(manual, "manual");
  const rec = new SegmentRecorder(manual.tick);
  for (let i = 0; i < 20; i++) {
    const payload = { x: 10 + (i % 5), y: 12 + (i % 3) };
    rec.record(manual.tick, classic.ACTION.moveTo, payload);
    rec.record(manual.tick, classic.ACTION.stop, {});
    manual.step(2);
  }
  frames.push({
    case: "Manual, 40 ticks, 40 inputs (worst-case clicking)",
    bytes: frame(rec.cut(manual)!),
  });
}

// ---- output -------------------------------------------------------------------

console.log("\n### Replay CPU per player-minute (real content)\n");
console.log(
  "| Case | Ticks | Segments | Replay ms | CPU ms / player-minute | Core share | hash() share |",
);
console.log("|---|---:|---:|---:|---:|---:|---:|");
for (const r of rates) {
  console.log(
    `| ${r.case} | ${r.ticks} | ${r.segments} | ${fmt(r.replayMs, 0)} | ${fmt(r.msPerPlayerMinute, 0)} | ${fmt(100 * r.coreShare, 1)} % | ${fmt(r.hashSharePct, 1)} % |`,
  );
}
console.log("\n### Depth profile (warrior, QA grant: level 40, Full Idle)\n");
console.log(
  "| Depth | Tick | Snapshot JSON | gzip | snapshot() ms | hash() ms | restore ms | CPU ms / x1 player-minute |",
);
console.log("|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const d of depths) {
  console.log(
    `| ${d.depth} | ${d.tick} | ${fmt(d.snapshotBytes / 1024, 1)} KB | ${fmt(d.gzipBytes / 1024, 1)} KB | ${fmt(d.snapshotMs, 2)} | ${fmt(d.hashMs, 2)} | ${fmt(d.restoreMs, 2)} | ${fmt(d.msPerPlayerMinute, 0)} |`,
  );
}
console.log("\n### Segment frames\n");
console.log("| Case | JSON bytes |");
console.log("|---|---:|");
for (const f of frames) console.log(`| ${f.case} | ${f.bytes} |`);

writeResults("verify", { node: process.version, rates, depths, frames });
