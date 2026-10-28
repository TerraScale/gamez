/**
 * VerifiedConnection over /ws/instance for client-driven modes (wave-B.md
 * §2.3-§2.5): one socket to the player's InstanceDO "<mode>:<accountId>".
 * Reconnects with backoff, asks handlers.resume() before every join, unpacks
 * snapshots (async, so frames are handled through a promise queue to keep
 * their order), estimates the server clock from pings, and never blocks the
 * caller: submit() returns false while not online and the caller resends
 * after the next join.
 */
import type { SimSnapshot } from "@gamez/kernel";
import {
  packSnapshot,
  unpackSnapshot,
  type BankOp,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";
import type {
  SegmentSubmission,
  Session,
  VerifiedConnection,
  VerifiedHandlers,
  VerifiedStatus,
} from "@gamez/ui-host";
import { ClockSync } from "../clock.ts";
import { backoffDelay } from "../net.ts";
import { clearSession, getSession } from "../session.ts";
import { CLOSE_REPLACED, CLOSE_UNAUTHORIZED } from "./messages.ts";
import { instanceUrl, type SocketLike } from "./connection.ts";

/** Steady ping interval (clock estimate); the first pings after a join come faster. */
export const VERIFIED_PING_MS = 5000;
const WARMUP_PINGS_MS = [0, 400, 1200];

export interface VerifiedClientOptions {
  mode: string;
  /** Current session; called before each connect (it may log in again). */
  session(): Promise<Session> | Session;
  /** The server rejected the token (close 4401). */
  onUnauthorized?(): void;
  /** Socket URL for a token and mode (default: /ws/instance on this host). */
  url?: (token: string, mode: string) => string;
  /** WebSocket factory (tests pass a fake). */
  createSocket?: (url: string) => SocketLike;
  /** Client clock (epoch ms). */
  now?: () => number;
  /** Random source for the backoff jitter. */
  random?: () => number;
  /** Called once by close(). */
  onClose?(): void;
}

const OPEN = 1;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Decodes one server frame; null when it is not a verified-protocol message. */
export function parseVerifiedServerMessage(frame: unknown): VerifiedServerMessage | null {
  if (typeof frame !== "string") return null;
  let m: unknown;
  try {
    m = JSON.parse(frame);
  } catch {
    return null;
  }
  if (!isRecord(m)) return null;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const packed = (v: unknown) =>
    isRecord(v) && (v.enc === "json" || v.enc === "gzip64") && v.data !== undefined;
  switch (m.t) {
    case "vstate":
      return typeof m.instanceId === "string" &&
        typeof m.mode === "string" &&
        typeof m.contentHash === "string" &&
        num(m.epoch) &&
        num(m.tick) &&
        typeof m.hash === "string" &&
        typeof m.continued === "boolean" &&
        (m.snapshot === null || packed(m.snapshot)) &&
        isRecord(m.limits)
        ? (m as VerifiedServerMessage)
        : null;
    case "verified":
      return num(m.epoch) && num(m.seq) && num(m.tick) && typeof m.hash === "string"
        ? (m as VerifiedServerMessage)
        : null;
    case "resync":
      return num(m.epoch) &&
        num(m.seq) &&
        typeof m.code === "string" &&
        num(m.tick) &&
        typeof m.hash === "string" &&
        packed(m.snapshot)
        ? (m as VerifiedServerMessage)
        : null;
    case "pong":
      return num(m.clientTime) && num(m.serverTime) ? (m as VerifiedServerMessage) : null;
    case "error":
      return typeof m.code === "string" && typeof m.message === "string"
        ? (m as VerifiedServerMessage)
        : null;
    case "bank": {
      const r = m.result;
      const a = m.applied;
      const resultOk =
        isRecord(r) &&
        (r.ok === true
          ? num(r.balance)
          : r.ok === false && typeof r.code === "string" && typeof r.message === "string");
      const appliedOk =
        a === null ||
        (isRecord(a) && num(a.tick) && typeof a.name === "string" && typeof a.hash === "string");
      return typeof m.opId === "string" && resultOk && appliedOk
        ? (m as VerifiedServerMessage)
        : null;
    }
    default:
      return null;
  }
}

export class VerifiedClient implements VerifiedConnection {
  readonly mode: string;
  readonly #opts: VerifiedClientOptions;
  readonly #clock = new ClockSync();
  #handlers: VerifiedHandlers | null = null;
  #status: VerifiedStatus = "connecting";
  #ws: SocketLike | null = null;
  #token = "";
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #timers: ReturnType<typeof setTimeout>[] = [];
  #ping: ReturnType<typeof setInterval> | null = null;
  /** The current socket got its vstate (segments may flow). */
  #joined = false;
  /** The next join discards the instance (restart() while not online). */
  #fresh = false;
  #closed = false;
  #started = false;
  /** Serialises frame handling: unpacking a snapshot is async. */
  #queue: Promise<void> = Promise.resolve();
  /** Bumped per socket; queued frames of an older socket are dropped. */
  #generation = 0;

  constructor(opts: VerifiedClientOptions) {
    this.mode = opts.mode;
    this.#opts = opts;
  }

  get status(): VerifiedStatus {
    return this.#status;
  }

  start(handlers: VerifiedHandlers): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    this.#handlers = handlers;
    handlers.status(this.#status);
    void this.#open();
  }

  submit(seg: SegmentSubmission): boolean {
    if (this.#status !== "online") return false;
    return this.#send({
      t: "segment",
      epoch: seg.epoch,
      seq: seg.seq,
      fromTick: seg.fromTick,
      toTick: seg.toTick,
      inputs: seg.inputs,
      hash: seg.hash,
    });
  }

  sendBank(msg: { opId: string; op: BankOp; at: { tick: number; hash: string } }): boolean {
    if (this.#status !== "online") return false;
    return this.#send({ t: "bank", opId: msg.opId, op: msg.op, at: msg.at });
  }

  importSave(snapshot: SimSnapshot, savedAt: number): void {
    if (this.#closed) return;
    const gen = this.#generation;
    void packSnapshot(snapshot)
      .then((packed) => {
        if (gen !== this.#generation || this.#status !== "online") {
          this.#handlers?.error?.("offline", "import needs a connection");
          return;
        }
        this.#send({ t: "import", snapshot: packed, savedAt });
      })
      .catch((err: unknown) => {
        console.warn("verified: could not pack the save", err);
        this.#handlers?.error?.("import_failed", "the save could not be packed");
      });
  }

  restart(): void {
    if (this.#closed) return;
    this.#fresh = true;
    if (this.#ws?.readyState === OPEN && this.#token) {
      // Acks still in flight belong to the old game; the new vstate starts a new epoch anyway.
      this.#joined = false;
      this.#setStatus("connecting");
      this.#sendJoin();
    }
  }

  serverNow(): number {
    return this.#clock.serverNow(this.#now());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#teardown();
    this.#setStatus("closed");
    this.#handlers = null;
    this.#opts.onClose?.();
  }

  // ---- socket lifecycle ------------------------------------------------------

  async #open(): Promise<void> {
    if (this.#closed) return;
    this.#setStatus("connecting");
    let url: string;
    try {
      const session = await this.#opts.session();
      this.#token = session.token;
      url = (this.#opts.url ?? instanceUrl)(session.token, this.mode);
    } catch (err) {
      console.warn("verified: login failed", err);
      this.#scheduleReconnect();
      return;
    }
    if (this.#closed) return;
    const gen = ++this.#generation;
    const ws = (this.#opts.createSocket ?? defaultSocket)(url);
    this.#ws = ws;
    ws.onopen = () => {
      if (this.#ws !== ws) return;
      this.#sendJoin();
      for (const at of WARMUP_PINGS_MS) this.#timers.push(setTimeout(() => this.#sendPing(), at));
      this.#ping = setInterval(() => this.#sendPing(), VERIFIED_PING_MS);
    };
    ws.onmessage = (ev) => {
      const msg = parseVerifiedServerMessage(ev.data);
      if (!msg) {
        console.warn("verified: bad frame");
        return;
      }
      this.#queue = this.#queue
        .then(() => this.#onMessage(msg, gen))
        .catch((err: unknown) => {
          console.error("verified: handler failed", err);
        });
    };
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#teardown();
      if (ev.code === CLOSE_REPLACED) {
        // Another tab took over; reconnecting would just steal it back.
        this.#handlers?.error?.("replaced", "this game was opened elsewhere");
        this.#setStatus("closed");
        return;
      }
      if (ev.code === CLOSE_UNAUTHORIZED) {
        this.#opts.onUnauthorized?.();
        this.#attempt = 0;
      }
      this.#scheduleReconnect();
    };
  }

  async #onMessage(msg: VerifiedServerMessage, gen: number): Promise<void> {
    if (gen !== this.#generation || this.#closed) return;
    const h = this.#handlers;
    if (!h) return;
    switch (msg.t) {
      case "vstate": {
        if (msg.mode !== this.mode) return;
        const snapshot = msg.snapshot ? await unpackSnapshot(msg.snapshot) : null;
        if (gen !== this.#generation || this.#closed) return;
        this.#clock.seed(msg.serverTime, this.#now());
        this.#joined = true;
        this.#fresh = false;
        this.#attempt = 0;
        // Online before state(): the handler may resubmit its pending segments right away.
        const wasOnline = this.#status === "online";
        this.#status = "online";
        h.state({
          instanceId: msg.instanceId,
          epoch: msg.epoch,
          tick: msg.tick,
          hash: msg.hash,
          continued: msg.continued,
          snapshot,
          offline: msg.offline,
          imported: msg.imported,
          importable: msg.importable,
          limits: msg.limits,
        });
        if (!wasOnline) this.#notifyStatus();
        return;
      }
      case "verified":
        if (!this.#joined) return;
        h.verified({
          epoch: msg.epoch,
          seq: msg.seq,
          tick: msg.tick,
          hash: msg.hash,
          creditMs: msg.creditMs,
        });
        return;
      case "resync": {
        if (!this.#joined) return;
        const snapshot = await unpackSnapshot(msg.snapshot);
        if (gen !== this.#generation || this.#closed) return;
        h.resync({
          epoch: msg.epoch,
          seq: msg.seq,
          code: msg.code,
          message: msg.message,
          tick: msg.tick,
          hash: msg.hash,
          snapshot,
        });
        return;
      }
      case "pong":
        this.#clock.addSample(msg.clientTime, msg.serverTime, this.#now());
        return;
      case "error":
        h.error?.(msg.code, msg.message);
        return;
      case "bank":
        if (!this.#joined) return;
        h.bank?.({ opId: msg.opId, result: msg.result, applied: msg.applied });
        return;
    }
  }

  #sendJoin(): void {
    const msg: Extract<VerifiedClientMessage, { t: "join" }> = {
      t: "join",
      token: this.#token,
      mode: this.mode,
    };
    if (this.#fresh) {
      msg.fresh = true;
    } else {
      let resume: ReturnType<VerifiedHandlers["resume"]> = null;
      try {
        resume = this.#handlers?.resume() ?? null;
      } catch (err) {
        console.error("verified: resume() failed", err);
      }
      if (resume) msg.resume = { tick: resume.tick, hash: resume.hash, pending: resume.pending };
    }
    this.#send(msg);
  }

  #sendPing(): void {
    this.#send({ t: "ping", clientTime: this.#now() });
  }

  #send(msg: VerifiedClientMessage): boolean {
    const ws = this.#ws;
    if (ws?.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
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
    this.#generation++;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
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

  #setStatus(status: VerifiedStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#notifyStatus();
  }

  #notifyStatus(): void {
    const status = this.#status;
    try {
      this.#handlers?.status(status);
    } catch (err) {
      console.error("verified: status handler failed", err);
    }
  }
}

function defaultSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

/**
 * ClientServices.connectVerified: one VerifiedClient per call (the caller
 * closes it on unmount). A rejected token (4401) drops the cached session
 * so the next connect logs in again, like the instance connector.
 */
export function verifiedConnector(
  session: () => Session,
): ((mode: string) => VerifiedConnection) | undefined {
  let current: Session | null = null;
  let stale = false;
  return (mode) =>
    new VerifiedClient({
      mode,
      async session() {
        if (stale) {
          current ??= await getSession();
          return current;
        }
        return session();
      },
      onUnauthorized() {
        clearSession();
        stale = true;
        current = null;
      },
    });
}
