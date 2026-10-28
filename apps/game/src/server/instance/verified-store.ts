/**
 * Durable state of a client-driven (verified) instance on DO SQLite
 * (docs/design/wave-B.md §2.4): one row with the base snapshot and the
 * verification bookkeeping, the verified segment log after the base, and the
 * last report hash per read-model row (so only changed rows reach the outbox).
 *
 * The host composes writes inside transaction(); every method is synchronous.
 */
import type { SegmentInput, SimSnapshot } from "@gamez/kernel";
import type { SqlStore } from "../contracts.ts";

/** Resync / mismatch bookkeeping (anti-cheat signals; no automatic action in wave B). */
export interface MismatchCounters {
  /** Lifetime count per resync code (hash_mismatch, too_fast, gap…). */
  byCode: Record<string, number>;
  /** Epoch ms of the mismatches in the last hour (bounded). */
  recent: number[];
  /** Set once FLAG_AFTER mismatches happened within an hour; never cleared automatically. */
  flagged: boolean;
}

export interface VerifiedRecord {
  instanceId: string;
  /** Seed of the sim's setup() (new games); restores ignore it. */
  seed: number;
  /** Current epoch: every vstate/resync bumps it. */
  epoch: number;
  /** Snapshot at baseTick (compaction point). */
  base: SimSnapshot;
  baseTick: number;
  /** Epoch ms the base was written. */
  baseAt: number;
  verifiedTick: number;
  verifiedHash: string;
  /** Speed ledger: wall-time credit (ms) as of creditAt. */
  creditMs: number;
  creditAt: number;
  /** Last verified segment or socket close (offline progress measures from here). */
  lastActiveAt: number;
  /** The current state descends from an imported local save. */
  imported: boolean;
  /** An import happened at some point (imports are one-time per instance). */
  importUsed: boolean;
  /** Segments ever verified on this instance (lifetime; a fresh game keeps counting). */
  segmentsTotal: number;
  /** Module ids of the loaded mode when the base was written (content carry-over rule). */
  moduleIds: string[];
  /** Owner and display name from the last joined socket (report envelopes). */
  accountId: string;
  displayName: string;
  counters: MismatchCounters;
}

/** One verified segment of the log (B, verifiedTick]. */
export interface StoredSegment {
  fromTick: number;
  toTick: number;
  inputs: SegmentInput[];
  hash: string;
}

export interface VerifiedStore {
  /** The stored instance, or null (none yet, or unreadable). */
  load(): VerifiedRecord | null;
  /** The segment log in tick order. */
  segments(): StoredSegment[];
  /** Writes the whole record (with the base) and drops the segment log. */
  writeBase(rec: VerifiedRecord): void;
  /** Appends one verified segment and writes the record's bookkeeping (not the base). */
  appendSegment(seg: StoredSegment, rec: VerifiedRecord): void;
  /** Writes the record's bookkeeping (epoch, counters, credit, lastActiveAt…), not the base. */
  saveMeta(rec: VerifiedRecord): void;
  /** Last stored report hash of a read-model row. */
  reportHash(table: string, key: string): string | null;
  setReportHash(table: string, key: string, hash: string): void;
  /** Runs fn atomically (all writes or none). */
  transaction<T>(fn: () => T): T;
}

interface InstanceRow extends Record<string, SqlStorageValue> {
  instance_id: string;
  seed: number;
  epoch: number;
  base: string;
  base_tick: number;
  base_at: number;
  verified_tick: number;
  verified_hash: string;
  credit_ms: number;
  credit_at: number;
  last_active_at: number;
  imported: number;
  import_used: number;
  segments_total: number;
  module_ids: string;
  account_id: string;
  display_name: string;
  counters: string;
}

interface SegmentRow extends Record<string, SqlStorageValue> {
  from_tick: number;
  to_tick: number;
  inputs: string;
  hash: string;
}

export function emptyCounters(): MismatchCounters {
  return { byCode: {}, recent: [], flagged: false };
}

function parseCounters(text: string): MismatchCounters {
  try {
    const c = JSON.parse(text) as Partial<MismatchCounters>;
    return {
      byCode: c.byCode && typeof c.byCode === "object" ? { ...c.byCode } : {},
      recent: Array.isArray(c.recent) ? c.recent.filter((n) => typeof n === "number") : [],
      flagged: c.flagged === true,
    };
  } catch {
    return emptyCounters();
  }
}

function parseIds(text: string): string[] {
  try {
    const ids = JSON.parse(text) as unknown;
    return Array.isArray(ids) ? ids.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** VerifiedStore over Durable Object SQLite (or the node:sqlite fake in tests). */
export class SqlVerifiedStore implements VerifiedStore {
  readonly #db: SqlStore;
  /** Nesting depth of transaction() (inner calls join the outer transaction). */
  #depth = 0;

  constructor(db: SqlStore) {
    this.#db = db;
    const sql = db.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS verified_instance (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      instance_id TEXT NOT NULL,
      seed INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      base TEXT NOT NULL,
      base_tick INTEGER NOT NULL,
      base_at INTEGER NOT NULL,
      verified_tick INTEGER NOT NULL,
      verified_hash TEXT NOT NULL,
      credit_ms REAL NOT NULL,
      credit_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      imported INTEGER NOT NULL,
      import_used INTEGER NOT NULL,
      segments_total INTEGER NOT NULL,
      module_ids TEXT NOT NULL,
      account_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      counters TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS verified_segment (
      to_tick INTEGER PRIMARY KEY,
      from_tick INTEGER NOT NULL,
      inputs TEXT NOT NULL,
      hash TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS report_state (
      tbl TEXT NOT NULL,
      key TEXT NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (tbl, key)
    )`);
  }

  load(): VerifiedRecord | null {
    const row = this.#db.sql
      .exec<InstanceRow>("SELECT * FROM verified_instance WHERE id = 1")
      .toArray()[0];
    if (!row) return null;
    let base: SimSnapshot;
    try {
      base = JSON.parse(row.base) as SimSnapshot;
    } catch {
      return null;
    }
    return {
      instanceId: row.instance_id,
      seed: row.seed,
      epoch: row.epoch,
      base,
      baseTick: row.base_tick,
      baseAt: row.base_at,
      verifiedTick: row.verified_tick,
      verifiedHash: row.verified_hash,
      creditMs: row.credit_ms,
      creditAt: row.credit_at,
      lastActiveAt: row.last_active_at,
      imported: row.imported === 1,
      importUsed: row.import_used === 1,
      segmentsTotal: row.segments_total,
      moduleIds: parseIds(row.module_ids),
      accountId: row.account_id,
      displayName: row.display_name,
      counters: parseCounters(row.counters),
    };
  }

  segments(): StoredSegment[] {
    return this.#db.sql
      .exec<SegmentRow>(
        "SELECT from_tick, to_tick, inputs, hash FROM verified_segment ORDER BY to_tick",
      )
      .toArray()
      .map((r) => ({
        fromTick: r.from_tick,
        toTick: r.to_tick,
        inputs: JSON.parse(r.inputs) as SegmentInput[],
        hash: r.hash,
      }));
  }

  writeBase(rec: VerifiedRecord): void {
    this.transaction(() => {
      this.#db.sql.exec(
        `INSERT INTO verified_instance (id, instance_id, seed, epoch, base, base_tick, base_at,
           verified_tick, verified_hash, credit_ms, credit_at, last_active_at, imported, import_used,
           segments_total, module_ids, account_id, display_name, counters)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET instance_id = excluded.instance_id, seed = excluded.seed,
           epoch = excluded.epoch, base = excluded.base, base_tick = excluded.base_tick,
           base_at = excluded.base_at, verified_tick = excluded.verified_tick,
           verified_hash = excluded.verified_hash, credit_ms = excluded.credit_ms,
           credit_at = excluded.credit_at, last_active_at = excluded.last_active_at,
           imported = excluded.imported, import_used = excluded.import_used,
           segments_total = excluded.segments_total, module_ids = excluded.module_ids,
           account_id = excluded.account_id, display_name = excluded.display_name,
           counters = excluded.counters`,
        rec.instanceId,
        rec.seed,
        rec.epoch,
        JSON.stringify(rec.base),
        rec.baseTick,
        rec.baseAt,
        rec.verifiedTick,
        rec.verifiedHash,
        rec.creditMs,
        rec.creditAt,
        rec.lastActiveAt,
        rec.imported ? 1 : 0,
        rec.importUsed ? 1 : 0,
        rec.segmentsTotal,
        JSON.stringify(rec.moduleIds),
        rec.accountId,
        rec.displayName,
        JSON.stringify(rec.counters),
      );
      this.#db.sql.exec("DELETE FROM verified_segment");
    });
  }

  appendSegment(seg: StoredSegment, rec: VerifiedRecord): void {
    this.transaction(() => {
      this.#db.sql.exec(
        `INSERT INTO verified_segment (to_tick, from_tick, inputs, hash) VALUES (?, ?, ?, ?)`,
        seg.toTick,
        seg.fromTick,
        JSON.stringify(seg.inputs),
        seg.hash,
      );
      this.#writeMeta(rec);
    });
  }

  saveMeta(rec: VerifiedRecord): void {
    this.transaction(() => this.#writeMeta(rec));
  }

  #writeMeta(rec: VerifiedRecord): void {
    this.#db.sql.exec(
      `UPDATE verified_instance SET epoch = ?, verified_tick = ?, verified_hash = ?, credit_ms = ?,
         credit_at = ?, last_active_at = ?, imported = ?, import_used = ?, segments_total = ?,
         account_id = ?, display_name = ?, counters = ?
       WHERE id = 1`,
      rec.epoch,
      rec.verifiedTick,
      rec.verifiedHash,
      rec.creditMs,
      rec.creditAt,
      rec.lastActiveAt,
      rec.imported ? 1 : 0,
      rec.importUsed ? 1 : 0,
      rec.segmentsTotal,
      rec.accountId,
      rec.displayName,
      JSON.stringify(rec.counters),
    );
  }

  reportHash(table: string, key: string): string | null {
    const row = this.#db.sql
      .exec<{ hash: string }>("SELECT hash FROM report_state WHERE tbl = ? AND key = ?", table, key)
      .toArray()[0];
    return row ? row.hash : null;
  }

  setReportHash(table: string, key: string, hash: string): void {
    this.#db.sql.exec(
      `INSERT INTO report_state (tbl, key, hash) VALUES (?, ?, ?)
       ON CONFLICT (tbl, key) DO UPDATE SET hash = excluded.hash`,
      table,
      key,
      hash,
    );
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#depth++;
    try {
      return this.#db.transactionSync(fn);
    } finally {
      this.#depth--;
    }
  }
}
