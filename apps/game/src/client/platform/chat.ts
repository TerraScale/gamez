/**
 * ChatApi (wave-B.md §5): one reconnecting WebSocket per channel
 * (/ws/chat?token&channel). Joining a channel that is already open reuses its
 * socket: every join gets its own handle, and the socket closes when the last
 * handle closes. The view holds at most CHAT_HISTORY*2 messages, oldest first,
 * minus the senders this viewer blocked.
 */
import {
  CHAT_HISTORY,
  CHAT_MAX_LEN,
  type ChannelId,
  type ChatClientMessage,
  type ChatMessage,
  type ChatServerMessage,
  type ReportReason,
} from "@gamez/protocol";
import type { ApiResult, ChatApi, ChatChannelClient, ChatChannelView } from "@gamez/ui-host";
import { backoffDelay } from "../net.ts";
import { wsUrl } from "./http.ts";

/** The part of the browser WebSocket the chat client uses. */
export interface ChatSocket {
  readonly readyState: number;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type ChatSocketCtor = new (url: string) => ChatSocket;

export interface ChatDeps {
  /** The current session token, read on every (re)connect. */
  token(): string | null | undefined;
  /** http(s) origin of the server (the app origin in a browser). */
  origin: string;
  WebSocket: ChatSocketCtor;
}

/** Messages kept in a view: two histories' worth, so scrollback survives a reconnect. */
export const CHAT_MAX_VIEW = CHAT_HISTORY * 2;
/** A send without an ack or error after this long resolves with code "timeout". */
export const CHAT_SEND_TIMEOUT_MS = 10_000;

const SOCKET_OPEN = 1;
/** Close codes set by the chat route (wave-B.md §5). */
export const CHAT_CLOSE_UNAUTHORIZED = 4401;
export const CHAT_CLOSE_FORBIDDEN = 4403;
/** Too many chat connects from this IP: reconnect at the slowest backoff. */
export const CHAT_CLOSE_RATE_LIMITED = 4429;

type SendResult = ApiResult<{ id: string }>;

function offline(message = "Chat is offline"): SendResult {
  return { ok: false, code: "offline", message };
}

function capMessages(list: readonly ChatMessage[]): ChatMessage[] {
  return list.length > CHAT_MAX_VIEW ? list.slice(list.length - CHAT_MAX_VIEW) : [...list];
}

/** One socket and its state, shared by every handle of a channel. */
class ChannelCore {
  view: ChatChannelView;
  /** Open handles. The socket closes when this drops to zero. */
  refs = 0;
  #socket: ChatSocket | null = null;
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #listeners = new Set<() => void>();
  #pending = new Map<
    string,
    { resolve: (r: SendResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  #nonce = 0;
  #blocked = new Set<string>();
  #stopped = false;
  #disposed = false;

  constructor(
    readonly channel: ChannelId,
    readonly deps: ChatDeps,
    /** Called once the socket is closed for good, so the API forgets this core. */
    private readonly onDispose: () => void,
  ) {
    this.view = {
      channel,
      status: "connecting",
      messages: [],
      mutedUntil: null,
      blocked: [],
      error: null,
    };
  }

  /** True once the core will never reconnect (unauthorized, forbidden or closed). */
  get stopped(): boolean {
    return this.#stopped;
  }

  start(): void {
    this.#connect();
  }

  addListener(cb: () => void): void {
    this.#listeners.add(cb);
  }

  removeListener(cb: () => void): void {
    this.#listeners.delete(cb);
  }

  /** A handle is released; the socket closes with the last one. */
  release(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0) this.dispose();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopped = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    const ws = this.#socket;
    this.#socket = null;
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(1000, "closed");
      } catch {
        // Already closed.
      }
    }
    this.#failPending("offline", "Chat closed");
    this.onDispose();
    this.#set({ status: "closed" });
  }

  send(text: string): Promise<SendResult> {
    const trimmed = text.trim();
    if (!trimmed)
      return Promise.resolve({ ok: false, code: "empty", message: "Type a message first" });
    if (trimmed.length > CHAT_MAX_LEN) {
      return Promise.resolve({
        ok: false,
        code: "too_long",
        message: `Messages are at most ${CHAT_MAX_LEN} characters`,
      });
    }
    const ws = this.#socket;
    if (!ws || this.#disposed || ws.readyState !== SOCKET_OPEN || this.view.status !== "online") {
      return Promise.resolve(offline());
    }
    const nonce = `c${++this.#nonce}`;
    return new Promise<SendResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(nonce)) {
          resolve({ ok: false, code: "timeout", message: "The chat server did not answer" });
        }
      }, CHAT_SEND_TIMEOUT_MS);
      this.#pending.set(nonce, { resolve, timer });
      const frame: ChatClientMessage = { t: "send", text: trimmed, nonce };
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        this.#resolvePending(nonce, offline("Could not send, try again"));
      }
    });
  }

  report(id: string, reason: ReportReason): void {
    this.#sendFrame({ t: "report", id, reason });
  }

  block(accountId: string, blocked: boolean): void {
    if (blocked) this.#blocked.add(accountId);
    else this.#blocked.delete(accountId);
    this.#set({
      blocked: [...this.#blocked],
      messages: this.view.messages.filter((m) => !this.#blocked.has(m.from)),
    });
    this.#sendFrame({ t: "block", accountId, blocked });
  }

  #sendFrame(frame: ChatClientMessage): void {
    const ws = this.#socket;
    if (!ws || ws.readyState !== SOCKET_OPEN || this.view.status !== "online") return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The socket is going away; the close handler reconnects.
    }
  }

  #set(patch: Partial<ChatChannelView>): void {
    this.view = { ...this.view, ...patch };
    for (const cb of this.#listeners) {
      try {
        cb();
      } catch (err) {
        console.warn("chat listener failed", err);
      }
    }
  }

  #connect(): void {
    if (this.#disposed || this.#stopped) return;
    let ws: ChatSocket;
    try {
      const url = wsUrl(this.deps.origin, "/ws/chat", {
        token: this.deps.token() ?? "",
        channel: this.channel,
      });
      ws = new this.deps.WebSocket(url);
    } catch (err) {
      console.warn("chat socket could not open", err);
      this.#socket = null;
      this.#scheduleReconnect();
      return;
    }
    this.#socket = ws;
    this.#set({ status: "connecting" });
    ws.onmessage = (ev) => {
      if (this.#socket === ws) this.#onFrame(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.#socket === ws) this.#onClose(ev.code);
    };
    // A failed connection is followed by a close event, which handles it.
    ws.onerror = () => {};
  }

  #onClose(code: number): void {
    this.#socket = null;
    this.#failPending("offline", "Chat connection lost");
    if (this.#disposed) return;
    if (code === CHAT_CLOSE_UNAUTHORIZED) {
      this.#stopped = true;
      this.#set({
        status: "offline",
        error: { code: "unauthorized", message: "Sign in to chat" },
      });
      return;
    }
    if (code === CHAT_CLOSE_FORBIDDEN) {
      this.#stopped = true;
      this.#set({
        status: "closed",
        error: { code: "forbidden", message: "You cannot join this chat" },
      });
      return;
    }
    // Rate limited: jump to the longest backoff instead of spending more of the IP's budget.
    if (code === CHAT_CLOSE_RATE_LIMITED) this.#attempt = 16;
    this.#set({ status: "offline" });
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#stopped) return;
    const delay = backoffDelay(this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 16);
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect();
    }, delay);
  }

  #onFrame(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: ChatServerMessage;
    try {
      msg = JSON.parse(data) as ChatServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;

    switch (msg.t) {
      case "welcome": {
        this.#attempt = 0;
        this.#blocked = new Set(Array.isArray(msg.blocked) ? msg.blocked : []);
        const history = (Array.isArray(msg.history) ? msg.history : []).filter(
          (m) => !this.#blocked.has(m.from),
        );
        this.#set({
          status: "online",
          messages: capMessages(history),
          mutedUntil: msg.mutedUntil ?? null,
          blocked: [...this.#blocked],
        });
        return;
      }
      case "message": {
        const m = msg.msg;
        if (!m || this.#blocked.has(m.from)) return;
        if (this.view.messages.some((existing) => existing.id === m.id)) return;
        this.#set({ messages: capMessages([...this.view.messages, m]) });
        return;
      }
      case "hidden": {
        const ids = new Set(msg.ids);
        const next = this.view.messages.filter((m) => !ids.has(m.id));
        if (next.length !== this.view.messages.length) this.#set({ messages: next });
        return;
      }
      case "ack": {
        this.#resolvePending(msg.nonce, { ok: true, value: { id: msg.id } });
        this.#set({ error: null });
        return;
      }
      case "muted":
        this.#set({
          mutedUntil: msg.until,
          error: { code: "muted", message: msg.reason || "You are muted for a while" },
        });
        return;
      case "blocked": {
        this.#blocked = new Set(msg.blocked);
        this.#set({
          blocked: [...this.#blocked],
          messages: this.view.messages.filter((m) => !this.#blocked.has(m.from)),
        });
        return;
      }
      case "error": {
        const err = { code: msg.code, message: msg.message };
        if (msg.nonce !== undefined) this.#resolvePending(msg.nonce, { ok: false, ...err });
        this.#set({ error: err });
        return;
      }
      default:
        // pong and unknown frames change nothing.
        return;
    }
  }

  #resolvePending(nonce: string, result: SendResult): void {
    const p = this.#pending.get(nonce);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(nonce);
    p.resolve(result);
  }

  #failPending(code: string, message: string): void {
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of waiting) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, code, message });
    }
  }
}

/** The client a caller holds for one join. Closing it releases its share of the socket. */
class ChatHandle implements ChatChannelClient {
  readonly channel: ChannelId;
  #closed = false;
  #unsubs = new Set<() => void>();

  constructor(private readonly core: ChannelCore) {
    this.channel = core.channel;
  }

  getView(): ChatChannelView {
    return this.core.view;
  }

  /** Called on every change; the callback is not called with the current view at subscribe time. */
  subscribe(cb: (view: ChatChannelView) => void): () => void {
    if (this.#closed) return () => {};
    const listener = () => cb(this.core.view);
    this.core.addListener(listener);
    const unsub = () => {
      this.core.removeListener(listener);
      this.#unsubs.delete(unsub);
    };
    this.#unsubs.add(unsub);
    return unsub;
  }

  send(text: string): Promise<SendResult> {
    if (this.#closed) return Promise.resolve(offline("Chat is closed"));
    return this.core.send(text);
  }

  report(messageId: string, reason: ReportReason): void {
    if (!this.#closed) this.core.report(messageId, reason);
  }

  block(accountId: string, blocked: boolean): void {
    if (!this.#closed) this.core.block(accountId, blocked);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsub of this.#unsubs) unsub();
    this.core.release();
  }
}

/** ChatApi over the given socket constructor and origin. */
export function createChatApi(deps: ChatDeps): ChatApi {
  const cores = new Map<ChannelId, ChannelCore>();
  return {
    join(channel: ChannelId): ChatChannelClient {
      let core = cores.get(channel);
      if (!core || core.stopped) {
        const created: ChannelCore = new ChannelCore(channel, deps, () => {
          if (cores.get(channel) === created) cores.delete(channel);
        });
        cores.set(channel, created);
        core = created;
        created.start();
      }
      core.refs += 1;
      return new ChatHandle(core);
    },
  };
}
