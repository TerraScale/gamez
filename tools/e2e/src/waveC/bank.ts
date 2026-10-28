/**
 * Wave C e2e: the classic bank (docs/design/wave-C.md §2, §11). OWNER: T-bridge.
 *
 * A guest's classic hero (ClassicBot over the verified socket) deposits gold
 * (5 % fee) and an item, withdraws coin and the item back, each op answered
 * on the fast path (the bot replays `applied` and must reach the server's
 * hash), with /api/account/wallet and /api/account/vault reflecting every op.
 * Rejections (no coin, not in town is covered by unit tests) leave the hero
 * untouched. afterRestart(): wallet and vault persisted, the instance resumes
 * at the same verified state and banks again.
 */
import type { SimSnapshot } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  BANK_ACTOR,
  type BankOp,
  type VaultResponse,
  type VerifiedServerMessage,
  type WalletView,
} from "@gamez/protocol";
import { api } from "../accounts.ts";
import { ClassicBot } from "../classic-bot.ts";
import { loginGuest, type Guest } from "../client.ts";
import type { E2eFeature } from "../features.ts";
import { check } from "../report.ts";

const NAME = "bank";

type BankAnswer = Extract<VerifiedServerMessage, { t: "bank" }>;

interface BankState {
  guest: Guest;
  coin: number;
  vaultUid: string;
  snapshot: SimSnapshot;
}

let ops = 0;
function opId(): string {
  return `e2e_bank_${Date.now().toString(36)}_${++ops}`;
}

async function coinOf(url: string, token: string): Promise<number> {
  const r = await api<WalletView>(url, "/api/account/wallet", { token });
  return r.body.balances?.coin ?? -1;
}

async function vaultOf(url: string, token: string): Promise<VaultResponse | null> {
  const r = await api<VaultResponse>(url, "/api/account/vault", { token });
  return r.status === 200 ? r.body : null;
}

function gold(bot: ClassicBot): number {
  return bot.sim.world.get(classic.heroOf(bot.sim.world), classic.Wallet)?.gold ?? -1;
}

function bagUids(bot: ClassicBot): number[] {
  const inv = bot.sim.world.get(classic.heroOf(bot.sim.world), classic.Inventory);
  return inv ? inv.items.map((e) => e.item.uid) : [];
}

/**
 * Sends a bank op at the bot's current (verified, just acked) state and
 * applies the answer like the browser: dispatch `applied` with BANK_ACTOR
 * outside the recorder and compare the hash.
 */
async function bank(bot: ClassicBot, op: BankOp): Promise<{ answer: BankAnswer; hashOk: boolean }> {
  const id = opId();
  bot.sendRaw({ t: "bank", opId: id, op, at: { tick: bot.sim.tick, hash: bot.sim.hash() } });
  const answer = await bot.waitFor(
    `bank answer ${id}`,
    (m): m is BankAnswer => m.t === "bank" && m.opId === id,
  );
  let hashOk = true;
  if (answer.applied) {
    const res = bot.sim.dispatch(answer.applied.name, answer.applied.payload, BANK_ACTOR);
    hashOk = res.ok && bot.sim.hash() === answer.applied.hash;
  }
  return { answer, hashOk };
}

export const bankFeature: E2eFeature = {
  name: NAME,

  async run(ctx) {
    const guest = await loginGuest(ctx.url);
    const bot = await ClassicBot.join(ctx.url, guest, { fresh: true, heroName: "Banker" });
    try {
      // Manual control keeps the hero in town (Auto would walk to the dungeon).
      bot.act(classic.ACTION.setControl, { mode: "manual" });
      await bot.play(40, { segmentTicks: 20 });
      check(gold(bot) === 50, `bank: the new hero has 50 gold (got ${gold(bot)})`);
      const coin0 = await coinOf(ctx.url, guest.token);

      // Gold -> coin, 5 % fee.
      const dep = await bank(bot, { kind: "depositGold", gold: 40 });
      check(
        dep.answer.result.ok && dep.answer.applied !== null && dep.hashOk,
        `bank: gold deposit applied on the fast path (${JSON.stringify(dep.answer.result)})`,
      );
      check(gold(bot) === 10, "bank: the hero paid 40 gold");
      const coin1 = await coinOf(ctx.url, guest.token);
      check(
        coin1 === coin0 + 38,
        `bank: the wallet got 38 coin (40 - 5 % fee): ${coin0} -> ${coin1}`,
      );
      await bot.play(20, { segmentTicks: 20 });

      // Coin -> gold.
      const wd = await bank(bot, { kind: "withdrawCoin", coin: 15 });
      check(wd.answer.result.ok && wd.hashOk, "bank: coin withdrawal applied");
      check(gold(bot) === 25, `bank: the hero got 15 gold (has ${gold(bot)})`);
      check((await coinOf(ctx.url, guest.token)) === coin1 - 15, "bank: the wallet paid 15 coin");
      // More than the account holds: refused, nothing moves.
      const hash = bot.sim.hash();
      const tooMuch = await bank(bot, { kind: "withdrawCoin", coin: 1_000_000 });
      check(
        !tooMuch.answer.result.ok &&
          tooMuch.answer.result.code === "insufficient_funds" &&
          tooMuch.answer.applied === null &&
          bot.sim.hash() === hash,
        "bank: an over-withdrawal is refused and changes nothing",
      );
      await bot.play(20, { segmentTicks: 20 });

      // Hero item -> vault -> hero, then into the vault again for the restart check.
      bot.act(classic.ACTION.unequip, { slot: "weapon" });
      await bot.play(20, { segmentTicks: 20 });
      const ref = bagUids(bot)[0];
      let vaultUid = "";
      if (ref === undefined) {
        check(false, "bank: the unequipped weapon is in the bag");
      } else {
        const before = (await vaultOf(ctx.url, guest.token))?.items.length ?? -1;
        const di = await bank(bot, { kind: "depositItem", ref });
        check(di.answer.result.ok && di.hashOk, "bank: item deposit applied");
        check(!bagUids(bot).includes(ref), "bank: the item left the bag");
        const vault = await vaultOf(ctx.url, guest.token);
        const added = vault?.items.find((i) => i.origin === "classic" && i.data !== null);
        check(
          vault !== null && vault.items.length === before + 1 && added !== undefined,
          `bank: the item is in /api/account/vault (${vault?.items.length ?? "no vault"} items)`,
        );
        await bot.play(20, { segmentTicks: 20 });
        if (added) {
          const back = await bank(bot, { kind: "withdrawItem", uid: added.uid });
          check(back.answer.result.ok && back.hashOk, "bank: item withdrawal applied");
          check(bagUids(bot).length === 1, "bank: the item is back in the bag");
          check(
            ((await vaultOf(ctx.url, guest.token))?.items.length ?? -1) === before,
            "bank: the vault gave the item back",
          );
          await bot.play(20, { segmentTicks: 20 });
          const again = await bank(bot, { kind: "depositItem", ref: bagUids(bot)[0]! });
          check(again.answer.result.ok, "bank: the item went into the vault again");
          if (again.answer.result.ok) vaultUid = again.answer.result.item?.uid ?? "";
        }
      }

      const after = await bot.play(40, { segmentTicks: 20 });
      check(
        after.resyncs.length === 0 && after.verified === 2,
        `bank: play verifies after the bank ops (${after.resyncs.map((r) => r.code).join(",") || "no resyncs"})`,
      );
      const state: BankState = {
        guest,
        coin: await coinOf(ctx.url, guest.token),
        vaultUid,
        snapshot: bot.verifiedSnapshot(),
      };
      ctx.state.set(NAME, state);
    } finally {
      await bot.close();
    }
  },

  async afterRestart(ctx) {
    const state = ctx.state.get(NAME) as BankState | undefined;
    if (!state) {
      check(false, "bank: no state from run() to resume");
      return;
    }
    const { guest } = state;
    check(
      (await coinOf(ctx.url, guest.token)) === state.coin,
      "bank: the wallet survived the restart",
    );
    const vault = await vaultOf(ctx.url, guest.token);
    check(
      vault !== null && vault.items.some((i) => i.uid === state.vaultUid),
      "bank: the vault item survived the restart",
    );
    const bot = await ClassicBot.join(ctx.url, guest, { resumeFrom: state.snapshot });
    try {
      check(bot.vstate.continued, "bank: the instance resumes at the verified state");
      const play = await bot.play(20, { segmentTicks: 20 });
      check(play.verified === 1 && play.resyncs.length === 0, "bank: play verifies after restart");
      const back = await bank(bot, { kind: "withdrawItem", uid: state.vaultUid });
      check(back.answer.result.ok && back.hashOk, "bank: withdraw after restart applied");
      const deposit = await bank(bot, { kind: "depositGold", gold: 20 });
      check(deposit.answer.result.ok && deposit.hashOk, "bank: deposit after restart applied");
      check(
        (await coinOf(ctx.url, guest.token)) === state.coin + 19,
        "bank: the wallet got 19 coin after restart",
      );
      const more = await bot.play(20, { segmentTicks: 20 });
      check(more.resyncs.length === 0, "bank: play verifies after the post-restart ops");
    } finally {
      await bot.close();
    }
  },
};
