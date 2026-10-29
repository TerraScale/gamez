/**
 * Client-side prediction for instance modes: action seqs, the queue of
 * actions the server has not answered yet, and reconciliation.
 *
 * The view snapshot is always "authoritative snapshot + pending actions
 * replayed on a local sim". The server wins: every state/result replaces the
 * authoritative snapshot and the pending actions are replayed on top of it.
 * No sockets or timers here, so it is unit-testable.
 */
import {
  createSim,
  stableHash,
  type DispatchResult,
  type GameEvent,
  type LoadedMode,
  type Sim,
  type SimSnapshot,
} from "@gamez/kernel";

export interface PendingAction {
  seq: number;
  name: string;
  payload: unknown;
  /** Hash of the predicted state right after this action; null when not predicted. */
  predictedHash: string | null;
  /** The predicted `ok`; null when not predicted. */
  predictedOk: boolean | null;
  /**
   * True once this action's events were handed to consumers (its predicted batch).
   * A server result that confirms the prediction then adds no events again.
   */
  shown: boolean;
  /** Settles the promise returned by act(). */
  resolve(res: DispatchResult): void;
}

export interface Mismatch {
  seq: number;
  predicted: string;
  server: string;
}

export class Prediction {
  /** Player id the server uses as actor (the account id). */
  actor: string | null = null;
  #authoritative: SimSnapshot | null = null;
  #view: SimSnapshot | null = null;
  #pending: PendingAction[] = [];
  #nextSeq = 1;
  #events: GameEvent[] = [];
  #error: { code: string; message: string } | null = null;
  /** Set when snapshots cannot be restored locally (client and server modules differ). */
  #predictable = true;

  constructor(readonly loaded: LoadedMode) {}

  /** Snapshot the UI shows: authoritative plus predicted pending actions. */
  get view(): SimSnapshot | null {
    return this.#view;
  }

  get authoritative(): SimSnapshot | null {
    return this.#authoritative;
  }

  get pending(): readonly PendingAction[] {
    return this.#pending;
  }

  get events(): GameEvent[] {
    return this.#events;
  }

  get error(): { code: string; message: string } | null {
    return this.#error;
  }

  set error(e: { code: string; message: string } | null) {
    this.#error = e;
  }

  get nextSeq(): number {
    return this.#nextSeq;
  }

  /** False once a server snapshot did not match the local modules. */
  get predictable(): boolean {
    return this.#predictable;
  }

  /** Queues an action with the next seq and predicts it on a copy of the view. */
  enqueue(name: string, payload: unknown, resolve: (res: DispatchResult) => void): PendingAction {
    const entry: PendingAction = {
      seq: this.#nextSeq++,
      name,
      payload,
      predictedHash: null,
      predictedOk: null,
      shown: false,
      resolve,
    };
    this.#pending.push(entry);
    const sim = this.#view ? this.#simFrom(this.#view) : null;
    if (sim) {
      const res = sim.dispatch(name, payload, this.actor);
      entry.predictedHash = sim.hash();
      entry.predictedOk = res.ok;
      if (res.ok) {
        this.#view = sim.snapshot();
        this.#events = res.events;
        entry.shown = true;
        this.#error = null;
      } else {
        this.#error = res.error ?? null;
      }
    }
    return entry;
  }

  /**
   * Adopts a "state". Pending actions with seq <= lastSeq were already
   * applied by the server (their results were lost with a socket) and are
   * resolved without events. Returns the pending actions still to be sent.
   */
  onState(lastSeq: number, snapshot: SimSnapshot): PendingAction[] {
    this.#nextSeq = Math.max(this.#nextSeq, lastSeq + 1);
    this.#authoritative = snapshot;
    const done = this.#pending.filter((p) => p.seq <= lastSeq);
    this.#pending = this.#pending.filter((p) => p.seq > lastSeq);
    for (const p of done) p.resolve({ ok: true, events: [], tick: snapshot.tick });
    this.#rebuild();
    return [...this.#pending];
  }

  /**
   * Adopts a "result" for a pending action. Returns null (and changes nothing)
   * when no pending action has this seq, else the prediction mismatch if any.
   */
  onResult(msg: {
    seq: number;
    ok: boolean;
    error?: { code: string; message: string };
    events: GameEvent[];
    snapshot: SimSnapshot;
  }): { mismatch: Mismatch | null } | null {
    const idx = this.#pending.findIndex((p) => p.seq === msg.seq);
    if (idx < 0) return null;
    // Older pending actions without a result cannot be answered any more.
    const lost = this.#pending.slice(0, idx);
    const entry = this.#pending[idx]!;
    this.#pending = this.#pending.slice(idx + 1);
    this.#authoritative = msg.snapshot;

    let mismatch: Mismatch | null = null;
    if (entry.predictedHash !== null) {
      const server = stableHash(msg.snapshot);
      if (server !== entry.predictedHash) {
        mismatch = { seq: msg.seq, predicted: entry.predictedHash, server };
      }
    }
    this.#error = msg.ok ? null : (msg.error ?? { code: "rejected", message: "action rejected" });
    // A confirmed prediction keeps the batch already shown (no second log of the same
    // action). A mismatch, a different `ok`, or an action never shown delivers the server's events.
    // The one re-log case is a mismatch, whose predicted events were already shown.
    const confirmed =
      entry.predictedHash !== null && mismatch === null && entry.predictedOk === msg.ok;
    if (!(confirmed && entry.shown)) this.#events = msg.events;
    this.#rebuild();

    const error = { code: "lost", message: "no result from the server" };
    for (const p of lost) p.resolve({ ok: false, error, events: [], tick: msg.snapshot.tick });
    entry.resolve({
      ok: msg.ok,
      ...(msg.error ? { error: msg.error } : {}),
      events: msg.events,
      tick: msg.snapshot.tick,
    });
    return { mismatch };
  }

  /** Rejects every pending action with `code` (restart, close). */
  dropPending(code: string, message: string): void {
    const dropped = this.#pending;
    this.#pending = [];
    this.#view = this.#authoritative;
    const tick = this.#authoritative?.tick ?? 0;
    for (const p of dropped) p.resolve({ ok: false, error: { code, message }, events: [], tick });
  }

  /** Replays the pending actions on the authoritative snapshot. */
  #rebuild(): void {
    this.#view = this.#authoritative;
    if (!this.#authoritative || this.#pending.length === 0) return;
    const sim = this.#simFrom(this.#authoritative);
    if (!sim) return;
    // Replaying does not touch #events: the events of actions already shown stay as they are.
    for (const p of this.#pending) {
      const res = sim.dispatch(p.name, p.payload, this.actor);
      p.predictedHash = sim.hash();
      p.predictedOk = res.ok;
    }
    this.#view = sim.snapshot();
  }

  #simFrom(snapshot: SimSnapshot): Sim | null {
    if (!this.#predictable) return null;
    try {
      // The seed is unused: the RNG state comes from the snapshot.
      return createSim(this.loaded, { seed: 0, from: snapshot });
    } catch (err) {
      this.#predictable = false;
      console.warn("instance: cannot restore server snapshots locally, prediction off", err);
      return null;
    }
  }
}
