/**
 * ChatChannelDO (wave-B.md §5): one chat channel — hibernatable sockets,
 * history, rate limits, word filter, async moderation, mutes, blocks and
 * reports (outbox -> D1 "chat_report"). Name: the channel id ("global",
 * "mode:<id>", "guild:<id>").
 *
 * This class only adapts WebSockets, SQLite, the outbox alarm and waitUntil to
 * ChatHost (chat/host.ts), which holds the logic. Blocks are kept in the
 * channel's SQLite (a socket attachment is capped at 2 KB), refreshed from
 * AccountDO on each join and written back to AccountDO on change. They are a
 * cache of the connected accounts only (R9): an account's last socket close
 * drops its rows.
 */
import type { AccountKind, ChatMessage } from "@gamez/protocol";
import { Outbox, type ReplicationBatch } from "@gamez/sync";
import { DurableObject } from "cloudflare:workers";
import { ChatHost, MEMBERSHIP_TTL_MS, type ChatSocket, type ChatSocketInfo } from "../chat/host.ts";
import { createModerator } from "../chat/moderation.ts";
import { ChatStore } from "../chat/store.ts";
import { CHAT_HEADERS, sqlStoreOf, type ChatChannelApi, type Env } from "../contracts.ts";

const FLUSH_BATCH = 200;
/** Same default delay as Outbox.scheduleFlush. */
const OUTBOX_FLUSH_DELAY_MS = 2000;
/** A failed outbox flush is retried after this long. */
const OUTBOX_RETRY_MS = 10_000;

/** Hibernation tag of an account's sockets (R9: per-account lookups without scanning every socket). */
function accountTag(accountId: string): string {
  return `acct:${accountId}`;
}

export class ChatChannelDO extends DurableObject<Env> implements ChatChannelApi {
  readonly #store: ChatStore;
  readonly #outbox: Outbox;
  readonly #wrappers = new WeakMap<WebSocket, ChatSocket>();
  #host: ChatHost | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const name = ctx.id.name ?? ctx.id.toString();
    this.#store = new ChatStore(sqlStoreOf(ctx.storage), name);
    this.#outbox = new Outbox(ctx.storage.sql, `chat:${name}`);
    void ctx.blockConcurrencyWhile(async () => {
      this.#store.init();
      this.#outbox.init();
    });
  }

  /** WebSocket upgrade forwarded by routes/chat.ts with CHAT_HEADERS. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const accountId = request.headers.get(CHAT_HEADERS.accountId);
    const name = request.headers.get(CHAT_HEADERS.name);
    const channel = request.headers.get(CHAT_HEADERS.channel);
    if (!accountId || !name || !channel) return new Response("missing identity", { status: 400 });
    if (channel !== this.#store.channel) return new Response("wrong channel", { status: 400 });

    const kind: AccountKind =
      request.headers.get(CHAT_HEADERS.kind) === "registered" ? "registered" : "guest";
    const tag = request.headers.get(CHAT_HEADERS.tag) || null;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [accountTag(accountId)]);
    const info: ChatSocketInfo = { accountId, name, kind, tag };
    server.serializeAttachment(info);
    const host = this.#hostOf();
    await host.open(this.#wrap(server));
    // R10: a guild channel re-checks every open socket's membership on an alarm.
    if (host.needsMembershipSweep()) await this.#alarmAt(Date.now() + MEMBERSHIP_TTL_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (!ws.deserializeAttachment()) return;
    // Never rejects (ChatHost.handleMessage handles its own failures).
    void this.#hostOf().handleMessage(this.#wrap(ws), message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    this.#released(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.#released(ws);
  }

  /** R9: the account's cached block rows go when its last socket here does. */
  #released(ws: WebSocket): void {
    if (!ws.deserializeAttachment()) return;
    this.#hostOf().socketClosed(this.#wrap(ws));
  }

  /**
   * Guild channels: sweeps membership (R10) and keeps the sweep alarm while
   * guild sockets are open. Then drains reports into the sync queue; a failed
   * flush is retried after OUTBOX_RETRY_MS (the sweep schedule never depends on
   * the runtime's alarm retries).
   */
  async alarm(): Promise<void> {
    const host = this.#hostOf();
    await host.sweepMembers();
    if (host.needsMembershipSweep()) await this.#alarmAt(Date.now() + MEMBERSHIP_TTL_MS);
    const sink = {
      send: async (batch: ReplicationBatch) => {
        await this.env.SYNC_QUEUE.send(batch);
      },
    };
    try {
      await this.#outbox.flush(sink, FLUSH_BATCH);
    } catch (err) {
      console.error(`chat ${this.#store.channel}: outbox flush failed`, err);
      await this.#alarmAt(Date.now() + OUTBOX_RETRY_MS);
      return;
    }
    if (this.#outbox.size() > 0) await this.#alarmAt(Date.now());
  }

  /**
   * One alarm serves both the outbox and the membership sweep: moves it
   * earlier, never later (Outbox.scheduleFlush would keep a later sweep alarm
   * and delay reports by up to a minute).
   */
  async #alarmAt(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // ---- ChatChannelApi (admin tools; the Worker route checks the caller) ----

  async mute(accountId: string, untilMs: number, reason: string): Promise<void> {
    this.#hostOf().mute(accountId, untilMs, reason);
  }

  async hide(messageIds: string[], reason: string): Promise<void> {
    this.#hostOf().hide(messageIds, reason);
  }

  async notice(text: string): Promise<void> {
    this.#hostOf().notice(text);
  }

  async recent(limit: number): Promise<ChatMessage[]> {
    return this.#hostOf().recent(limit);
  }

  async revoke(accountId: string, reason: string): Promise<number> {
    return this.#hostOf().revoke(accountId, reason);
  }

  #hostOf(): ChatHost {
    this.#host ??= new ChatHost({
      channel: this.#store.channel,
      store: this.#store,
      sockets: () => this.#sockets(),
      socketsOf: (accountId) => this.#sockets(accountTag(accountId)),
      now: () => Date.now(),
      moderator: createModerator(this.env),
      outbox: {
        append: (table, pk, payload) => {
          this.#outbox.append(table, pk, "upsert", payload);
        },
        scheduleFlush: () => {
          this.#alarmAt(Date.now() + OUTBOX_FLUSH_DELAY_MS).catch((err: unknown) => {
            console.error(`chat ${this.#store.channel}: scheduleFlush failed`, err);
          });
        },
      },
      remoteBlocks: (accountId) => this.env.ACCOUNT.getByName(accountId).blocks(),
      remoteSetBlocked: (accountId, target, blocked) =>
        this.env.ACCOUNT.getByName(accountId).setBlocked(target, blocked),
      guildLookup: async (accountId) =>
        (await this.env.ACCOUNT.getByName(accountId).guild())?.guildId ?? null,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      log: (message, err) => console.error(message, err),
    });
    return this.#host;
  }

  /** Open sockets with their attachments (hibernation-safe). */
  #sockets(tag?: string): ChatSocket[] {
    const out: ChatSocket[] = [];
    for (const ws of this.ctx.getWebSockets(tag)) {
      if (ws.readyState !== WebSocket.OPEN || !ws.deserializeAttachment()) continue;
      out.push(this.#wrap(ws));
    }
    return out;
  }

  /** One stable adapter per WebSocket; the attachment is the source of its info. */
  #wrap(ws: WebSocket): ChatSocket {
    let w = this.#wrappers.get(ws);
    if (!w) {
      w = {
        get info() {
          return ws.deserializeAttachment() as ChatSocketInfo;
        },
        send: (frame) => ws.send(frame),
        close: (code, reason) => ws.close(code, reason),
      };
      this.#wrappers.set(ws, w);
    }
    return w;
  }
}
