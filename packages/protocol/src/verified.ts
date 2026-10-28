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
  | "internal";

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
      resume?: { tick: number; hash: string; pending: boolean };
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
  | { t: "ping"; clientTime: number };

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
    }
  | { t: "pong"; clientTime: number; serverTime: number }
  | { t: "error"; code: string; message: string };

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

/** Unpacks a wire snapshot. Throws on malformed data (callers treat it as a bad message). */
export async function unpackSnapshot(packed: PackedSnapshot): Promise<SimSnapshot> {
  if (packed.enc === "json") return packed.data;
  if (packed.enc !== "gzip64" || typeof packed.data !== "string") {
    throw new TypeError("unknown snapshot encoding");
  }
  const raw = await pipe(fromBase64(packed.data), new DecompressionStream("gzip"));
  return JSON.parse(decoder.decode(raw)) as SimSnapshot;
}
