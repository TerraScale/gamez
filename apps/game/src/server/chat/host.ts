/**
 * ChatChannelDO's logic without Workers APIs (wave-B.md §5): handles client
 * messages, rate limits, mutes, blocks, reports and moderation. The DO adapts
 * its WebSockets, SQLite, outbox and waitUntil to the deps below, so tests
 * drive this class with in-memory fakes.
 *
 * Synchronous except open() (block-list refresh) and the work handed to
 * deps.waitUntil (moderation, AccountDO block persistence). Nothing throws out
 * of a handler: failures are logged and answered with an "internal" error.
 */
import {
  CHAT_HISTORY,
  CHAT_MAX_LEN,
  type AccountKind,
  type ChatMessage,
  type ChatServerMessage,
  type ChatClientMessage,
  type ChatErrorCode,
  type ReportReason,
} from "@gamez/protocol";
import type { ChatReportPayload } from "../contracts.ts";
import { TokenBucket, type BucketSpec } from "../rate-limit.ts";
import { filterChat } from "./filter.ts";
import { encodeChatServerMessage, parseChatClientMessage } from "./messages.ts";
import type { Moderator, Verdict } from "./moderation.ts";
import { ChatStore, type ModerationStatus } from "./store.ts";

/** Per account per channel: registered burst 5, one per 2 s; guests burst 3, one per 5 s. */
export const CHAT_RATE: Readonly<Record<AccountKind, BucketSpec>> = {
  registered: { burst: 5, perSecond: 0.5 },
  guest: { burst: 3, perSecond: 0.2 },
};
/** The same text from the same account within this window is a duplicate. */
export const DUPLICATE_WINDOW_MS = 30_000;
/** Messages kept per channel (older ones are pruned). */
export const RETAIN_MESSAGES = 200;
/** Unsafe messages within this window count toward an auto-mute. */
export const STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const STRIKES_TO_MUTE = 3;
export const AUTO_MUTE_MS = 15 * 60 * 1000;
/** Pings per socket: burst 3, one per second; excess ones are dropped silently. */
const PING_RATE: BucketSpec = { burst: 3, perSecond: 1 };
const MAX_HIDE_IDS = 50;

/** Report author recorded for automatic (moderator) reports. */
export const MODERATION_REPORTER = "system:moderation";
/** Sender id of system notices. */
export const SYSTEM_SENDER = "system";

/** Per-socket data the DO keeps in the WebSocket attachment (static for the connection). */
export interface ChatSocketInfo {
  accountId: string;
  name: string;
  kind: AccountKind;
  /** Guild tag of the account when it joined. */
  tag: string | null;
}

export interface ChatSocket {
  readonly info: ChatSocketInfo;
  send(frame: string): void;
  close(code: number, reason: string): void;
}

export interface ChatOutbox {
  /** Appends one upsert in the caller's storage transaction. */
  append(table: string, pk: string, payload: unknown): void;
  /** Ensures an outbox flush is scheduled (fire and forget). */
  scheduleFlush(): void;
}

export interface ChatHostDeps {
  channel: string;
  store: ChatStore;
  /** Open sockets of this channel. */
  sockets(): ChatSocket[];
  now(): number;
  moderator: Moderator;
  outbox: ChatOutbox;
  /** The account's block list in AccountDO (may throw). */
  remoteBlocks(accountId: string): Promise<string[]>;
  /** Persists a block change in AccountDO (may throw; the local block still applies). */
  remoteSetBlocked(accountId: string, target: string, blocked: boolean): Promise<unknown>;
  /** Keeps background work alive past the handler (the DO's ctx.waitUntil). */
  waitUntil(promise: Promise<unknown>): void;
  log?: (message: string, err?: unknown) => void;
}

/** A join never waits longer than this for the AccountDO block list (the welcome goes out without it). */
export const BLOCK_REFRESH_MS = 2000;

/** Rejects when `work` takes longer than `ms` (the timer is always cleared). */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_LOG = (message: string, err?: unknown): void => console.warn(message, err);

/** Collapses control characters and runs of whitespace; trims. */
export function cleanChatText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

export class ChatHost {
  readonly #d: ChatHostDeps;
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #pings = new WeakMap<ChatSocket, TokenBucket>();
  readonly #log: (message: string, err?: unknown) => void;
  #lastAt = -1;
  #lastN = -1;

  constructor(deps: ChatHostDeps) {
    this.#d = deps;
    this.#log = deps.log ?? DEFAULT_LOG;
    const last = deps.store.lastMessageId();
    const m = last ? /^([0-9a-z]+)-(\d+)$/.exec(last) : null;
    if (m) {
      this.#lastAt = Number.parseInt(m[1]!, 36);
      this.#lastN = Number(m[2]);
    }
  }

  /**
   * A socket joined: refreshes its block list from AccountDO, then sends the
   * welcome (history without blocked senders, mute, blocks).
   */
  async open(socket: ChatSocket): Promise<void> {
    const { accountId, name } = socket.info;
    try {
      this.#d.store.mergeBlocks(
        accountId,
        await withTimeout(this.#d.remoteBlocks(accountId), BLOCK_REFRESH_MS),
      );
    } catch (err) {
      this.#log(`chat ${this.#d.channel}: block list refresh failed`, err);
    }
    const now = this.#d.now();
    const blocked = this.#d.store.blockList(accountId);
    const blockedSet = new Set(blocked);
    const history = this.#d.store
      .recentVisible(CHAT_HISTORY)
      .filter((m) => !blockedSet.has(m.from));
    const mute = this.#d.store.muteOf(accountId);
    this.#send(socket, {
      t: "welcome",
      channel: this.#d.channel,
      self: { accountId, displayName: name },
      history,
      mutedUntil: mute && mute.until > now ? mute.until : null,
      blocked,
    });
  }

  /** Handles one client frame. Never throws. */
  handleMessage(socket: ChatSocket, raw: string | ArrayBuffer): void {
    const msg = parseChatClientMessage(raw);
    if (!msg) {
      this.#reject(socket, "bad_message", "invalid message");
      return;
    }
    try {
      this.#dispatch(socket, msg);
    } catch (err) {
      this.#log(`chat ${this.#d.channel}: ${msg.t} failed`, err);
      this.#reject(socket, "internal", `${msg.t} failed`);
    }
  }

  /** Admin: mutes an account in this channel until `untilMs` (epoch ms). */
  mute(accountId: string, untilMs: number, reason: string): void {
    this.#d.store.setMute(accountId, untilMs, reason);
    this.#sendToAccount(accountId, { t: "muted", until: untilMs, reason });
  }

  /** Admin: hides messages everywhere in this channel. */
  hide(messageIds: readonly string[], reason: string): void {
    const ids = messageIds
      .filter((id) => typeof id === "string" && id.length > 0)
      .slice(0, MAX_HIDE_IDS);
    this.#d.store.transact(() => this.#d.store.hide(ids));
    this.#broadcast({ t: "hidden", ids });
    this.#log(`chat ${this.#d.channel}: hid ${ids.length} message(s): ${reason}`);
  }

  /** System notice to everyone in the channel (not moderated). */
  notice(text: string): void {
    const now = this.#d.now();
    const body = cleanChatText(text).slice(0, CHAT_MAX_LEN);
    if (body.length === 0) return;
    const msg: ChatMessage = {
      id: this.#newId(now),
      channel: this.#d.channel,
      from: SYSTEM_SENDER,
      name: "Notice",
      text: body,
      at: now,
      system: true,
    };
    this.#d.store.transact(() => {
      this.#d.store.insert(msg, "");
      this.#d.store.prune(RETAIN_MESSAGES);
    });
    this.#broadcast({ t: "message", msg });
  }

  /** The newest visible messages, oldest first (admin and tests). */
  recent(limit: number): ChatMessage[] {
    return this.#d.store.recentVisible(Math.min(200, Math.max(1, Math.trunc(limit))));
  }

  #dispatch(socket: ChatSocket, msg: ChatClientMessage): void {
    switch (msg.t) {
      case "send":
        this.#onSend(socket, msg.text, msg.nonce);
        return;
      case "report":
        this.#onReport(socket, msg.id, msg.reason);
        return;
      case "block":
        this.#onBlock(socket, msg.accountId, msg.blocked);
        return;
      case "ping":
        this.#onPing(socket, msg.clientTime);
        return;
    }
  }

  #onSend(socket: ChatSocket, raw: string, nonce: string): void {
    const { accountId, kind, name, tag } = socket.info;
    const now = this.#d.now();
    const text = cleanChatText(raw);
    if (text.length === 0) return this.#reject(socket, "empty", "message is empty", nonce);
    if (text.length > CHAT_MAX_LEN) {
      return this.#reject(socket, "too_long", `at most ${CHAT_MAX_LEN} characters`, nonce);
    }
    const mute = this.#d.store.muteOf(accountId);
    if (mute && mute.until > now) {
      return this.#reject(socket, "muted", "you are muted in this channel", nonce);
    }
    if (!this.#bucket(socket.info, now).take(now)) {
      return this.#reject(socket, "rate_limited", "slow down", nonce);
    }
    const key = text.toLowerCase();
    if (this.#d.store.recentKeys(accountId, now - DUPLICATE_WINDOW_MS).includes(key)) {
      return this.#reject(socket, "duplicate", "you just sent that", nonce);
    }
    const filtered = filterChat(text, { allowLinks: kind === "registered" });
    if (!filtered.ok) {
      return filtered.reason === "link"
        ? this.#reject(socket, "filtered", "links need a registered account", nonce)
        : this.#reject(socket, "filtered", "that message was blocked", nonce);
    }
    const msg: ChatMessage = {
      id: this.#newId(now),
      channel: this.#d.channel,
      from: accountId,
      name,
      ...(tag ? { tag } : {}),
      text: filtered.text,
      at: now,
    };
    this.#d.store.transact(() => {
      this.#d.store.insert(msg, key);
      this.#d.store.prune(RETAIN_MESSAGES);
    });
    this.#send(socket, { t: "ack", nonce, id: msg.id });
    this.#broadcast({ t: "message", msg }, this.#d.store.blockersOf(accountId));
    this.#d.waitUntil(this.#moderate(msg, text));
  }

  /** Runs after the broadcast. An unsafe verdict hides the message and counts a strike. */
  async #moderate(msg: ChatMessage, raw: string): Promise<void> {
    let verdict: Verdict;
    try {
      verdict = await this.#d.moderator.classify(raw);
    } catch (err) {
      this.#log(`chat ${this.#d.channel}: moderation failed`, err);
      return;
    }
    if (verdict.source === "error") return;
    const status: ModerationStatus = verdict.safe ? "safe" : "unsafe";
    this.#d.store.setVerdict(msg.id, status);
    if (verdict.safe) return;

    const now = this.#d.now();
    const muteUntil = this.#d.store.transact(() => {
      this.#d.store.hide([msg.id]);
      this.#d.store.addStrike(msg.from, now);
      let until: number | null = null;
      if (this.#d.store.strikesSince(msg.from, now - STRIKE_WINDOW_MS) >= STRIKES_TO_MUTE) {
        until = now + AUTO_MUTE_MS;
        this.#d.store.setMute(msg.from, until, "repeated_unsafe");
      }
      this.#appendReport(msg.id, msg.from, MODERATION_REPORTER, "abuse", msg.text, "unsafe", now);
      return until;
    });
    this.#d.outbox.scheduleFlush();
    this.#broadcast({ t: "hidden", ids: [msg.id] });
    if (muteUntil !== null) {
      this.#sendToAccount(msg.from, { t: "muted", until: muteUntil, reason: "repeated_unsafe" });
    } else {
      this.#sendToAccount(msg.from, {
        t: "error",
        code: "filtered",
        message: "your message was removed by moderation",
      });
    }
  }

  #onReport(socket: ChatSocket, id: string, reason: ReportReason): void {
    const { accountId } = socket.info;
    const row = this.#d.store.getMessage(id);
    if (!row || row.system) return this.#reject(socket, "bad_message", "unknown message");
    if (row.from === accountId) {
      return this.#reject(socket, "bad_message", "you cannot report yourself");
    }
    const now = this.#d.now();
    const created = this.#d.store.transact(() => {
      if (this.#d.store.seenReport(row.id, accountId)) return false;
      this.#d.store.markReport(row.id, accountId, now);
      this.#appendReport(row.id, row.from, accountId, reason, row.text, row.verdict, now);
      return true;
    });
    if (created) this.#d.outbox.scheduleFlush();
  }

  /** Writes one chat_report record (caller's transaction). */
  #appendReport(
    messageId: string,
    reportedId: string,
    reporterId: string,
    reason: ReportReason,
    text: string,
    verdict: ModerationStatus,
    at: number,
  ): void {
    const channel = this.#d.channel;
    const payload: ChatReportPayload = {
      channel,
      messageId,
      reporterId,
      reportedId,
      reason,
      text,
      at,
      verdict,
    };
    this.#d.outbox.append("chat_report", `${channel}/${messageId}/${reporterId}`, payload);
  }

  #onBlock(socket: ChatSocket, target: string, blocked: boolean): void {
    const me = socket.info.accountId;
    if (target === me) return this.#reject(socket, "bad_message", "you cannot block yourself");
    this.#d.store.setBlockRow(me, target, blocked);
    // Every socket of this account sees the new list at once.
    this.#sendToAccount(me, { t: "blocked", blocked: this.#d.store.blockList(me) });
    this.#d.waitUntil(this.#persistBlock(me, target, blocked));
  }

  async #persistBlock(me: string, target: string, blocked: boolean): Promise<void> {
    try {
      await this.#d.remoteSetBlocked(me, target, blocked);
    } catch (err) {
      this.#log(`chat ${this.#d.channel}: AccountDO block update failed (kept locally)`, err);
    }
  }

  #onPing(socket: ChatSocket, clientTime: number): void {
    const now = this.#d.now();
    let bucket = this.#pings.get(socket);
    if (!bucket) {
      bucket = new TokenBucket(PING_RATE, now);
      this.#pings.set(socket, bucket);
    }
    if (!bucket.take(now)) return;
    this.#send(socket, { t: "pong", clientTime, serverTime: now });
  }

  #bucket(info: ChatSocketInfo, now: number): TokenBucket {
    let bucket = this.#buckets.get(info.accountId);
    if (!bucket) {
      bucket = new TokenBucket(CHAT_RATE[info.kind === "registered" ? "registered" : "guest"], now);
      this.#buckets.set(info.accountId, bucket);
    }
    return bucket;
  }

  /** Message ids: "<at base36>-<n>", unique and increasing per channel (even across restarts). */
  #newId(now: number): string {
    let at = now;
    let n = 0;
    if (now <= this.#lastAt) {
      at = this.#lastAt;
      n = this.#lastN + 1;
    }
    this.#lastAt = at;
    this.#lastN = n;
    return `${at.toString(36)}-${n}`;
  }

  #reject(socket: ChatSocket, code: ChatErrorCode, message: string, nonce?: string): void {
    this.#send(socket, {
      t: "error",
      code,
      message,
      ...(nonce !== undefined ? { nonce } : {}),
    });
  }

  #send(socket: ChatSocket, msg: ChatServerMessage): void {
    this.#sendFrame(socket, encodeChatServerMessage(msg));
  }

  #sendFrame(socket: ChatSocket, frame: string): void {
    try {
      socket.send(frame);
    } catch (err) {
      // A socket that closed mid-send is cleaned up by the runtime.
      this.#log(`chat ${this.#d.channel}: send failed`, err);
    }
  }

  #broadcast(msg: ChatServerMessage, skipAccounts?: ReadonlySet<string>): void {
    const frame = encodeChatServerMessage(msg);
    for (const s of this.#d.sockets()) {
      if (skipAccounts?.has(s.info.accountId)) continue;
      this.#sendFrame(s, frame);
    }
  }

  #sendToAccount(accountId: string, msg: ChatServerMessage): void {
    const frame = encodeChatServerMessage(msg);
    for (const s of this.#d.sockets()) {
      if (s.info.accountId === accountId) this.#sendFrame(s, frame);
    }
  }
}
