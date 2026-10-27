/**
 * InstanceConnection over /ws/instance: one socket to the player's
 * InstanceDO for a mode, reconnecting with backoff and re-joining, with
 * local prediction of actions (see prediction.ts).
 */
import { restoreWorld, type DispatchResult, type LoadedMode, type World } from "@gamez/kernel";
import type { InstanceClientMessage, InstanceServerMessage } from "@gamez/protocol";
import type { InstanceConnection, InstanceView, Session } from "@gamez/ui-host";
import { backoffDelay } from "../net.ts";
import {
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  encodeClientMessage,
  parseServerMessage,
} from "./messages.ts";
import { Prediction } from "./prediction.ts";

/** Ping interval; each pong updates view.pingMs. */
export const PING_MS = 5000;

/** The part of the browser WebSocket this connection uses. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface InstanceClientOptions {
  mode: string;
  /** The mode loaded from the shared catalog (same modules as the server). */
  loaded: LoadedMode;
  /** Current session; called before each connect, so it may log in again. */
  session(): Promise<Session>;
  /** The server rejected the token (close 4401): drop it so session() logs in again. */
  onUnauthorized?(): void;
  /** Socket URL for a token and mode (default: /ws/instance on this host). */
  url?: (token: string, mode: string) => string;
  /** WebSocket constructor (tests pass a fake). */
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
  /** Random source for backoff jitter. */
  random?: () => number;
  /** Called once by close(). */
  onClose?(): void;
}

const OPEN = 1;

export function instanceUrl(token: string, mode: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const q = `token=${encodeURIComponent(token)}&mode=${encodeURIComponent(mode)}`;
  return `${proto}//${location.host}/ws/instance?${q}`;
}

export class InstanceClient implements InstanceConnection {
  readonly mode: string;
  readonly loaded: LoadedMode;
  readonly #opts: InstanceClientOptions;
  readonly #prediction: Prediction;
  readonly #subs = new Set<(view: InstanceView) => void>();
  #ws: SocketLike | null = null;
  #token = "";
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;
  #status: InstanceView["status"] = "connecting";
  /** True once the current socket received its join "state". */
  #joined = false;
  /** The next join discards the instance (restart() while not joined yet). */
  #fresh = false;
  #closed = false;
  #pingMs: number | null = null;
  #view: InstanceView;
  #worldFor: { snapshot: unknown; world: World | null } = { snapshot: null, world: null };

  constructor(opts: InstanceClientOptions) {
    this.mode = opts.mode;
    this.loaded = opts.loaded;
    this.#opts = opts;
    this.#prediction = new Prediction(opts.loaded);
    this.#view = this.#buildView();
    void this.#open();
  }

  getView(): InstanceView {
    return this.#view;
  }

  subscribe(cb: (view: InstanceView) => void): () => void {
    this.#subs.add(cb);
    return () => this.#subs.delete(cb);
  }

  act(name: string, payload: unknown): Promise<DispatchResult> {
    if (this.#closed) {
      return Promise.resolve({
        ok: false,
        error: { code: "closed", message: "connection closed" },
        events: [],
        tick: this.#prediction.view?.tick ?? 0,
      });
    }
    return new Promise<DispatchResult>((resolve) => {
      const entry = this.#prediction.enqueue(name, payload, resolve);
      if (this.#joined) this.#send({ t: "action", seq: entry.seq, name, payload });
      this.#emit();
    });
  }

  restart(): void {
    if (this.#closed) return;
    this.#prediction.dropPending("restarted", "the instance was restarted");
    this.#fresh = true;
    if (this.#ws?.readyState === OPEN) {
      // Results still in flight belong to the old instance: ignore them until the new state.
      this.#joined = false;
      this.#sendJoin();
    }
    this.#emit();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#teardown();
    this.#prediction.dropPending("closed", "connection closed");
    this.#status = "offline";
    this.#emit();
    this.#subs.clear();
    this.#opts.onClose?.();
  }

  async #open(): Promise<void> {
    if (this.#closed) return;
    this.#setStatus("connecting");
    let url: string;
    try {
      const session = await this.#opts.session();
      this.#token = session.token;
      this.#prediction.actor = session.accountId;
      url = (this.#opts.url ?? instanceUrl)(session.token, this.mode);
    } catch (err) {
      console.warn("instance: login failed", err);
      this.#scheduleReconnect();
      return;
    }
    if (this.#closed) return;
    const ws = (this.#opts.createSocket ?? defaultSocket)(url);
    this.#ws = ws;
    ws.onopen = () => {
      this.#sendJoin();
      this.#sendPing();
      this.#ping = setInterval(() => this.#sendPing(), PING_MS);
    };
    ws.onmessage = (ev) => {
      const msg = parseServerMessage(ev.data);
      if (!msg) {
        console.warn("instance: bad frame", ev.data);
        return;
      }
      this.#onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#teardown();
      if (ev.code === CLOSE_REPLACED) {
        // Another tab took over; reconnecting would just steal it back.
        this.#prediction.dropPending("replaced", "opened elsewhere");
        this.#prediction.error = { code: "replaced", message: "this game was opened elsewhere" };
        this.#setStatus("offline");
        return;
      }
      if (ev.code === CLOSE_UNAUTHORIZED) {
        this.#opts.onUnauthorized?.();
        this.#attempt = 0;
      }
      this.#scheduleReconnect();
    };
  }

  #onMessage(msg: InstanceServerMessage): void {
    switch (msg.t) {
      case "state": {
        if (msg.mode !== this.mode) return;
        const joining = !this.#joined;
        this.#joined = true;
        this.#fresh = false;
        this.#attempt = 0;
        this.#status = "online";
        const unsent = this.#prediction.onState(msg.lastSeq, msg.snapshot);
        if (msg.contentHash !== this.loaded.contentHash) {
          this.#prediction.error = {
            code: "client_outdated",
            message: "the game was updated; reload the page",
          };
        }
        // Only the join reply re-sends: later states (other players, fixed ticks) don't lose actions.
        if (joining) {
          for (const p of unsent) {
            this.#send({ t: "action", seq: p.seq, name: p.name, payload: p.payload });
          }
        }
        this.#emit();
        return;
      }
      case "result": {
        if (!this.#joined) return;
        const res = this.#prediction.onResult(msg);
        if (res?.mismatch) {
          console.debug(
            `instance: prediction mismatch at seq ${res.mismatch.seq}: predicted ${res.mismatch.predicted}, server ${res.mismatch.server}`,
          );
        }
        if (res) this.#emit();
        return;
      }
      case "pong":
        this.#pingMs = Math.max(0, this.#now() - msg.clientTime);
        this.#emit();
        return;
      case "error":
        this.#prediction.error = { code: msg.code, message: msg.message };
        this.#emit();
        return;
    }
  }

  #sendJoin(): void {
    this.#send({ t: "join", token: this.#token, mode: this.mode, fresh: this.#fresh });
  }

  #sendPing(): void {
    this.#send({ t: "ping", clientTime: this.#now() });
  }

  #send(msg: InstanceClientMessage): boolean {
    if (this.#ws?.readyState !== OPEN) return false;
    this.#ws.send(encodeClientMessage(msg));
    return true;
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#retry) return;
    this.#setStatus("offline");
    const delay = backoffDelay(this.#attempt++, 500, 10_000, this.#opts.random ?? Math.random);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#open();
    }, delay);
  }

  #teardown(): void {
    this.#joined = false;
    if (this.#ping) clearInterval(this.#ping);
    this.#ping = null;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      if (ws.readyState <= OPEN) ws.close();
    }
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  #setStatus(status: InstanceView["status"]): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit();
  }

  #buildView(): InstanceView {
    const snapshot = this.#prediction.view;
    if (this.#worldFor.snapshot !== snapshot) {
      let world: World | null = null;
      try {
        world = snapshot ? restoreWorld(snapshot.world) : null;
      } catch (err) {
        console.warn("instance: snapshot world could not be restored", err);
      }
      this.#worldFor = { snapshot, world };
    }
    return {
      status: this.#status,
      snapshot,
      world: this.#worldFor.world,
      events: this.#prediction.events,
      error: this.#prediction.error,
      pingMs: this.#pingMs,
    };
  }

  #emit(): void {
    this.#view = this.#buildView();
    for (const cb of this.#subs) {
      try {
        cb(this.#view);
      } catch (err) {
        console.error("instance: view subscriber failed", err);
      }
    }
  }
}

function defaultSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}
