/**
 * SQLite tables of one ChatChannelDO (wave-B.md §5): messages, moderation
 * strikes and mutes, the local block lists, and the report dedupe marks.
 * Logic only; the DO and the tests hand it a SqlStore (contracts.ts).
 *
 * Every write is synchronous and runs inside `transact()` when it must be
 * atomic with an outbox append.
 */
import type { ChatMessage } from "@gamez/protocol";
import type { SqlStore } from "../contracts.ts";

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

  /** Keeps the newest `keep` messages (system notices included). */
  prune(keep: number): void {
    this.sql.exec(
      "DELETE FROM chat_message WHERE seq <= (SELECT MAX(seq) FROM chat_message) - ?",
      keep,
    );
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

  setBlockRow(blocker: string, target: string, blocked: boolean): void {
    if (blocked) {
      this.sql.exec(
        "INSERT OR IGNORE INTO chat_block (blocker, target) VALUES (?, ?)",
        blocker,
        target,
      );
    } else {
      this.sql.exec("DELETE FROM chat_block WHERE blocker = ? AND target = ?", blocker, target);
    }
  }

  /** Adds targets from the account service's list (never removes local entries). */
  mergeBlocks(blocker: string, targets: readonly string[]): void {
    for (const t of targets.slice(0, 200)) {
      if (typeof t === "string" && t.length > 0 && t.length <= 100) {
        this.sql.exec(
          "INSERT OR IGNORE INTO chat_block (blocker, target) VALUES (?, ?)",
          blocker,
          t,
        );
      }
    }
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
