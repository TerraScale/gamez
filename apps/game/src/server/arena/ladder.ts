/**
 * The arena ladder logic (wave-C.md §6.3): one instance per ArenaDO
 * "<mode>:<seasonId>". Owns the ghost pool, matchmaking tickets, fights,
 * ratings, the match log and the crash-safe reward/notice steps.
 *
 * Everything that changes state runs inside one synchronous SQLite
 * transaction (the DO is single-threaded, and the fight itself is pure and
 * synchronous). Only the reward/notice steps call other DOs, and each step
 * is persisted before the next one runs, so a crash re-drives from where it
 * stopped. Every call to AccountGateway is idempotent by txId / notice id.
 *
 * Deps are injected (store, gateway, outbox, clock, seeds, fight) so tests
 * run it with fakes; the DO adapter (do/arena.ts) wires the real ones.
 */
import {
  arenaRewards,
  eloUpdate,
  FIGHTS_PER_DAY,
  MATCH_BAND,
  MATCH_BAND_MAX,
  MATCH_BAND_STEP,
  START_RATING,
} from "@gamez/economy";
import type {
  ArenaBuild,
  ArenaMatch,
  ArenaMatchSummary,
  ArenaStatus,
  ArenaTicket,
  ArenaWinner,
  NoticeInput,
  Party,
} from "@gamez/protocol";
import type { Outbox } from "@gamez/sync";
import type { AccountGateway, ArenaRatingPayload, EconResult, SqlStore } from "../contracts.ts";
import { checkBuild, SHADE_ACCOUNT_ID, SHADE_NAME, shadeOf } from "./build.ts";
import { hexId, type SeedSource } from "./seeds.ts";
import { ARENA_COLUMNS, ARENA_SCHEMA } from "./schema.ts";

/** A waiting ticket this old may be matched with a ghost (live pairs match at once). */
export const GHOST_AFTER_MS = 3_000;
/** Matches kept in the log. */
export const MATCH_HISTORY = 500;
/** Recent matches listed per account. */
export const RECENT_PER_ACCOUNT = 20;
/** Reward/notice steps retried this many times (about 2 h of backoff) before they are left for a human. */
export const REWARD_MAX_ATTEMPTS = 30;
/** First retry delay of a failed reward/notice step; doubles per attempt up to RETRY_MAX_MS. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 300_000;
/** How often waiting tickets are re-checked (ghost fallback, band widening). */
export const TICKET_RECHECK_MS = 1_000;
const DAY_MS = 86_400_000;

/** Resolves one fight. Matches `fight()` of @gamez/mode-arena (extra fields ignored). */
export type FightFn = (
  attacker: ArenaBuild,
  defender: ArenaBuild,
  seed: number,
) => { winner: ArenaWinner; ticks: number; contentHash: string };

export interface LadderOptions {
  store: SqlStore;
  accounts: AccountGateway;
  outbox: Outbox;
  clock: () => number;
  seeds: SeedSource;
  fight: FightFn;
  /** Source mode, e.g. "classic". */
  mode: string;
  /** Season id, e.g. "2026-s1". */
  seasonId: string;
}

type PlayerRow = {
  account_id: string;
  display_name: string;
  class_id: string;
  level: number;
  build_json: string | null;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  updated_at: number;
};

type TicketRow = {
  ticket_id: string;
  account_id: string;
  op_id: string;
  rating: number;
  build_json: string;
  state: string;
  reason: string | null;
  match_id: string | null;
  searches: number;
  created_at: number;
};

type RewardRow = {
  match_id: string;
  account_id: string;
  coin: number;
  season_xp: number;
  notify_account: string | null;
  notice_json: string | null;
  step: string;
  attempts: number;
};

/** The defending side of a fight: a live ticket, a ghost of a registered player, or the shade. */
interface Opponent {
  accountId: string;
  displayName: string;
  build: ArenaBuild;
  /** True when the defender is not a live player fighting now (ghost or shade). */
  ghost: boolean;
  /** The Sparring Shade: unrated, no notice, no ratings. */
  shade: boolean;
  /** The defender's own waiting ticket, when it is a live pairing. */
  ticketId: string | null;
}

const PLAYER_BY_ID = "SELECT * FROM arena_player WHERE account_id = ?";
const TICKET_BY_ID = "SELECT * FROM arena_ticket WHERE ticket_id = ?";
const TICKET_BY_OP = "SELECT * FROM arena_ticket WHERE account_id = ? AND op_id = ?";

export class ArenaLadder {
  readonly #o: LadderOptions;

  constructor(opts: LadderOptions) {
    this.#o = opts;
  }

  get seasonId(): string {
    return this.#o.seasonId;
  }

  /** Creates the tables (idempotent), and adds columns that older storage lacks. */
  init(): void {
    for (const stmt of ARENA_SCHEMA) this.#o.store.sql.exec(stmt);
    for (const stmt of ARENA_COLUMNS) {
      try {
        this.#o.store.sql.exec(stmt);
      } catch (err) {
        if (!/duplicate column/i.test(String(err))) throw err;
      }
    }
  }

  // ---- helpers --------------------------------------------------------------

  #rows<T>(query: string, ...args: (string | number | null)[]): T[] {
    return this.#o.store.sql.exec(query, ...args).toArray() as unknown as T[];
  }

  #one<T>(query: string, ...args: (string | number | null)[]): T | null {
    return this.#rows<T>(query, ...args)[0] ?? null;
  }

  #run(query: string, ...args: (string | number | null)[]): void {
    this.#o.store.sql.exec(query, ...args);
  }

  #dayOf(now: number): number {
    return Math.floor(now / DAY_MS);
  }

  #fightsOn(accountId: string, day: number): number {
    return (
      this.#one<{ fights: number }>(
        "SELECT fights FROM arena_day WHERE account_id = ? AND day = ?",
        accountId,
        day,
      )?.fights ?? 0
    );
  }

  #newTicketId(): string {
    return `${this.#o.seasonId}.${hexId(this.#o.seeds, 2)}`;
  }

  #newMatchId(): string {
    return `${this.#o.seasonId}.${hexId(this.#o.seeds, 2)}`;
  }

  #ticketView(row: TicketRow): ArenaTicket {
    const match = row.match_id ? this.match(row.match_id) : null;
    return {
      ticket: row.ticket_id,
      status: row.state as ArenaTicket["status"],
      match,
      reason: row.reason,
    };
  }

  #upsertPlayer(build: ArenaBuild, now: number): void {
    this.#run(
      `INSERT INTO arena_player (account_id, display_name, class_id, level, build_json, rating, games, wins, losses, draws, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?)
       ON CONFLICT (account_id) DO UPDATE SET
         display_name = excluded.display_name,
         class_id = excluded.class_id,
         level = excluded.level,
         build_json = excluded.build_json,
         updated_at = excluded.updated_at`,
      build.accountId,
      build.displayName,
      build.classId,
      build.level,
      JSON.stringify(build),
      START_RATING,
      now,
    );
  }

  #ratingOf(accountId: string): number {
    return this.#one<PlayerRow>(PLAYER_BY_ID, accountId)?.rating ?? START_RATING;
  }

  #ratingPayload(p: PlayerRow): ArenaRatingPayload {
    return {
      seasonId: this.#o.seasonId,
      mode: this.#o.mode,
      accountId: p.account_id,
      displayName: p.display_name,
      classId: p.class_id,
      level: p.level,
      rating: p.rating,
      wins: p.wins,
      losses: p.losses,
      draws: p.draws,
      updatedAt: p.updated_at,
    };
  }

  // ---- ghost pool and queue --------------------------------------------------

  /** Stores (or refreshes) the caller's ghost build. Returns the status. */
  register(build: ArenaBuild): ArenaStatus {
    this.#upsertPlayer(build, this.#o.clock());
    return this.status(build.accountId);
  }

  /**
   * Queues a fight. Idempotent by opId (the same ticket comes back). A second
   * opId while a ticket still waits returns that waiting ticket. Over the daily
   * limit the ticket is created already failed with reason "limit".
   */
  async enqueue(input: { opId: string; build: ArenaBuild }): Promise<EconResult<ArenaTicket>> {
    const accountId = input.build.accountId;
    const same = this.#one<TicketRow>(TICKET_BY_OP, accountId, input.opId);
    if (same) return { ok: true, value: this.#ticketView(same), replayed: true };
    const waiting = this.#one<TicketRow>(
      "SELECT * FROM arena_ticket WHERE account_id = ? AND state = 'waiting' LIMIT 1",
      accountId,
    );
    if (waiting) return { ok: true, value: this.#ticketView(waiting), replayed: true };

    const now = this.#o.clock();
    const day = this.#dayOf(now);
    const limited = this.#fightsOn(accountId, day) >= FIGHTS_PER_DAY;
    const ticketId = this.#newTicketId();
    this.#o.store.transactionSync(() => {
      this.#upsertPlayer(input.build, now);
      this.#run(
        `INSERT INTO arena_ticket (ticket_id, account_id, op_id, rating, build_json, state, reason, match_id, searches, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
        ticketId,
        accountId,
        input.opId,
        this.#ratingOf(accountId),
        JSON.stringify(input.build),
        limited ? "failed" : "waiting",
        limited ? "limit" : null,
        now,
      );
      if (!limited) {
        this.#run(
          `INSERT INTO arena_day (account_id, day, fights) VALUES (?, ?, 1)
           ON CONFLICT (account_id, day) DO UPDATE SET fights = fights + 1`,
          accountId,
          day,
        );
      }
    });
    const row = this.#one<TicketRow>(TICKET_BY_ID, ticketId)!;
    return { ok: true, value: this.#ticketView(row) };
  }

  /**
   * Resolves what is due, then returns the ticket (owned by accountId) with
   * its match when matched. Drives pending rewards on the way.
   */
  async poll(input: { accountId: string; ticket: string }): Promise<ArenaTicket | null> {
    this.#resolve();
    await this.drain();
    const row = this.#one<TicketRow>(TICKET_BY_ID, input.ticket);
    if (!row || row.account_id !== input.accountId) return null;
    return this.#ticketView(row);
  }

  /** Alarm work: resolve every due ticket, then drive pending rewards. */
  async work(): Promise<void> {
    this.#resolve();
    await this.drain();
  }

  /** True while a ticket waits or a reward/notice step is still open. */
  pendingWork(): boolean {
    const waiting = this.#one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM arena_ticket WHERE state = 'waiting'",
    );
    const open = this.#one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM arena_reward WHERE step != 'done' AND attempts < ?",
      REWARD_MAX_ATTEMPTS,
    );
    return (waiting?.n ?? 0) > 0 || (open?.n ?? 0) > 0;
  }

  /**
   * When the alarm should next run: soon while a ticket waits, else when the
   * earliest open reward/notice step is due (backoff), else null.
   */
  nextWakeAt(): number | null {
    const now = this.#o.clock();
    const waiting = this.#one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM arena_ticket WHERE state = 'waiting'",
    );
    if ((waiting?.n ?? 0) > 0) return now + TICKET_RECHECK_MS;
    const due = this.#one<{ at: number | null }>(
      "SELECT MIN(next_at) AS at FROM arena_reward WHERE step != 'done' AND attempts < ?",
      REWARD_MAX_ATTEMPTS,
    );
    return due?.at == null ? null : Math.max(now, due.at);
  }

  // ---- matchmaking ------------------------------------------------------------

  #resolve(): void {
    const now = this.#o.clock();
    const waiting = this.#rows<TicketRow>(
      "SELECT * FROM arena_ticket WHERE state = 'waiting' ORDER BY created_at ASC, ticket_id ASC",
    );
    for (const w of waiting) {
      const t = this.#one<TicketRow>(TICKET_BY_ID, w.ticket_id);
      if (!t || t.state !== "waiting") continue;

      // Two live tickets within the band fight at once; the earlier one attacks.
      const other = this.#liveOpponent(t);
      if (other) {
        const [attacker, defender] = orderTickets(t, other);
        const player = this.#one<PlayerRow>(PLAYER_BY_ID, defender.account_id);
        if (!player?.build_json) continue;
        this.#settle(attacker, {
          accountId: defender.account_id,
          displayName: player.display_name,
          build: parseBuild(defender.build_json),
          ghost: false,
          shade: false,
          ticketId: defender.ticket_id,
        });
        continue;
      }

      if (now - t.created_at < GHOST_AFTER_MS) continue;
      const pick = this.#pickGhost(t);
      if (pick === "wait") continue;
      this.#settle(t, pick);
    }
  }

  #liveOpponent(t: TicketRow): TicketRow | null {
    return this.#one<TicketRow>(
      `SELECT * FROM arena_ticket
       WHERE state = 'waiting' AND account_id != ? AND ABS(rating - ?) <= ?
       ORDER BY ABS(rating - ?) ASC, created_at ASC, ticket_id ASC LIMIT 1`,
      t.account_id,
      t.rating,
      MATCH_BAND,
      t.rating,
    );
  }

  /**
   * The defender for a ticket that waited past GHOST_AFTER_MS: a ghost within
   * the band (widening per empty search, up to MATCH_BAND_MAX, then the
   * nearest), the Sparring Shade when the pool is empty, or "wait".
   */
  #pickGhost(t: TicketRow): Opponent | "wait" {
    const pool = this.#rows<PlayerRow>(
      "SELECT * FROM arena_player WHERE build_json IS NOT NULL AND account_id != ? ORDER BY account_id ASC",
      t.account_id,
    );
    const attacker = parseBuild(t.build_json);
    if (pool.length === 0) {
      return {
        accountId: SHADE_ACCOUNT_ID,
        displayName: SHADE_NAME,
        build: shadeOf(attacker),
        ghost: true,
        shade: true,
        ticketId: null,
      };
    }
    const band = Math.min(MATCH_BAND_MAX, MATCH_BAND + MATCH_BAND_STEP * t.searches);
    let cands = pool.filter((p) => Math.abs(p.rating - t.rating) <= band);
    if (cands.length === 0) {
      if (band < MATCH_BAND_MAX) {
        this.#run(
          "UPDATE arena_ticket SET searches = searches + 1 WHERE ticket_id = ?",
          t.ticket_id,
        );
        return "wait";
      }
      const best = Math.min(...pool.map((p) => Math.abs(p.rating - t.rating)));
      cands = pool.filter((p) => Math.abs(p.rating - t.rating) === best);
    }
    const ghost = cands[this.#o.seeds() % cands.length]!;
    return {
      accountId: ghost.account_id,
      displayName: ghost.display_name,
      build: parseBuild(ghost.build_json!),
      ghost: true,
      shade: false,
      ticketId: null,
    };
  }

  // ---- fights and settlement --------------------------------------------------

  /**
   * Fights attacker vs defender and settles everything in one transaction:
   * match log, ratings (rated only), outbox rows, recent lists, tickets,
   * the reward step and the defender's notice.
   */
  #settle(a: TicketRow, d: Opponent): ArenaMatch {
    const now = this.#o.clock();
    const aBuild = parseBuild(a.build_json);
    const aPlayer = this.#one<PlayerRow>(PLAYER_BY_ID, a.account_id);
    const aRating = aPlayer?.rating ?? START_RATING;
    const aGames = aPlayer?.games ?? 0;
    const dPlayer = d.shade ? null : this.#one<PlayerRow>(PLAYER_BY_ID, d.accountId);
    const dRating = d.shade ? aRating : (dPlayer?.rating ?? START_RATING);
    const dGames = dPlayer?.games ?? 0;

    const seed = this.#o.seeds() >>> 0;
    const result = this.#o.fight(aBuild, d.build, seed);
    const outcome: "win" | "loss" | "draw" =
      result.winner === "attacker" ? "win" : result.winner === "defender" ? "loss" : "draw";
    const reward = arenaRewards(outcome);
    const rated = !d.shade;
    const score = outcome === "win" ? 1 : outcome === "loss" ? 0 : 0.5;
    const elo = rated
      ? eloUpdate({ rating: aRating, games: aGames }, { rating: dRating, games: dGames }, score)
      : { a: aRating, b: dRating };

    const matchId = this.#newMatchId();
    const match: ArenaMatch = {
      id: matchId,
      seasonId: this.#o.seasonId,
      at: now,
      attacker: {
        party: { accountId: a.account_id, displayName: aBuild.displayName },
        classId: aBuild.classId,
        level: aBuild.level,
        ratingBefore: aRating,
        ratingAfter: rated ? elo.a : aRating,
        ghost: false,
      },
      defender: {
        party: { accountId: d.accountId, displayName: d.displayName },
        classId: d.build.classId,
        level: d.build.level,
        ratingBefore: dRating,
        ratingAfter: rated ? elo.b : dRating,
        ghost: d.ghost,
      },
      winner: result.winner,
      seed,
      builds: { attacker: aBuild, defender: d.build },
      ticks: result.ticks,
      contentHash: result.contentHash,
      rewards: { coin: reward.coin, seasonXp: reward.seasonXp },
    };

    const defenderOutcome = outcome === "win" ? "loss" : outcome === "loss" ? "win" : "draw";
    const notice = d.shade || d.accountId === a.account_id ? null : defenderNotice(match, aBuild);

    this.#o.store.transactionSync(() => {
      const inserted = this.#one<{ seq: number }>(
        `INSERT INTO arena_match (match_id, attacker_id, defender_id, at, json)
         VALUES (?, ?, ?, ?, ?) RETURNING seq`,
        matchId,
        a.account_id,
        d.accountId,
        now,
        JSON.stringify(match),
      )!;

      if (rated) {
        const aAfter = this.#applyResult(a.account_id, elo.a, outcome, now);
        this.#outboxRating(aAfter);
        if (dPlayer) {
          const dAfter = this.#applyResult(d.accountId, elo.b, defenderOutcome, now);
          this.#outboxRating(dAfter);
        }
      }

      this.#addRecent(a.account_id, inserted.seq, matchId);
      if (!d.shade) this.#addRecent(d.accountId, inserted.seq, matchId);
      this.#run(
        "UPDATE arena_ticket SET state = 'matched', match_id = ? WHERE ticket_id = ?",
        matchId,
        a.ticket_id,
      );
      if (d.ticketId) {
        this.#refundDefenderFight(d.ticketId);
        this.#run(
          "UPDATE arena_ticket SET state = 'matched', match_id = ? WHERE ticket_id = ?",
          matchId,
          d.ticketId,
        );
      }
      this.#run(
        `INSERT INTO arena_reward (match_id, account_id, coin, season_xp, notify_account, notice_json, step, attempts, at)
         VALUES (?, ?, ?, ?, ?, ?, 'coin', 0, ?)`,
        matchId,
        a.account_id,
        reward.coin,
        reward.seasonXp,
        notice ? d.accountId : null,
        notice ? JSON.stringify(notice) : null,
        now,
      );
      this.#prune(inserted.seq);
    });
    return match;
  }

  /**
   * A live defender's own ticket was spent on being attacked, not on a fight of
   * its own, so its daily fight is given back (DECISION in the commit: refund
   * instead of a defender reward, so the arena adds no new coin faucet).
   * A ticket that failed on the daily limit never counted a fight.
   */
  #refundDefenderFight(ticketId: string): void {
    const t = this.#one<TicketRow>(TICKET_BY_ID, ticketId);
    if (!t || t.reason !== null) return;
    this.#run(
      "UPDATE arena_day SET fights = fights - 1 WHERE account_id = ? AND day = ? AND fights > 0",
      t.account_id,
      this.#dayOf(t.created_at),
    );
  }

  /** Writes a fighter's new rating and counters (rated fights only). */
  #applyResult(
    accountId: string,
    rating: number,
    outcome: "win" | "loss" | "draw",
    now: number,
  ): PlayerRow {
    this.#run(
      `UPDATE arena_player SET rating = ?, games = games + 1,
         wins = wins + ?, losses = losses + ?, draws = draws + ?, updated_at = ?
       WHERE account_id = ?`,
      rating,
      outcome === "win" ? 1 : 0,
      outcome === "loss" ? 1 : 0,
      outcome === "draw" ? 1 : 0,
      now,
      accountId,
    );
    return this.#one<PlayerRow>(PLAYER_BY_ID, accountId)!;
  }

  #outboxRating(p: PlayerRow): void {
    this.#o.outbox.append(
      "arena_rating",
      `${this.#o.seasonId}/${p.account_id}`,
      "upsert",
      this.#ratingPayload(p),
    );
  }

  #addRecent(accountId: string, seq: number, matchId: string): void {
    if (accountId === SHADE_ACCOUNT_ID) return;
    this.#run(
      "INSERT OR REPLACE INTO arena_recent (account_id, seq, match_id) VALUES (?, ?, ?)",
      accountId,
      seq,
      matchId,
    );
    this.#run(
      `DELETE FROM arena_recent WHERE account_id = ? AND match_id NOT IN (
         SELECT match_id FROM arena_recent WHERE account_id = ? ORDER BY seq DESC LIMIT ?)`,
      accountId,
      accountId,
      RECENT_PER_ACCOUNT,
    );
  }

  #prune(latestSeq: number): void {
    const cutoff = latestSeq - MATCH_HISTORY;
    if (cutoff > 0) this.#run("DELETE FROM arena_match WHERE seq <= ?", cutoff);
  }

  // ---- rewards and notices (crash-safe, idempotent) ---------------------------

  /**
   * Drives every open reward step: coin (walletTx, txId arena:<match>:coin),
   * season xp (addSeasonXp, arena:<match>:xp), then the defender's notice.
   * A failing step keeps its row open and counts an attempt.
   */
  async drain(): Promise<void> {
    const now = this.#o.clock();
    const open = this.#rows<{ match_id: string }>(
      `SELECT match_id FROM arena_reward WHERE step != 'done' AND attempts < ? AND next_at <= ?
       ORDER BY at ASC, match_id ASC LIMIT 50`,
      REWARD_MAX_ATTEMPTS,
      now,
    );
    for (const { match_id: matchId } of open) {
      for (;;) {
        const r = this.#one<RewardRow>(
          `SELECT match_id, account_id, coin, season_xp, notify_account, notice_json, step, attempts
           FROM arena_reward WHERE match_id = ?`,
          matchId,
        );
        if (!r || r.step === "done" || r.attempts >= REWARD_MAX_ATTEMPTS) break;
        try {
          await this.#advance(r);
        } catch (err) {
          const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(r.attempts, 20));
          this.#run(
            `UPDATE arena_reward SET attempts = attempts + 1, last_error = ?, next_at = ?
             WHERE match_id = ?`,
            String(err instanceof Error ? err.message : err).slice(0, 200),
            this.#o.clock() + delay,
            matchId,
          );
          break;
        }
      }
    }
  }

  async #advance(r: RewardRow): Promise<void> {
    const { accounts } = this.#o;
    if (r.step === "coin") {
      const res = await accounts.walletTx(r.account_id, {
        txId: `arena:${r.match_id}:coin`,
        currency: "coin",
        amount: r.coin,
        reason: `arena.reward:${r.match_id}`,
        flow: "faucet",
      });
      if (!res.ok) throw new Error(`coin reward: ${res.code}`);
      this.#setStep(r.match_id, "xp");
      return;
    }
    if (r.step === "xp") {
      await accounts.addSeasonXp(
        r.account_id,
        `arena:${r.match_id}:xp`,
        r.season_xp,
        `arena.reward:${r.match_id}`,
      );
      this.#setStep(r.match_id, "notice");
      return;
    }
    if (r.step === "notice") {
      if (r.notify_account && r.notice_json) {
        await accounts.notify(r.notify_account, JSON.parse(r.notice_json) as NoticeInput);
      }
      this.#setStep(r.match_id, "done");
    }
  }

  #setStep(matchId: string, step: string): void {
    this.#run(
      "UPDATE arena_reward SET step = ?, last_error = NULL, next_at = 0 WHERE match_id = ?",
      step,
      matchId,
    );
  }

  // ---- reads ------------------------------------------------------------------

  /** The caller's rating, counters, ghost flag, fights left today and recent matches. */
  status(accountId: string): ArenaStatus {
    const now = this.#o.clock();
    const player = this.#one<PlayerRow>(PLAYER_BY_ID, accountId);
    const fights = this.#fightsOn(accountId, this.#dayOf(now));
    const ticket = this.#one<{ ticket_id: string }>(
      "SELECT ticket_id FROM arena_ticket WHERE account_id = ? AND state = 'waiting' LIMIT 1",
      accountId,
    );
    const recent = this.#rows<{ json: string }>(
      `SELECT m.json AS json FROM arena_recent r
       JOIN arena_match m ON m.match_id = r.match_id
       WHERE r.account_id = ? ORDER BY r.seq DESC LIMIT ?`,
      accountId,
      RECENT_PER_ACCOUNT,
    ).map((r) => summaryOf(JSON.parse(r.json) as ArenaMatch, accountId));
    return {
      seasonId: this.#o.seasonId,
      rating: player?.rating ?? START_RATING,
      wins: player?.wins ?? 0,
      losses: player?.losses ?? 0,
      draws: player?.draws ?? 0,
      registered: !!player?.build_json,
      fightsLeftToday: Math.max(0, FIGHTS_PER_DAY - fights),
      ticket: ticket?.ticket_id ?? null,
      recent,
    };
  }

  /** A stored match, or null. */
  match(id: string): ArenaMatch | null {
    const row = this.#one<{ json: string }>("SELECT json FROM arena_match WHERE match_id = ?", id);
    return row ? (JSON.parse(row.json) as ArenaMatch) : null;
  }

  /** Dev override: the build used instead of exportBuild for this account. */
  devSetBuild(build: ArenaBuild): void {
    this.#run(
      `INSERT INTO arena_dev_build (account_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      build.accountId,
      JSON.stringify(build),
      this.#o.clock(),
    );
  }

  devBuild(accountId: string): ArenaBuild | null {
    const row = this.#one<{ json: string }>(
      "SELECT json FROM arena_dev_build WHERE account_id = ?",
      accountId,
    );
    return row ? checkBuild(JSON.parse(row.json), { accountId, displayName: "" }) : null;
  }
}

/** The earlier ticket attacks (created_at, then ticket id). */
function orderTickets(x: TicketRow, y: TicketRow): [TicketRow, TicketRow] {
  const xFirst =
    x.created_at < y.created_at || (x.created_at === y.created_at && x.ticket_id < y.ticket_id);
  return xFirst ? [x, y] : [y, x];
}

function parseBuild(json: string): ArenaBuild {
  return JSON.parse(json) as ArenaBuild;
}

function summaryOf(match: ArenaMatch, accountId: string): ArenaMatchSummary {
  const attacking = match.attacker.party.accountId === accountId;
  const me = attacking ? match.attacker : match.defender;
  const opponent: Party = attacking ? match.defender.party : match.attacker.party;
  const result =
    match.winner === "draw"
      ? "draw"
      : match.winner === (attacking ? "attacker" : "defender")
        ? "win"
        : "loss";
  return {
    id: match.id,
    at: match.at,
    opponent,
    result,
    ratingDelta: me.ratingAfter - me.ratingBefore,
    defended: !attacking,
  };
}

/** The notice the ghost owner gets when their ghost was fought. */
function defenderNotice(match: ArenaMatch, aBuild: ArenaBuild): NoticeInput {
  const verdict =
    match.winner === "defender"
      ? match.defender.ghost
        ? "you held"
        : "you won"
      : match.winner === "attacker"
        ? "you lost"
        : "a draw";
  const name = aBuild.displayName.slice(0, 24);
  const target = match.defender.ghost ? "your ghost" : "you";
  const text = `${name} fought ${target}: ${verdict}`.slice(0, 140);
  return {
    id: `arena:${match.id}:defended`,
    kind: "arena.defended",
    text,
    data: {
      matchId: match.id,
      rating: match.defender.ratingAfter,
      delta: match.defender.ratingAfter - match.defender.ratingBefore,
    },
  };
}
