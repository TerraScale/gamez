/**
 * Quests over the server-verified classic connection (docs/design/classic.md
 * §16, wave-B.md §2, §10). OWNER: quest fix round 1 (persist-replay).
 *
 * run(): a fresh classic instance; the hero walks to Captain Hale with
 * classic.interact (segments verified on the way), classic.acceptQuest is
 * accepted by the server (no resync, the hash matches the local sim), and
 * the quest state survives a reconnect (the server's snapshot carries it).
 * afterRestart(): after the dev server restart the same quest state is still
 * there; the bot keeps verifying.
 *
 * Not covered here (too slow for an e2e run): killing the gnawlings and the
 * turn-in. Those are in modules/classic/tests/quests.persist.test.ts.
 *
 * Registration (features.ts is shared, so it is not edited here): add
 *   import { classicQuestsFeature } from "./classic-quests.ts";
 * and put `classicQuestsFeature,` right after `classicVerifyFeature,` in FEATURES.
 */
import * as classic from "@gamez/mode-classic";
import { ClassicBot } from "./classic-bot.ts";
import { loginGuest, type Guest } from "./client.ts";
import type { E2eFeature } from "./features.ts";
import { check, timings } from "./report.ts";

const NAME = "classic-quests";
const RATS = "classic.quest.rats_in_the_cellar";
const HALE = "classic.npc.captain_hale";
/** Walk budget for the interact: ticks (20 Hz). */
const WALK_MAX_TICKS = 800;

/** What run() leaves for afterRestart() in ctx.state. */
export interface ClassicQuestsState {
  guest: Guest;
  tick: number;
  hash: string;
  quests: classic.QuestState;
}

function haleOf(sim: ClassicBot["sim"]): number {
  for (const e of sim.world.query(classic.Npc, classic.Pos)) {
    if (sim.world.read(e, classic.Npc).proto === HALE) return e;
  }
  return 0;
}

/** True when the hero is within INTERACT_RANGE of the giver (the sim's own range rule). */
function inReach(sim: ClassicBot["sim"], giver: number): boolean {
  const hero = classic.heroOf(sim.world);
  if (hero === 0 || giver === 0) return false;
  const h = sim.world.read(hero, classic.Pos);
  const g = sim.world.read(giver, classic.Pos);
  return Math.hypot(h.x - g.x, h.y - g.y) <= classic.INTERACT_RANGE;
}

/** Quest state as the local sim holds it (a copy: the sim keeps mutating). */
function questsOf(sim: ClassicBot["sim"]): classic.QuestState {
  return structuredClone(classic.questsOf(sim.world));
}

export const classicQuestsFeature: E2eFeature = {
  name: NAME,

  async run(ctx) {
    const guest = await loginGuest(ctx.url);
    const t0 = performance.now();
    const bot = await ClassicBot.join(ctx.url, guest, { fresh: true, heroName: "Questor" });
    let state: ClassicQuestsState | null = null;
    try {
      check(classic.heroOf(bot.sim.world) !== 0, "classic-quests: the bot created a hero");
      bot.act(classic.ACTION.setControl, { mode: "manual" });
      await bot.play(2, { segmentTicks: 2 });

      // Walk to Captain Hale with classic.interact, in verified segments.
      const hale = haleOf(bot.sim);
      check(hale !== 0, "classic-quests: Captain Hale is in town");
      bot.act(classic.ACTION.interact, { target: hale });
      let walked = 0;
      let walkResyncs = 0;
      while (!inReach(bot.sim, hale) && walked < WALK_MAX_TICKS) {
        const r = await bot.play(40, { segmentTicks: 40 });
        walked += 40;
        walkResyncs += r.resyncs.length;
      }
      check(
        inReach(bot.sim, hale) && walkResyncs === 0,
        `classic-quests: interact walks the hero to Hale in ${walked} ticks, no resync`,
      );

      // Accept Rats in the Cellar through the verified connection.
      bot.act(classic.ACTION.acceptQuest, { quest: RATS });
      const acc = await bot.play(20, { segmentTicks: 20 });
      check(
        acc.verified === 1 && acc.resyncs.length === 0,
        `classic-quests: the server verified acceptQuest (resyncs: ${acc.resyncs.map((r) => r.code).join(",") || "none"})`,
      );
      check(
        bot.verified.hash === bot.sim.hash(),
        "classic-quests: the server hash matches the local sim after acceptQuest",
      );
      const accepted = questsOf(bot.sim);
      check(
        accepted.active.length === 1 && accepted.active[0]!.id === RATS,
        "classic-quests: Rats in the Cellar is active on the client",
      );
      state = {
        guest,
        tick: bot.verified.tick,
        hash: bot.verified.hash,
        quests: accepted,
      };
      timings["classic-quests: run"] = performance.now() - t0;
    } finally {
      await bot.close();
    }

    // Reconnect in the same server run: the server's snapshot carries the quest.
    const again = await ClassicBot.join(ctx.url, guest, { noHero: true });
    try {
      const v = again.vstate;
      check(
        v.tick === state!.tick && v.hash === state!.hash,
        `classic-quests: reconnect gets the verified state at tick ${v.tick} (want ${state!.tick})`,
      );
      check(
        JSON.stringify(questsOf(again.sim)) === JSON.stringify(state!.quests),
        "classic-quests: the quest state survives a reconnect (server snapshot)",
      );
    } finally {
      await again.close();
    }
    ctx.state.set(NAME, state);
  },

  async afterRestart(ctx) {
    const state = ctx.state.get(NAME) as ClassicQuestsState | undefined;
    if (!state) {
      check(false, "classic-quests: no state from run() to resume");
      return;
    }
    const bot = await ClassicBot.join(ctx.url, state.guest, { noHero: true });
    try {
      const v = bot.vstate;
      check(
        v.tick === state.tick && v.hash === state.hash,
        `classic-quests: after restart the verified state is at tick ${v.tick} (want ${state.tick})`,
      );
      check(
        JSON.stringify(questsOf(bot.sim)) === JSON.stringify(state.quests),
        "classic-quests: the quest state survives a dev server restart",
      );
      // Still verifying: a short manual segment after the restart.
      const more = await bot.play(20, { segmentTicks: 20 });
      check(
        more.verified === 1 && more.resyncs.length === 0,
        "classic-quests: play after restart keeps verifying",
      );
    } finally {
      await bot.close();
    }
  },
};
