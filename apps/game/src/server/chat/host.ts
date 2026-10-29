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
import { BLOCK_LIMIT } from "../account/social.ts";
import type { Analytics } from "../analytics/types.ts";
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
/** Block messages per socket: burst 10, one per 2 s (R9). Refusals never reach AccountDO. */
export const BLOCK_RATE: BucketSpec = { burst: 10, perSecond: 0.5 };
/** Report messages per socket: burst 5, one per 5 s (R9b). */
export const REPORT_RATE: BucketSpec = { burst: 5, perSecond: 0.2 };
/**
 * R9b: only the first this-many reporters of a message are recorded (a
 * chat_seen_report row plus one D1 chat_report row each). Later reports of that
 * message are accepted silently and write nothing: the message is already in
 * the moderation queue, and admin counts read "at least" this many. This bounds
 * the channel's report rows by RETAIN_MESSAGES x REPORTERS_PER_MESSAGE however
 * many (free guest) accounts report.
 */
export const REPORTERS_PER_MESSAGE = 5;
/**
 * R9: a join drops the cached block rows of accounts with no open socket at
 * most this often (a backstop for a close the runtime never reported; the
 * last-socket close and a host start drop them as well).
 */
export const BLOCK_SWEEP_MS = 5 * 60 * 1000;
/** A guild channel re-checks a sender's membership at most this often (R10). */
export const MEMBERSHIP_TTL_MS = 60_000;
/**
 * A guild channel whose membership answers keep failing closes a socket once
 * its last confirmed answer is this old (R10). The client reconnects and the
 * upgrade checks membership again.
 */
export const MEMBERSHIP_STALE_MS = 3 * MEMBERSHIP_TTL_MS;
/** Close code for a socket whose account is no longer allowed here (routes/chat.ts CLOSE_CHAT_FORBIDDEN). */
export const CLOSE_FORBIDDEN = 4403;
/** Close code when membership could not be confirmed (retryable: "try again later"). */
export const CLOSE_RETRY = 1013;
const GUILD_PREFIX = "guild:";
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
  /** Accept time (epoch ms), for ws.close durationS. Absent on sockets accepted before analytics. */
  openedAt?: number;
}

/** The chat.message channelKind blob: the channel's access kind, never the id. */
export type ChannelKind = "global" | "mode" | "guild" | "other";

export function channelKindOf(channel: string): ChannelKind {
  if (channel === "global") return "global";
  if (channel.startsWith("mode:")) return "mode";
  if (channel.startsWith("guild:")) return "guild";
  return "other";
}

/** chat.message outcomes (docs/design/admin-dashboard.md §3). */
export type ChatOutcome = "ok" | "filtered" | "muted" | "rate_limited" | "guard";
/** mod.action kinds and who took them. */
export type ModAction = "mute" | "hide" | "report" | "filter" | "guard";
export type ModBy = "admin" | "auto" | "player";

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
  /** Open sockets of one account (defaults to filtering sockets()). */
  socketsOf?: (accountId: string) => ChatSocket[];
  now(): number;
  moderator: Moderator;
  outbox: ChatOutbox;
  /** The account's block list in AccountDO (may throw). */
  remoteBlocks(accountId: string): Promise<string[]>;
  /** Persists a block change in AccountDO (may throw; the local block still applies). */
  remoteSetBlocked(accountId: string, target: string, blocked: boolean): Promise<unknown>;
  /**
   * Guild channels only (R10): the guild id the account belongs to now, or null.
   * The host caches answers for MEMBERSHIP_TTL_MS. Unset outside guild channels.
   */
  guildLookup?: (accountId: string) => Promise<string | null>;
  /** Keeps background work alive past the handler (the DO's ctx.waitUntil). */
  waitUntil(promise: Promise<unknown>): void;
  log?: (message: string, err?: unknown) => void;
  /** Analytics writer for chat.message and mod.action points (optional: no points without it). */
  analytics?: Analytics;
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
  readonly #blockBuckets = new WeakMap<ChatSocket, TokenBucket>();
  readonly #reportBuckets = new WeakMap<ChatSocket, TokenBucket>();
  /** Sockets this host has closed (revoke is idempotent over them). */
  readonly #closed = new WeakSet<ChatSocket>();
  /** Guild id of this channel, or null for a non-guild channel. */
  readonly #guildId: string | null;
  /** Last membership answer per account (guild channels). */
  readonly #members = new Map<string, { guildId: string | null; at: number }>();
  /**
   * Guild sockets accepted but not yet confirmed by open()'s fresh membership
   * lookup. They get no broadcasts until confirmed (R10).
   */
  readonly #opening = new WeakSet<ChatSocket>();
  /** Lookups in flight, shared by concurrent sends of one account (keeps their order). */
  readonly #lookups = new Map<string, Promise<string | null | undefined>>();
  readonly #log: (message: string, err?: unknown) => void;
  #lastAt = -1;
  #lastN = -1;
  #lastBlockSweep: number;

  constructor(deps: ChatHostDeps) {
    this.#d = deps;
    this.#log = deps.log ?? DEFAULT_LOG;
    this.#guildId = deps.channel.startsWith(GUILD_PREFIX)
      ? deps.channel.slice(GUILD_PREFIX.length)
      : null;
    const last = deps.store.lastMessageId();
    const m = last ? /^([0-9a-z]+)-(\d+)$/.exec(last) : null;
    if (m) {
      this.#lastAt = Number.parseInt(m[1]!, 36);
      this.#lastN = Number(m[2]);
    }
    // R9: rows of accounts whose sockets went away while no host was running
    // (a restart drops every socket) are stale cache entries.
    this.#lastBlockSweep = deps.now();
    this.#sweepBlocks();
  }

  /**
   * The runtime reports that `socket` closed or errored. When it was the
   * account's last socket here, its cached block rows are dropped (R9): they
   * live in AccountDO and the next open() restores them.
   */
  socketClosed(socket: ChatSocket): void {
    this.#closed.add(socket);
    this.#releaseIfGone(socket.info.accountId);
  }

  /** Accounts with a send rate bucket in memory (tests and diagnostics, R9b). */
  get rateBucketCount(): number {
    return this.#buckets.size;
  }

  /**
   * A socket joined: refreshes its block list from AccountDO, then sends the
   * welcome (history without blocked senders, mute, blocks).
   */
  async open(socket: ChatSocket): Promise<void> {
    const { accountId, name } = socket.info;
    if (this.#guildId !== null && this.#d.guildLookup) {
      // R10: the upgrade's membership check ran before this socket was
      // accepted, so a kick could have released the account and revoked (seeing
      // no socket) in between. A lookup that starts now, after the accept,
      // either sees the release or the revoke sees this socket.
      this.#opening.add(socket);
      let current: string | null;
      try {
        current = await withTimeout(this.#d.guildLookup(accountId), BLOCK_REFRESH_MS);
      } catch (err) {
        this.#log(`chat ${this.#d.channel}: membership lookup on join failed`, err);
        this.#closeSocket(socket, CLOSE_RETRY, "membership unavailable");
        return;
      }
      if (this.#closed.has(socket)) return; // revoked while the lookup ran (the revoke wins)
      this.#members.set(accountId, { guildId: current, at: this.#d.now() });
      if (current !== this.#guildId) {
        this.#closeSocket(socket, CLOSE_FORBIDDEN, "not a member");
        return;
      }
      this.#opening.delete(socket);
    }
    try {
      const remote = await withTimeout(this.#d.remoteBlocks(accountId), BLOCK_REFRESH_MS);
      // The socket may have closed while AccountDO answered: its close already
      // dropped the rows, so a merge now would leave them behind (R9).
      if (this.#closed.has(socket) || !this.#hasLiveSocket(accountId)) return;
      this.#d.store.mergeBlocks(accountId, remote);
    } catch (err) {
      this.#log(`chat ${this.#d.channel}: block list refresh failed`, err);
    }
    const now = this.#d.now();
    if (now - this.#lastBlockSweep >= BLOCK_SWEEP_MS) {
      this.#lastBlockSweep = now;
      this.#sweepBlocks();
      this.#sweepBuckets(now);
    }
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

  /**
   * Handles one client frame. Never rejects. Non-guild frames are handled
   * synchronously; a guild send first re-checks the sender's membership (R10),
   * so it resolves later.
   */
  async handleMessage(socket: ChatSocket, raw: string | ArrayBuffer): Promise<void> {
    // A socket this host closed (revoke, sweep) gets no more service.
    if (this.#closed.has(socket) || this.#opening.has(socket)) return;
    const msg = parseChatClientMessage(raw);
    if (!msg) {
      this.#reject(socket, "bad_message", "invalid message");
      return;
    }
    try {
      if (msg.t === "send" && this.#guildId !== null && this.#d.guildLookup) {
        if (!(await this.#stillMember(socket.info.accountId))) {
          // Kicked or left: the message is dropped and the socket closed.
          this.#closeSocket(socket, CLOSE_FORBIDDEN, "not a member");
          return;
        }
      }
      this.#dispatch(socket, msg);
    } catch (err) {
      this.#log(`chat ${this.#d.channel}: ${msg.t} failed`, err);
      this.#reject(socket, "internal", `${msg.t} failed`);
    }
  }

  /**
   * Closes every open socket of `accountId` in this channel with close code
   * 4403 (a guild kick or leave, R10). Returns how many were closed; a repeat
   * call closes nothing more.
   */
  revoke(accountId: string, reason: string): number {
    // Later sends and sweeps within the TTL see the departure without a lookup.
    if (this.#guildId !== null) {
      this.#members.set(accountId, { guildId: null, at: this.#d.now() });
    }
    let closed = 0;
    for (const s of this.#socketsOf(accountId)) {
      if (this.#closed.has(s)) continue;
      this.#closeSocket(s, CLOSE_FORBIDDEN, reason);
      closed++;
    }
    return closed;
  }

  /** True when this is a guild channel with open sockets (the DO keeps its sweep alarm then). */
  needsMembershipSweep(): boolean {
    return this.#guildId !== null && this.#d.sockets().some((s) => !this.#closed.has(s));
  }

  /**
   * Guild channels (R10): looks up the membership of every account with an
   * open socket and closes the sockets of accounts that are no longer in this
   * guild with 4403. Covers a lost revoke and a member who only reads. A failed
   * lookup keeps the socket until its last confirmed answer is
   * MEMBERSHIP_STALE_MS old, then closes it with 1013 (the client reconnects and
   * the upgrade checks again). Never rejects.
   */
  async sweepMembers(): Promise<void> {
    const guildId = this.#guildId;
    const lookup = this.#d.guildLookup;
    if (guildId === null || !lookup) return;
    const accounts = [
      ...new Set(
        this.#d
          .sockets()
          .filter((s) => !this.#closed.has(s))
          .map((s) => s.info.accountId),
      ),
    ].sort();
    const answers = await Promise.all(
      accounts.map(async (accountId) => {
        try {
          return await withTimeout(lookup(accountId), BLOCK_REFRESH_MS);
        } catch (err) {
          this.#log(`chat ${this.#d.channel}: membership sweep lookup failed`, err);
          return undefined;
        }
      }),
    );
    const now = this.#d.now();
    accounts.forEach((accountId, i) => {
      const current = answers[i];
      let close: { code: number; reason: string } | null = null;
      if (current === undefined) {
        const last = this.#members.get(accountId);
        if (last && last.guildId !== guildId) {
          close = { code: CLOSE_FORBIDDEN, reason: "not a member" };
        } else if (!last || now - last.at > MEMBERSHIP_STALE_MS) {
          close = { code: CLOSE_RETRY, reason: "membership unavailable" };
        }
      } else {
        this.#members.set(accountId, { guildId: current, at: now });
        if (current !== guildId) close = { code: CLOSE_FORBIDDEN, reason: "not a member" };
      }
      if (!close) return;
      for (const s of this.#socketsOf(accountId)) {
        if (!this.#closed.has(s)) this.#closeSocket(s, close.code, close.reason);
      }
    });
  }

  /**
   * Whether `accountId` is still in this guild channel's guild (R10). An answer
   * is cached for MEMBERSHIP_TTL_MS. A failed lookup keeps the last known answer,
   * and with none known the send is allowed (the upgrade already checked it).
   */
  async #stillMember(accountId: string): Promise<boolean> {
    const guildId = this.#guildId;
    const now = this.#d.now();
    const known = this.#members.get(accountId);
    if (known && now - known.at < MEMBERSHIP_TTL_MS) return known.guildId === guildId;

    let pending = this.#lookups.get(accountId);
    if (!pending) {
      const lookup = this.#d.guildLookup;
      if (!lookup) return true;
      pending = Promise.resolve()
        .then(() => lookup(accountId))
        .then(
          (current) => {
            this.#members.set(accountId, { guildId: current, at: this.#d.now() });
            return current;
          },
          (err: unknown) => {
            this.#log(`chat ${this.#d.channel}: membership lookup failed`, err);
            return undefined;
          },
        )
        .finally(() => {
          this.#lookups.delete(accountId);
        });
      this.#lookups.set(accountId, pending);
    }
    const current = await pending;
    if (current === undefined) {
      const last = this.#members.get(accountId);
      return last ? last.guildId === guildId : true;
    }
    return current === guildId;
  }

  #closeSocket(socket: ChatSocket, code: number, reason: string): void {
    this.#closed.add(socket);
    try {
      socket.close(code, reason);
    } catch (err) {
      this.#log(`chat ${this.#d.channel}: close failed`, err);
    }
    this.#releaseIfGone(socket.info.accountId);
  }

  #socketsOf(accountId: string): ChatSocket[] {
    return this.#d.socketsOf
      ? this.#d.socketsOf(accountId)
      : this.#d.sockets().filter((s) => s.info.accountId === accountId);
  }

  #hasLiveSocket(accountId: string): boolean {
    return this.#socketsOf(accountId).some((s) => !this.#closed.has(s));
  }

  /**
   * Once the account has no open socket here: drops its cached block rows (R9)
   * and its send rate bucket when that is full again (R9b). A bucket that is
   * still draining stays, so reconnecting never refills it early; the next
   * sweep drops it.
   */
  #releaseIfGone(accountId: string): void {
    if (this.#hasLiveSocket(accountId)) return;
    if (this.#buckets.get(accountId)?.full(this.#d.now()) ?? false) {
      this.#buckets.delete(accountId);
    }
    try {
      this.#d.store.dropBlocks(accountId);
    } catch (err) {
      this.#log(`chat ${this.#d.channel}: dropping block rows failed`, err);
    }
  }

  /** R9: drops the cached block rows of every account with no open socket here. */
  #sweepBlocks(): void {
    const live = new Set<string>();
    for (const s of this.#d.sockets()) {
      if (!this.#closed.has(s)) live.add(s.info.accountId);
    }
    try {
      const dropped = this.#d.store.dropBlocksExcept(live);
      if (dropped > 0)
        this.#log(`chat ${this.#d.channel}: dropped block rows of ${dropped} gone account(s)`);
    } catch (err) {
      this.#log(`chat ${this.#d.channel}: block row sweep failed`, err);
    }
  }

  /**
   * R9b: drops the send rate buckets of accounts with no open socket here once
   * they are full again (equivalent to a fresh bucket, so nothing is lost).
   */
  #sweepBuckets(now: number): void {
    for (const [accountId, bucket] of this.#buckets) {
      if (bucket.full(now) && !this.#hasLiveSocket(accountId)) this.#buckets.delete(accountId);
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
      this.#d.store.prune(RETAIN_MESSAGES, { now, strikesBefore: now - STRIKE_WINDOW_MS });
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
    if (text.length === 0) {
      this.#chatPoint("guard", 0);
      return this.#reject(socket, "empty", "message is empty", nonce);
    }
    if (text.length > CHAT_MAX_LEN) {
      this.#chatPoint("guard", text.length);
      return this.#reject(socket, "too_long", `at most ${CHAT_MAX_LEN} characters`, nonce);
    }
    const mute = this.#d.store.muteOf(accountId);
    if (mute && mute.until > now) {
      this.#chatPoint("muted", text.length);
      return this.#reject(socket, "muted", "you are muted in this channel", nonce);
    }
    if (!this.#bucket(socket.info, now).take(now)) {
      this.#chatPoint("rate_limited", text.length);
      return this.#reject(socket, "rate_limited", "slow down", nonce);
    }
    const key = text.toLowerCase();
    if (this.#d.store.recentKeys(accountId, now - DUPLICATE_WINDOW_MS).includes(key)) {
      this.#chatPoint("guard", text.length);
      this.#modPoint("guard", "auto");
      return this.#reject(socket, "duplicate", "you just sent that", nonce);
    }
    const filtered = filterChat(text, { allowLinks: kind === "registered" });
    if (!filtered.ok) {
      this.#chatPoint("filtered", text.length);
      this.#modPoint("filter", "auto");
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
      this.#d.store.prune(RETAIN_MESSAGES, { now, strikesBefore: now - STRIKE_WINDOW_MS });
    });
    this.#chatPoint("ok", msg.text.length);
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
    this.#modPoint("hide", "auto");
    this.#broadcast({ t: "hidden", ids: [msg.id] });
    if (muteUntil !== null) {
      this.#modPoint("mute", "auto");
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
    const now = this.#d.now();
    if (!this.#socketBucket(this.#reportBuckets, REPORT_RATE, socket, now).take(now)) {
      return this.#reject(socket, "rate_limited", "slow down");
    }
    const row = this.#d.store.getMessage(id);
    if (!row || row.system) return this.#reject(socket, "bad_message", "unknown message");
    if (row.from === accountId) {
      return this.#reject(socket, "bad_message", "you cannot report yourself");
    }
    const created = this.#d.store.transact(() => {
      if (this.#d.store.seenReport(row.id, accountId)) return false;
      // R9b: enough reporters already put this message in the queue.
      if (this.#d.store.reportCount(row.id) >= REPORTERS_PER_MESSAGE) return false;
      this.#d.store.markReport(row.id, accountId, now);
      this.#appendReport(row.id, row.from, accountId, reason, row.text, row.verdict, now);
      return true;
    });
    if (created) {
      this.#d.outbox.scheduleFlush();
      this.#modPoint("report", "player");
    }
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
    const now = this.#d.now();
    if (!this.#socketBucket(this.#blockBuckets, BLOCK_RATE, socket, now).take(now)) {
      return this.#reject(socket, "rate_limited", "slow down");
    }
    if (target === me) return this.#reject(socket, "bad_message", "you cannot block yourself");
    if (this.#d.store.setBlockRow(me, target, blocked) === "block_limit") {
      return this.#reject(socket, "block_limit", `at most ${BLOCK_LIMIT} blocked accounts`);
    }
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

  #socketBucket(
    buckets: WeakMap<ChatSocket, TokenBucket>,
    spec: BucketSpec,
    socket: ChatSocket,
    now: number,
  ): TokenBucket {
    let bucket = buckets.get(socket);
    if (!bucket) {
      bucket = new TokenBucket(spec, now);
      buckets.set(socket, bucket);
    }
    return bucket;
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

  /** One chat.message point: the outcome of a send attempt in this channel. */
  #chatPoint(outcome: ChatOutcome, chars: number): void {
    this.#d.analytics?.write(
      "chat.message",
      { channelKind: channelKindOf(this.#d.channel), outcome },
      { chars },
    );
  }

  /** One mod.action point: a mute, hide, report, filter or guard block. */
  #modPoint(action: ModAction, by: ModBy): void {
    this.#d.analytics?.write("mod.action", { action, by });
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
      if (this.#opening.has(s) || this.#closed.has(s)) continue;
      this.#sendFrame(s, frame);
    }
  }

  #sendToAccount(accountId: string, msg: ChatServerMessage): void {
    const frame = encodeChatServerMessage(msg);
    // The DO answers this with an `acct:` tag lookup, not a scan of the channel.
    for (const s of this.#socketsOf(accountId)) {
      if (this.#opening.has(s) || this.#closed.has(s)) continue;
      this.#sendFrame(s, frame);
    }
  }
}
