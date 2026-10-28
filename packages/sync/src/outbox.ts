import type { BatchSink, OutboxOp, OutboxRecord } from "./types.ts";

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
 * - `flush(sink, maxBatch)` sends pending records in seq order as batches of
 *   at most `maxBatch`, deleting each batch's rows only after `sink.send`
 *   resolves. If send throws, rows stay and the error propagates (the alarm
 *   retries). Returns the number of records sent.
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
   * Stops after the first batch shorter than `maxBatch` (the outbox was empty
   * at that read); records appended meanwhile are left for the next alarm.
   * Concurrent flushes may send the same records twice, which is allowed.
   */
  async flush(sink: BatchSink, maxBatch = 500): Promise<number> {
    if (!Number.isInteger(maxBatch) || maxBatch < 1) {
      throw new Error(`maxBatch must be a positive integer, got ${maxBatch}`);
    }
    let sent = 0;
    for (;;) {
      const records = this.pending(maxBatch);
      const last = records.at(-1);
      if (!last) break;
      await sink.send({ source: this.source, records });
      // New appends always get a higher seq, so this only drops what was sent.
      this.sql.exec("DELETE FROM _outbox WHERE seq <= ?", last.seq);
      sent += records.length;
      if (records.length < maxBatch) break;
    }
    return sent;
  }

  /** Sets a DO alarm `delayMs` from now unless one is already scheduled. */
  async scheduleFlush(storage: DurableObjectStorage, delayMs = 2000): Promise<void> {
    if ((await storage.getAlarm()) !== null) return;
    await storage.setAlarm(Date.now() + delayMs);
  }
}
