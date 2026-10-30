/**
 * ArenaLadder (wave-C.md §6.3) over in-memory storage: matchmaking band and
 * widening, live pairing, ghosts, the Sparring Shade, daily limits, ticket
 * idempotency, ratings, rewards (exactly once across a crash), the outbox,
 * the recent list and the match log cap.
 */
import { describe, expect, it } from "vite-plus/test";
import { arenaLoaded } from "@gamez/mode-arena";
import { fight as realFight } from "@gamez/mode-arena";
import {
  GHOST_AFTER_MS,
  MATCH_HISTORY,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  REWARD_MAX_ATTEMPTS,
  TICKET_RECHECK_MS,
} from "../../src/server/arena/ladder.ts";
import { SHADE_ACCOUNT_ID, shadeOf } from "../../src/server/arena/build.ts";
import { build, fightByHp, harness, SEASON } from "./support.ts";

const DAY = 86_400_000;

/** Sets a player's rating directly (test setup only). */
function setRating(h: ReturnType<typeof harness>, accountId: string, rating: number): void {
  h.store.fake.db
    .prepare("UPDATE arena_player SET rating = ? WHERE account_id = ?")
    .run(rating, accountId);
}

/** Queues accountId and returns its ticket id. */
async function queue(
  h: ReturnType<typeof harness>,
  accountId: string,
  opId: string,
  b = build(accountId),
): Promise<string> {
  const res = await h.current.enqueue({ opId, build: b });
  if (!res.ok) throw new Error(res.message);
  return res.value.ticket;
}

/** Runs one shade fight for accountId (sole registrant): queue, age, poll. */
async function shadeFight(h: ReturnType<typeof harness>, accountId: string, n: number) {
  const ticket = await queue(h, accountId, `shade-op-${n}-${accountId}`);
  h.clock.advance(GHOST_AFTER_MS + 1);
  const view = await h.current.poll({ accountId, ticket });
  if (!view?.match) throw new Error(`no match for ${ticket}: ${view?.status}`);
  return view.match;
}

describe("enqueue and tickets", () => {
  it("creates a waiting ticket with a season-scoped id and counts the fight", async () => {
    const h = harness();
    const res = await h.current.enqueue({ opId: "op-first-0001", build: build("a") });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.replayed).toBeUndefined();
    expect(res.value.status).toBe("waiting");
    expect(res.value.match).toBeNull();
    expect(res.value.ticket).toMatch(new RegExp(`^${SEASON}\\.[0-9a-f]{16}$`));
    const st = h.current.status("a");
    expect(st).toMatchObject({
      seasonId: SEASON,
      rating: 1000,
      registered: true,
      fightsLeftToday: 19,
      ticket: res.value.ticket,
      recent: [],
    });
  });

  it("is idempotent by opId: the same ticket and no second fight counted", async () => {
    const h = harness();
    const first = await queue(h, "a", "same-op-0001");
    const again = await h.current.enqueue({ opId: "same-op-0001", build: build("a") });
    expect(again.ok && again.replayed).toBe(true);
    expect(again.ok && again.value.ticket).toBe(first);
    expect(h.current.status("a").fightsLeftToday).toBe(19);
  });

  it("returns the waiting ticket for a second opId while one still waits", async () => {
    const h = harness();
    const first = await queue(h, "a", "op-one-00001");
    const second = await h.current.enqueue({ opId: "op-two-00002", build: build("a") });
    expect(second.ok && second.value.ticket).toBe(first);
    expect(second.ok && second.replayed).toBe(true);
  });

  it("keeps each account's tickets private to that account", async () => {
    const h = harness();
    const ticket = await queue(h, "a", "private-op-1");
    expect(await h.current.poll({ accountId: "b", ticket })).toBeNull();
    expect(await h.current.poll({ accountId: "a", ticket })).not.toBeNull();
  });

  it("stores the latest build per account in the ghost pool", async () => {
    const h = harness();
    await shadeFight(h, "a", 1);
    const ticket = await queue(h, "a", "build-op-0002", build("a", { maxHp: 120 }));
    expect(ticket).toMatch(/^2026-s1\./);
    const row = h.store.fake.db
      .prepare("SELECT build_json FROM arena_player WHERE account_id = 'a'")
      .get() as { build_json: string };
    expect(JSON.parse(row.build_json).maxHp).toBe(120);
  });
});

describe("live pairing", () => {
  it("pairs two waiting tickets in the band: the earlier one attacks, both get the match", async () => {
    const h = harness();
    const ta = await queue(h, "a", "live-op-a-001", build("a", { maxHp: 100 }));
    h.clock.advance(1);
    const tb = await queue(h, "b", "live-op-b-001", build("b", { maxHp: 50 }));

    const va = await h.current.poll({ accountId: "a", ticket: ta });
    const vb = await h.current.poll({ accountId: "b", ticket: tb });
    expect(va?.status).toBe("matched");
    expect(vb?.status).toBe("matched");
    expect(va?.match?.id).toBe(vb?.match?.id);
    const m = va!.match!;
    expect(m.attacker.party.accountId).toBe("a");
    expect(m.defender.party.accountId).toBe("b");
    expect(m.defender.ghost).toBe(false);
    expect(m.winner).toBe("attacker");
    expect(m.ticks).toBe(42);
    expect(m.contentHash).toBe("test-hash");
    expect(m.rewards).toEqual({ coin: 25, seasonXp: 60 });
  });

  it("refunds the daily fight of a live defender; the attacker keeps its fight", async () => {
    const h = harness();
    const ta = await queue(h, "a", "refund-op-a-01", build("a", { maxHp: 100 }));
    h.clock.advance(1);
    const tb = await queue(h, "b", "refund-op-b-01", build("b", { maxHp: 50 }));
    expect(h.current.status("b").fightsLeftToday).toBe(19);
    await h.current.poll({ accountId: "a", ticket: ta });
    await h.current.poll({ accountId: "b", ticket: tb });
    expect(h.current.status("a").fightsLeftToday).toBe(19);
    expect(h.current.status("b").fightsLeftToday).toBe(20);
    // The defender earns no coin: only the attacker's reward row exists.
    const rewards = h.store.fake.db.prepare("SELECT account_id FROM arena_reward").all() as {
      account_id: string;
    }[];
    expect(rewards.map((r) => r.account_id)).toEqual(["a"]);
  });

  it("moves both ratings with Elo and keeps W/L counters", async () => {
    const h = harness();
    const ta = await queue(h, "a", "elo-op-a-001", build("a", { maxHp: 100 }));
    h.clock.advance(1);
    const tb = await queue(h, "b", "elo-op-b-001", build("b", { maxHp: 50 }));
    await h.current.poll({ accountId: "a", ticket: ta });
    await h.current.poll({ accountId: "b", ticket: tb });
    expect(h.current.status("a")).toMatchObject({ rating: 1016, wins: 1, losses: 0 });
    expect(h.current.status("b")).toMatchObject({ rating: 984, wins: 0, losses: 1 });
  });

  it("does not pair tickets outside the band before the ghost timer", async () => {
    const h = harness();
    h.current.register(build("a"));
    h.current.register(build("b"));
    setRating(h, "b", 1500);
    const ta = await queue(h, "a", "far-op-a-0001", build("a"));
    await queue(h, "b", "far-op-b-0001", build("b"));
    const va = await h.current.poll({ accountId: "a", ticket: ta });
    expect(va?.status).toBe("waiting");
  });
});

describe("ghosts, the shade and matchmaking", () => {
  it("picks a ghost after the timer, never the player's own build, and notifies the owner", async () => {
    const h = harness();
    h.current.register(build("b", { maxHp: 50 }));
    const ta = await queue(h, "a", "ghost-op-a-01", build("a", { maxHp: 100 }));
    expect((await h.current.poll({ accountId: "a", ticket: ta }))?.status).toBe("waiting");

    h.clock.advance(GHOST_AFTER_MS);
    const view = await h.current.poll({ accountId: "a", ticket: ta });
    expect(view?.status).toBe("matched");
    expect(view?.match?.defender.party.accountId).toBe("b");
    expect(view?.match?.defender.ghost).toBe(true);
    expect(view?.match?.winner).toBe("attacker");

    expect(h.current.status("b")).toMatchObject({ rating: 984, losses: 1, registered: true });
    const notices = h.accounts.notices.get("b") ?? [];
    expect(notices.map((n) => n.kind)).toEqual(["arena.defended"]);
    expect(notices[0]!.id).toBe(`arena:${view!.match!.id}:defended`);
    expect(notices[0]!.text).toBe("Name-a fought your ghost: you lost");
    expect(h.current.status("b").recent[0]).toMatchObject({ result: "loss", defended: true });
  });

  it("falls back to the Sparring Shade when the pool is empty (unrated, rewards still paid)", async () => {
    const h = harness();
    const ta = await queue(h, "a", "shade-op-a-01", build("a", { maxHp: 100 }));
    h.clock.advance(GHOST_AFTER_MS);
    const view = await h.current.poll({ accountId: "a", ticket: ta });
    const m = view!.match!;
    expect(m.defender.party).toEqual({
      accountId: SHADE_ACCOUNT_ID,
      displayName: "Sparring Shade",
    });
    expect(m.defender.ghost).toBe(true);
    expect(m.builds.defender.maxHp).toBe(90);
    expect(m.builds.defender.displayName).toBe("Sparring Shade");
    expect(m.defender.ratingBefore).toBe(m.defender.ratingAfter);
    expect(h.current.status("a")).toMatchObject({ rating: 1000, wins: 0, losses: 0 });
    expect(h.accounts.balance("a")).toBe(25);
    expect(h.accounts.notices.size).toBe(0);
    expect(h.outbox.pending().filter((r) => r.table === "arena_rating")).toHaveLength(0);
  });

  it("never fights the player's own build even when it is the only one registered", async () => {
    const h = harness();
    const ta = await queue(h, "a", "self-op-a-0001", build("a"));
    h.clock.advance(GHOST_AFTER_MS);
    const m = (await h.current.poll({ accountId: "a", ticket: ta }))!.match!;
    expect(m.defender.party.accountId).not.toBe("a");
    expect(m.defender.party.accountId).toBe(SHADE_ACCOUNT_ID);
  });

  it("widens the band by one step per empty search and matches on the third poll", async () => {
    const h = harness();
    h.current.register(build("b"));
    setRating(h, "b", 1250);
    const ta = await queue(h, "a", "band-op-a-001", build("a"));
    h.clock.advance(GHOST_AFTER_MS);

    // Band 100, then 200 (empty), then 300 (250 apart): found on the third poll.
    expect((await h.current.poll({ accountId: "a", ticket: ta }))?.status).toBe("waiting");
    expect((await h.current.poll({ accountId: "a", ticket: ta }))?.status).toBe("waiting");
    const third = await h.current.poll({ accountId: "a", ticket: ta });
    expect(third?.status).toBe("matched");
    expect(third?.match?.defender.party.accountId).toBe("b");
  });

  it("takes the nearest ghost once the band is at its maximum", async () => {
    const h = harness();
    h.current.register(build("b"));
    setRating(h, "b", 2000);
    const ta = await queue(h, "a", "max-op-a-0001", build("a"));
    h.clock.advance(GHOST_AFTER_MS);
    for (let i = 0; i < 5; i++) {
      expect((await h.current.poll({ accountId: "a", ticket: ta }))?.status).toBe("waiting");
    }
    const sixth = await h.current.poll({ accountId: "a", ticket: ta });
    expect(sixth?.status).toBe("matched");
    expect(sixth?.match?.defender.party.accountId).toBe("b");
  });

  it("uses a seeded pick among equally close ghosts (deterministic for a seed)", async () => {
    const h = harness();
    h.current.register(build("b"));
    h.current.register(build("c"));
    const ta = await queue(h, "a", "pick-op-a-001", build("a"));
    h.clock.advance(GHOST_AFTER_MS);
    const m = (await h.current.poll({ accountId: "a", ticket: ta }))!.match!;
    expect(["b", "c"]).toContain(m.defender.party.accountId);
    expect(m.defender.ghost).toBe(true);
  });
});

describe("daily limit", () => {
  it("allows FIGHTS_PER_DAY fights per UTC day, then fails the ticket with 'limit'", async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) await shadeFight(h, "a", i);
    expect(h.current.status("a").fightsLeftToday).toBe(0);

    const res = await h.current.enqueue({ opId: "over-limit-001", build: build("a") });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe("failed");
    expect(res.value.reason).toBe("limit");
    expect(res.value.match).toBeNull();
    expect(h.current.status("a").ticket).toBeNull();
  });

  it("resets on the next UTC day", async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) await shadeFight(h, "a", i);
    h.clock.advance(DAY);
    expect(h.current.status("a").fightsLeftToday).toBe(20);
    const ticket = await queue(h, "a", "next-day-op-01");
    expect(ticket).toMatch(/^2026-s1\./);
  });

  it("counts matches per account, not per ladder instance", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await shadeFight(h, "a", i);
    expect(h.current.status("a").fightsLeftToday).toBe(17);
    expect(h.current.status("b").fightsLeftToday).toBe(20);
  });
});

describe("ratings, rewards and the log", () => {
  it("credits the attacker's coin exactly once with the faucet txId", async () => {
    const h = harness();
    await shadeFight(h, "a", 1);
    expect(h.accounts.balance("a")).toBe(25);
    const coin = [...h.accounts.txs.entries()].find(([k]) => k.endsWith(":coin"));
    expect(coin?.[0]).toMatch(/^a\|arena:2026-s1\.[0-9a-f]{16}:coin$/);
    expect(coin?.[1]).toEqual({ amount: 25, applications: 1 });
    expect(h.accounts.xp.get("a")).toBe(60);
  });

  it("pays draw and loss rewards by the table", async () => {
    const h = harness({ fight: () => ({ winner: "defender", ticks: 1, contentHash: "h" }) });
    await shadeFight(h, "a", 1);
    expect(h.accounts.balance("a")).toBe(5);
    expect(h.accounts.xp.get("a")).toBe(20);
  });

  it("stores the full match with seed, builds and contentHash", async () => {
    const calls: { seed: number }[] = [];
    const h = harness({ fight: fightByHp(calls) });
    const m = await shadeFight(h, "a", 1);
    expect(m.seed).toBe(calls[0]!.seed);
    expect(m.builds.attacker.accountId).toBe("a");
    expect(m.builds.defender).toEqual(shadeOf(build("a")));
    expect(m.seasonId).toBe(SEASON);
    expect(h.current.match(m.id)).toEqual(m);
    expect(h.current.match("2026-s1.0000000000000000")).toBeNull();
  });

  it("writes arena_rating outbox rows for both fighters of a rated match", async () => {
    const h = harness();
    const ta = await queue(h, "a", "outbox-op-a1", build("a", { maxHp: 100 }));
    h.clock.advance(1);
    const tb = await queue(h, "b", "outbox-op-b1", build("b", { maxHp: 50 }));
    await h.current.poll({ accountId: "a", ticket: ta });
    await h.current.poll({ accountId: "b", ticket: tb });
    const rows = h.outbox.pending().filter((r) => r.table === "arena_rating");
    expect(rows.map((r) => r.pk).sort()).toEqual([`${SEASON}/a`, `${SEASON}/b`]);
    const a = rows.find((r) => r.pk.endsWith("/a"))!;
    expect(a.op).toBe("upsert");
    expect(a.payload).toMatchObject({
      seasonId: SEASON,
      mode: "classic",
      accountId: "a",
      rating: 1016,
      wins: 1,
      losses: 0,
      draws: 0,
    });
  });

  it("keeps the last 20 matches per account", async () => {
    const h = harness();
    for (let i = 0; i < 25; i++) {
      if (i > 0 && i % 20 === 0) h.clock.advance(DAY);
      await shadeFight(h, "a", i);
    }
    const recent = h.current.status("a").recent;
    expect(recent).toHaveLength(20);
    expect(recent[0]!.result).toBe("win");
    expect(recent[0]!.opponent.accountId).toBe(SHADE_ACCOUNT_ID);
  });

  it("keeps the last 500 matches in the log", async () => {
    const h = harness();
    const ids: string[] = [];
    const total = MATCH_HISTORY + 10;
    for (let i = 0; i < total; i++) {
      if (i > 0 && i % 20 === 0) h.clock.advance(DAY);
      ids.push((await shadeFight(h, "a", i)).id);
    }
    expect(h.current.match(ids[0]!)).toBeNull();
    expect(h.current.match(ids[total - 1]!)).not.toBeNull();
    expect(h.current.match(ids[total - MATCH_HISTORY]!)).not.toBeNull();
  }, 20_000);
});

describe("crash-safe rewards", () => {
  it("re-drives a lost coin response and a failed xp step without a second credit", async () => {
    const h = harness();
    h.accounts.faults.walletTxLost = 1; // credit applied, response lost
    h.accounts.faults.addSeasonXpFail = 1;
    const ta = await queue(h, "a", "crash-op-a-01", build("a", { maxHp: 100 }));
    h.clock.advance(1);
    await queue(h, "b", "crash-op-b-01", build("b", { maxHp: 50 }));

    const first = await h.current.poll({ accountId: "a", ticket: ta });
    const matchId = first!.match!.id;
    expect(h.accounts.balance("a")).toBe(25); // applied once, then the response was lost
    expect(h.accounts.xp.get("a")).toBeUndefined();

    // A poll before the retry is due does not touch the account (backoff).
    await h.current.poll({ accountId: "a", ticket: ta });
    expect(h.accounts.faults.addSeasonXpFail).toBe(1);

    // Once due: the coin step replays (no second credit); the xp step fails.
    h.clock.advance(RETRY_BASE_MS);
    await h.current.poll({ accountId: "a", ticket: ta });
    expect(h.accounts.balance("a")).toBe(25);
    expect(h.accounts.xp.get("a")).toBeUndefined();
    expect(h.current.pendingWork()).toBe(true);

    // A restart (new instance over the same storage) finishes the rest.
    h.clock.advance(RETRY_BASE_MS * 2);
    const restarted = h.restart();
    await restarted.poll({ accountId: "a", ticket: ta });
    expect(h.accounts.applications("a", `arena:${matchId}:coin`)).toBe(1);
    expect(h.accounts.balance("a")).toBe(25);
    expect(h.accounts.xp.get("a")).toBe(60);
    expect(h.accounts.notices.get("b")).toHaveLength(1);
    expect(h.accounts.notices.get("b")![0]!.text).toMatch(/^Name-a fought you: /);
    expect(h.accounts.balance("b")).toBe(0);
    expect(restarted.pendingWork()).toBe(false);
  });

  it("retries a failed notice step with exponential backoff", async () => {
    const h = harness();
    h.accounts.faults.notifyFail = 2;
    h.current.register(build("b", { maxHp: 50 }));
    const ta = await queue(h, "a", "notify-op-a-1", build("a", { maxHp: 100 }));
    h.clock.advance(GHOST_AFTER_MS);
    await h.current.poll({ accountId: "a", ticket: ta });
    expect(h.current.pendingWork()).toBe(true);
    // First failure: due again after RETRY_BASE_MS.
    expect(h.current.nextWakeAt()).toBe(h.clock.now + RETRY_BASE_MS);
    await h.current.work(); // not due yet: no call
    expect(h.accounts.faults.notifyFail).toBe(1);
    h.clock.advance(RETRY_BASE_MS);
    await h.current.work(); // second failure: the delay doubles
    expect(h.current.nextWakeAt()).toBe(h.clock.now + RETRY_BASE_MS * 2);
    h.clock.advance(RETRY_BASE_MS * 2);
    await h.current.work();
    expect(h.accounts.notices.get("b")?.length ?? 0).toBe(1);
    expect(h.current.pendingWork()).toBe(false);
    expect(h.current.nextWakeAt()).toBeNull();
  });

  it("caps the backoff and leaves a step for a human after the attempt limit", async () => {
    const h = harness();
    h.accounts.faults.walletTxFail = 1_000;
    const ta = await queue(h, "a", "limit-op-a-01", build("a"));
    h.clock.advance(GHOST_AFTER_MS);
    await h.current.poll({ accountId: "a", ticket: ta });
    let maxGap = 0;
    for (let i = 1; i < REWARD_MAX_ATTEMPTS; i++) {
      const due = h.current.nextWakeAt()!;
      maxGap = Math.max(maxGap, due - h.clock.now);
      h.clock.advance(due - h.clock.now);
      await h.current.work();
    }
    expect(maxGap).toBe(RETRY_MAX_MS);
    expect(h.accounts.faults.walletTxFail).toBe(1_000 - REWARD_MAX_ATTEMPTS);
    expect(h.current.pendingWork()).toBe(false);
    expect(h.current.nextWakeAt()).toBeNull();
    expect(h.accounts.balance("a")).toBe(0);
  });

  it("wakes soon while a ticket waits", async () => {
    const h = harness();
    expect(h.current.nextWakeAt()).toBeNull();
    await queue(h, "a", "wake-op-a-001", build("a"));
    expect(h.current.nextWakeAt()).toBe(h.clock.now + TICKET_RECHECK_MS);
  });

  it("adds the backoff column to storage created by the first schema", async () => {
    const h = harness();
    h.store.fake.db.exec("DROP TABLE arena_reward");
    h.store.fake.db.exec(
      `CREATE TABLE arena_reward (match_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
       coin INTEGER NOT NULL, season_xp INTEGER NOT NULL, notify_account TEXT, notice_json TEXT,
       step TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, at INTEGER NOT NULL)`,
    );
    const restarted = h.restart();
    restarted.init(); // twice: the duplicate column is ignored
    const ta = await queue(h, "a", "migr-op-a-001", build("a"));
    h.clock.advance(GHOST_AFTER_MS);
    expect((await restarted.poll({ accountId: "a", ticket: ta }))?.status).toBe("matched");
    expect(h.accounts.balance("a")).toBe(25);
  });

  it("drives a waiting ticket to a match from work() without a poll", async () => {
    const h = harness();
    const ta = await queue(h, "a", "alarm-op-a-01", build("a"));
    h.clock.advance(GHOST_AFTER_MS);
    expect(h.current.pendingWork()).toBe(true);
    await h.current.work();
    expect(h.current.status("a").ticket).toBeNull();
    const view = await h.current.poll({ accountId: "a", ticket: ta });
    expect(view?.status).toBe("matched");
  });
});

describe("determinism and wiring", () => {
  it("two ladders with the same seeds and script produce the same matches", async () => {
    const script = async (h: ReturnType<typeof harness>) => {
      h.current.register(build("b", { maxHp: 70 }));
      const out: unknown[] = [];
      for (let i = 0; i < 4; i++) {
        const ticket = await queue(h, "a", `script-op-${i}-a`, build("a", { maxHp: 60 + i * 10 }));
        h.clock.advance(GHOST_AFTER_MS);
        const v = await h.current.poll({ accountId: "a", ticket });
        out.push({ id: v?.match?.id, seed: v?.match?.seed, winner: v?.match?.winner });
        h.clock.advance(DAY);
      }
      return out;
    };
    const first = await script(harness());
    const second = await script(harness());
    expect(second).toEqual(first);
  });

  it("resolves with the real arena fight (contentHash of the loaded arena mode)", async () => {
    const h = harness({ fight: (a, b, seed) => realFight(a, b, seed) });
    const m = await shadeFight(h, "a", 1);
    expect(["attacker", "defender", "draw"]).toContain(m.winner);
    expect(m.contentHash).toBe(arenaLoaded().contentHash);
    expect(m.ticks).toBeGreaterThanOrEqual(0);
  });
});
