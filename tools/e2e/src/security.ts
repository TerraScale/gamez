/**
 * ADR 0007 e2e: the server-observable pre-merge security fixes, against the
 * real dev server.
 *
 * - R1: a forged legacy save (10M gold, level 60) still imports for solo play,
 *   but the bank refuses every op of the imported hero (the wallet does not
 *   move), and its D1 row is kept with imported = 1 but never ranked.
 * - R2: a bank opId that was used once is bound to its op: the same opId with
 *   another op is a conflict, and an identical resend replays the stored result
 *   without moving value again.
 * - R4: /start without a valid fragment nonce sets no state cookie and fails.
 * - R8: a gzip bomb import is refused unread, an amplifying JSON save is
 *   refused before restore, and the instance keeps answering.
 * - R10: a kick closes the kicked member's open guild chat socket with 4403.
 * R3 (link CSRF, link code only via POST with a bearer) is covered in auth.ts §7b,
 * R11 (a pose tag is not free text) in classic-presence.ts.
 */
import { gzipSync } from "node:zlib";
import { createSim } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  BANK_ACTOR,
  VERIFIED_ACTOR,
  type BankOp,
  type GuildInfo,
  type VerifiedServerMessage,
  type WalletView,
} from "@gamez/protocol";
import { api, oauthNonce, registerGuest } from "./accounts.ts";
import { ChatBot } from "./chat-client.ts";
import { ClassicBot, classicLoaded } from "./classic-bot.ts";
import { loginGuest } from "./client.ts";
import type { E2eContext, E2eFeature } from "./features.ts";
import { check } from "./report.ts";

type BankAnswer = Extract<VerifiedServerMessage, { t: "bank" }>;
type BoardBody = { rows: { accountId: string }[] };

const FORGED_GOLD = 10_000_000;
const FORGED_LEVEL = 60;
/** The host allows one bank op per second per socket. */
const BANK_GAP_MS = 1100;
const POLL_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ops = 0;
function newOpId(): string {
  return `e2e_sec_${Date.now().toString(36)}_${++ops}`;
}

async function coinOf(url: string, token: string): Promise<number> {
  const r = await api<WalletView>(url, "/api/account/wallet", { token });
  return r.body.balances?.coin ?? -1;
}

function gold(bot: ClassicBot): number {
  return bot.sim.world.get(classic.heroOf(bot.sim.world), classic.Wallet)?.gold ?? -1;
}

/** A bank op at the bot's verified state; a fast-path `applied` is replayed like the browser. */
async function bank(
  bot: ClassicBot,
  op: BankOp,
  opId = newOpId(),
): Promise<{ answer: BankAnswer; hashOk: boolean }> {
  bot.sendRaw({ t: "bank", opId, op, at: { tick: bot.sim.tick, hash: bot.sim.hash() } });
  const answer = await bot.waitFor(
    `bank answer ${opId}`,
    (m): m is BankAnswer => m.t === "bank" && m.opId === opId,
  );
  let hashOk = true;
  if (answer.applied) {
    const res = bot.sim.dispatch(answer.applied.name, answer.applied.payload, BANK_ACTOR);
    hashOk = res.ok && bot.sim.hash() === answer.applied.hash;
  }
  await sleep(BANK_GAP_MS);
  return { answer, hashOk };
}

/** R1: forged import is solo-only. */
async function forgedImport(ctx: E2eContext): Promise<void> {
  const guest = await loginGuest(ctx.url);
  const bot = await ClassicBot.join(ctx.url, guest, { fresh: true, noHero: true });
  try {
    // A client-authored "legacy save": a new hero, then edited like a save file.
    const forged = createSim(classicLoaded(), { seed: 0, from: bot.sim.snapshot() });
    const made = forged.dispatch(
      classic.ACTION.newHero,
      { classId: "classic.warrior", name: "Forger" },
      VERIFIED_ACTOR,
    );
    forged.dispatch(classic.ACTION.setControl, { mode: "manual" }, VERIFIED_ACTOR);
    // The hero gets its wallet and gear on its first tick (items/heroInit.ts).
    forged.step(1);
    const hero = classic.heroOf(forged.world);
    if (!made.ok || hero === 0) {
      check(false, "security: the forged save has a hero");
      return;
    }
    forged.world.update(hero, classic.Wallet, { gold: FORGED_GOLD });
    const lvl = forged.world.read(hero, classic.Level);
    forged.world.update(hero, classic.Level, { ...lvl, level: FORGED_LEVEL });

    const coin0 = await coinOf(ctx.url, guest.token);
    const imported = await bot.importSave(forged.snapshot());
    check(
      "vstate" in imported && imported.vstate.imported === true,
      `security: a forged legacy save imports for solo play, flagged imported (${"error" in imported ? imported.error.code : "vstate"})`,
    );
    if (!("vstate" in imported)) return;
    check(gold(bot) === FORGED_GOLD, `security: the imported hero holds ${gold(bot)} gold`);
    const play = await bot.play(20, { segmentTicks: 20 });
    check(
      play.verified === 1 && play.resyncs.length === 0,
      "security: the imported hero plays and verifies",
    );

    const dep = await bank(bot, { kind: "depositGold", gold: 1_000_000 });
    check(
      !dep.answer.result.ok &&
        dep.answer.result.code === "not_eligible" &&
        dep.answer.applied === null &&
        gold(bot) === FORGED_GOLD,
      `security: the bank refuses a deposit from an imported hero (${JSON.stringify(dep.answer.result)})`,
    );
    const wd = await bank(bot, { kind: "withdrawCoin", coin: 1 });
    check(
      !wd.answer.result.ok && wd.answer.result.code === "not_eligible",
      "security: the bank refuses a withdrawal to an imported hero",
    );
    check(
      (await coinOf(ctx.url, guest.token)) === coin0,
      "security: the imported hero's wallet did not move",
    );
  } finally {
    // The last close compacts and reports the hero (imported = 1) into the outbox.
    await bot.close();
  }

  let row: { imported: number; level: number } | undefined;
  for (const until = Date.now() + POLL_MS; Date.now() < until && !row;) {
    const rows = await ctx.db.query<{ imported: number; level: number }>(
      "SELECT imported, level FROM classic_hero WHERE account_id = ? AND _deleted = 0",
      [guest.accountId],
    );
    row = rows[0];
    if (!row) await sleep(500);
  }
  check(
    row?.imported === 1 && row.level === FORGED_LEVEL,
    `security: the imported hero's D1 row is kept for audit with imported = 1 (${JSON.stringify(row ?? null)})`,
  );
  const res = await fetch(`${ctx.url}/api/leaderboards?board=level&mode=classic&limit=100`);
  const board = (await res.json()) as BoardBody;
  check(
    res.status === 200 && !board.rows.some((r) => r.accountId === guest.accountId),
    "security: the imported level-60 hero is not on the level leaderboard",
  );
}

/** R2: one opId, one op. */
async function opIdReplay(ctx: E2eContext): Promise<void> {
  const guest = await loginGuest(ctx.url);
  const bot = await ClassicBot.join(ctx.url, guest, { fresh: true, heroName: "Replayer" });
  try {
    bot.act(classic.ACTION.setControl, { mode: "manual" });
    await bot.play(40, { segmentTicks: 20 });
    const coin0 = await coinOf(ctx.url, guest.token);
    const opId = newOpId();
    const first = await bank(bot, { kind: "depositGold", gold: 20 }, opId);
    check(
      first.answer.result.ok && first.hashOk,
      `security: a deposit under a new opId applies (${JSON.stringify(first.answer.result)})`,
    );
    const coin1 = await coinOf(ctx.url, guest.token);
    check(coin1 === coin0 + 19, `security: the wallet got 19 coin (${coin0} -> ${coin1})`);
    const gold1 = gold(bot);

    const other = await bank(bot, { kind: "withdrawCoin", coin: 1_000_000_000 }, opId);
    check(
      !other.answer.result.ok &&
        other.answer.result.code === "conflict" &&
        other.answer.applied === null,
      `security: the same opId with another op is a conflict (${JSON.stringify(other.answer.result)})`,
    );
    const again = await bank(bot, { kind: "depositGold", gold: 20 }, opId);
    check(
      again.answer.result.ok && again.answer.applied === null && gold(bot) === gold1,
      `security: an identical resend replays the stored result (${JSON.stringify(again.answer.result)})`,
    );
    check((await coinOf(ctx.url, guest.token)) === coin1, "security: neither resend moved coin");
  } finally {
    await bot.close();
  }
}

/** R4: no nonce, no flow. */
async function oauthNonceRequired(ctx: E2eContext): Promise<void> {
  for (const [label, q] of [
    ["without a nonce", "?link=0"],
    ["with a malformed nonce", "?link=0&n=short"],
  ] as const) {
    const res = await fetch(`${ctx.url}/api/auth/oauth/google/start${q}`, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    check(
      res.status === 302 &&
        location.includes("#auth_error=oauth_failed") &&
        !(res.headers.get("set-cookie") ?? "").includes("gz_oauth"),
      `security: /start ${label} fails and sets no state cookie (${res.status} ${location})`,
    );
  }
  const ok = await fetch(`${ctx.url}/api/auth/oauth/google/start?link=0&n=${oauthNonce()}`, {
    redirect: "manual",
  });
  check(
    ok.status === 302 && (ok.headers.get("set-cookie") ?? "").includes("gz_oauth"),
    "security: /start with a valid nonce sets the state cookie",
  );
}

/**
 * R8: the server never inflates client gzip (a bomb is refused unread), and a
 * plain-JSON save under the frame cap but with an amplifying structure is
 * refused before any restore.
 */
async function gzipBomb(ctx: E2eContext): Promise<void> {
  const guest = await loginGuest(ctx.url);
  const bot = await ClassicBot.join(ctx.url, guest, { fresh: true, noHero: true });
  try {
    // 64 MiB of spaces inflate from about 64 KiB of gzip (8x MAX_SNAPSHOT_BYTES).
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x20), { level: 9 }).toString("base64");
    const answer = await bot.importSave({ enc: "gzip64", data: bomb });
    check(
      "error" in answer &&
        answer.error.code === "import_rejected" &&
        answer.error.message === "compressed saves are not accepted",
      `security: a gzip-bomb import is refused without inflating (${"error" in answer ? answer.error.message : "vstate"}, ${bomb.length} chars)`,
    );
  } finally {
    await bot.close();
  }
  // A fresh socket (imports are rate limited per socket).
  const other = await ClassicBot.join(ctx.url, await loginGuest(ctx.url), {
    fresh: true,
    noHero: true,
  });
  try {
    // About 290k empty objects: under the 900 KiB frame cap, but a structure bomb.
    const junk = {
      modeId: "classic",
      contentHash: "x",
      tick: 0,
      rng: [1, 2, 3, 4],
      world: {
        nextEntity: 1,
        components: {},
        resources: { "zz.junk": Array.from({ length: 290_000 }, () => ({})) },
      },
    };
    const wide = await other.importSave({ enc: "json", data: junk as never });
    check(
      "error" in wide &&
        wide.error.code === "import_rejected" &&
        wide.error.message === "the save is too large",
      `security: an amplifying JSON import is refused before restore (${"error" in wide ? wide.error.message : "vstate"})`,
    );
    const v = await other.rejoin({ fresh: true });
    check(
      v.importable,
      "security: the instance still answers after the bombs, and stays importable",
    );
  } finally {
    await other.close();
  }
}

/** R10: a kicked member's open guild chat socket is closed at once. */
async function guildKickClosesChat(ctx: E2eContext): Promise<void> {
  const suffix = Date.now().toString(36);
  const leader = await registerGuest(ctx.url, await loginGuest(ctx.url), `Kl ${suffix.slice(-4)}`);
  const member = await registerGuest(ctx.url, await loginGuest(ctx.url), `Km ${suffix.slice(-4)}`);
  const created = await api<{ guild?: GuildInfo }>(ctx.url, "/api/guilds", {
    token: leader.token,
    body: {
      name: `Kick ${suffix}`,
      tag: `K${String(Date.now() % 1000).padStart(3, "0")}`,
      open: true,
    },
  });
  const guildId = created.body.guild?.id;
  if (created.status !== 201 || !guildId) {
    check(false, `security: the leader creates a guild (${created.status})`);
    return;
  }
  try {
    const joined = await api<unknown>(ctx.url, `/api/guilds/${guildId}/join`, {
      token: member.token,
      method: "POST",
    });
    check(joined.status === 200, "security: the member joins the guild");
    const chat = new ChatBot(ctx.url, member.token, `guild:${guildId}`, "kicked");
    const lead = new ChatBot(ctx.url, leader.token, `guild:${guildId}`, "leader");
    try {
      for (const bot of [chat, lead]) {
        await bot.waitFor(
          "guild welcome",
          (m): m is Extract<typeof m, { t: "welcome" }> => m.t === "welcome",
        );
      }
      const kickedAt = Date.now();
      const kicked = await api<unknown>(ctx.url, "/api/guilds/kick", {
        token: leader.token,
        body: { accountId: member.accountId },
      });
      check(kicked.status === 200, `security: the leader kicks the member (${kicked.status})`);
      // The revoke takes effect at once: a guild line posted after the kick
      // (acked to the leader) never reaches the kicked member's socket.
      const ack = await lead.outcome(lead.say("after the kick", "sec-kick-1"));
      const lineId = ack.t === "ack" ? ack.id : "";
      check(lineId !== "", `security: the leader posts after the kick (${ack.t})`);
      await sleep(1000);
      check(
        !chat.log.some((r) => r.msg.t === "message" && r.msg.msg.id === lineId),
        "security: a kicked member no longer receives guild chat",
      );
      // workerd flushes a hibernatable socket's server-side close lazily (about
      // 10 s in local dev), so the close code gets a wider window.
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), 25_000));
      const ev = await Promise.race([chat.closed, timeout]);
      check(
        ev?.code === 4403,
        `security: the kick closes the member's guild chat socket with 4403 (${ev ? `${ev.code} after ${Date.now() - kickedAt} ms` : "still open"})`,
      );
    } finally {
      await chat.close();
      await lead.close();
    }
  } finally {
    // The last member leaving disbands the guild.
    await api<unknown>(ctx.url, "/api/guilds/leave", {
      token: leader.token,
      method: "POST",
      body: {},
    });
  }
}

export const securityFeature: E2eFeature = {
  name: "security",
  async run(ctx) {
    // Each part reports on its own: a broken harness in one must not hide the others.
    for (const [name, part] of [
      ["forged import (R1)", forgedImport],
      ["bank opId replay (R2)", opIdReplay],
      ["OAuth nonce (R4)", oauthNonceRequired],
      ["gzip bomb (R8)", gzipBomb],
      ["guild kick closes chat (R10)", guildKickClosesChat],
    ] as const) {
      try {
        await part(ctx);
      } catch (err) {
        check(
          false,
          `security: ${name} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  },
};
