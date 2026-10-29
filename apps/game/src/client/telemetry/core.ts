/**
 * Telemetry state machine (docs/design/admin-dashboard.md §9). OWNER: T-telemetry.
 *
 * Everything the browser provides arrives through `TelemetryEnv`, so the
 * batching, heartbeat, perf and error rules are testable with fake globals.
 * Nothing here throws into the app: every entry point is wrapped.
 */
import {
  TELEMETRY_LIMITS,
  type TelemetryBatch,
  type TelemetryEvent,
  type ClientDevice,
  type ClientPlatform,
} from "@gamez/protocol";
import { FrameSampler, type FrameSource } from "./sampler.ts";
import { normaliseMessage } from "./normalise.ts";

export interface TelemetryContext {
  /** Bearer token of the signed-in session ("" for none). */
  token: string;
  /** Mode the player is in ("" outside a mode). */
  mode: string;
  /** contentHash of that mode ("" outside a mode). */
  contentHash: string;
}

export interface TelemetryEnv {
  /** Random per page load; never an account id. */
  sid: string;
  build: string;
  endpoint: string;
  platform: ClientPlatform;
  device: ClientDevice;
  /** Epoch ms. */
  now(): number;
  /** Milliseconds since navigation start (performance.now()). */
  perfNow(): number;
  /** Uniform in [0, 1); decides the perf sample once per session. */
  random(): number;
  /** True while the page is visible. */
  visible(): boolean;
  /** JS heap in MB, 0 when unknown. */
  memoryMb(): number;
  /** Sends one batch with keepalive fetch; the promise may reject (ignored). */
  fetch(
    url: string,
    init: { method: "POST"; keepalive: true; headers: Record<string, string>; body: string },
  ): Promise<unknown> | void;
  /** Sends one batch with sendBeacon; false when the browser refused it. */
  sendBeacon(url: string, body: string): boolean;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** requestAnimationFrame source, or null when the page has none. */
  frames: FrameSource | null;
}

export const HEARTBEAT_MS = TELEMETRY_LIMITS.heartbeatMs;
export const BATCH_EVENTS = TELEMETRY_LIMITS.maxEvents;
export const ERRORS_PER_MINUTE = 5;
/** Minimum frames in a window before a perf event is worth sending. */
export const MIN_PERF_SAMPLES = 10;
const MAX_QUEUE = 200;

/** Whether this session is one of the perf-sampled sessions (decided once per session). */
export function decidePerfSample(random: number): boolean {
  return random < TELEMETRY_LIMITS.perfSampleRate;
}

/** lengthBand input: whole visible seconds (floor). */
export function activeSeconds(activeMs: number): number {
  return Math.max(0, Math.floor(activeMs / 1000));
}

export class TelemetryCore {
  readonly #env: TelemetryEnv;
  readonly #sampler: FrameSampler | null;
  #ctx: TelemetryContext = { token: "", mode: "", contentHash: "" };
  #queue: TelemetryEvent[] = [];
  #visible: boolean;
  #visibleSince: number | null = null;
  #activeMs = 0;
  #timer: unknown = null;
  #started = false;
  #ended = false;
  #lastError = "";
  readonly #errorTimes: number[] = [];

  constructor(env: TelemetryEnv) {
    this.#env = env;
    this.#visible = false;
    const sampled = decidePerfSample(env.random());
    this.#sampler = sampled && env.frames ? new FrameSampler(env.frames) : null;
  }

  /** True when this session sends perf events (for tests and the boot log). */
  get perfEnabled(): boolean {
    return this.#sampler !== null;
  }

  get pending(): number {
    return this.#queue.length;
  }

  /** Starts the session: session.start is sent now, then a heartbeat every HEARTBEAT_MS. */
  start(): void {
    if (this.#started || this.#ended) return;
    this.#started = true;
    this.#visible = this.#env.visible();
    if (this.#visible) this.#visibleSince = this.#env.now();
    this.#push({
      k: "session.start",
      platform: this.#env.platform,
      device: this.#env.device,
      loadMs: this.#env.perfNow(),
    });
    // Sent right away (one small request), so a session that crashes or is
    // killed before the first heartbeat still counts.
    this.#flush(false);
    this.#timer = this.#env.setInterval(() => this.#tick(), HEARTBEAT_MS);
    this.#syncSampler();
  }

  /** Sets the token, mode and contentHash (called when the session or mode changes). */
  setContext(next: Partial<TelemetryContext>): void {
    try {
      this.#ctx = {
        token: typeof next.token === "string" ? next.token : this.#ctx.token,
        mode: typeof next.mode === "string" ? next.mode : this.#ctx.mode,
        contentHash:
          typeof next.contentHash === "string" ? next.contentHash : this.#ctx.contentHash,
      };
      this.#syncSampler();
    } catch {
      // Telemetry never throws into the app.
    }
  }

  /** Visibility changed. Hidden time is not counted as session time. */
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    const now = this.#env.now();
    if (visible) {
      this.#visibleSince = now;
    } else {
      if (this.#visibleSince !== null) this.#activeMs += Math.max(0, now - this.#visibleSince);
      this.#visibleSince = null;
      this.#flush(false);
    }
    this.#visible = visible;
    this.#syncSampler();
  }

  /** An error to report (kind "error" | "unhandledrejection" | "render"). Dropped silently when over budget. */
  reportError(kind: "error" | "unhandledrejection" | "render", raw: unknown): void {
    try {
      if (!this.#started || this.#ended) return;
      const message = normaliseMessage(raw);
      if (message === this.#lastError) return;
      const now = this.#env.now();
      while (this.#errorTimes.length && now - (this.#errorTimes[0] ?? 0) >= 60_000)
        this.#errorTimes.shift();
      if (this.#errorTimes.length >= ERRORS_PER_MINUTE) return;
      this.#errorTimes.push(now);
      this.#lastError = message;
      this.#push({ k: "error", kind, message });
    } catch {
      // Telemetry never throws into the app.
    }
  }

  /** Page hide: closes the session and sends everything with sendBeacon. Idempotent. */
  end(): void {
    if (!this.#started || this.#ended) return;
    this.#ended = true;
    const now = this.#env.now();
    if (this.#visibleSince !== null) {
      this.#activeMs += Math.max(0, now - this.#visibleSince);
      this.#visibleSince = null;
    }
    this.#takePerf();
    this.#queue.push({
      k: "session.end",
      elapsedS: activeSeconds(this.#activeMs),
      mode: this.#ctx.mode,
    });
    this.#flush(true);
    if (this.#timer !== null) this.#env.clearInterval(this.#timer);
    this.#timer = null;
    this.#sampler?.setActive(false);
  }

  /** The heartbeat: a session.heartbeat while visible, the perf window, then a flush. */
  #tick(): void {
    try {
      if (this.#visible) {
        this.#push({
          k: "session.heartbeat",
          elapsedS: activeSeconds(this.#currentActiveMs()),
          mode: this.#ctx.mode,
          visible: true,
        });
      }
      this.#takePerf();
      this.#flush(false);
    } catch {
      // Telemetry never throws into the app.
    }
  }

  #currentActiveMs(): number {
    const now = this.#env.now();
    return (
      this.#activeMs + (this.#visibleSince !== null ? Math.max(0, now - this.#visibleSince) : 0)
    );
  }

  /** Turns the frame window into a perf event (only inside a mode). */
  #takePerf(): void {
    const sampler = this.#sampler;
    if (!sampler || this.#ctx.mode === "") return;
    const summary = sampler.take(MIN_PERF_SAMPLES);
    if (!summary) return;
    this.#push({
      k: "perf",
      mode: this.#ctx.mode,
      fpsP50: summary.fpsP50,
      fpsP95: summary.fpsP95,
      frameMsP95: summary.frameMsP95,
      samples: summary.samples,
      heapMb: this.#env.memoryMb(),
    });
  }

  /** Frames are sampled only while visible, in a mode and in a sampled session. */
  #syncSampler(): void {
    const sampler = this.#sampler;
    if (!sampler) return;
    const want = this.#started && !this.#ended && this.#visible && this.#ctx.mode !== "";
    sampler.setActive(want);
  }

  #push(event: TelemetryEvent): void {
    if (this.#queue.length >= MAX_QUEUE) this.#queue.shift();
    this.#queue.push(event);
    if (this.#queue.length >= BATCH_EVENTS) this.#flush(false);
  }

  /** Sends the queue in batches of at most BATCH_EVENTS. Failures are dropped. */
  #flush(beacon: boolean): void {
    while (this.#queue.length > 0) {
      const events = this.#queue.splice(0, BATCH_EVENTS);
      this.#send(events, beacon);
    }
  }

  #send(events: TelemetryEvent[], beacon: boolean): void {
    const batch: TelemetryBatch = {
      v: 1,
      sid: this.#env.sid,
      build: this.#env.build,
      contentHash: this.#ctx.contentHash,
      events,
    };
    const body = JSON.stringify(batch);
    const url = this.#env.endpoint;
    try {
      if (beacon && this.#env.sendBeacon(url, body)) return;
    } catch {
      // fall through to fetch
    }
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.#ctx.token) headers.authorization = `Bearer ${this.#ctx.token}`;
      const pending = this.#env.fetch(url, { method: "POST", keepalive: true, headers, body });
      if (pending && typeof pending.catch === "function") pending.catch(() => undefined);
    } catch {
      // Dropped: no retry loop.
    }
  }
}
