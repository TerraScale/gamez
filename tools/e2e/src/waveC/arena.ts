/**
 * Wave C e2e: arena. Two registered accounts set dev builds, both queue and
 * the live pairing resolves; the winner, ticks and ratings are consistent,
 * the attacker's coin reward is in the wallet once, the ladder rows reach D1
 * and the replay of the stored match matches. afterRestart: status and the
 * match persist. (docs/design/wave-C.md §6, §13.) OWNER: T-arena.
 *
 * The replay runs @gamez/mode-arena's fight() in this process (imported from
 * the module source: the e2e package does not depend on it).
 */
import type {
  ArenaLadderResponse,
  ArenaMatch,
  ArenaStatus,
  ArenaTicket,
  WalletView,
} from "@gamez/protocol";
import { arenaLoaded, fight } from "../../../../modules/arena/src/index.ts";
import { api, registerGuest, type Registered } from "../accounts.ts";
import { loginGuest } from "../client.ts";
import type { E2eContext, E2eFeature } from "../features.ts";
import { check } from "../report.ts";

const POLL_MS = 20_000;
const REWARD_COIN = { win: 25, draw: 10, loss: 5 } as const;

/** A classic-like build (ArenaBuild ranges, protocol arena.ts). Only the numbers differ. */
function devBuild(name: string, maxHp: number, dmgMin: number, dmgMax: number) {
  return {
    name,
    classId: "classic.warrior",
    level: 10,
    appearance: "unit.hero",
    maxHp,
    dmgMin,
    dmgMax,
    attackRate: 12,
    armor: 3,
    resist: 5,
    critPct: 8,
    moveSpeed: 3,
    skills: [
      {
        id: "classic.skill.cleave",
        name: "Cleave",
        kind: "strike",
        power: 150,
        cooldown: 30,
        range: 1,
      },
    ],
    power: 120,
    sourceHash: "e2e-arena",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls GET /api/arena/queue/:ticket until it is no longer waiting (or time runs out). */
async function pollTicket(url: string, token: string, ticket: string): Promise<ArenaTicket | null> {
  const until = Date.now() + POLL_MS;
  for (;;) {
    const res = await api<ArenaTicket>(url, `/api/arena/queue/${encodeURIComponent(ticket)}`, {
      token,
    });
    if (res.status === 200 && res.body.status !== "waiting") return res.body;
    if (Date.now() >= until) return res.status === 200 ? res.body : null;
    await sleep(300);
  }
}

async function coinOf(url: string, token: string): Promise<number> {
  const res = await api<WalletView>(url, "/api/account/wallet", { token });
  return res.body.balances.coin;
}

async function statusOf(url: string, token: string): Promise<ArenaStatus> {
  return (await api<ArenaStatus>(url, "/api/arena/status", { token })).body;
}

export const arenaFeature: E2eFeature = {
  name: "arena",
  async run(ctx: E2eContext) {
    const sfx = Date.now().toString(36);
    const url = ctx.url;

    // Guests browse but cannot queue (trading needs an account).
    const guest = await loginGuest(url);
    const guestQueue = await api<{ error: { code: string } }>(url, "/api/arena/queue", {
      token: guest.token,
      body: { opId: `arena-g-${sfx}-q1` },
    });
    check(guestQueue.status === 403, "arena: a guest cannot queue (403)");

    const a: Registered = await registerGuest(url, await loginGuest(url), `ArenaA${sfx}`);
    const b: Registered = await registerGuest(url, await loginGuest(url), `ArenaB${sfx}`);
    ctx.state.set("arena", {
      a: a.token,
      b: b.token,
      accountA: a.accountId,
      accountB: b.accountId,
    });

    const setA = await api(url, "/api/dev/arena/build", {
      token: a.token,
      body: { build: devBuild("Ash", 160, 12, 18) },
    });
    const setB = await api(url, "/api/dev/arena/build", {
      token: b.token,
      body: { build: devBuild("Bren", 90, 8, 12) },
    });
    check(setA.status === 200 && setB.status === 200, "arena: both dev builds stored (200)");

    const coinBefore = await coinOf(url, a.token);
    const queueA = await api<ArenaTicket>(url, "/api/arena/queue", {
      token: a.token,
      body: { opId: `arena-a-${sfx}-q1`, mode: "classic" },
    });
    const queueB = await api<ArenaTicket>(url, "/api/arena/queue", {
      token: b.token,
      body: { opId: `arena-b-${sfx}-q1`, mode: "classic" },
    });
    check(
      queueA.status === 202 && queueA.body.status === "waiting",
      "arena: A queues (202 waiting)",
    );
    check(queueB.status === 202 || queueB.status === 200, "arena: B queues");

    const ticketA = await pollTicket(url, a.token, queueA.body.ticket);
    const ticketB = await pollTicket(url, b.token, queueB.body.ticket);
    const match = ticketA?.match ?? null;
    check(
      ticketA?.status === "matched" && ticketB?.status === "matched",
      `arena: both tickets matched (${ticketA?.status ?? "none"} / ${ticketB?.status ?? "none"})`,
    );
    if (!match || !ticketB?.match) return;
    check(ticketB.match.id === match.id, "arena: both tickets share one match");
    const pair = [match.attacker.party.accountId, match.defender.party.accountId].sort();
    check(
      pair.join() === [a.accountId, b.accountId].sort().join(),
      "arena: the match pairs A and B (one attacks, one defends)",
    );

    check(["attacker", "defender", "draw"].includes(match.winner), `arena: winner ${match.winner}`);
    check(Number.isInteger(match.ticks) && match.ticks >= 0, `arena: ticks ${match.ticks}`);
    check(
      match.rewards.coin === REWARD_COIN[outcomeOf(match)],
      "arena: the reward table matches the result",
    );

    // Ratings: the match and the status agree; a decided fight moves both ratings.
    const sA = await statusOf(url, a.token);
    const sB = await statusOf(url, b.token);
    const ratingA =
      match.attacker.party.accountId === a.accountId ? match.attacker : match.defender;
    const ratingB =
      match.attacker.party.accountId === a.accountId ? match.defender : match.attacker;
    check(
      sA.rating === ratingA.ratingAfter,
      `arena: A's rating ${sA.rating} is the match's after-rating`,
    );
    check(
      sB.rating === ratingB.ratingAfter,
      `arena: B's rating ${sB.rating} is the match's after-rating`,
    );
    if (match.winner === "draw") {
      check(
        sA.rating === 1000 && sB.rating === 1000,
        "arena: a draw between equals keeps both at 1000",
      );
    } else {
      check(sA.rating !== 1000 && sB.rating !== 1000, "arena: a decided fight moves both ratings");
    }
    check(
      Math.abs(sA.rating + sB.rating - 2000) <= 1,
      "arena: Elo keeps the rating sum (within rounding)",
    );
    check(sA.fightsLeftToday === 19, `arena: A has 19 fights left today (${sA.fightsLeftToday})`);
    check(
      sA.recent[0]?.id === match.id && sB.recent[0]?.id === match.id,
      "arena: both players list the match",
    );
    const bDefended = match.defender.party.accountId === b.accountId;
    check(
      !bDefended || sB.recent[0]?.defended === true,
      "arena: B's recent entry is marked defended",
    );

    // The reward: exactly one credit of the table's coin for the attacker.
    const attackerToken = match.attacker.party.accountId === a.accountId ? a.token : b.token;
    const attackerId = match.attacker.party.accountId;
    const coinAfter = await coinOf(url, a.token);
    if (attackerId === a.accountId) {
      check(
        coinAfter - coinBefore === match.rewards.coin,
        `arena: A's wallet gained the reward once (+${coinAfter - coinBefore}, want +${match.rewards.coin})`,
      );
    } else {
      check(coinAfter === coinBefore, "arena: A (defender) gets no coin");
      const coinAttacker = await coinOf(url, attackerToken);
      check(
        coinAttacker === match.rewards.coin,
        `arena: B (attacker) wallet ${coinAttacker} = the reward`,
      );
    }

    // Replay: the stored match re-runs to the same result in this process.
    const stored = await api<ArenaMatch>(url, `/api/arena/match/${match.id}`, { token: a.token });
    check(stored.status === 200 && stored.body.id === match.id, "arena: the match is served by id");
    const replay = fight(
      stored.body.builds.attacker,
      stored.body.builds.defender,
      stored.body.seed,
    );
    const sameMode = arenaLoaded().contentHash === stored.body.contentHash;
    check(sameMode, "arena: the e2e arena content hash equals the match's");
    check(
      replay.winner === stored.body.winner && replay.ticks === stored.body.ticks,
      `arena: replay gives the same winner and ticks (${replay.winner}, ${replay.ticks})`,
    );

    // Idempotent retry: the same opId returns the same ticket.
    const again = await api<ArenaTicket>(url, "/api/arena/queue", {
      token: a.token,
      body: { opId: `arena-a-${sfx}-q1`, mode: "classic" },
    });
    check(
      again.status === 200 && again.body.ticket === queueA.body.ticket,
      "arena: a retried queue returns the same ticket",
    );

    // The ladder: D1 rows for both fighters within 20 s.
    const deadline = Date.now() + POLL_MS;
    let rows: { account_id: string; rating: number }[] = [];
    while (Date.now() < deadline) {
      rows = await ctx.db.query<{ account_id: string; rating: number }>(
        "SELECT account_id, rating FROM arena_rating WHERE season_id = ? AND account_id IN (?, ?) AND _deleted = 0",
        [match.seasonId, a.accountId, b.accountId],
      );
      if (
        rows.length === 2 &&
        rows.every((r) => r.rating === (r.account_id === a.accountId ? sA.rating : sB.rating))
      )
        break;
      await sleep(500);
    }
    check(rows.length === 2, `arena: both ladder rows reached D1 (${rows.length}/2)`);
    check(
      rows.length === 2 &&
        rows.every((r) => r.rating === (r.account_id === a.accountId ? sA.rating : sB.rating)),
      "arena: the D1 ladder ratings match the arena",
    );

    const ladder = await api<ArenaLadderResponse>(url, "/api/arena/ladder?mode=classic&limit=100");
    check(
      ladder.status === 200 && ladder.body.available === true,
      "arena: GET /api/arena/ladder answers (available)",
    );
    const sorted = ladder.body.rows.every((r, i, all) => i === 0 || all[i - 1]!.rating >= r.rating);
    check(
      sorted && ladder.body.rows.every((r, i) => r.rank === i + 1),
      "arena: ladder rows are ranked by rating",
    );

    ctx.state.set("arena", {
      a: a.token,
      b: b.token,
      accountA: a.accountId,
      accountB: b.accountId,
      matchId: match.id,
      ratingA: sA.rating,
      ratingB: sB.rating,
      coinA: await coinOf(url, a.token),
      attackerToken,
    });
  },

  async afterRestart(ctx: E2eContext) {
    const state = ctx.state.get("arena") as
      | {
          a: string;
          b: string;
          accountA: string;
          matchId?: string;
          ratingA?: number;
          coinA?: number;
        }
      | undefined;
    if (!state?.matchId) return;
    const sA = await statusOf(ctx.url, state.a);
    check(
      sA.rating === state.ratingA,
      `arena: A's rating persists across a restart (${sA.rating})`,
    );
    check(
      sA.recent.some((m) => m.id === state.matchId),
      "arena: A's recent matches persist across a restart",
    );
    const match = await api<ArenaMatch>(ctx.url, `/api/arena/match/${state.matchId}`, {
      token: state.a,
    });
    check(match.status === 200, "arena: the stored match survives a restart");
    check(
      (await coinOf(ctx.url, state.a)) === state.coinA,
      "arena: the reward is not paid again after a restart",
    );
  },
};

function outcomeOf(match: ArenaMatch): "win" | "draw" | "loss" {
  // The reward belongs to the attacker: its result is the match's winner.
  return match.winner === "attacker" ? "win" : match.winner === "draw" ? "draw" : "loss";
}
