/**
 * Wave B e2e: classic verification and persistence (docs/design/wave-B.md §2,
 * §10). OWNER: T-verify.
 *
 * run(): a fresh classic instance, a hero in Auto then Full Idle x8, every
 * segment verified; a tampered segment (wrong hash) resyncs hash_mismatch and
 * the bot continues verified after adopting it; a segment claiming far more
 * sim time than wall time resyncs too_fast; a server-only action resyncs
 * server_only_action. The hero is left in Manual (no offline grant) and the
 * verified snapshot kept in ctx.state.
 * afterRestart(): a resume join continues at the same verified tick/hash and
 * keeps verifying; a fresh join resets the instance.
 */
import type { SimSnapshot } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import { ClassicBot, type Resync } from "./classic-bot.ts";
import { loginGuest, type Guest } from "./client.ts";
import type { E2eFeature } from "./features.ts";
import { check } from "./report.ts";
import { timings } from "./report.ts";

const NAME = "classic-verify";

/** What run() leaves for afterRestart() (and other features) in ctx.state. */
export interface ClassicVerifyState {
  guest: Guest;
  tick: number;
  hash: string;
  snapshot: SimSnapshot;
  heroName: string;
}

const isResync = (m: { t: string }): m is Resync => m.t === "resync";

export const classicVerifyFeature: E2eFeature = {
  name: NAME,

  async run(ctx) {
    const guest = await loginGuest(ctx.url);
    const heroName = "Verity";
    const t0 = performance.now();
    const bot = await ClassicBot.join(ctx.url, guest, { fresh: true, heroName });
    try {
      timings["classic-verify: join"] = performance.now() - t0;
      check(
        bot.vstate.continued === false && bot.vstate.snapshot !== null && bot.vstate.tick === 0,
        "classic-verify: fresh join gets a snapshot at tick 0",
      );
      check(bot.vstate.importable === true, "classic-verify: a new instance is importable");
      check(classic.heroOf(bot.sim.world) !== 0, "classic-verify: the bot created a hero");

      // Auto at x1, then Full Idle at x8: every segment verified.
      const auto = await bot.play(120, { segmentTicks: 60 });
      bot.act(classic.ACTION.setControl, { mode: "idle" });
      bot.act(classic.ACTION.setSpeed, { speed: 8 });
      const idle = await bot.play(640, { segmentTicks: 160 });
      const segs = auto.verified + idle.verified;
      check(
        auto.resyncs.length === 0 && idle.resyncs.length === 0 && segs === 6,
        `classic-verify: 760 ticks in Auto then Full Idle x8 verified (${segs} acks, resyncs: ${[...auto.resyncs, ...idle.resyncs].map((r) => r.code).join(",") || "none"})`,
      );
      check(
        bot.verified.tick === 760 && bot.verified.hash === bot.sim.hash(),
        `classic-verify: server hash matches the local sim at tick ${bot.verified.tick}`,
      );

      // A tampered hash -> hash_mismatch; the bot adopts and continues.
      const bad = bot.cut(40);
      const epochBefore = bot.epoch;
      bot.sendRaw({ ...bad, hash: "0badc0de0badc0de" });
      const mismatch = await bot.waitFor(`resync of ${bad.seq}`, isResync);
      check(
        mismatch.code === "hash_mismatch" && mismatch.tick === 760 && mismatch.epoch > epochBefore,
        `classic-verify: tampered segment -> resync ${mismatch.code} at tick ${mismatch.tick}`,
      );
      await bot.adopt(mismatch);
      const after = await bot.play(160, { segmentTicks: 160 });
      check(
        after.verified === 1 && after.resyncs.length === 0 && bot.verified.tick === 920,
        `classic-verify: after adopting the resync play verifies again (tick ${bot.verified.tick})`,
      );

      // Far more sim time than wall time: back to Auto (x1) and 400 ticks = 20 s at once.
      bot.act(classic.ACTION.setControl, { mode: "auto" });
      const burst = bot.cut(400);
      bot.sendRaw(burst);
      const fast = await bot.waitFor(`resync of ${burst.seq}`, isResync);
      check(
        fast.code === "too_fast" && fast.tick === 920,
        `classic-verify: a burst of 20 s of play -> resync ${fast.code}`,
      );
      await bot.adopt(fast);

      // A server-only action in a segment.
      const cheat = bot.cut(20);
      cheat.inputs = [
        {
          tick: cheat.fromTick,
          name: classic.ACTION.offlineProgress,
          payload: { elapsedMs: 3_600_000 },
        },
      ];
      bot.sendRaw(cheat);
      const only = await bot.waitFor(`resync of ${cheat.seq}`, isResync);
      check(
        only.code === "server_only_action" && only.tick === 920,
        `classic-verify: classic.offlineProgress from the client -> resync ${only.code}`,
      );
      await bot.adopt(only);

      // Manual control: no offline grant after the restart, so the resume continues.
      bot.act(classic.ACTION.setControl, { mode: "manual" });
      const last = await bot.play(40, { segmentTicks: 40 });
      check(
        last.verified === 1 && last.resyncs.length === 0,
        "classic-verify: still verified after the rejected segments",
      );
      const state: ClassicVerifyState = {
        guest,
        tick: bot.verified.tick,
        hash: bot.verified.hash,
        snapshot: bot.verifiedSnapshot(),
        heroName,
      };
      ctx.state.set(NAME, state);
      timings["classic-verify: run"] = performance.now() - t0;
    } finally {
      await bot.close();
    }
  },

  async afterRestart(ctx) {
    const state = ctx.state.get(NAME) as ClassicVerifyState | undefined;
    if (!state) {
      check(false, "classic-verify: no state from run() to resume");
      return;
    }
    const bot = await ClassicBot.join(ctx.url, state.guest, {
      resumeFrom: state.snapshot,
      noHero: true,
    });
    try {
      const v = bot.vstate;
      check(
        v.continued === true && v.tick === state.tick && v.hash === state.hash,
        `classic-verify: after restart a resume continues at tick ${v.tick} (want ${state.tick}, continued ${v.continued}, offline ${v.offline ? "granted" : "none"})`,
      );
      check(
        classic.heroOf(bot.sim.world) !== 0,
        "classic-verify: after restart the hero is still there",
      );
      const more = await bot.play(40, { segmentTicks: 40 });
      check(
        more.verified === 1 && more.resyncs.length === 0,
        "classic-verify: after restart play keeps verifying",
      );

      const fresh = await bot.rejoin({ fresh: true });
      check(
        fresh.continued === false &&
          fresh.tick === 0 &&
          classic.heroOf(bot.sim.world) === 0 &&
          fresh.importable === false,
        `classic-verify: a fresh join resets the instance (tick ${fresh.tick}, importable ${fresh.importable})`,
      );
    } finally {
      await bot.close();
    }
  },
};
