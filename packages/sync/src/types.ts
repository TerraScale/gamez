/**
 * Sync engine v1 contracts: Durable Object (authoritative) -> D1 (read model).
 *
 * Flow: a DO writes its own SQLite row and appends an OutboxRecord in the same
 * transaction -> an alarm drains the outbox into a Queue as a ReplicationBatch
 * -> the queue consumer applies the batch to D1 through Projections.
 *
 * Correctness rules (do not weaken these):
 * - Delivery is at-least-once and batches may arrive out of order or twice.
 * - Every applied row carries `_version`; an upsert only wins when its version
 *   is strictly greater than the stored one. That alone makes replays,
 *   duplicates and reordering harmless.
 * - Deletes are tombstones (`_deleted = 1` with a newer `_version`), never
 *   physical deletes, so an old upsert can't resurrect a deleted row.
 * - `sync_cursor` is for lag monitoring only (max seq seen per source). It is
 *   never used to skip records.
 *
 * Everything sits behind these interfaces so the transport can later be
 * replaced (e.g. by TerraScale) without touching game modules.
 */

export type SqlValue = string | number | null;

export type OutboxOp = "upsert" | "delete";

export interface OutboxRecord {
  /** Monotonic per source DO, starting at 1. */
  seq: number;
  /** Projection name, e.g. "character_summary". */
  table: string;
  /** Primary key value of the projected row. */
  pk: string;
  op: OutboxOp;
  /** Monotonic per (table, pk) within the source DO. */
  version: number;
  /** JSON-serialisable entity state; null for deletes. */
  payload: unknown;
  /** Epoch ms when the change was recorded. */
  at: number;
}

export interface ReplicationBatch {
  /** Stable id of the source DO, e.g. "character:<accountId>:classic". */
  source: string;
  records: OutboxRecord[];
}

/**
 * Maps outbox payloads of one table to a D1 row. The D1 table must have the
 * pk column plus `_version INTEGER NOT NULL`, `_deleted INTEGER NOT NULL DEFAULT 0`
 * and `_updated_at INTEGER NOT NULL`.
 */
export interface Projection<P = unknown> {
  /** D1 table name (also the OutboxRecord.table it handles). */
  table: string;
  pkColumn: string;
  /** Non-pk, non-meta columns for an upsert. */
  toRow(payload: P): Record<string, SqlValue>;
}

export type ProjectionMap = Record<string, Projection<any>>;

export interface ApplyResult {
  /** Records whose version won and were written. */
  applied: number;
  /** Records skipped because D1 already had an equal or newer version. */
  stale: number;
  /** Records for tables with no projection (logged and dropped). */
  unknown: number;
}

/** Destination the outbox drains into (a Queue in production, anything in tests). */
export interface BatchSink {
  send(batch: ReplicationBatch): Promise<void>;
}
