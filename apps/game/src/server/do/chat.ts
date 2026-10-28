/**
 * ChatChannelDO (wave-B.md §5): one chat channel — hibernatable sockets,
 * history, rate limits, word filter, async moderation, mutes, blocks and
 * reports (outbox -> D1 "chat_report"). Name: the channel id ("global",
 * "mode:<id>", "guild:<id>").
 *
 * This class only adapts WebSockets, SQLite, the outbox alarm and waitUntil to
 * ChatHost (chat/host.ts), which holds the logic. Blocks are kept in the
 * channel's SQLite (a socket attachment is capped at 2 KB), refreshed from
 * AccountDO on each join and written back to AccountDO on change.
 */
import type { AccountKind, ChatMessage } from "@gamez/protocol";
import { Outbox, type ReplicationBatch } from "@gamez/sync";
import { DurableObject } from "cloudflare:workers";
import { ChatHost, type ChatSocket, type ChatSocketInfo } from "../chat/host.ts";
import { createModerator } from "../chat/moderation.ts";
import { ChatStore } from "../chat/store.ts";
import { CHAT_HEADERS, sqlStoreOf, type ChatChannelApi, type Env } from "../contracts.ts";

const FLUSH_BATCH = 200;

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
    this.ctx.acceptWebSocket(server);
    const info: ChatSocketInfo = { accountId, name, kind, tag };
    server.serializeAttachment(info);
    await this.#hostOf().open(this.#wrap(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (!ws.deserializeAttachment()) return;
    this.#hostOf().handleMessage(this.#wrap(ws), message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** Drains reports into the sync queue. A throw makes the runtime retry the alarm. */
  async alarm(): Promise<void> {
    const sink = {
      send: async (batch: ReplicationBatch) => {
        await this.env.SYNC_QUEUE.send(batch);
      },
    };
    await this.#outbox.flush(sink, FLUSH_BATCH);
    if (this.#outbox.size() > 0) await this.#outbox.scheduleFlush(this.ctx.storage, 0);
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

  #hostOf(): ChatHost {
    this.#host ??= new ChatHost({
      channel: this.#store.channel,
      store: this.#store,
      sockets: () => this.#sockets(),
      now: () => Date.now(),
      moderator: createModerator(this.env),
      outbox: {
        append: (table, pk, payload) => {
          this.#outbox.append(table, pk, "upsert", payload);
        },
        scheduleFlush: () => {
          this.#outbox.scheduleFlush(this.ctx.storage).catch((err: unknown) => {
            console.error(`chat ${this.#store.channel}: scheduleFlush failed`, err);
          });
        },
      },
      remoteBlocks: (accountId) => this.env.ACCOUNT.getByName(accountId).blocks(),
      remoteSetBlocked: (accountId, target, blocked) =>
        this.env.ACCOUNT.getByName(accountId).setBlocked(target, blocked),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      log: (message, err) => console.error(message, err),
    });
    return this.#host;
  }

  /** Open sockets with their attachments (hibernation-safe). */
  #sockets(): ChatSocket[] {
    const out: ChatSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
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
