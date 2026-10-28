import type { BatchSink, FlushOptions, OutboxOp, OutboxRecord } from "./types.ts";

/** Default byte budget per queue message. Queue messages are capped at 128 KiB. */
export const DEFAULT_MAX_BATCH_BYTES = 96 * 1024;
/** A single record estimated above this is dropped instead of blocking the outbox. */
export const DEFAULT_HARD_MAX_RECORD_BYTES = 120 * 1024;

const RECORD_OVERHEAD_BYTES = 32;
/** Any char above U+00FF (V8 two-byte string). */
const WIDE_CHAR = /[\u0100-\uffff]/;
const TOO_LARGE = /too large|exceeds|size/i;

/**
 * Estimated serialised size of one record in a batch. The estimate is the JSON
 * length. V8 stores strings with any char above U+00FF as two bytes per char, so
 * such records count double. Plus a fixed overhead for the envelope fields.
 */
export function estimateRecordBytes(record: OutboxRecord): number {
  const json = JSON.stringify(record);
  const base = WIDE_CHAR.test(json) ? json.length * 2 : json.length;
  return base + RECORD_OVERHEAD_BYTES;
}

function isTooLargeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TOO_LARGE.test(message);
}

function logOversize(record: OutboxRecord, bytes: number): void {
  console.error("outbox: record too large for a queue message, dropped", {
    tbl: record.table,
    pk: record.pk,
    size: bytes,
  });
}

type OutboxRow = {
  seq: number;
  tbl: string;
  pk: string;
  op: string;
  version: number;
  payload: string | null;
  at: number;
};

/**
 * Transactional outbox stored in a Durable Object's SQLite (`ctx.storage.sql`).
 *
 * Usage inside a DO:
 *   ctx.storage.transactionSync(() => {
 *     sql.exec("UPDATE character SET x = ?, y = ? ...", x, y);
 *     outbox.append("character_summary", id, "upsert", state);
 *   });
 *   await outbox.scheduleFlush(ctx.storage);   // sets an alarm if none pending
 *   // in alarm(): await outbox.flush(sink)
 *
 * Contract:
 * - `init()` creates `_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl, pk, op,
 *   version, payload TEXT, at)` and `_outbox_versions(tbl, pk, version, PRIMARY KEY(tbl, pk))`
 *   if missing. Idempotent.
 * - `append()` is synchronous (must run inside the caller's transaction),
 *   bumps the per-(table, pk) version and returns the new record.
 * - `pending(limit)` returns the oldest unflushed records in seq order.
 * - `flush(sink, maxBatch, opts)` sends pending records in seq order as batches
 *   of at most `maxBatch` records and `opts.maxBytes` estimated bytes, deleting
 *   each batch's rows only after `sink.send` resolves. If send throws, rows stay
 *   and the error propagates (the alarm retries). Returns the number of records
 *   sent.
 *
 * `_outbox_versions` is never pruned: versions must keep growing across
 * deletes and re-creates, otherwise D1 would ignore the re-created row.
 */
export class Outbox {
  constructor(
    readonly sql: SqlStorage,
    readonly source: string,
  ) {}

  init(): void {
    // AUTOINCREMENT so seqs are never reused after flushed rows are deleted.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS _outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tbl TEXT NOT NULL,
        pk TEXT NOT NULL,
        op TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT,
        at INTEGER NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS _outbox_versions (
        tbl TEXT NOT NULL,
        pk TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (tbl, pk)
      )`,
    );
  }

  append(table: string, pk: string, op: OutboxOp, payload: unknown): OutboxRecord {
    if (op !== "upsert" && op !== "delete") throw new Error(`invalid outbox op: ${String(op)}`);
    const { version } = this.sql
      .exec<{ version: number }>(
        `INSERT INTO _outbox_versions (tbl, pk, version) VALUES (?, ?, 1)
         ON CONFLICT (tbl, pk) DO UPDATE SET version = version + 1
         RETURNING version`,
        table,
        pk,
      )
      .one();
    const stored = op === "delete" ? null : (payload ?? null);
    const at = Date.now();
    const { seq } = this.sql
      .exec<{ seq: number }>(
        `INSERT INTO _outbox (tbl, pk, op, version, payload, at) VALUES (?, ?, ?, ?, ?, ?)
         RETURNING seq`,
        table,
        pk,
        op,
        version,
        stored === null ? null : JSON.stringify(stored),
        at,
      )
      .one();
    return { seq, table, pk, op, version, payload: stored, at };
  }

  pending(limit = 500): OutboxRecord[] {
    return this.sql
      .exec<OutboxRow>(
        "SELECT seq, tbl, pk, op, version, payload, at FROM _outbox ORDER BY seq LIMIT ?",
        limit,
      )
      .toArray()
      .map((r) => ({
        seq: r.seq,
        table: r.tbl,
        pk: r.pk,
        op: r.op as OutboxOp,
        version: r.version,
        payload: r.payload === null ? null : JSON.parse(r.payload),
        at: r.at,
      }));
  }

  size(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM _outbox").one().n;
  }

  /**
   * Sends pending records in seq order. A batch holds at most `maxBatch`
   * records and `opts.maxBytes` estimated bytes (see `estimateRecordBytes`), and
   * always at least one record. A record estimated above `opts.hardMaxBytes` is
   * deleted and passed to `opts.onOversize`, so it can never block the head.
   * If `send` fails with a size-like error, the first half of the batch is sent
   * once instead, and the error is rethrown if that also fails.
   *
   * Stops after a read that returned fewer than `maxBatch` rows, once every row
   * of that read has been sent or dropped. Records appended meanwhile are left
   * for the next alarm. Concurrent flushes may send the same records twice,
   * which is allowed.
   */
  async flush(sink: BatchSink, maxBatch = 500, opts: FlushOptions = {}): Promise<number> {
    if (!Number.isInteger(maxBatch) || maxBatch < 1) {
      throw new Error(`maxBatch must be a positive integer, got ${maxBatch}`);
    }
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BATCH_BYTES;
    const hardMaxBytes = opts.hardMaxBytes ?? DEFAULT_HARD_MAX_RECORD_BYTES;
    const onOversize = opts.onOversize ?? logOversize;
    let sent = 0;
    for (;;) {
      const window = this.pending(maxBatch);
      if (window.length === 0) break;
      let i = 0;
      while (i < window.length) {
        const head = window[i]!;
        const headBytes = estimateRecordBytes(head);
        if (headBytes > hardMaxBytes) {
          this.sql.exec("DELETE FROM _outbox WHERE seq = ?", head.seq);
          onOversize(head, headBytes);
          i++;
          continue;
        }
        const batch: OutboxRecord[] = [];
        let bytes = 0;
        for (let j = i; j < window.length && batch.length < maxBatch; j++) {
          const rec = window[j]!;
          const size = estimateRecordBytes(rec);
          if (size > hardMaxBytes) break;
          if (batch.length > 0 && bytes + size > maxBytes) break;
          batch.push(rec);
          bytes += size;
        }
        const records = await this.sendBatch(sink, batch);
        // New appends always get a higher seq, so this only drops what was sent.
        this.sql.exec("DELETE FROM _outbox WHERE seq <= ?", records.at(-1)!.seq);
        sent += records.length;
        i += records.length;
      }
      // A short read means the outbox was drained at read time.
      if (window.length < maxBatch) break;
    }
    return sent;
  }

  /**
   * Sends `batch`. On a size-like error, retries once with the first half and
   * returns the records actually sent. Other errors propagate.
   */
  private async sendBatch(sink: BatchSink, batch: OutboxRecord[]): Promise<OutboxRecord[]> {
    try {
      await sink.send({ source: this.source, records: batch });
      return batch;
    } catch (err) {
      if (batch.length < 2 || !isTooLargeError(err)) throw err;
      const half = batch.slice(0, Math.ceil(batch.length / 2));
      await sink.send({ source: this.source, records: half });
      return half;
    }
  }

  /** Sets a DO alarm `delayMs` from now unless one is already scheduled. */
  async scheduleFlush(storage: DurableObjectStorage, delayMs = 2000): Promise<void> {
    if ((await storage.getAlarm()) !== null) return;
    await storage.setAlarm(Date.now() + delayMs);
  }
}
