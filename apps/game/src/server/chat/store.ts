/**
 * SQLite tables of one ChatChannelDO (wave-B.md §5): messages, moderation
 * strikes and mutes, the local block lists, and the report dedupe marks.
 * Logic only; the DO and the tests hand it a SqlStore (contracts.ts).
 *
 * Every write is synchronous and runs inside `transact()` when it must be
 * atomic with an outbox append.
 *
 * `chat_block` is a cache of the AccountDO block lists of the accounts that
 * have a socket open here (R9): ChatHost drops an account's rows when its last
 * socket closes, and open() restores them from AccountDO. So the table is
 * bounded by open sockets x BLOCK_LIMIT, never by every account that ever joined.
 *
 * R9b: `chat_seen_report` keeps at most REPORTERS_PER_MESSAGE rows per kept
 * message (ChatHost stops recording reporters after that), and prune() drops the
 * rows of pruned messages, expired strikes and expired mutes in the same
 * transaction as the messages. So every table here is bounded by kept messages
 * or by recent activity, never by every account that ever joined.
 */
import type { ChatMessage } from "@gamez/protocol";
import type { SqlStore } from "../contracts.ts";
import { BLOCK_LIMIT } from "../account/social.ts";

export type ModerationStatus = "safe" | "unsafe" | "unknown";

export interface StoredMessage extends ChatMessage {
  hidden: boolean;
  verdict: ModerationStatus;
}

type Row = Record<string, string | number | null>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

export class ChatStore {
  constructor(
    readonly store: SqlStore,
    /** The channel this DO serves (stamped on every message it returns). */
    readonly channel: string,
  ) {}

  private get sql() {
    return this.store.sql;
  }

  init(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chat_message (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      from_id TEXT NOT NULL,
      name TEXT NOT NULL,
      tag TEXT,
      text TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      at INTEGER NOT NULL,
      system INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      verdict TEXT NOT NULL DEFAULT 'unknown'
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS chat_message_from ON chat_message (from_id, at)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chat_strike (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS chat_strike_account ON chat_strike (account_id, at)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chat_mute (
      account_id TEXT PRIMARY KEY,
      until INTEGER NOT NULL,
      reason TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chat_block (
      blocker TEXT NOT NULL,
      target TEXT NOT NULL,
      PRIMARY KEY (blocker, target)
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS chat_block_target ON chat_block (target)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chat_seen_report (
      message_id TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (message_id, reporter_id)
    )`);
  }

  /** Runs `fn` atomically (storage transaction). */
  transact<T>(fn: () => T): T {
    return this.store.transactionSync(fn);
  }

  /** The id of the newest stored message, for seeding id generation after a restart. */
  lastMessageId(): string | null {
    const rows = this.sql
      .exec<Row>("SELECT id FROM chat_message ORDER BY seq DESC LIMIT 1")
      .toArray();
    return rows[0] ? str(rows[0].id) : null;
  }

  insert(msg: ChatMessage, dedupeKey: string): void {
    this.sql.exec(
      "INSERT INTO chat_message (id, from_id, name, tag, text, dedupe_key, at, system) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      msg.id,
      msg.from,
      msg.name,
      msg.tag ?? null,
      msg.text,
      dedupeKey,
      msg.at,
      msg.system ? 1 : 0,
    );
  }

  /** The newest `limit` visible (not hidden) messages, oldest first. */
  recentVisible(limit: number): ChatMessage[] {
    const rows = this.sql
      .exec<Row>(
        "SELECT * FROM (SELECT * FROM chat_message WHERE hidden = 0 ORDER BY seq DESC LIMIT ?) ORDER BY seq",
        limit,
      )
      .toArray();
    return rows.map((r) => this.#message(r));
  }

  getMessage(id: string): StoredMessage | null {
    const rows = this.sql.exec<Row>("SELECT * FROM chat_message WHERE id = ?", id).toArray();
    const row = rows[0];
    if (!row) return null;
    return {
      ...this.#message(row),
      hidden: num(row.hidden) === 1,
      verdict: (str(row.verdict) || "unknown") as ModerationStatus,
    };
  }

  hide(ids: readonly string[]): void {
    for (const id of ids) this.sql.exec("UPDATE chat_message SET hidden = 1 WHERE id = ?", id);
  }

  setVerdict(id: string, verdict: ModerationStatus): void {
    this.sql.exec("UPDATE chat_message SET verdict = ? WHERE id = ?", verdict, id);
  }

  /**
   * Keeps the newest `keep` messages (system notices included) and drops what
   * hangs off pruned or expired state (R9b): report marks of messages that are
   * gone, strikes older than `strikesBefore` (they no longer count toward a
   * mute) and mutes that ended at or before `now`. Run it inside the caller's
   * transaction.
   */
  prune(keep: number, opts: { now: number; strikesBefore: number }): void {
    this.sql.exec(
      "DELETE FROM chat_message WHERE seq <= (SELECT MAX(seq) FROM chat_message) - ?",
      keep,
    );
    this.sql.exec(
      "DELETE FROM chat_seen_report WHERE message_id NOT IN (SELECT id FROM chat_message)",
    );
    this.sql.exec("DELETE FROM chat_strike WHERE at < ?", opts.strikesBefore);
    this.sql.exec("DELETE FROM chat_mute WHERE until <= ?", opts.now);
  }

  /** Dedupe keys (lowercased raw text) of the account's player messages since `since`. */
  recentKeys(accountId: string, since: number): string[] {
    return this.sql
      .exec<Row>(
        "SELECT dedupe_key FROM chat_message WHERE from_id = ? AND at >= ? AND system = 0 ORDER BY seq DESC LIMIT 20",
        accountId,
        since,
      )
      .toArray()
      .map((r) => str(r.dedupe_key));
  }

  addStrike(accountId: string, at: number): void {
    this.sql.exec("INSERT INTO chat_strike (account_id, at) VALUES (?, ?)", accountId, at);
  }

  strikesSince(accountId: string, since: number): number {
    const rows = this.sql
      .exec<Row>(
        "SELECT COUNT(*) AS n FROM chat_strike WHERE account_id = ? AND at >= ?",
        accountId,
        since,
      )
      .toArray();
    return rows[0] ? num(rows[0].n) : 0;
  }

  muteOf(accountId: string): { until: number; reason: string } | null {
    const rows = this.sql
      .exec<Row>("SELECT until, reason FROM chat_mute WHERE account_id = ?", accountId)
      .toArray();
    const row = rows[0];
    return row ? { until: num(row.until), reason: str(row.reason) } : null;
  }

  setMute(accountId: string, until: number, reason: string): void {
    this.sql.exec(
      `INSERT INTO chat_mute (account_id, until, reason) VALUES (?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET until = excluded.until, reason = excluded.reason`,
      accountId,
      until,
      reason,
    );
  }

  /** Account ids this blocker has blocked (local copy, sorted). */
  blockList(blocker: string): string[] {
    return this.sql
      .exec<Row>("SELECT target FROM chat_block WHERE blocker = ? ORDER BY target", blocker)
      .toArray()
      .map((r) => str(r.target));
  }

  /** Account ids that blocked `target`. */
  blockersOf(target: string): Set<string> {
    return new Set(
      this.sql
        .exec<Row>("SELECT blocker FROM chat_block WHERE target = ?", target)
        .toArray()
        .map((r) => str(r.blocker)),
    );
  }

  /** Blocked accounts a blocker has in this channel's storage. */
  blockCount(blocker: string): number {
    return Number(
      this.sql
        .exec<Row>("SELECT COUNT(*) AS n FROM chat_block WHERE blocker = ?", blocker)
        .toArray()[0]?.n ?? 0,
    );
  }

  /**
   * Writes one block change. Blocking a new target is refused with "block_limit"
   * when the blocker already has BLOCK_LIMIT rows (R9): nothing is written.
   * Re-blocking a listed target and unblocking always succeed. Returns "ok" or
   * "block_limit".
   */
  setBlockRow(blocker: string, target: string, blocked: boolean): "ok" | "block_limit" {
    if (!blocked) {
      this.sql.exec("DELETE FROM chat_block WHERE blocker = ? AND target = ?", blocker, target);
      return "ok";
    }
    const listed =
      this.sql
        .exec<Row>(
          "SELECT 1 AS one FROM chat_block WHERE blocker = ? AND target = ?",
          blocker,
          target,
        )
        .toArray().length > 0;
    if (!listed && this.blockCount(blocker) >= BLOCK_LIMIT) return "block_limit";
    this.sql.exec(
      "INSERT OR IGNORE INTO chat_block (blocker, target) VALUES (?, ?)",
      blocker,
      target,
    );
    return "ok";
  }

  /**
   * Adds targets from the account service's list (never removes local entries).
   * Stops at BLOCK_LIMIT rows for the blocker, so the union of both lists stays bounded.
   */
  mergeBlocks(blocker: string, targets: readonly string[]): void {
    for (const t of targets.slice(0, BLOCK_LIMIT)) {
      if (typeof t !== "string" || t.length === 0 || t.length > 100) continue;
      if (this.blockCount(blocker) >= BLOCK_LIMIT) break;
      this.sql.exec("INSERT OR IGNORE INTO chat_block (blocker, target) VALUES (?, ?)", blocker, t);
    }
  }

  /** Drops every local block row of `blocker` (R9: the row set is a cache of AccountDO). */
  dropBlocks(blocker: string): void {
    this.sql.exec("DELETE FROM chat_block WHERE blocker = ?", blocker);
  }

  /**
   * Drops the block rows of every blocker not in `keep` (R9: accounts with no
   * open socket). Returns how many blockers were dropped.
   */
  dropBlocksExcept(keep: ReadonlySet<string>): number {
    const gone = this.sql
      .exec<Row>("SELECT DISTINCT blocker FROM chat_block ORDER BY blocker")
      .toArray()
      .map((r) => str(r.blocker))
      .filter((b) => !keep.has(b));
    for (const b of gone) this.dropBlocks(b);
    return gone.length;
  }

  /** Block rows in this channel's storage, all blockers together. */
  blockRowCount(): number {
    return num(this.sql.exec<Row>("SELECT COUNT(*) AS n FROM chat_block").toArray()[0]?.n ?? 0);
  }

  seenReport(messageId: string, reporterId: string): boolean {
    return (
      this.sql
        .exec<Row>(
          "SELECT 1 AS one FROM chat_seen_report WHERE message_id = ? AND reporter_id = ?",
          messageId,
          reporterId,
        )
        .toArray().length > 0
    );
  }

  /** Reporters recorded for one message (at most REPORTERS_PER_MESSAGE, R9b). */
  reportCount(messageId: string): number {
    return num(
      this.sql
        .exec<Row>("SELECT COUNT(*) AS n FROM chat_seen_report WHERE message_id = ?", messageId)
        .toArray()[0]?.n ?? 0,
    );
  }

  /** Rows per table, for tests and diagnostics (R9b storage bounds). */
  rowCounts(): { messages: number; reports: number; strikes: number; mutes: number } {
    const count = (table: string) =>
      num(this.sql.exec<Row>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]?.n ?? 0);
    return {
      messages: count("chat_message"),
      reports: count("chat_seen_report"),
      strikes: count("chat_strike"),
      mutes: count("chat_mute"),
    };
  }

  markReport(messageId: string, reporterId: string, at: number): void {
    this.sql.exec(
      "INSERT INTO chat_seen_report (message_id, reporter_id, at) VALUES (?, ?, ?)",
      messageId,
      reporterId,
      at,
    );
  }

  #message(r: Row): ChatMessage {
    const tag = r.tag === null || r.tag === undefined ? undefined : str(r.tag);
    return {
      id: str(r.id),
      channel: this.channel,
      from: str(r.from_id),
      name: str(r.name),
      ...(tag !== undefined ? { tag } : {}),
      text: str(r.text),
      at: num(r.at),
      ...(num(r.system) === 1 ? { system: true } : {}),
    };
  }
}
