/**
 * Party e2e (docs/design/party.md §13): a classic party of three is built,
 * played and verified by the server, then survives a dev-server restart.
 *
 * run():
 * - A fresh, importable instance gets a local save (a founder with enough
 *   purse gold to buy two slots). It goes up through the wave B import, the
 *   only honest way to start a save with gold without hours of play.
 * - In town the bot buys slots 2 and 3, recruits a Rogue and a Sorcerer,
 *   renames one, and takes control of the Rogue. Every action is a kernel
 *   action in a segment, so the server's VerifiedHost replays it.
 * - The party plays in Full Idle x8 (every member on the party AI), every
 *   segment verified, and the server hash matches the local one.
 * - A tampered control input (a non-member) is answered with a resync.
 * - After the socket closes, D1 gets one classic_hero row per member
 *   (keys "hero", "hero:1", "hero:2").
 * afterRestart(): a resume join continues at the same tick and hash with the
 * same party and controlled hero, and keeps verifying.
 */
import type { SimSnapshot } from "@gamez/kernel";
import { createSim } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import { ClassicBot, classicLoaded, type Resync } from "./classic-bot.ts";
import { loginGuest, type Guest } from "./client.ts";
import type { E2eContext, E2eFeature } from "./features.ts";
import { check, timings } from "./report.ts";

const NAME = "classic-party";
/** Enough for slot 2 (1500) + slot 3 (7500) + two recruit fees at level 1 (50 each). */
const START_GOLD = 9_200;
const POLL_MS = 25_000;

interface PartyState {
  guest: Guest;
  tick: number;
  hash: string;
  snapshot: SimSnapshot;
  members: number[];
  controlled: number;
}

const isResync = (m: { t: string }): m is Resync => m.t === "resync";

/** A local save: a fresh founder in town with START_GOLD in the purse (the import payload). */
function localSave(seed: number): SimSnapshot {
  const sim = createSim(classicLoaded(), { seed });
  const r = sim.dispatch(
    classic.ACTION.newHero,
    { classId: "classic.warrior", name: "Brannoc" },
    null,
  );
  if (!r.ok) throw new Error(`classic-party: newHero rejected (${r.error?.code})`);
  sim.step(5); // heroInit: starter kit and purse
  const hero = classic.heroOf(sim.world);
  sim.world.update(hero, classic.Wallet, { gold: START_GOLD });
  sim.step(5);
  return sim.snapshot();
}

async function waitForRows(ctx: E2eContext, accountId: string, n: number): Promise<string[]> {
  const until = Date.now() + POLL_MS;
  let ids: string[] = [];
  while (Date.now() < until) {
    const rows = await ctx.db.query<{ id: string }>(
      "SELECT id FROM classic_hero WHERE account_id = ? AND _deleted = 0 ORDER BY id",
      [accountId],
    );
    ids = rows.map((r) => r.id);
    if (ids.length >= n) return ids;
    await new Promise((r) => setTimeout(r, 500));
  }
  return ids;
}

export const classicPartyFeature: E2eFeature = {
  name: NAME,

  async run(ctx) {
    const t0 = performance.now();
    const guest = await loginGuest(ctx.url);
    const bot = await ClassicBot.join(ctx.url, guest, { fresh: true, noHero: true });
    try {
      check(bot.vstate.importable === true, "classic-party: a fresh instance is importable");
      const v = await bot.importSnapshot(localSave(4242));
      check(
        v.imported === true && classic.heroOf(bot.sim.world) !== 0,
        "classic-party: the local save is imported",
      );
      const w = () => bot.sim.world;
      const founder = classic.heroOf(w());
      check(classic.partyGold(w()) === START_GOLD, "classic-party: the purse holds the gold");

      // Town: two slots, two recruits, a rename, control of the Rogue.
      bot.act(classic.ACTION.partyBuySlot, {});
      bot.act(classic.ACTION.partyBuySlot, {});
      bot.act(classic.ACTION.partyRecruit, { classId: "classic.rogue", name: "Wren" });
      bot.act(classic.ACTION.partyRecruit, { classId: "classic.sorcerer", name: "Ilsa" });
      const members = classic.partyMembers(w());
      const rogue = members[1]!;
      bot.act(classic.ACTION.partyRename, { hero: members[2]!, name: "Ilsabet" });
      bot.act(classic.ACTION.partyControl, { hero: rogue });
      check(
        members.length === 3 && classic.heroOf(w()) === rogue && classic.founderOf(w()) === founder,
        `classic-party: recruited 2 heroes and took control of the Rogue (members ${members.length})`,
      );
      check(
        classic.partyGold(w()) === START_GOLD - 1500 - 7500 - 100,
        `classic-party: slots and fees came out of the purse (gold ${classic.partyGold(w())})`,
      );
      const setup = await bot.play(40, { segmentTicks: 40 });
      check(
        setup.verified === 1 && setup.resyncs.length === 0,
        `classic-party: the party actions verify on the server (resyncs: ${setup.resyncs.map((r) => r.code).join(",") || "none"})`,
      );

      // Full Idle x8: the whole party runs on the AI.
      bot.act(classic.ACTION.setControl, { mode: "idle" });
      bot.act(classic.ACTION.setSpeed, { speed: 8 });
      const idle = await bot.play(960, { segmentTicks: 160 });
      check(
        idle.resyncs.length === 0 && idle.verified === 6,
        `classic-party: 960 ticks of party Idle x8 verified (${idle.verified} acks, resyncs: ${idle.resyncs.map((r) => r.code).join(",") || "none"})`,
      );
      check(
        bot.verified.hash === bot.sim.hash() && classic.partySize(w()) === 3,
        `classic-party: server hash matches the local party sim at tick ${bot.verified.tick}`,
      );
      const depths = classic.partyMembers(w()).map((e) => w().get(e, classic.AreaTag)?.depth);
      check(
        depths.every((d) => d === classic.currentDepth(w())),
        `classic-party: every member is in the party's area (${depths.join(",")})`,
      );

      // A tampered control input (no such member): the server rejects the segment.
      bot.act(classic.ACTION.setControl, { mode: "manual" });
      const bad = bot.cut(20);
      bad.inputs = [
        ...bad.inputs,
        { tick: bad.fromTick, name: classic.ACTION.partyControl, payload: { hero: 999_999 } },
      ];
      bot.sendRaw(bad);
      const rejected = await bot.waitFor(`resync of ${bad.seq}`, isResync);
      check(
        rejected.code === "input_rejected" || rejected.code === "hash_mismatch",
        `classic-party: a control input for a non-member -> resync ${rejected.code}`,
      );
      await bot.adopt(rejected);
      // Manual: no offline grant after the restart, so the resume continues.
      bot.act(classic.ACTION.setControl, { mode: "manual" });
      const last = await bot.play(40, { segmentTicks: 40 });
      check(
        last.verified === 1 && last.resyncs.length === 0 && classic.heroOf(w()) === rogue,
        "classic-party: still verified (Rogue controlled) after the rejected segment",
      );
      const state: PartyState = {
        guest,
        tick: bot.verified.tick,
        hash: bot.verified.hash,
        snapshot: bot.verifiedSnapshot(),
        members: classic.partyMembers(w()),
        controlled: classic.heroOf(w()),
      };
      ctx.state.set(NAME, state);
    } finally {
      // The last close compacts and reports every member into the outbox.
      await bot.close();
    }
    const ids = await waitForRows(ctx, guest.accountId, 3);
    const keys = ids.map((id) => id.slice(id.lastIndexOf("/") + 1)).sort();
    check(
      keys.length === 3 && keys[0] === "hero" && keys[1] === "hero:1" && keys[2] === "hero:2",
      `classic-party: one classic_hero row per member in D1 (${keys.join(", ") || "none"})`,
    );
    timings["classic-party: run"] = performance.now() - t0;
  },

  async afterRestart(ctx) {
    const state = ctx.state.get(NAME) as PartyState | undefined;
    if (!state) {
      check(false, "classic-party: no state from run() to resume");
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
        `classic-party: after restart a resume continues at tick ${v.tick} (want ${state.tick})`,
      );
      const members = classic.partyMembers(bot.sim.world);
      check(
        members.join(",") === state.members.join(",") &&
          classic.heroOf(bot.sim.world) === state.controlled,
        `classic-party: after restart the party (${members.length}) and the controlled hero are kept`,
      );
      bot.act(classic.ACTION.partyControl, { hero: state.members[0]! });
      const more = await bot.play(40, { segmentTicks: 40 });
      check(
        more.verified === 1 && more.resyncs.length === 0,
        "classic-party: after restart a control switch keeps verifying",
      );
    } finally {
      await bot.close();
    }
  },
};
