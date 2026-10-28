/**
 * One pose bot of the presence swarm (docs/design/wave-C.md §12): a guest
 * that joins a client-pose world over /ws, random-walks inside it and reports
 * poses at a fixed rate, and measures what it receives.
 *
 * Latency is measured two ways:
 * - end to end: every pose carries its send time in the cosmetic tag
 *   ("lt-<epoch ms>", tag.ts); a bot receiving another bot's upsert records
 *   receive time - send time. All bots of a run share the host clock, so this
 *   needs no clock sync and is the pose -> delivery latency players see.
 * - server stamp: receive time (moved to the server clock with the ping
 *   offset) - the upsert's pathStartedAt. The chunk back-dates pathStartedAt
 *   when it continues a walk (presence/pose.ts continueWalk), so this is an
 *   upper bound of chunk -> client latency, reported for comparison.
 */
import type { ClientMessage, EntityId, ServerMessage, TilePos } from "@gamez/protocol";
// The same codec constant the browser client uses, so the swarm follows a wire-format switch.
import { codec } from "../../../apps/game/src/shared/codec.ts";
import { Histogram } from "./stats.ts";
import { latencyTag, parseLatencyTag } from "./tag.ts";

export { TAG_PREFIX } from "./tag.ts";
const PING_EVERY_MS = 5000;
const WALK_SPEED = 4;
const MAX_PATH = 8;
const EDGE = 2;

export interface BotOptions {
  url: string;
  world: string;
  poseHz: number;
  width: number;
  height: number;
  /** Abort a join that takes longer than this (ms). */
  joinTimeoutMs?: number;
}

/** Counters and histograms shared by every bot of one thread; reset per measurement window. */
export class SwarmSink {
  readonly e2e = new Histogram();
  readonly server = new Histogram();
  frames = 0;
  bytes = 0;
  /** Upserts of other bots received. */
  upserts = 0;
  removes = 0;
  posesSent = 0;
  errors: Record<string, number> = {};
  closes = 0;
  since = Date.now();

  error(code: string): void {
    this.errors[code] = (this.errors[code] ?? 0) + 1;
  }

  reset(): void {
    this.e2e.reset();
    this.server.reset();
    this.frames = 0;
    this.bytes = 0;
    this.upserts = 0;
    this.removes = 0;
    this.posesSent = 0;
    this.errors = {};
    this.closes = 0;
    this.since = Date.now();
  }
}

export interface Guest {
  token: string;
  accountId: string;
  name: string;
}

export async function newGuest(url: string): Promise<Guest> {
  const res = await fetch(`${url}/api/guest`, { method: "POST" });
  if (!res.ok) throw new Error(`guest login failed: HTTP ${res.status}`);
  return (await res.json()) as Guest;
}

export class PoseBot {
  readonly opts: BotOptions;
  readonly sink: SwarmSink;
  guest: Guest | null = null;
  selfId: EntityId | null = null;
  /** Ids of everything else in the world this bot currently knows about (players and fixtures). */
  readonly others = new Map<EntityId, string>();
  joinMs = Number.NaN;
  wsMs = Number.NaN;
  /** Server time - local time, from the lowest-RTT ping so far. */
  clockOffset = 0;
  #bestRtt = Number.POSITIVE_INFINITY;
  #ws: WebSocket | null = null;
  #timers: ReturnType<typeof setInterval>[] = [];
  #stopping = false;
  #tile: TilePos;
  #route: TilePos[] = [];
  #carry = 0;
  readonly #listeners = new Set<(m: ServerMessage) => void>();

  constructor(opts: BotOptions, sink: SwarmSink) {
    this.opts = opts;
    this.sink = sink;
    this.#tile = this.#randomTile();
  }

  /** How many other entities of `kind` this bot knows about. */
  count(kind: string): number {
    let n = 0;
    for (const k of this.others.values()) if (k === kind) n++;
    return n;
  }

  /** Guest login, socket, welcome. Resolves with the join time in ms (login start -> welcome). */
  async join(): Promise<number> {
    const started = performance.now();
    this.guest = await newGuest(this.opts.url);
    const wsStarted = performance.now();
    const base = this.opts.url.replace(/^http/, "ws");
    const ws = new WebSocket(
      `${base}/ws?token=${encodeURIComponent(this.guest.token)}&world=${encodeURIComponent(this.opts.world)}`,
    );
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    const welcome = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("welcome timed out")),
        this.opts.joinTimeoutMs ?? 30_000,
      );
      const off = this.on((m) => {
        if (m.t !== "welcome") return;
        clearTimeout(timer);
        off();
        resolve();
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error("closed before welcome"));
      });
    });
    ws.addEventListener("message", (ev: MessageEvent<string | ArrayBuffer>) =>
      this.#onFrame(ev.data),
    );
    ws.addEventListener("close", () => {
      if (!this.#stopping) this.sink.closes++;
    });
    ws.addEventListener("error", () => {
      if (!this.#stopping) this.sink.error("ws-error");
    });
    await welcome;
    const now = performance.now();
    this.joinMs = now - started;
    this.wsMs = now - wsStarted;
    return this.joinMs;
  }

  /** Starts walking and posing (with a random phase so bots don't pose in lockstep), plus pings. */
  start(): void {
    const every = 1000 / this.opts.poseHz;
    const phase = setTimeout(() => {
      this.#pose();
      this.#timers.push(setInterval(() => this.#pose(), every));
    }, Math.random() * every);
    this.#timers.push(phase as unknown as ReturnType<typeof setInterval>);
    this.#ping();
    this.#timers.push(setInterval(() => this.#ping(), PING_EVERY_MS));
  }

  /** Subscribes to decoded server messages; returns the unsubscribe function. */
  on(fn: (m: ServerMessage) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  send(msg: ClientMessage): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(codec.encodeClient(msg) as string | Uint8Array<ArrayBuffer>);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    const ws = this.#ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((r) => ws.addEventListener("close", () => r()));
    ws.close(1000, "bye");
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))]);
  }

  #onFrame(data: string | ArrayBuffer): void {
    const now = Date.now();
    this.sink.frames++;
    // String length = bytes for the ASCII JSON frames the swarm produces.
    this.sink.bytes += typeof data === "string" ? data.length : data.byteLength;
    let msg: ServerMessage;
    try {
      msg = codec.decodeServer(data);
    } catch {
      this.sink.error("decode");
      return;
    }
    switch (msg.t) {
      case "welcome":
        this.selfId = msg.selfId;
        this.others.clear();
        for (const e of msg.entities) if (e.id !== msg.selfId) this.others.set(e.id, e.kind);
        break;
      case "delta":
        for (const id of msg.removes) {
          if (this.others.delete(id)) this.sink.removes++;
        }
        for (const e of msg.upserts) {
          if (e.id === this.selfId) continue;
          this.others.set(e.id, e.kind);
          if (e.kind !== "player") continue;
          this.sink.upserts++;
          const sent = parseLatencyTag(e.tag);
          if (sent !== null) this.sink.e2e.add(now - sent);
          this.sink.server.add(now + this.clockOffset - e.pathStartedAt);
        }
        break;
      case "pong": {
        const rtt = now - msg.clientTime;
        if (rtt < this.#bestRtt) {
          this.#bestRtt = rtt;
          this.clockOffset = msg.serverTime - (msg.clientTime + now) / 2;
        }
        break;
      }
      case "error":
        this.sink.error(msg.code);
        break;
    }
    for (const fn of this.#listeners) fn(msg);
  }

  #ping(): void {
    this.send({ t: "ping", clientTime: Date.now() });
  }

  /** Advances the random walk by one pose interval and reports the pose. */
  #pose(): void {
    this.#carry += WALK_SPEED / this.opts.poseHz;
    while (this.#carry >= 1) {
      this.#carry -= 1;
      if (this.#route.length === 0) this.#route = this.#routeTo(this.#randomTile());
      const next = this.#route.shift();
      if (next) this.#tile = next;
    }
    if (this.#route.length === 0) this.#route = this.#routeTo(this.#randomTile());
    this.send({
      t: "pose",
      pos: this.#tile,
      path: this.#route.slice(0, MAX_PATH),
      speed: WALK_SPEED,
      appearance: "unit.hero",
      tag: latencyTag(Date.now()),
    });
    this.sink.posesSent++;
  }

  #randomTile(): TilePos {
    const span = (n: number) => EDGE + Math.floor(Math.random() * Math.max(1, n - 2 * EDGE));
    return { x: span(this.opts.width), y: span(this.opts.height) };
  }

  /** Chebyshev steps from the current tile to `to` (excluding the current tile). */
  #routeTo(to: TilePos): TilePos[] {
    const out: TilePos[] = [];
    let { x, y } = this.#tile;
    while (x !== to.x || y !== to.y) {
      x += Math.sign(to.x - x);
      y += Math.sign(to.y - y);
      out.push({ x, y });
    }
    return out;
  }
}
