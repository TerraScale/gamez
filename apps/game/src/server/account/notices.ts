/**
 * AccountDO notices inbox + open-trade index (wave-C.md §3.2). OWNER: T-escrow.
 *
 * notify() is idempotent by notice.id (a second push with the same id is
 * ignored) and keeps the newest NOTICES_MAX. Notices are ordered by insertion
 * (a seq column). notices(sinceId) returns those newer than sinceId (all when
 * null or when sinceId is unknown/pruned), oldest first, plus the unread count.
 * markRead(upTo) marks every notice up to and including upTo as read.
 *
 * linkTrade(id, true) indexes a trade as open (never reopens a closed one);
 * linkTrade(id, false) closes it. openTrades() lists open ones, oldest first.
 */
import { NOTICES_MAX, type Notice, type NoticeInput, type NoticesResponse } from "@gamez/protocol";
import type { SqlStore } from "../contracts.ts";
import { EconomyError } from "./economy.ts";

const MAX_NOTICE_ID = 160;
const MAX_KIND = 32;
const MAX_TEXT = 140;
const MAX_DATA_KEYS = 16;
const MAX_DATA_KEY = 32;
const MAX_DATA_STRING = 200;
const MAX_TRADE_ID = 64;
/** Closed trade index rows kept (history is not served; this only bounds the table). */
const CLOSED_TRADES_KEPT = 50;

type NoticeRow = {
  seq: number;
  id: string;
  at: number;
  kind: string;
  text: string;
  data: string;
  read: number;
};

type Primitive = string | number | boolean | null;

function cleanData(data: unknown): Record<string, Primitive> {
  const out: Record<string, Primitive> = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  const keys = Object.keys(data)
    .filter((k) => k.length > 0 && k.length <= MAX_DATA_KEY)
    .sort()
    .slice(0, MAX_DATA_KEYS);
  for (const k of keys) {
    const v = (data as Record<string, unknown>)[k];
    if (v === null || typeof v === "boolean") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, MAX_DATA_STRING);
  }
  return out;
}

function toNotice(r: NoticeRow): Notice {
  let data: Record<string, Primitive> = {};
  try {
    data = cleanData(JSON.parse(r.data));
  } catch {
    data = {};
  }
  return {
    id: r.id,
    at: r.at,
    kind: r.kind as Notice["kind"],
    text: r.text,
    data,
    read: r.read !== 0,
  };
}

export class AccountNotices {
  constructor(
    readonly store: SqlStore,
    readonly now: () => number = Date.now,
  ) {}

  init(): void {
    const sql = this.store.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS notices (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      data TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS trade_index (
      trade_id TEXT PRIMARY KEY,
      open INTEGER NOT NULL,
      at INTEGER NOT NULL
    )`);
  }

  notify(notice: NoticeInput): void {
    if (
      !notice ||
      typeof notice.id !== "string" ||
      notice.id.length === 0 ||
      notice.id.length > MAX_NOTICE_ID
    )
      throw new EconomyError("bad_notice", "notice id: 1..160 chars");
    if (
      typeof notice.kind !== "string" ||
      notice.kind.length === 0 ||
      notice.kind.length > MAX_KIND
    )
      throw new EconomyError("bad_notice", "notice kind required");
    const text = typeof notice.text === "string" ? notice.text.slice(0, MAX_TEXT) : "";
    const at =
      typeof notice.at === "number" && Number.isSafeInteger(notice.at) ? notice.at : this.now();
    this.store.transactionSync(() => {
      const sql = this.store.sql;
      const inserted = sql
        .exec<{ seq: number }>(
          `INSERT INTO notices (id, at, kind, text, data, read) VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT (id) DO NOTHING RETURNING seq`,
          notice.id,
          at,
          notice.kind,
          text,
          JSON.stringify(cleanData(notice.data)),
        )
        .toArray();
      if (inserted.length === 0) return;
      sql.exec(
        `DELETE FROM notices WHERE seq NOT IN (SELECT seq FROM notices ORDER BY seq DESC LIMIT ?)`,
        NOTICES_MAX,
      );
    });
  }

  notices(sinceId: string | null): NoticesResponse {
    const sql = this.store.sql;
    const since = sinceId === null ? null : this.#seqOf(sinceId);
    const rows =
      since === null
        ? sql.exec<NoticeRow>("SELECT * FROM notices ORDER BY seq").toArray()
        : sql.exec<NoticeRow>("SELECT * FROM notices WHERE seq > ? ORDER BY seq", since).toArray();
    const unread = sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM notices WHERE read = 0")
      .one().n;
    return { notices: rows.map(toNotice), unread };
  }

  markRead(upToId: string): number {
    if (typeof upToId !== "string") return 0;
    return this.store.transactionSync(() => {
      const upTo = this.#seqOf(upToId);
      if (upTo === null) return 0;
      const n = this.store.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM notices WHERE seq <= ? AND read = 0", upTo)
        .one().n;
      if (n > 0)
        this.store.sql.exec("UPDATE notices SET read = 1 WHERE seq <= ? AND read = 0", upTo);
      return n;
    });
  }

  linkTrade(tradeId: string, open: boolean): void {
    if (typeof tradeId !== "string" || tradeId.length === 0 || tradeId.length > MAX_TRADE_ID)
      throw new EconomyError("bad_trade", "trade id required");
    const sql = this.store.sql;
    this.store.transactionSync(() => {
      if (open) {
        sql.exec(
          "INSERT INTO trade_index (trade_id, open, at) VALUES (?, 1, ?) ON CONFLICT (trade_id) DO NOTHING",
          tradeId,
          this.now(),
        );
        return;
      }
      sql.exec(
        `INSERT INTO trade_index (trade_id, open, at) VALUES (?, 0, ?)
         ON CONFLICT (trade_id) DO UPDATE SET open = 0, at = excluded.at`,
        tradeId,
        this.now(),
      );
      sql.exec(
        `DELETE FROM trade_index WHERE open = 0 AND trade_id NOT IN
           (SELECT trade_id FROM trade_index WHERE open = 0 ORDER BY at DESC, trade_id LIMIT ?)`,
        CLOSED_TRADES_KEPT,
      );
    });
  }

  openTrades(): string[] {
    return this.store.sql
      .exec<{ trade_id: string }>(
        "SELECT trade_id FROM trade_index WHERE open = 1 ORDER BY at, trade_id",
      )
      .toArray()
      .map((r) => r.trade_id);
  }

  #seqOf(id: string): number | null {
    return (
      this.store.sql.exec<{ seq: number }>("SELECT seq FROM notices WHERE id = ?", id).toArray()[0]
        ?.seq ?? null
    );
  }
}
