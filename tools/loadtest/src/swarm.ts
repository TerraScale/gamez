/**
 * Presence bot swarm (docs/design/wave-C.md §12). N guests join a client-pose
 * world over /ws, random-walk and pose at --pose-hz; the swarm ramps through
 * --ramp steps and measures, per step: join time, pose -> delivery latency
 * (end to end and server stamped, see bot.ts), frames / bytes / upserts per
 * bot per second, delivery ratio, errors and closes, the workerd CPU and RSS
 * (when it started the server itself) and the ChunkDO counters
 * (/api/dev/presence/stats).
 *
 *   node tools/loadtest/src/swarm.ts --serve 5403 --ramp 50,100,250,500,1000
 *   node tools/loadtest/src/swarm.ts --url http://localhost:5403 --bots 50 --duration 10
 *   node tools/loadtest/src/swarm.ts --serve 5403 --mode preview   (after `vp -C apps/game build`)
 *
 * Never point it at the user's live dev server (:5173; refused).
 */
import { cpus, loadavg, totalmem } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { PRESENCE_WORLDS } from "../../../apps/game/src/shared/worlds.ts";
import type { BotOptions } from "./bot.ts";
import type { GrowResult, PoolReport } from "./pool.ts";
import { cpuPercent, sampleTree, type ProcSample } from "./proc.ts";
import { assertSafeUrl, startServer, type SwarmServer } from "./server.ts";
import { Histogram, percentilesOf, type Percentiles } from "./stats.ts";
import type { WorkerCommand } from "./worker.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** e2e p95 above this, or any error / close, marks a step as saturated (wave-C.md §12). */
export const SATURATION_P95_MS = 300;

interface ChunkStats {
  avatars: number;
  fixtures: number;
  relays: string[];
  poses: number;
  flushes: number;
  upsertsSent: number;
  deliverFailures: number;
}

export interface StepResult {
  bots: number;
  joined: number;
  joinFailed: number;
  joinErrors: string[];
  joinMs: Percentiles;
  windowS: number;
  e2eMs: Percentiles;
  serverMs: Percentiles;
  posesPerS: number;
  framesPerBotS: number;
  kbPerBotS: number;
  upsertsPerBotS: number;
  deliveryRatio: number;
  errors: Record<string, number>;
  closes: number;
  seenMin: number;
  seenMean: number;
  chunk: {
    posesPerS: number;
    flushesPerS: number;
    upsertsPerFlush: number;
    relays: string[];
    deliverFailures: number;
  } | null;
  workerd: { cpuPct: number; rssMb: number; procs: number } | null;
  generator: { eluMax: number; eluMean: number; cpuPct: number };
  loadavg1: number;
  saturated: boolean;
}

/** Proxy for a worker thread running a BotPool. */
class PoolWorker {
  readonly #worker: Worker;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  #next = 0;

  constructor(opts: BotOptions, concurrency: number) {
    this.#worker = new Worker(resolve(HERE, "worker.ts"), { workerData: { opts, concurrency } });
    this.#worker.on(
      "message",
      (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
        const p = this.#pending.get(m.id);
        this.#pending.delete(m.id);
        if (m.ok) p?.resolve(m.result);
        else p?.reject(new Error(m.error));
      },
    );
    this.#worker.on("error", (err) => {
      for (const p of this.#pending.values())
        p.reject(err instanceof Error ? err : new Error(String(err)));
      this.#pending.clear();
    });
  }

  call<T>(cmd: WorkerCommand["cmd"], extra: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#worker.postMessage({ id, cmd, ...extra });
    });
  }

  async terminate(): Promise<void> {
    await this.#worker.terminate();
  }
}

async function chunkStats(url: string, world: string): Promise<ChunkStats | null> {
  try {
    const res = await fetch(`${url}/api/dev/presence/stats?world=${encodeURIComponent(world)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? ((await res.json()) as ChunkStats) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

function summarise(
  bots: number,
  grow: GrowResult,
  reports: PoolReport[],
  before: { chunk: ChunkStats | null; proc: ProcSample; cpu: NodeJS.CpuUsage; at: number },
  after: { chunk: ChunkStats | null; proc: ProcSample; cpu: NodeJS.CpuUsage; at: number },
  serverPid: number | null,
): StepResult {
  const e2e = new Histogram();
  const server = new Histogram();
  let frames = 0;
  let bytes = 0;
  let upserts = 0;
  let poses = 0;
  let closes = 0;
  const errors: Record<string, number> = {};
  const seen: number[] = [];
  for (const r of reports) {
    e2e.merge(r.e2e);
    server.merge(r.server);
    frames += r.frames;
    bytes += r.bytes;
    upserts += r.upserts;
    poses += r.posesSent;
    closes += r.closes;
    for (const [k, v] of Object.entries(r.errors)) errors[k] = (errors[k] ?? 0) + v;
    seen.push(...r.seenPlayers);
  }
  const windowS = (after.at - before.at) / 1000;
  const n = Math.max(1, bots);
  const expected = poses * Math.max(0, bots - 1);
  const e2eMs = e2e.summary();
  const cpuUs = after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system;
  const chunk =
    before.chunk && after.chunk
      ? {
          posesPerS: (after.chunk.poses - before.chunk.poses) / windowS,
          flushesPerS: (after.chunk.flushes - before.chunk.flushes) / windowS,
          upsertsPerFlush:
            (after.chunk.upsertsSent - before.chunk.upsertsSent) /
            Math.max(1, after.chunk.flushes - before.chunk.flushes),
          relays: after.chunk.relays,
          deliverFailures: after.chunk.deliverFailures - before.chunk.deliverFailures,
        }
      : null;
  const errorCount = Object.values(errors).reduce((a, b) => a + b, 0);
  const deliveryRatio = expected > 0 ? upserts / expected : Number.NaN;
  return {
    bots,
    joined: grow.joinMs.length,
    joinFailed: grow.failed,
    joinErrors: grow.errors,
    joinMs: percentilesOf(grow.joinMs),
    windowS,
    e2eMs,
    serverMs: server.summary(),
    posesPerS: poses / windowS,
    framesPerBotS: frames / n / windowS,
    kbPerBotS: bytes / 1024 / n / windowS,
    upsertsPerBotS: upserts / n / windowS,
    deliveryRatio,
    errors,
    closes,
    seenMin: seen.length ? Math.min(...seen) : 0,
    seenMean: seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : 0,
    chunk,
    workerd:
      serverPid === null
        ? null
        : {
            cpuPct: cpuPercent(before.proc, after.proc),
            rssMb: after.proc.rssKb / 1024,
            procs: after.proc.procs.length,
          },
    generator: {
      eluMax: Math.max(...reports.map((r) => r.elu)),
      eluMean: reports.reduce((a, r) => a + r.elu, 0) / Math.max(1, reports.length),
      cpuPct: (cpuUs / 1e6 / windowS) * 100,
    },
    loadavg1: loadavg()[0]!,
    saturated:
      !(e2eMs.p95 <= SATURATION_P95_MS) ||
      errorCount > 0 ||
      closes > 0 ||
      grow.failed > 0 ||
      deliveryRatio < 0.95,
  };
}

function line(s: StepResult): string {
  return [
    `bots ${String(s.bots).padStart(4)}`,
    `join p50/p95 ${round(s.joinMs.p50, 0)}/${round(s.joinMs.p95, 0)} ms`,
    `e2e p50/p95/p99 ${s.e2eMs.p50}/${s.e2eMs.p95}/${s.e2eMs.p99} ms`,
    `srv p95 ${s.serverMs.p95} ms`,
    `${round(s.framesPerBotS)} fr/s ${round(s.kbPerBotS)} KB/s ${round(s.upsertsPerBotS)} ups/s per bot`,
    `deliv ${round(s.deliveryRatio * 100)}%`,
    `seen min ${s.seenMin}`,
    s.workerd ? `workerd ${round(s.workerd.cpuPct, 0)}% ${round(s.workerd.rssMb, 0)} MB` : "",
    `gen elu ${round(s.generator.eluMax, 2)}`,
    `err ${JSON.stringify(s.errors)} closes ${s.closes}`,
    s.saturated ? "SATURATED" : "ok",
  ]
    .filter(Boolean)
    .join(" | ");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      serve: { type: "string" },
      world: { type: "string", default: "classic-town" },
      bots: { type: "string" },
      ramp: { type: "string", default: "50,100,250,500,1000" },
      duration: { type: "string", default: "15" },
      warmup: { type: "string", default: "3" },
      "pose-hz": { type: "string", default: "3" },
      workers: { type: "string", default: "4" },
      "join-concurrency": { type: "string", default: "8" },
      "stop-p95": { type: "string", default: "10000" },
      out: { type: "string" },
      log: { type: "string", default: "/tmp/gamez-loadtest-dev.log" },
      /** Persist into apps/game/.cloudflare/state like every other dev server (not recommended). */
      "shared-state": { type: "boolean", default: false },
      /** Keep the local explorer's per-invocation tracing on (dev default; costs CPU and memory). */
      observability: { type: "boolean", default: false },
      /** "dev" (vp dev) or "preview" (vp preview of the last `vp -C apps/game build`, no module runner). */
      mode: { type: "string", default: "dev" },
    },
  });
  const worldId = values.world!;
  const world = PRESENCE_WORLDS[worldId];
  if (!world || world.movement !== "client-pose") throw new Error(`${worldId} is not a pose world`);
  const steps = (values.bots ?? values.ramp!)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const poseHz = Number(values["pose-hz"]);
  if (!(poseHz >= 0.5 && poseHz <= 5))
    throw new Error("--pose-hz must be 0.5..5 (server limit 5/s)");
  const durationMs = Number(values.duration) * 1000;
  const warmupMs = Number(values.warmup) * 1000;
  const workers = Math.max(1, Number(values.workers));
  const stopP95 = Number(values["stop-p95"]);

  let server: SwarmServer | null = null;
  let url = values.url;
  if (!url) {
    const port = Number(values.serve ?? 5403);
    console.log(`starting vp ${values.mode} on :${port} (log ${values.log})`);
    // Local dev records a trace per invocation (the local explorer's observability), which
    // production does not do per RPC; off by default so the numbers measure the game.
    const env: Record<string, string> = values.observability
      ? {}
      : { X_LOCAL_OBSERVABILITY: "false" };
    const mode = values.mode === "preview" ? "preview" : "dev";
    server = await startServer(
      port,
      values.log!,
      values["shared-state"] ? null : undefined,
      env,
      mode,
    );
    url = server.url;
  }
  assertSafeUrl(url);
  // A killed swarm must not leave its private dev server running.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      console.log(`${sig}: stopping`);
      void (server?.stop() ?? Promise.resolve()).finally(() => process.exit(130));
    });
  }

  const opts: BotOptions = {
    url,
    world: worldId,
    poseHz,
    width: world.width,
    height: world.height,
  };
  const pool = Array.from(
    { length: workers },
    () => new PoolWorker(opts, Number(values["join-concurrency"])),
  );
  const results: StepResult[] = [];
  const file =
    values.out ??
    resolve(
      HERE,
      `../results/swarm-${worldId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
  const save = (): void => {
    const knee = results.find((r) => r.saturated)?.bots ?? null;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          kind: "gamez-presence-swarm",
          at: new Date().toISOString(),
          machine,
          config: {
            world: worldId,
            poseHz,
            durationS: durationMs / 1000,
            warmupS: warmupMs / 1000,
            workers,
            steps,
            observability: values.observability === true,
            mode: values.url ? "external" : values.mode,
            sharedState: values["shared-state"] === true,
            url,
          },
          saturationRule: `e2e p95 > ${SATURATION_P95_MS} ms, any error/close/failed join, or delivery < 95 %`,
          firstSaturatedStep: knee,
          steps: results,
        },
        null,
        2,
      )}\n`,
    );
  };
  let current = 0;
  const machine = {
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    memGb: round(totalmem() / 2 ** 30, 1),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
  };
  console.log(
    `swarm: ${worldId} @ ${url}, steps ${steps.join(",")}, ${poseHz} poses/s, ${workers} workers, ${durationMs / 1000}s windows`,
  );
  try {
    for (const target of steps) {
      const add = target - current;
      const shares = pool.map((_, i) => Math.floor(add / workers) + (i < add % workers ? 1 : 0));
      const grows = await Promise.all(
        pool.map((w, i) =>
          shares[i]! > 0
            ? w.call<GrowResult>("grow", { count: shares[i] })
            : Promise.resolve<GrowResult>({ joinMs: [], failed: 0, errors: [] }),
        ),
      );
      const grow: GrowResult = {
        joinMs: grows.flatMap((g) => g.joinMs),
        failed: grows.reduce((a, g) => a + g.failed, 0),
        errors: grows.flatMap((g) => g.errors).slice(0, 5),
      };
      current = target - grow.failed;
      await sleep(warmupMs);
      await Promise.all(pool.map((w) => w.call("reset")));
      const before = {
        chunk: await chunkStats(url, worldId),
        proc: sampleTree(server?.pid ?? null),
        cpu: process.cpuUsage(),
        at: Date.now(),
      };
      await sleep(durationMs);
      const reports = await Promise.all(pool.map((w) => w.call<PoolReport>("report")));
      const after = {
        chunk: await chunkStats(url, worldId),
        proc: sampleTree(server?.pid ?? null),
        cpu: process.cpuUsage(),
        at: Date.now(),
      };
      const step = summarise(current, grow, reports, before, after, server?.pid ?? null);
      results.push(step);
      save();
      console.log(line(step));
      if (step.e2eMs.p95 > stopP95) {
        console.log(`stopping the ramp: e2e p95 ${step.e2eMs.p95} ms > --stop-p95 ${stopP95}`);
        break;
      }
    }
  } finally {
    await Promise.all(pool.map((w) => w.call("stop").catch(() => {})));
    await Promise.all(pool.map((w) => w.terminate()));
    await server?.stop();
  }

  save();
  const knee = results.find((r) => r.saturated)?.bots ?? null;
  console.log(`first saturated step: ${knee ?? "none"}; results in ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
