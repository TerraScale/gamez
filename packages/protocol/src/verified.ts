/**
 * Wire messages of client-driven (verified) instance modes — classic in wave B
 * (docs/design/wave-B.md §2). Same socket path as other instances
 * (/ws/instance?token&mode), JSON frames; the InstanceDO picks the verified
 * host when the mode's ModeSpec.instance.clientDriven is set.
 *
 * Flow:
 *   client -> join {resume?}          server -> vstate (authoritative tick + hash,
 *                                                snapshot unless continued, offline grant)
 *   client -> segment (every ~2 s)    server -> verified (ack, durable) | resync (restore this)
 *   client -> import (once, empty instance only: local save migration) -> vstate
 *
 * Epochs: every vstate/resync starts a new epoch. Segments carry the epoch
 * they were recorded in; the server silently drops segments of older epochs
 * (they were in flight when the resync went out).
 */
import type { GameEvent, SegmentInput, SimSnapshot } from "@gamez/kernel";
import type { BankOp, BankResult } from "./economy.ts";

/** Actor both sides pass to sim.dispatch for client inputs (the sim never reads it). */
export const VERIFIED_ACTOR = "local";

/**
 * A snapshot on the wire. Senders use "json" below PACK_GZIP_ABOVE bytes of
 * JSON and "gzip64" (base64 of gzip of the JSON) above it, to stay under the
 * 1 MiB WebSocket message limit. Receivers accept both.
 */
export type PackedSnapshot = { enc: "json"; data: SimSnapshot } | { enc: "gzip64"; data: string };

/** JSON size above which packSnapshot() gzips. */
export const PACK_GZIP_ABOVE = 256 * 1024;
/** Largest client frame the verified host decodes (import frames are the big ones). */
export const MAX_VERIFIED_CLIENT_FRAME = 900 * 1024;

/**
 * Largest inflated snapshot unpackSnapshot accepts. Twice the client's 4 MB
 * MAX_CACHE_CHARS (modules/classic/src/client/sync/cache.ts).
 *
 * unpackSnapshot is for snapshots the SERVER sent (trusted). It is not a
 * memory bound for untrusted input: workerd's DecompressionStream inflates a
 * whole chunk eagerly before the reader can stop it (ADR 0007 R8). The server
 * never inflates client data; an import must be enc "json" (see
 * snapshotWithinLimits).
 */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/**
 * Most JSON nodes (objects, arrays and scalars) an imported snapshot may hold
 * (ADR 0007 R8). A real classic save holds about 500 (3 KB of JSON), so this
 * is about 100x headroom; it bounds the work and memory of restoring and
 * validating an import whatever the client sends.
 */
export const MAX_IMPORT_SNAPSHOT_NODES = 50_000;
/** Deepest nesting an imported snapshot may have (a real classic save: 7). */
export const MAX_IMPORT_SNAPSHOT_DEPTH = 32;

/**
 * True when `value` has at most `maxNodes` JSON nodes and at most `maxDepth`
 * levels of nesting. Iterative (no recursion on hostile input) and stops at
 * the first node over either limit, so the cost is O(min(size, maxNodes)).
 */
export function jsonWithinLimits(
  value: unknown,
  maxNodes: number = MAX_IMPORT_SNAPSHOT_NODES,
  maxDepth: number = MAX_IMPORT_SNAPSHOT_DEPTH,
): boolean {
  // Every node is counted when it is first seen, before it is queued, so the
  // stack never holds more than maxNodes entries.
  const values: unknown[] = [value];
  const depths: number[] = [0];
  let seen = 1;
  while (values.length > 0) {
    const v = values.pop();
    const d = depths.pop()!;
    if (d > maxDepth) return false;
    if (v === null || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      if (seen + v.length > maxNodes) return false;
      seen += v.length;
      for (let i = 0; i < v.length; i++) {
        values.push(v[i]);
        depths.push(d + 1);
      }
    } else {
      for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        if (++seen > maxNodes) return false;
        values.push((v as Record<string, unknown>)[k]);
        depths.push(d + 1);
      }
    }
  }
  return seen <= maxNodes;
}

/**
 * Longest gzip64 base64 unpackSnapshot accepts by default: the base64 of the
 * largest gzip stream of MAX_SNAPSHOT_BYTES (10% margin for stored-block
 * overhead). Client frames are capped tighter by parsePacked.
 */
export const MAX_SNAPSHOT_GZIP_BASE64 = Math.ceil((MAX_SNAPSHOT_BYTES * 1.1 + 64) / 3) * 4;

/** Limits the server enforces, sent in vstate so the client can respect them. */
export interface VerifyLimits {
  /** ClientDrivenPolicy.maxTicksPerSegment. */
  maxTicksPerSegment: number;
  maxInputsPerSegment: number;
  /** Client cuts a segment at least this often (wall ms) while ticking. */
  segmentEveryMs: number;
  /**
   * Unverified ticks the client may hold (disconnected play). Beyond it the
   * client stops recording and will accept the server state + offline
   * progress on reconnect (wave-B.md §2.6).
   */
  maxPendingTicks: number;
  /** Wall-time credit cap of the speed ledger (ms). */
  creditCapMs: number;
}

export type ResyncCode =
  | "hash_mismatch"
  | "input_rejected"
  | "bad_segment"
  | "server_only_action"
  | "step_failed"
  /** Claimed sim time exceeds the wall-time credit (speed hack or a far too fast clock). */
  | "too_fast"
  /** fromTick does not continue the verified tick. */
  | "gap"
  | "content_changed"
  /** The server could not persist the segment (storage error); restore and continue. */
  | "internal"
  /**
   * Wave C: a bank operation was applied at a verified tick the client had
   * already moved past (it did not pause, or segments were in flight); restore
   * this snapshot (it includes the bank change).
   */
  | "bank"
  /**
   * A deferred offline grant (docs/design/offline-idle.md §5): the client
   * rejoined with unverified play after an absence; once that play verified,
   * the server dispatched the offline action there. Restore this snapshot
   * and show resync.offline.
   */
  | "offline";

export type VerifiedClientMessage =
  /**
   * First message. `fresh` discards the instance (new game, server seed).
   * `resume`: the client still has a local sim that continues from the
   * server-verified `tick`/`hash`; `pending` = it holds unsent/unacked
   * segments. When tick+hash match, the server answers continued=true and
   * grants no offline progress if pending; otherwise the client must adopt
   * the vstate snapshot.
   *
   * tick+hash may also be an EARLIER verified state of the server's current
   * segment log (acks lost with the old socket): continued=true then too,
   * with vstate.tick/hash ahead of the client's; the client resends its
   * pending segments in the new epoch and those the server already verified
   * are re-acked (duplicates get a "verified" with the server's verified tick).
   */
  | {
      t: "join";
      token: string;
      mode: string;
      fresh?: boolean;
      /**
       * `pendingToTick`: toTick of the client's last pending segment (absent
       * or <= tick when nothing is pending). The server grants offline
       * progress at once unless the client holds unverified play past the
       * server's verified tick; then the grant is deferred until that play
       * verified (resync "offline"), docs/design/offline-idle.md §5.
       */
      resume?: { tick: number; hash: string; pending: boolean; pendingToTick?: number };
    }
  | {
      t: "segment";
      epoch: number;
      /** Client counter (echoed in verified/resync); not used for ordering. */
      seq: number;
      fromTick: number;
      toTick: number;
      inputs: SegmentInput[];
      /** sim.hash() at toTick. */
      hash: string;
    }
  /** Local save migration (wave-B.md §2.7). Only accepted while the instance has no progress. */
  | { t: "import"; snapshot: PackedSnapshot; savedAt: number }
  | { t: "ping"; clientTime: number }
  /**
   * Wave C bank operation (docs/design/wave-C.md §2): hero <-> account vault.
   * The client cuts and submits a segment ending at `at`, PAUSES its sim
   * (no step, no dispatch) and sends this. The server handles it after every
   * earlier frame (one promise queue), so `at` normally equals its verified
   * tick/hash: then it dispatches the mode's bank action there and answers
   * "bank" with `applied` (the client dispatches the same action itself and
   * checks the hash). Otherwise it still applies at its verified tick and
   * sends resync "bank" first. Idempotent by opId (a retry returns the first result).
   */
  | { t: "bank"; opId: string; op: BankOp; at: { tick: number; hash: string } };

export interface OfflineGrant {
  /** Server-measured absence used (capped). */
  elapsedMs: number;
  /** Events of the offline action dispatch (e.g. classic.offline.summary). */
  events: GameEvent[];
}

export type VerifiedServerMessage =
  | {
      t: "vstate";
      instanceId: string;
      mode: string;
      contentHash: string;
      epoch: number;
      /** Verified tick and hash. */
      tick: number;
      hash: string;
      /** True: the client keeps its local sim (resume matched). snapshot is null then. */
      continued: boolean;
      snapshot: PackedSnapshot | null;
      offline: OfflineGrant | null;
      /** True when this instance's state came from an imported local save. */
      imported: boolean;
      /** True when an import is still possible (no progress yet). */
      importable: boolean;
      serverTime: number;
      limits: VerifyLimits;
    }
  | {
      t: "verified";
      epoch: number;
      seq: number;
      /** New verified tick (the segment's toTick) and hash; durable when sent. */
      tick: number;
      hash: string;
      /** Remaining wall-time credit (ms) after this segment. */
      creditMs: number;
    }
  | {
      t: "resync";
      /** The NEW epoch; segments of older epochs are dropped. */
      epoch: number;
      /** seq of the offending segment (0 when not caused by a segment). */
      seq: number;
      code: ResyncCode;
      message: string;
      /** Verified tick/hash the client must restore. */
      tick: number;
      hash: string;
      snapshot: PackedSnapshot;
      /** Set with code "offline": the grant now part of `snapshot`. */
      offline?: OfflineGrant | null;
    }
  | { t: "pong"; clientTime: number; serverTime: number }
  | { t: "error"; code: string; message: string }
  /** Wave C: answer to a client "bank" message (always sent, after any resync it caused). */
  | {
      t: "bank";
      opId: string;
      result: BankResult;
      /**
       * Set when the op changed the sim exactly at the client's `at`: the
       * client dispatches (name, payload) with actor BANK_ACTOR on its paused
       * sim, which must then hash to `hash` (else it waits for / asks a resync
       * by rejoining). null: nothing to apply locally (failed op, or a resync
       * already carried the change).
       */
      applied: { tick: number; name: string; payload: unknown; hash: string } | null;
    };

/** Actor both sides pass to sim.dispatch for server-applied bank actions. */
export const BANK_ACTOR = "server";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(
  bytes: Uint8Array<ArrayBuffer>,
  stream: GenericTransformStream,
): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Packs a snapshot for the wire (gzip above PACK_GZIP_ABOVE bytes of JSON, or always with force). */
export async function packSnapshot(
  snapshot: SimSnapshot,
  opts: { forceGzip?: boolean } = {},
): Promise<PackedSnapshot> {
  const json = JSON.stringify(snapshot);
  if (!opts.forceGzip && json.length <= PACK_GZIP_ABOVE) return { enc: "json", data: snapshot };
  const gz = await pipe(encoder.encode(json), new CompressionStream("gzip"));
  return { enc: "gzip64", data: toBase64(gz) };
}

/**
 * Inflates gzip bytes with a hard output cap: reads the stream chunk by chunk,
 * cancels and throws RangeError once the total passes maxBytes.
 */
async function inflateBounded(
  bytes: Uint8Array<ArrayBuffer>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new RangeError("snapshot too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface UnpackOptions {
  /** Largest inflated size accepted (default MAX_SNAPSHOT_BYTES). */
  maxBytes?: number;
  /** Longest gzip64 base64 accepted before decoding (default MAX_SNAPSHOT_GZIP_BASE64). */
  maxInputChars?: number;
}

/**
 * Unpacks a snapshot the server sent. Throws on malformed data and on oversize
 * input or output (RangeError "snapshot too large"). Callers treat a throw as
 * a bad message. Not for client input on the server (see MAX_SNAPSHOT_BYTES).
 */
export async function unpackSnapshot(
  packed: PackedSnapshot,
  opts: UnpackOptions = {},
): Promise<SimSnapshot> {
  if (packed.enc === "json") return packed.data;
  if (packed.enc !== "gzip64" || typeof packed.data !== "string") {
    throw new TypeError("unknown snapshot encoding");
  }
  if (packed.data.length > (opts.maxInputChars ?? MAX_SNAPSHOT_GZIP_BASE64)) {
    throw new RangeError("snapshot too large");
  }
  const raw = await inflateBounded(fromBase64(packed.data), opts.maxBytes ?? MAX_SNAPSHOT_BYTES);
  return JSON.parse(decoder.decode(raw)) as SimSnapshot;
}
