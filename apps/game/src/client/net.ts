import type { ClientMessage, ServerMessage } from "@gamez/protocol";
import { CLOSE_UNAUTHORIZED, codec } from "../shared/codec.ts";
import type { ClockSync } from "./clock.ts";

export type NetStatus = "connecting" | "online" | "offline";

export interface ConnectionOptions {
  /** Builds the socket URL (may log in first). */
  url(): Promise<string>;
  clock: ClockSync;
  onMessage(msg: ServerMessage): void;
  onStatus(status: NetStatus): void;
  /** The server rejected our token; drop it so `url()` logs in again. */
  onUnauthorized(): void;
}

/** Steady-state ping interval; the first few pings after connecting go faster. */
const PING_MS = 2000;
const WARMUP_PINGS = [0, 300, 700];

/** Exponential backoff with full jitter: random in [0, min(max, base * 2^attempt)]. */
export function backoffDelay(
  attempt: number,
  base = 500,
  max = 10_000,
  rand = Math.random,
): number {
  return Math.round(rand() * Math.min(max, base * 2 ** attempt));
}

/**
 * One logical connection to the relay: reconnects with backoff, pings to keep
 * the clock estimate fresh, and decodes frames with the shared codec.
 */
export class Connection {
  #ws: WebSocket | null = null;
  #attempt = 0;
  #timers: ReturnType<typeof setTimeout>[] = [];
  #retry: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(readonly opts: ConnectionOptions) {}

  start(): void {
    this.#stopped = false;
    void this.#open();
  }

  stop(): void {
    this.#stopped = true;
    this.#teardown();
    this.opts.onStatus("offline");
  }

  send(msg: ClientMessage): boolean {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(codec.encodeClient(msg));
    return true;
  }

  /** Drops the socket and reconnects right away to get a fresh welcome. */
  resync(): void {
    this.#teardown();
    this.#attempt = 0;
    void this.#open();
  }

  async #open(): Promise<void> {
    if (this.#stopped) return;
    this.opts.onStatus("connecting");
    let url: string;
    try {
      url = await this.opts.url();
    } catch (err) {
      console.warn("login failed", err);
      this.#scheduleReconnect();
      return;
    }
    if (this.#stopped) return;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.onopen = () => this.#startPings();
    ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
      let msg: ServerMessage;
      try {
        msg = codec.decodeServer(ev.data);
      } catch (err) {
        console.warn("bad frame", err);
        return;
      }
      if (msg.t === "pong") {
        this.opts.clock.addSample(msg.clientTime, msg.serverTime, Date.now());
      } else if (msg.t === "welcome") {
        this.#attempt = 0;
        this.opts.onStatus("online");
      }
      this.opts.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#teardown();
      if (ev.code === CLOSE_UNAUTHORIZED) {
        this.opts.onUnauthorized();
        this.#attempt = 0;
      }
      this.#scheduleReconnect();
    };
  }

  #startPings(): void {
    const ping = () => this.send({ t: "ping", clientTime: Date.now() });
    for (const at of WARMUP_PINGS) this.#timers.push(setTimeout(ping, at));
    this.#timers.push(setInterval(ping, PING_MS));
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#retry) return;
    this.opts.onStatus("offline");
    const delay = backoffDelay(this.#attempt++);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#open();
    }, delay);
  }

  #teardown(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }
}
