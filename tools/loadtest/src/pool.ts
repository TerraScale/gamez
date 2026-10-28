/**
 * A set of pose bots in one thread, with the measurement-window protocol the
 * swarm drives (grow -> reset -> wait -> report). Used in-process by the e2e
 * and inside each worker thread by the swarm.
 */
import { performance } from "node:perf_hooks";
import { PoseBot, SwarmSink, type BotOptions } from "./bot.ts";
import type { HistogramData } from "./stats.ts";

export interface GrowResult {
  joinMs: number[];
  failed: number;
  errors: string[];
}

export interface PoolReport {
  bots: number;
  windowMs: number;
  e2e: HistogramData;
  server: HistogramData;
  frames: number;
  bytes: number;
  upserts: number;
  removes: number;
  posesSent: number;
  errors: Record<string, number>;
  closes: number;
  /** Per bot: other players / fixtures it currently sees. */
  seenPlayers: number[];
  seenFixtures: number[];
  /** Event-loop utilisation of this thread during the window (0..1): >0.9 means the generator saturated. */
  elu: number;
}

export class BotPool {
  readonly bots: PoseBot[] = [];
  readonly sink = new SwarmSink();
  readonly #opts: BotOptions;
  readonly #concurrency: number;
  #elu = performance.eventLoopUtilization();

  constructor(opts: BotOptions, concurrency = 10) {
    this.#opts = opts;
    this.#concurrency = Math.max(1, concurrency);
  }

  /** Adds `count` bots, joining at most `concurrency` at a time; each starts posing once joined. */
  async grow(count: number): Promise<GrowResult> {
    const out: GrowResult = { joinMs: [], failed: 0, errors: [] };
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < count) {
        next++;
        const bot = new PoseBot(this.#opts, this.sink);
        try {
          out.joinMs.push(await bot.join());
          bot.start();
          this.bots.push(bot);
        } catch (err) {
          out.failed++;
          if (out.errors.length < 5) out.errors.push(String(err));
          await bot.stop();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, count) }, lane));
    return out;
  }

  reset(): void {
    this.sink.reset();
    this.#elu = performance.eventLoopUtilization();
  }

  report(): PoolReport {
    const s = this.sink;
    return {
      bots: this.bots.length,
      windowMs: Date.now() - s.since,
      e2e: s.e2e.toData(),
      server: s.server.toData(),
      frames: s.frames,
      bytes: s.bytes,
      upserts: s.upserts,
      removes: s.removes,
      posesSent: s.posesSent,
      errors: { ...s.errors },
      closes: s.closes,
      seenPlayers: this.bots.map((b) => b.count("player")),
      seenFixtures: this.bots.map((b) => b.count("shopkeeper")),
      elu: performance.eventLoopUtilization(this.#elu).utilization,
    };
  }

  async stop(): Promise<void> {
    await Promise.all(this.bots.map((b) => b.stop()));
    this.bots.length = 0;
  }
}
