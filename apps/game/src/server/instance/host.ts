/**
 * The InstanceDO's logic without Workers APIs: message handling, sim
 * lifecycle, persistence and the fixed-tick loop. The DO adapts its
 * WebSockets, SQLite and alarm to the small interfaces below, so tests can
 * drive this class with in-memory fakes.
 *
 * All handlers are synchronous, so messages are processed strictly in
 * arrival order and a dispatch plus its persist can never interleave with
 * another message.
 */
import { createSim, type LoadedMode, type Sim, type SimSnapshot } from "@gamez/kernel";
import type { InstanceClientMessage, InstanceServerMessage } from "@gamez/protocol";
import { TokenBucket, type BucketSpec } from "../rate-limit.ts";
import { CLOSE_REPLACED, encodeServerMessage, parseClientMessage } from "./messages.ts";

/** Per-socket state; the DO keeps it in the WebSocket attachment so it survives hibernation. */
export interface SocketInfo {
  accountId: string;
  name: string;
  mode: string;
  /** True once this socket joined the instance. */
  joined: boolean;
}

export interface InstanceSocket {
  /** Current attachment. */
  readonly info: SocketInfo;
  setInfo(info: SocketInfo): void;
  send(frame: string): void;
  close(code: number, reason: string): void;
}

/** What the store keeps about the running sim. */
export interface StoredInstance {
  instanceId: string;
  seed: number;
  snapshot: SimSnapshot;
}

export interface InstanceStore {
  load(): StoredInstance | null;
  /** Players that joined, with the highest action seq applied for each. */
  players(): Map<string, number>;
  /** Writes the instance and, if given, one player's lastSeq in a single transaction. */
  save(instance: StoredInstance, player?: { accountId: string; lastSeq: number }): void;
}

export interface InstanceHostDeps {
  /** DO name ("<mode>:<accountId>"); prefix of instance ids. */
  name: string;
  loaded: LoadedMode;
  store: InstanceStore;
  /** Open sockets of this instance. */
  sockets(): InstanceSocket[];
  now(): number;
  /** Seed for a new sim (crypto random in the DO). */
  randomSeed(): number;
  setAlarm(at: number): void;
}

/** Per-socket action limit: burst 10, refilled at 10/s. */
export const ACTION_LIMIT: BucketSpec = { burst: 10, perSecond: 10 };
/** Pings are cheap but still bounded; excess ones are dropped silently. */
export const PING_LIMIT: BucketSpec = { burst: 3, perSecond: 1 };
/** Fixed modes: at most this often a "state" broadcast. */
export const BROADCAST_MS = 100;
/** Fixed modes: at most this often the ticking snapshot is persisted. */
export const PERSIST_MS = 1000;
/** Fixed modes: ticks run per alarm at most this many seconds behind; older backlog is dropped. */
export const MAX_CATCH_UP_S = 1;

interface Limits {
  action: TokenBucket;
  ping: TokenBucket;
}

export class InstanceHost {
  readonly #d: InstanceHostDeps;
  #sim: Sim | null = null;
  #instanceId = "";
  #seed = 0;
  #lastSeq: Map<string, number> | null = null;
  readonly #limits = new WeakMap<InstanceSocket, Limits>();
  // Fixed-tick loop.
  #ticking = false;
  #lastStepAt = 0;
  #lastBroadcast = Number.NEGATIVE_INFINITY;
  #lastPersist = Number.NEGATIVE_INFINITY;
  #dirty = false;

  constructor(deps: InstanceHostDeps) {
    this.#d = deps;
  }

  get mode(): string {
    return this.#d.loaded.mode.id;
  }

  /** The live sim, if loaded (tests). */
  get sim(): Sim | null {
    return this.#sim;
  }

  /** True while the fixed-tick alarm loop runs. */
  get ticking(): boolean {
    return this.#ticking;
  }

  handleMessage(socket: InstanceSocket, frame: string | ArrayBuffer): void {
    const msg = parseClientMessage(frame);
    if (!msg) {
      this.#send(socket, { t: "error", code: "bad_message", message: "invalid message" });
      return;
    }
    try {
      switch (msg.t) {
        case "ping":
          if (!this.#limitsOf(socket).ping.take(this.#d.now())) return;
          this.#send(socket, { t: "pong", clientTime: msg.clientTime, serverTime: this.#d.now() });
          return;
        case "join":
          this.#join(socket, msg);
          return;
        case "action":
          this.#action(socket, msg);
          return;
      }
    } catch (err) {
      console.error(`instance ${this.#d.name}: ${msg.t} failed`, err);
      this.#send(socket, { t: "error", code: "internal", message: `${msg.t} failed` });
    }
  }

  /** A socket closed. Persists ticking state when the last player leaves. */
  handleClose(socket: InstanceSocket): void {
    if (this.#joined().some((s) => s !== socket)) return;
    this.#persistIfDirty();
  }

  /** DO alarm: runs due ticks of a fixed mode, broadcasts and persists at bounded rates. */
  alarm(): void {
    const tick = this.#d.loaded.mode.tick;
    if (tick.kind !== "fixed") return;
    const now = this.#d.now();
    const joined = this.#joined();
    if (joined.length === 0) {
      this.#ticking = false;
      this.#persistIfDirty();
      return;
    }
    const { sim, changed } = this.#ensureSim(false);
    if (changed) this.#announceReset(joined);
    if (!this.#ticking) {
      // Woken after an eviction: restart the clock, no catch-up.
      this.#ticking = true;
      this.#lastStepAt = now;
    }
    const msPerTick = 1000 / tick.hz;
    const maxTicks = Math.max(1, Math.round(tick.hz * MAX_CATCH_UP_S));
    let n = Math.floor((now - this.#lastStepAt) / msPerTick);
    if (n > maxTicks) {
      n = maxTicks;
      this.#lastStepAt = now - n * msPerTick;
    }
    if (n > 0) {
      try {
        sim.step(n);
      } catch (err) {
        // The kernel rolled the sim back; retrying would fail the same way.
        console.error(`instance ${this.#d.name}: step failed`, err);
        this.#ticking = false;
        for (const s of joined) {
          this.#send(s, { t: "error", code: "sim_failed", message: "the simulation stopped" });
        }
        return;
      }
      this.#lastStepAt += n * msPerTick;
      this.#dirty = true;
      if (now - this.#lastBroadcast >= BROADCAST_MS) {
        this.#lastBroadcast = now;
        this.#broadcastState(joined);
      }
    }
    if (now - this.#lastPersist >= PERSIST_MS) this.#persistIfDirty();
    this.#d.setAlarm(Math.max(now + 1, this.#lastStepAt + msPerTick));
  }

  #join(socket: InstanceSocket, msg: Extract<InstanceClientMessage, { t: "join" }>): void {
    const info = socket.info;
    if (msg.mode !== info.mode || msg.mode !== this.mode) {
      this.#send(socket, {
        t: "error",
        code: "wrong_mode",
        message: `this connection is for mode "${info.mode}"`,
      });
      return;
    }
    const players = this.#players();
    const max = this.#d.loaded.mode.instance?.maxPlayers ?? 1;
    if (!players.has(info.accountId) && players.size >= max) {
      this.#send(socket, { t: "error", code: "instance_full", message: "the instance is full" });
      return;
    }

    const fresh = msg.fresh === true;
    const { sim, changed } = this.#ensureSim(fresh);
    if (!players.has(info.accountId)) {
      players.set(info.accountId, 0);
      this.#d.store.save(this.#stored(sim), { accountId: info.accountId, lastSeq: 0 });
    }

    // One live connection per player: the newest wins.
    for (const other of this.#d.sockets()) {
      if (other !== socket && other.info.accountId === info.accountId) {
        other.setInfo({ ...other.info, joined: false });
        other.close(CLOSE_REPLACED, "replaced by a newer connection");
      }
    }
    if (!info.joined) socket.setInfo({ ...info, joined: true });

    if (fresh || changed) {
      // Everyone in the instance sees the reset.
      const joined = this.#joined();
      if (changed) this.#announceReset(joined);
      this.#broadcastState(joined);
    } else {
      this.#sendState(socket, sim.snapshot());
    }
    this.#startTicking();
  }

  #action(socket: InstanceSocket, msg: Extract<InstanceClientMessage, { t: "action" }>): void {
    const info = socket.info;
    if (!info.joined) {
      this.#send(socket, { t: "error", code: "not_joined", message: "join before acting" });
      return;
    }
    const { sim, changed } = this.#ensureSim(false);
    const reject = (code: string, message: string) =>
      this.#send(socket, {
        t: "result",
        seq: msg.seq,
        ok: false,
        error: { code, message },
        events: [],
        snapshot: sim.snapshot(),
      });
    if (changed) {
      this.#announceReset(this.#joined());
      this.#broadcastState(this.#joined());
      reject("content_changed", "the game was updated; the instance restarted");
      return;
    }
    if (!this.#limitsOf(socket).action.take(this.#d.now())) {
      reject("rate_limited", "too many actions");
      return;
    }
    const players = this.#players();
    if (msg.seq <= (players.get(info.accountId) ?? 0)) {
      reject("stale_seq", `action ${msg.seq} was already handled`);
      return;
    }

    const res = sim.dispatch(msg.name, msg.payload, info.accountId);
    players.set(info.accountId, msg.seq);
    if (res.ok) {
      try {
        this.#d.store.save(this.#stored(sim), { accountId: info.accountId, lastSeq: msg.seq });
        this.#dirty = false;
        this.#lastPersist = this.#d.now();
      } catch (err) {
        // Memory is ahead of storage: drop it and answer with the stored state.
        console.error(`instance ${this.#d.name}: persist failed`, err);
        this.#sim = null;
        this.#lastSeq = null;
        const restored = this.#ensureSim(false).sim;
        this.#send(socket, {
          t: "result",
          seq: msg.seq,
          ok: false,
          error: { code: "internal", message: "could not save the action" },
          events: [],
          snapshot: restored.snapshot(),
        });
        return;
      }
    }

    const snapshot = sim.snapshot();
    this.#send(socket, {
      t: "result",
      seq: msg.seq,
      ok: res.ok,
      ...(res.error ? { error: res.error } : {}),
      events: res.events,
      snapshot,
    });
    if (res.ok) {
      const others = this.#joined().filter((s) => s !== socket);
      if (others.length > 0) this.#broadcastState(others, snapshot);
    }
  }

  /**
   * The live sim: cached, else restored from storage, else new (and stored).
   * `changed` is true when a stored instance had to be dropped because the
   * mode's content changed since it was saved.
   */
  #ensureSim(fresh: boolean): { sim: Sim; changed: boolean } {
    if (!fresh && this.#sim) return { sim: this.#sim, changed: false };
    const { loaded } = this.#d;
    let changed = false;
    if (!fresh) {
      const stored = this.#d.store.load();
      if (stored) {
        const snap = stored.snapshot;
        if (snap.modeId === loaded.mode.id && snap.contentHash === loaded.contentHash) {
          try {
            const sim = createSim(loaded, { seed: stored.seed, from: snap });
            this.#sim = sim;
            this.#instanceId = stored.instanceId;
            this.#seed = stored.seed;
            this.#dirty = false;
            return { sim, changed: false };
          } catch (err) {
            console.warn(`instance ${this.#d.name}: stored snapshot unusable`, err);
          }
        }
        changed = true;
      }
    }
    const seed = this.#d.randomSeed() >>> 0;
    const sim = createSim(loaded, { seed });
    this.#sim = sim;
    this.#seed = seed;
    this.#instanceId = `${this.#d.name}:${seed.toString(16).padStart(8, "0")}`;
    this.#d.store.save(this.#stored(sim));
    this.#dirty = false;
    this.#lastPersist = this.#d.now();
    return { sim, changed };
  }

  #stored(sim: Sim): StoredInstance {
    return { instanceId: this.#instanceId, seed: this.#seed, snapshot: sim.snapshot() };
  }

  #players(): Map<string, number> {
    this.#lastSeq ??= this.#d.store.players();
    return this.#lastSeq;
  }

  #joined(): InstanceSocket[] {
    return this.#d.sockets().filter((s) => s.info.joined);
  }

  #limitsOf(socket: InstanceSocket): Limits {
    let l = this.#limits.get(socket);
    if (!l) {
      const now = this.#d.now();
      l = { action: new TokenBucket(ACTION_LIMIT, now), ping: new TokenBucket(PING_LIMIT, now) };
      this.#limits.set(socket, l);
    }
    return l;
  }

  #startTicking(): void {
    const tick = this.#d.loaded.mode.tick;
    if (tick.kind !== "fixed" || this.#ticking) return;
    this.#ticking = true;
    const now = this.#d.now();
    this.#lastStepAt = now;
    this.#d.setAlarm(now + 1000 / tick.hz);
  }

  #persistIfDirty(): void {
    if (!this.#dirty || !this.#sim) return;
    this.#d.store.save(this.#stored(this.#sim));
    this.#dirty = false;
    this.#lastPersist = this.#d.now();
  }

  #announceReset(sockets: InstanceSocket[]): void {
    for (const s of sockets) {
      this.#send(s, {
        t: "error",
        code: "content_changed",
        message: "the game was updated; your previous instance could not be resumed",
      });
    }
  }

  #sendState(socket: InstanceSocket, snapshot: SimSnapshot): void {
    this.#send(socket, {
      t: "state",
      instanceId: this.#instanceId,
      mode: this.mode,
      contentHash: this.#d.loaded.contentHash,
      lastSeq: this.#players().get(socket.info.accountId) ?? 0,
      snapshot,
    });
  }

  #broadcastState(sockets: InstanceSocket[], snapshot?: SimSnapshot): void {
    if (sockets.length === 0 || !this.#sim) return;
    const snap = snapshot ?? this.#sim.snapshot();
    for (const s of sockets) this.#sendState(s, snap);
  }

  #send(socket: InstanceSocket, msg: InstanceServerMessage): void {
    try {
      socket.send(encodeServerMessage(msg));
    } catch {
      // Socket went away; its close handler cleans up.
    }
  }
}
