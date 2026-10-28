/**
 * Per-account local cache of the server-backed classic client (wave-B.md
 * §2.5): `gamez.classic.server.v1.<accountId>` holds the local sim snapshot,
 * the last server-verified tick/hash, the segments not acked yet and the open
 * segment's inputs, so a reload starts instantly and resumes where it was.
 *
 * Invariant of a valid record (checked on read):
 *   verified.tick == pending[0].fromTick, pending[i].toTick == pending[i+1].fromTick,
 *   last toTick (or verified.tick) == open.fromTick <= snapshot.tick,
 *   open inputs are at ticks in [open.fromTick, snapshot.tick].
 * A record that breaks the chain keeps its snapshot but is marked overflow
 * (the next join adopts the server state). Every storage access is wrapped.
 */
import type { SegmentInput, SimSnapshot } from "@gamez/kernel";
import type { Settings } from "../contract.ts";
import { isSnapshot, sanitizeSettings, type KeyValueStorage } from "../persist.ts";

export const SYNC_CACHE_PREFIX = "gamez.classic.server.v1.";
export const SYNC_CACHE_VERSION = 1;
/** Largest record written (chars); above it the pending log is dropped (overflow). */
export const MAX_CACHE_CHARS = 4_000_000;

export function syncCacheKey(accountId: string): string {
  return `${SYNC_CACHE_PREFIX}${accountId}`;
}

/** A cut segment not yet acked by the server. */
export interface PendingSegment {
  seq: number;
  fromTick: number;
  toTick: number;
  inputs: SegmentInput[];
  hash: string;
}

export interface SyncCacheRecord {
  v: 1;
  accountId: string;
  contentHash: string;
  /** Wall clock of the write. */
  savedAt: number;
  settings: Settings;
  /** The local sim when the record was written. */
  snapshot: SimSnapshot;
  /** Last server-verified tick and hash the local sim descends from. */
  verified: { tick: number; hash: string };
  pending: PendingSegment[];
  /** The open (not yet cut) segment: its first tick and inputs so far. */
  open: { fromTick: number; inputs: SegmentInput[] };
  /** Local progress beyond what the server will accept: adopt the server state on the next join. */
  overflow: boolean;
  imported: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isTick = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function isInputs(v: unknown): v is SegmentInput[] {
  return (
    Array.isArray(v) &&
    v.every((i) => isRecord(i) && isTick(i.tick) && typeof i.name === "string" && i.name !== "")
  );
}

function isPending(v: unknown): v is PendingSegment {
  return (
    isRecord(v) &&
    Number.isSafeInteger(v.seq) &&
    isTick(v.fromTick) &&
    isTick(v.toTick) &&
    (v.toTick as number) > (v.fromTick as number) &&
    typeof v.hash === "string" &&
    isInputs(v.inputs)
  );
}

/** True when pending + open continue verified and end at or before the snapshot tick. */
export function chainIsValid(
  rec: Pick<SyncCacheRecord, "verified" | "pending" | "open" | "snapshot">,
): boolean {
  let at = rec.verified.tick;
  for (const p of rec.pending) {
    if (p.fromTick !== at) return false;
    if (p.inputs.some((i) => i.tick < p.fromTick || i.tick >= p.toTick)) return false;
    at = p.toTick;
  }
  if (rec.open.fromTick !== at || rec.snapshot.tick < at) return false;
  let last = at;
  for (const i of rec.open.inputs) {
    if (i.tick < last || i.tick > rec.snapshot.tick) return false;
    last = i.tick;
  }
  return true;
}

/** Parses a stored record for this account and content. Null when absent, malformed or stale. */
export function decodeSyncCache(
  text: string | null,
  accountId: string,
  contentHash: string,
): SyncCacheRecord | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.v !== SYNC_CACHE_VERSION) return null;
    if (raw.accountId !== accountId || raw.contentHash !== contentHash) return null;
    if (!isSnapshot(raw.snapshot) || raw.snapshot.contentHash !== contentHash) return null;
    const verified = raw.verified;
    if (!isRecord(verified) || !isTick(verified.tick) || typeof verified.hash !== "string") {
      return null;
    }
    const open = raw.open;
    const pendingOk = Array.isArray(raw.pending) && raw.pending.every(isPending);
    const openOk = isRecord(open) && isTick(open.fromTick) && isInputs(open.inputs);
    const rec: SyncCacheRecord = {
      v: SYNC_CACHE_VERSION,
      accountId,
      contentHash,
      savedAt: typeof raw.savedAt === "number" && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
      settings: sanitizeSettings(raw.settings),
      snapshot: raw.snapshot,
      verified: { tick: verified.tick, hash: verified.hash },
      pending: pendingOk ? (raw.pending as PendingSegment[]) : [],
      open: openOk
        ? { fromTick: open.fromTick as number, inputs: open.inputs as SegmentInput[] }
        : { fromTick: raw.snapshot.tick, inputs: [] },
      overflow: raw.overflow === true,
      imported: raw.imported === true,
    };
    if (rec.overflow || !pendingOk || !openOk || !chainIsValid(rec)) {
      // The snapshot is still the best start; the server state replaces it on join.
      return {
        ...rec,
        pending: [],
        open: { fromTick: rec.snapshot.tick, inputs: [] },
        overflow: true,
      };
    }
    return rec;
  } catch {
    return null;
  }
}

export function readSyncCache(
  storage: KeyValueStorage | null,
  accountId: string,
  contentHash: string,
): SyncCacheRecord | null {
  if (!storage) return null;
  try {
    return decodeSyncCache(storage.getItem(syncCacheKey(accountId)), accountId, contentHash);
  } catch {
    return null;
  }
}

/**
 * Writes the record. Above MAX_CACHE_CHARS it retries without the pending log
 * (marked overflow); false when storage refused both. Never throws.
 */
export function writeSyncCache(storage: KeyValueStorage | null, rec: SyncCacheRecord): boolean {
  if (!storage) return false;
  const key = syncCacheKey(rec.accountId);
  const attempt = (r: SyncCacheRecord): boolean => {
    try {
      const text = JSON.stringify(r);
      if (text.length > MAX_CACHE_CHARS) return false;
      storage.setItem(key, text);
      return true;
    } catch {
      return false;
    }
  };
  if (attempt(rec)) return true;
  return attempt({
    ...rec,
    pending: [],
    open: { fromTick: rec.snapshot.tick, inputs: [] },
    overflow: true,
  });
}

export function clearSyncCache(storage: KeyValueStorage | null, accountId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(syncCacheKey(accountId));
  } catch {
    // Nothing to do.
  }
}
