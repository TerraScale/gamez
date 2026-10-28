/**
 * ServerSync: the server-backed classic client (wave-B.md §2.5-§2.7).
 *
 * The browser keeps running the sim locally (ping never affects play). This
 * class sits beside the game (GameDeps.server hooks) and
 *   - records every successful dispatch in a SegmentRecorder and cuts a
 *     segment right after a step every limits.segmentEveryMs or when it is
 *     full, then submits it fire-and-forget over the VerifiedConnection;
 *   - keeps the unacked segments (in order) and the last verified tick/hash;
 *     `verified` drops what was acked, `resync` replaces the sim with the
 *     server's snapshot, a non-continued `vstate` adopts the server state
 *     (unless the local sim provably descends from it);
 *   - stops recording (overflow) beyond limits.maxPendingTicks, so the next
 *     join adopts the server state plus its offline grant;
 *   - writes a per-account cache (sync/cache.ts) so a reload starts instantly;
 *   - imports the legacy local save once (§2.7);
 *   - restarts the server instance for a new game and replays the inputs made
 *     on the placeholder sim onto the server's fresh one.
 *
 * It never mutates a sim except through dispatch/step, never dispatches
 * server-only actions and never waits for the network.
 */
import {
  createSim,
  SegmentRecorder,
  type GameEvent,
  type LoadedMode,
  type SegmentInput,
  type Sim,
  type SimSnapshot,
} from "@gamez/kernel";
import type {
  VerifiedAck,
  VerifiedConnection,
  VerifiedHandlers,
  VerifiedResync,
  VerifiedState,
  VerifiedStatus,
} from "@gamez/ui-host";
import type { Settings, Store, SyncView, Toast } from "../contract.ts";
import type { ServerHooks } from "../game.ts";
import type { KeyValueStorage, LegacyImport } from "../persist.ts";
import {
  readSyncCache,
  writeSyncCache,
  type PendingSegment,
  type SyncCacheRecord,
} from "./cache.ts";

/** Actor of client inputs on both sides (protocol VERIFIED_ACTOR; the sim never reads it). */
export const SYNC_ACTOR = "local";
/** Limits used until the first vstate brings the server's (same values as the server defaults). */
export const DEFAULT_LIMITS: VerifiedState["limits"] = {
  maxTicksPerSegment: 400,
  maxInputsPerSegment: 256,
  segmentEveryMs: 2000,
  maxPendingTicks: 12_000,
  creditCapMs: 15 * 60_000,
};
/** Without a cache, wait this long for the server before falling back to local mode. */
export const BOOT_TIMEOUT_MS = 8000;
/** A tab hidden this long reconnects on return so the server can grant offline progress. */
export const HIDDEN_RECONNECT_MS = 60_000;
/** SyncView refresh period while ticking. */
const VIEW_EVERY_MS = 500;

export const SYNC_TEXT = {
  resyncTitle: "Progress corrected by the server",
  resyncBody: "Your hero was restored to the last verified state",
  replacedTitle: "Progress restored from the server",
  replacedBody: "Recent progress on this device could not be verified and was replaced",
  importTitle: "Your hero now lives on your account",
  importBody: "Your local save was moved to the server",
  versionTitle: "A new version is available",
  versionBody: "Reload the page to keep your progress saved",
  fallbackTitle: "Server unavailable",
  fallbackBody: "Playing locally on this device",
} as const;

/** The game as ServerSync sees it (ClassicGame implements it). */
export interface SyncHost {
  currentSim(): Sim;
  replaceSim(next: Sim): void;
  emit(events: readonly GameEvent[]): void;
  notify(kind: Toast["kind"], title: string, body: string, ms?: number): void;
  log(text: string): void;
}

export interface ServerSyncOptions {
  loaded: LoadedMode;
  accountId: string;
  /** Opens a connection (called again for a deliberate reconnect). */
  connect(): VerifiedConnection;
  /** localStorage (or a fake); null = no cache. */
  storage: KeyValueStorage | null;
  /** Performance clock (ms): cut timing. */
  now(): number;
  /** Wall clock (ms): cache and resync timestamps. */
  wall(): number;
  /** The legacy local save to import once (§2.7), and how to retire it after the import. */
  legacy?: { load(): LegacyImport | null; markMigrated(): void } | null;
  /** Timers (tests inject fakes). */
  setTimer?(cb: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** Result of boot(): the sim to start with and how it was obtained. */
export interface SyncBoot {
  sim: Sim;
  /** "cache": started from the local cache; "server": from the first vstate. */
  from: "cache" | "server";
  /** Settings of the cache or of the imported legacy save (null: keep defaults). */
  settings: Settings | null;
}

interface MutableStore<T> {
  store: Store<T>;
  get(): T;
  set(v: T): void;
}

function makeStore<T>(initial: T): MutableStore<T> {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    store: {
      getSnapshot: () => value,
      subscribe(cb) {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
    },
    get: () => value,
    set(v) {
      if (v === value) return;
      value = v;
      for (const cb of subs) cb();
    },
  };
}

function sameView(a: SyncView, b: SyncView): boolean {
  return (
    a.mode === b.mode &&
    a.status === b.status &&
    a.verifiedTick === b.verifiedTick &&
    a.pendingTicks === b.pendingTicks &&
    a.overflow === b.overflow &&
    a.lastResync === b.lastResync &&
    a.imported === b.imported
  );
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class ServerSync implements ServerHooks {
  readonly #opts: ServerSyncOptions;
  readonly #serverOnly: ReadonlySet<string>;
  readonly #view = makeStore<SyncView>({
    mode: "server",
    status: "connecting",
    verifiedTick: 0,
    pendingTicks: 0,
    overflow: false,
    lastResync: null,
    imported: false,
  });

  #conn: VerifiedConnection | null = null;
  /** Connection generation: callbacks of a closed connection are ignored. */
  #gen = 0;
  #host: SyncHost | null = null;
  #recorder = new SegmentRecorder(0);
  #pending: PendingSegment[] = [];
  #verified: { tick: number; hash: string } | null = null;
  #epoch = -1;
  #seq = 0;
  #limits: VerifiedState["limits"] = DEFAULT_LIMITS;
  #status: VerifiedStatus = "connecting";
  #overflow = false;
  /** newGame sent connection.restart(); the next vstate is the fresh instance. */
  #restarting = false;
  /** Gave up (stale client content): plays on without recording or saving. */
  #detached = false;
  #destroyed = false;
  #imported = false;
  #lastCutAt: number;
  #lastViewAt = Number.NEGATIVE_INFINITY;
  #lastResync: SyncView["lastResync"] = null;
  #creditMs: number | null = null;
  /** Boot without a cache: waiting for the first usable vstate. */
  #boot: {
    resolve(b: SyncBoot | null): void;
    timer: unknown;
    importing: LegacyImport | null;
    fallback: VerifiedState | null;
  } | null = null;
  /** Offline events of the boot vstate, fanned out once the game is attached. */
  #bootEvents: GameEvent[] = [];
  #bootToasts: [string, string][] = [];
  /** Started from the cache: connect once the game is attached. */
  #connectOnAttach = false;
  /** A vstate that arrived after boot but before attach. */
  #early: VerifiedState | null = null;
  /** A legacy import whose answer is still out (after a boot timeout). */
  #importInFlight = false;

  constructor(opts: ServerSyncOptions) {
    this.#opts = opts;
    this.#serverOnly = new Set(opts.loaded.mode.instance?.clientDriven?.serverOnlyActions ?? []);
    this.#lastCutAt = opts.now();
  }

  // ---- public state ------------------------------------------------------------

  /** api.sync */
  get view(): Store<SyncView> {
    return this.#view.store;
  }

  /** Debug / QA summary (window.__gamez.sync). */
  debugInfo(): Record<string, unknown> {
    const sim = this.#host?.currentSim();
    return {
      ...this.#view.get(),
      localTick: sim?.tick ?? null,
      verifiedHash: this.#verified?.hash ?? null,
      pendingSegments: this.#pending.length,
      pendingSegmentTicks: this.#pendingSegmentTicks(),
      openFromTick: this.#recorder.fromTick,
      openInputs: this.#recorder.inputs.length,
      epoch: this.#epoch,
      seq: this.#seq,
      restarting: this.#restarting,
      detached: this.#detached,
      creditMs: this.#creditMs,
      limits: this.#limits,
    };
  }

  get epoch(): number {
    return this.#epoch;
  }

  get pending(): readonly PendingSegment[] {
    return this.#pending;
  }

  get verified(): { tick: number; hash: string } | null {
    return this.#verified;
  }

  get recorder(): SegmentRecorder {
    return this.#recorder;
  }

  get status(): VerifiedStatus {
    return this.#status;
  }

  // ---- boot --------------------------------------------------------------------

  /**
   * Starts the connection and resolves the sim to play: instantly from the
   * account's cache when it has one, else from the first vstate (after the
   * legacy save import round trip), or null after `timeoutMs` without a server.
   */
  boot(timeoutMs = BOOT_TIMEOUT_MS): Promise<SyncBoot | null> {
    const cache = readSyncCache(
      this.#opts.storage,
      this.#opts.accountId,
      this.#opts.loaded.contentHash,
    );
    if (cache !== null) {
      const sim = this.#startFromCache(cache);
      if (sim !== null) {
        this.#connectOnAttach = true;
        return Promise.resolve({ sim, from: "cache", settings: cache.settings });
      }
    }
    return new Promise<SyncBoot | null>((resolve) => {
      const timer = this.#setTimer(() => {
        const b = this.#boot;
        if (!b) return;
        this.#boot = null;
        // An import answer that never came: start from the server state we have.
        if (b.importing !== null) this.#importInFlight = true;
        if (b.fallback) resolve(this.#bootFrom(b.fallback, null));
        else resolve(null);
      }, timeoutMs);
      this.#boot = { resolve, timer, importing: null, fallback: null };
      this.#connect();
    });
  }

  /** Connects the game (after boot). Fans out what the boot state brought. */
  attach(host: SyncHost): void {
    this.#host = host;
    if (this.#bootEvents.length > 0) {
      host.emit(this.#bootEvents);
      this.#bootEvents = [];
    }
    for (const [title, body] of this.#bootToasts) host.notify("info", title, body);
    this.#bootToasts = [];
    this.#updateView(true);
    if (this.#connectOnAttach) {
      this.#connectOnAttach = false;
      this.#connect();
    }
    const early = this.#early;
    this.#early = null;
    if (early) this.#guard(() => this.#onState(early));
  }

  #startFromCache(cache: SyncCacheRecord): Sim | null {
    let sim: Sim;
    try {
      sim = createSim(this.#opts.loaded, { seed: 0, from: cache.snapshot });
    } catch {
      return null;
    }
    this.#verified = { ...cache.verified };
    this.#pending = cache.pending.map((p) => ({ ...p, inputs: [...p.inputs] }));
    this.#seq = this.#pending.reduce((m, p) => Math.max(m, p.seq), 0);
    this.#overflow = cache.overflow;
    this.#imported = cache.imported;
    this.#recorder = new SegmentRecorder(cache.open.fromTick);
    if (!cache.overflow) {
      for (const i of cache.open.inputs) this.#recorder.record(i.tick, i.name, i.payload);
    }
    return sim;
  }

  #bootFrom(s: VerifiedState, legacy: LegacyImport | null): SyncBoot | null {
    if (s.snapshot === null) return null;
    let sim: Sim;
    try {
      sim = createSim(this.#opts.loaded, { seed: 0, from: s.snapshot });
    } catch {
      this.#detach();
      return null;
    }
    this.#acceptState(s, sim);
    if (s.offline) this.#bootEvents = [...s.offline.events];
    return { sim, from: "server", settings: legacy?.settings ?? null };
  }

  #onBootState(s: VerifiedState): void {
    const b = this.#boot;
    if (!b) return;
    if (b.importing !== null) {
      // The answer to our import (or a reconnect state while it was in flight).
      const legacy = b.importing;
      if (s.imported) {
        this.#opts.legacy?.markMigrated();
        this.#bootToasts.push([SYNC_TEXT.importTitle, SYNC_TEXT.importBody]);
      }
      this.#finishBoot(this.#bootFrom(s, s.imported ? legacy : null));
      return;
    }
    if (s.importable && s.snapshot !== null) {
      const legacy = this.#opts.legacy?.load() ?? null;
      if (legacy !== null && this.#conn) {
        b.importing = legacy;
        b.fallback = s;
        this.#conn.importSave(legacy.snapshot, legacy.savedAt);
        return;
      }
    }
    this.#finishBoot(this.#bootFrom(s, null));
  }

  #finishBoot(result: SyncBoot | null): void {
    const b = this.#boot;
    if (!b) return;
    this.#boot = null;
    this.#clearTimer(b.timer);
    b.resolve(result);
  }

  // ---- connection --------------------------------------------------------------

  #connect(): void {
    if (this.#destroyed || this.#detached) return;
    const gen = ++this.#gen;
    const live = (): boolean => gen === this.#gen && !this.#destroyed;
    const handlers: VerifiedHandlers = {
      resume: () => (live() ? this.#resume() : null),
      state: (s) => {
        if (live()) this.#guard(() => this.#onState(s));
      },
      verified: (a) => {
        if (live()) this.#guard(() => this.#onVerified(a));
      },
      resync: (r) => {
        if (live()) this.#guard(() => this.#onResync(r));
      },
      status: (st) => {
        if (live()) this.#guard(() => this.#onStatus(st));
      },
      error: (code, message) => {
        if (live()) this.#guard(() => this.#onError(code, message));
      },
    };
    try {
      this.#conn = this.#opts.connect();
      this.#conn.start(handlers);
    } catch (err) {
      this.#conn = null;
      this.#status = "offline";
      this.#host?.log(`Server connection failed: ${errText(err)}`);
      this.#updateView(true);
    }
  }

  /** Closes the socket and joins again (asks resume() anew). */
  reconnect(): void {
    if (this.#destroyed || this.#detached) return;
    try {
      this.#conn?.close();
    } catch {
      // Already closed.
    }
    this.#conn = null;
    this.#status = "connecting";
    this.#connect();
  }

  #guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#host?.log(`Server sync error: ${errText(err)}`);
    }
  }

  #resume(): { tick: number; hash: string; pending: boolean } | null {
    if (this.#restarting || this.#overflow || this.#verified === null || this.#boot !== null) {
      return null;
    }
    return {
      tick: this.#verified.tick,
      hash: this.#verified.hash,
      pending: this.#pending.length > 0,
    };
  }

  #onStatus(st: VerifiedStatus): void {
    this.#status = st;
    this.#updateView(true);
  }

  #onError(code: string, message: string): void {
    this.#host?.log(`Server: ${code} ${message}`.trim());
    const b = this.#boot;
    if (b && b.importing !== null && b.fallback !== null) {
      // The import was refused: keep the server's state and the legacy save as it is.
      const fallback = b.fallback;
      b.importing = null;
      this.#finishBoot(this.#bootFrom(fallback, null));
    }
  }

  /** Records a server state as the verified base, starting a new epoch. */
  #acceptState(s: { epoch: number; tick: number; hash: string }, sim: Sim): void {
    this.#epoch = s.epoch;
    this.#verified = { tick: s.tick, hash: s.hash };
    this.#pending = [];
    this.#overflow = false;
    this.#recorder.reset(sim.tick);
    this.#lastCutAt = this.#opts.now();
  }

  #onState(s: VerifiedState): void {
    this.#limits = s.limits;
    this.#imported = s.imported;
    if (this.#boot) {
      this.#epoch = s.epoch;
      this.#onBootState(s);
      return;
    }
    const host = this.#host;
    if (!host) {
      this.#early = s;
      return;
    }
    this.#epoch = s.epoch;
    if (this.#importInFlight && s.imported) {
      this.#importInFlight = false;
      this.#opts.legacy?.markMigrated();
      host.notify("info", SYNC_TEXT.importTitle, SYNC_TEXT.importBody);
    }
    if (this.#restarting) {
      this.#restarting = false;
      this.#rebase(s, host);
      return;
    }
    if (s.continued) {
      this.#verified = { tick: s.tick, hash: s.hash };
      this.#resend();
      this.#updateView(true);
      return;
    }
    if (!this.#overflow && s.offline === null) {
      // The local sim may still descend from the server's state: an acked
      // segment whose ack was lost, or the verified state itself.
      if (this.#verified && s.tick === this.#verified.tick && s.hash === this.#verified.hash) {
        this.#resend();
        this.#updateView(true);
        return;
      }
      const i = this.#pending.findIndex((p) => p.toTick === s.tick && p.hash === s.hash);
      if (i >= 0) {
        this.#pending.splice(0, i + 1);
        this.#verified = { tick: s.tick, hash: s.hash };
        this.#resend();
        this.#updateView(true);
        return;
      }
    }
    if (s.snapshot === null) {
      // continued=false always carries a snapshot; nothing to adopt otherwise.
      this.#host?.log("Server state without a snapshot ignored");
      return;
    }
    const lost = this.#pending.length > 0 || this.#overflow;
    if (!this.#adopt(s, s.snapshot, host)) return;
    if (s.offline && s.offline.events.length > 0) host.emit(s.offline.events);
    if (lost) host.notify("info", SYNC_TEXT.replacedTitle, SYNC_TEXT.replacedBody);
  }

  /** Replaces the local sim with a server snapshot. False when it cannot restore (detached). */
  #adopt(
    s: { epoch: number; tick: number; hash: string },
    snapshot: SimSnapshot,
    host: SyncHost,
  ): boolean {
    const cur = host.currentSim();
    if (
      cur.tick === s.tick &&
      this.#pending.length === 0 &&
      this.#recorder.inputs.length === 0 &&
      cur.hash() === s.hash
    ) {
      // Already identical: keep the sim (no scene reset).
      this.#acceptState(s, cur);
      this.#updateView(true);
      return true;
    }
    let sim: Sim;
    try {
      sim = createSim(this.#opts.loaded, { seed: 0, from: snapshot });
    } catch (err) {
      host.log(`Server state does not restore: ${errText(err)}`);
      host.notify("info", SYNC_TEXT.versionTitle, SYNC_TEXT.versionBody);
      this.#detach();
      return false;
    }
    this.#acceptState(s, sim);
    host.replaceSim(sim);
    this.#updateView(true);
    return true;
  }

  #onVerified(a: VerifiedAck): void {
    if (a.epoch !== this.#epoch || this.#restarting) return;
    this.#creditMs = a.creditMs;
    const i = this.#pending.findIndex((p) => p.toTick === a.tick);
    if (i < 0) return;
    this.#pending.splice(0, i + 1);
    this.#verified = { tick: a.tick, hash: a.hash };
    this.#updateView(true);
  }

  #onResync(r: VerifiedResync): void {
    const host = this.#host;
    if (!host || this.#restarting || this.#boot) {
      if (!this.#boot) this.#epoch = r.epoch;
      return;
    }
    this.#lastResync = { code: r.code, message: r.message, at: this.#opts.wall() };
    host.log(`Server resync (${r.code}): ${r.message}`);
    if (this.#adopt(r, r.snapshot, host)) {
      host.notify("info", SYNC_TEXT.resyncTitle, SYNC_TEXT.resyncBody);
    }
  }

  /** Re-sends every pending segment in order with the current epoch (after a join). */
  #resend(): void {
    const conn = this.#conn;
    if (!conn || this.#epoch < 0) return;
    for (const p of this.#pending) {
      if (!conn.submit({ ...p, epoch: this.#epoch })) break;
    }
  }

  #detach(): void {
    this.#detached = true;
    this.#gen++;
    try {
      this.#conn?.close();
    } catch {
      // Already closed.
    }
    this.#conn = null;
    this.#status = "offline";
    this.#updateView(true);
  }

  // ---- new game ----------------------------------------------------------------

  /** ServerHooks.newGame: restarts the server instance; plays a placeholder until it answers. */
  newGame(seed: number): Sim {
    const placeholder = createSim(this.#opts.loaded, { seed });
    this.#pending = [];
    this.#overflow = false;
    this.#recorder.reset(placeholder.tick);
    this.#lastCutAt = this.#opts.now();
    if (this.#detached || !this.#conn) return placeholder;
    this.#restarting = true;
    this.#verified = null;
    this.#imported = false;
    try {
      this.#conn.restart();
    } catch (err) {
      this.#host?.log(`Server restart failed: ${errText(err)}`);
    }
    this.#updateView(true);
    return placeholder;
  }

  /** The fresh server state arrived: replay the placeholder's inputs on it. */
  #rebase(s: VerifiedState, host: SyncHost): void {
    if (s.snapshot === null) {
      this.#host?.log("Fresh server state without a snapshot ignored");
      return;
    }
    const placeholder = host.currentSim();
    const inputs: SegmentInput[] = [...this.#recorder.inputs];
    let sim: Sim;
    try {
      sim = createSim(this.#opts.loaded, { seed: 0, from: s.snapshot });
    } catch (err) {
      host.log(`Server state does not restore: ${errText(err)}`);
      host.notify("info", SYNC_TEXT.versionTitle, SYNC_TEXT.versionBody);
      this.#detach();
      return;
    }
    this.#acceptState(s, sim);
    const target = placeholder.tick;
    try {
      for (const input of inputs) {
        this.#advanceRecorded(sim, input.tick);
        const tick = sim.tick;
        const res = sim.dispatch(input.name, input.payload, SYNC_ACTOR);
        if (res.ok) this.#recorder.record(tick, input.name, input.payload);
      }
      this.#advanceRecorded(sim, target);
    } catch (err) {
      host.log(`Replaying the new game on the server state failed: ${errText(err)}`);
    }
    host.replaceSim(sim);
    if (s.offline && s.offline.events.length > 0) host.emit(s.offline.events);
    this.#updateView(true);
  }

  /** Steps `sim` up to tick `to` in segment-sized chunks, cutting full segments. */
  #advanceRecorded(sim: Sim, to: number): void {
    while (sim.tick < to) {
      const n = Math.min(to - sim.tick, this.room(sim));
      sim.step(n);
      if (sim.tick - this.#recorder.fromTick >= this.#limits.maxTicksPerSegment) {
        this.#cut(sim);
      }
    }
  }

  // ---- ServerHooks ---------------------------------------------------------------

  get #recording(): boolean {
    return !this.#detached && !this.#overflow && !this.#destroyed;
  }

  refuse(name: string): { code: string; message: string } | null {
    if (this.#serverOnly.has(name)) {
      return { code: "server_only", message: "Only the server grants this" };
    }
    if (this.#recording && this.#recorder.inputs.length >= this.#limits.maxInputsPerSegment) {
      return { code: "busy", message: "Too many actions at once" };
    }
    return null;
  }

  dispatched(tick: number, name: string, payload: unknown): void {
    if (!this.#recording) return;
    this.#recorder.record(tick, name, payload);
  }

  room(sim: Sim): number {
    if (!this.#recording || this.#restarting) return Number.POSITIVE_INFINITY;
    return Math.max(1, this.#limits.maxTicksPerSegment - (sim.tick - this.#recorder.fromTick));
  }

  stepped(sim: Sim, nowMs: number): void {
    if (!this.#recording || this.#restarting) return;
    const span = sim.tick - this.#recorder.fromTick;
    if (
      span >= this.#limits.maxTicksPerSegment ||
      nowMs - this.#lastCutAt >= this.#limits.segmentEveryMs ||
      this.#recorder.inputs.length >= this.#limits.maxInputsPerSegment / 2
    ) {
      this.#cut(sim);
    }
    if (nowMs - this.#lastViewAt >= VIEW_EVERY_MS) this.#updateView(false);
  }

  /** Closes the open segment (right after a step) and submits it. */
  #cut(sim: Sim): void {
    const seg = this.#recorder.cut(sim);
    if (seg === null) return;
    this.#lastCutAt = this.#opts.now();
    const p: PendingSegment = { ...seg, seq: ++this.#seq };
    this.#pending.push(p);
    if (this.#pendingSegmentTicks() > this.#limits.maxPendingTicks) {
      // Stop recording: the next join adopts the server state (and its offline grant).
      this.#overflow = true;
      this.#host?.log("Too much unverified progress: the server state will replace it");
      this.#updateView(true);
      if (this.#status === "online") this.reconnect();
      return;
    }
    if (!this.#restarting && this.#epoch >= 0 && this.#status === "online" && this.#conn) {
      this.#conn.submit({ ...p, epoch: this.#epoch });
    }
    this.#updateView(true);
  }

  #pendingSegmentTicks(): number {
    const last = this.#pending.at(-1);
    return last && this.#verified ? last.toTick - this.#verified.tick : 0;
  }

  // ---- page life -------------------------------------------------------------------

  /**
   * Cuts and submits the open segment when that is legal now (no input at the
   * current tick, i.e. nothing dispatched since the last step). Tab hide, unmount.
   */
  flush(): void {
    const sim = this.#host?.currentSim();
    if (!sim || !this.#recording || this.#restarting) return;
    if (this.#recorder.inputs.some((i) => i.tick >= sim.tick)) return;
    this.#cut(sim);
  }

  /**
   * The tab became visible after `hiddenMs`. After a long absence with
   * nothing pending, rejoin so the server can grant offline progress.
   */
  visible(hiddenMs: number): void {
    if (hiddenMs < HIDDEN_RECONNECT_MS || this.#restarting || this.#detached) return;
    if (this.#pending.length > 0 || this.#overflow) return;
    if (this.#status === "online") this.reconnect();
  }

  /** Writes the cache (game.save in server mode). False when skipped or refused. */
  persist(snapshot: SimSnapshot, settings: Settings): boolean {
    if (this.#detached || this.#restarting || this.#boot || this.#verified === null) return false;
    const rec: SyncCacheRecord = {
      v: 1,
      accountId: this.#opts.accountId,
      contentHash: this.#opts.loaded.contentHash,
      savedAt: this.#opts.wall(),
      settings,
      snapshot,
      verified: { ...this.#verified },
      pending: this.#pending,
      open: { fromTick: this.#recorder.fromTick, inputs: [...this.#recorder.inputs] },
      overflow: this.#overflow,
      imported: this.#imported,
    };
    if (this.#overflow) {
      rec.pending = [];
      rec.open = { fromTick: snapshot.tick, inputs: [] };
    }
    return writeSyncCache(this.#opts.storage, rec);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#gen++;
    const b = this.#boot;
    if (b) {
      this.#boot = null;
      this.#clearTimer(b.timer);
      b.resolve(null);
    }
    try {
      this.#conn?.close();
    } catch {
      // Already closed.
    }
    this.#conn = null;
  }

  // ---- view --------------------------------------------------------------------

  #updateView(force: boolean): void {
    const now = this.#opts.now();
    if (!force && now - this.#lastViewAt < VIEW_EVERY_MS) return;
    this.#lastViewAt = now;
    const sim = this.#host?.currentSim();
    const verifiedTick = this.#verified?.tick ?? 0;
    const next: SyncView = {
      mode: "server",
      status:
        this.#detached || this.#status === "closed"
          ? "offline"
          : (this.#status as SyncView["status"]),
      verifiedTick,
      pendingTicks: sim && this.#verified !== null ? Math.max(0, sim.tick - verifiedTick) : 0,
      overflow: this.#overflow,
      lastResync: this.#lastResync,
      imported: this.#imported,
    };
    if (!sameView(next, this.#view.get())) this.#view.set(next);
  }

  #setTimer(cb: () => void, ms: number): unknown {
    return this.#opts.setTimer ? this.#opts.setTimer(cb, ms) : globalThis.setTimeout(cb, ms);
  }

  #clearTimer(h: unknown): void {
    if (this.#opts.clearTimer) this.#opts.clearTimer(h);
    else globalThis.clearTimeout(h as ReturnType<typeof setTimeout>);
  }
}
