/**
 * Input segments for client-driven fixed-tick modes (docs/design/wave-B.md §2).
 *
 * The client runs the sim locally and records every SUCCESSFUL dispatch with
 * the sim tick it was made at (dispatch at tick T happens between step()s,
 * while sim.tick === T). After a step() it may cut a segment: the inputs for
 * ticks [fromTick, toTick) plus sim.hash() at toTick. The server replays the
 * segment on its copy of the sim with replaySegment() and compares hashes.
 *
 * Replay semantics (identical on both sides, by construction):
 *   for each input in order: step(input.tick - sim.tick); dispatch(input)
 *   then step(toTick - sim.tick); hash()
 * step(k) is exactly k step(1)s, so where the client cut its step() calls does
 * not matter. Inputs at the same tick keep their recorded order.
 *
 * Mechanics only: the mode supplies the limits and speedOf (ClientDrivenPolicy).
 */
import { stableHash } from "./hash.ts";
import type { GameEvent, Sim, World } from "./types.ts";

/** One successful dispatch the client made at sim tick `tick`. */
export interface SegmentInput {
  tick: number;
  name: string;
  /** Plain JSON (the recorder stores the JSON round trip of what was dispatched). */
  payload: unknown;
}

/** Inputs for ticks [fromTick, toTick). */
export interface SegmentBody {
  fromTick: number;
  toTick: number;
  inputs: SegmentInput[];
}

/** A segment as the client sends it: the body plus sim.hash() at toTick. */
export interface RecordedSegment extends SegmentBody {
  hash: string;
}

export type ReplayErrorCode =
  /** Shape or limits: ticks out of order or range, too many ticks/inputs, fromTick != sim.tick. */
  | "bad_segment"
  /** An input names a server-only action. */
  | "server_only_action"
  /** An input was rejected by the sim (ok=false): the client and server diverged. */
  | "input_rejected"
  /** step() threw (a system failed). */
  | "step_failed"
  /** Replay finished but the hash differs from the client's. */
  | "hash_mismatch";

export type ReplayOutcome =
  | {
      ok: true;
      /** sim.hash() at toTick. */
      hash: string;
      /** Wall time the segment claims: sum over ticks of msPerTick / speed. */
      costMs: number;
    }
  | {
      ok: false;
      code: ReplayErrorCode;
      message: string;
      /** Sim tick where the replay stopped. */
      tick: number;
      /** Server hash at toTick (hash_mismatch only). */
      hash?: string;
      /** Cost of the ticks replayed so far. */
      costMs: number;
    };

export interface ReplayOptions {
  /** Actor passed to dispatch (VERIFIED_ACTOR on both sides). */
  actor: string | null;
  maxTicks: number;
  maxInputs: number;
  serverOnly?: ReadonlySet<string>;
  /** Speed multiplier for the coming ticks; default 1. Clamped to [1, maxSpeed]. */
  speedOf?: (world: World) => number;
  maxSpeed?: number;
  /** When given, a different final hash is reported as hash_mismatch. */
  expectHash?: string;
  /**
   * Observer of the events of every step and successful dispatch, in order
   * (analytics). Must not touch the sim. Called before the outcome is known:
   * callers buffer and drop the events when the replay fails.
   */
  onEvents?: (events: readonly GameEvent[]) => void;
}

/** Shape and limit checks only (no sim work). Null when the segment is acceptable. */
export function checkSegment(
  seg: SegmentBody,
  fromTick: number,
  opts: Pick<ReplayOptions, "maxTicks" | "maxInputs" | "serverOnly">,
): { code: ReplayErrorCode; message: string } | null {
  const bad = (message: string) => ({ code: "bad_segment" as const, message });
  if (!Number.isSafeInteger(seg.fromTick) || !Number.isSafeInteger(seg.toTick))
    return bad("ticks must be integers");
  if (seg.fromTick !== fromTick)
    return bad(`segment starts at ${seg.fromTick}, sim is at ${fromTick}`);
  const span = seg.toTick - seg.fromTick;
  if (span < 1) return bad("a segment covers at least one tick");
  if (span > opts.maxTicks) return bad(`segment covers ${span} ticks (max ${opts.maxTicks})`);
  if (!Array.isArray(seg.inputs)) return bad("inputs must be an array");
  if (seg.inputs.length > opts.maxInputs)
    return bad(`segment has ${seg.inputs.length} inputs (max ${opts.maxInputs})`);
  let last = seg.fromTick;
  for (const input of seg.inputs) {
    if (!Number.isSafeInteger(input.tick)) return bad("input tick must be an integer");
    if (input.tick < last) return bad("input ticks must not decrease");
    if (input.tick >= seg.toTick) return bad(`input at tick ${input.tick} is not before toTick`);
    if (typeof input.name !== "string" || input.name.length === 0) return bad("input name");
    if (opts.serverOnly?.has(input.name))
      return { code: "server_only_action", message: `"${input.name}" is server-only` };
    last = input.tick;
  }
  return null;
}

/**
 * Replays `seg` on `sim` (which must be at seg.fromTick). On failure the sim
 * is left at an unspecified tick: callers rebuild it from their last
 * verified state. Never throws for bad input; step() errors become step_failed.
 */
export function replaySegment(sim: Sim, seg: SegmentBody, opts: ReplayOptions): ReplayOutcome {
  const tick = sim.loaded.mode.tick;
  if (tick.kind !== "fixed") throw new Error("replaySegment: only fixed-tick modes are replayed");
  const msPerTick = 1000 / tick.hz;
  const maxSpeed = Math.max(1, opts.maxSpeed ?? 1);
  const speed = (): number => {
    const s = opts.speedOf ? opts.speedOf(sim.world) : 1;
    return Number.isFinite(s) ? Math.min(maxSpeed, Math.max(1, s)) : 1;
  };
  let costMs = 0;
  const fail = (code: ReplayErrorCode, message: string, hash?: string): ReplayOutcome => ({
    ok: false,
    code,
    message,
    tick: sim.tick,
    costMs,
    ...(hash !== undefined ? { hash } : {}),
  });

  const shape = checkSegment(seg, sim.tick, opts);
  if (shape) return fail(shape.code, shape.message);

  // An observer that throws must not fail the replay: it is analytics, not verification.
  const observe = (events: readonly GameEvent[]): void => {
    try {
      opts.onEvents?.(events);
    } catch {
      /* ignored */
    }
  };

  let currentSpeed = speed();
  const advance = (to: number): boolean => {
    const n = to - sim.tick;
    if (n <= 0) return true;
    costMs += (n * msPerTick) / currentSpeed;
    let events: GameEvent[];
    try {
      events = sim.step(n);
    } catch {
      return false;
    }
    if (opts.onEvents && events.length > 0) observe(events);
    return true;
  };

  for (const input of seg.inputs) {
    if (!advance(input.tick)) return fail("step_failed", `step failed before tick ${input.tick}`);
    const res = sim.dispatch(input.name, input.payload, opts.actor);
    if (res.ok && opts.onEvents && res.events.length > 0) observe(res.events);
    if (!res.ok) {
      return fail(
        "input_rejected",
        `${input.name} at tick ${input.tick}: ${res.error?.code ?? "error"} ${res.error?.message ?? ""}`.trim(),
      );
    }
    currentSpeed = speed();
  }
  if (!advance(seg.toTick)) return fail("step_failed", `step failed before tick ${seg.toTick}`);
  const hash = sim.hash();
  if (opts.expectHash !== undefined && opts.expectHash !== hash)
    return fail("hash_mismatch", `hash ${opts.expectHash} != server ${hash}`, hash);
  return { ok: true, hash, costMs };
}

/**
 * Client-side recorder. Usage (one per local sim):
 *   const rec = new SegmentRecorder(sim.tick);
 *   const res = sim.dispatch(name, payload, VERIFIED_ACTOR);
 *   if (res.ok) rec.record(sim.tick, name, payload);
 *   sim.step(n);
 *   if (due) send(rec.cut(sim));     // right after a step, before more dispatches
 */
export class SegmentRecorder {
  #from: number;
  #inputs: SegmentInput[] = [];

  constructor(fromTick: number) {
    this.#from = fromTick;
  }

  /** First tick of the open segment. */
  get fromTick(): number {
    return this.#from;
  }

  /** Inputs recorded in the open segment. */
  get inputs(): readonly SegmentInput[] {
    return this.#inputs;
  }

  /** Records a successful dispatch made while sim.tick === tick. */
  record(tick: number, name: string, payload: unknown): void {
    const last = this.#inputs.at(-1)?.tick ?? this.#from;
    if (!Number.isSafeInteger(tick) || tick < last) {
      throw new RangeError(`SegmentRecorder.record: tick ${tick} before ${last}`);
    }
    const json = payload === undefined ? null : (JSON.parse(JSON.stringify(payload)) as unknown);
    this.#inputs.push({ tick, name, payload: json });
  }

  /**
   * Closes the open segment at sim.tick and hashes the sim. Null (nothing
   * closed) when no tick elapsed since fromTick. Call only right after a
   * step(), never between a dispatch and the next step at the same tick
   * (the hash must not include an input of the next segment): throws then.
   */
  cut(sim: Sim): RecordedSegment | null {
    const toTick = sim.tick;
    if (toTick <= this.#from) return null;
    if (this.#inputs.some((i) => i.tick >= toTick)) {
      // A dispatch at the current tick already changed the state the hash would cover.
      throw new Error(
        "SegmentRecorder.cut: an input was recorded at the cut tick; cut right after step()",
      );
    }
    const seg: RecordedSegment = {
      fromTick: this.#from,
      toTick,
      inputs: this.#inputs,
      hash: sim.hash(),
    };
    this.#from = toTick;
    this.#inputs = [];
    return seg;
  }

  /** Drops the open segment and restarts at `tick` (after a resync or a new sim). */
  reset(tick: number): void {
    this.#from = tick;
    this.#inputs = [];
  }
}

/** Hash of a segment body (dedup / logs). */
export function segmentKey(seg: SegmentBody): string {
  return stableHash([seg.fromTick, seg.toTick, seg.inputs]);
}
