import { DatabaseSync } from "node:sqlite";

/**
 * Test doubles for the Cloudflare APIs the sync engine touches, backed by a
 * real in-memory SQLite (`node:sqlite`) so SQL semantics (upserts, RETURNING,
 * changes counts, transactions) match production closely.
 */

type Row = Record<string, unknown>;

function oneStatement(query: string): string {
  const body = query.trim().replace(/;\s*$/, "");
  if (body.includes(";")) throw new Error("fake supports a single statement per call");
  return body;
}

/** `ctx.storage.sql`: `exec(query, ...bindings)` returning a cursor. */
export class FakeSqlStorage {
  readonly db = new DatabaseSync(":memory:");

  exec(query: string, ...bindings: unknown[]): FakeCursor {
    for (const b of bindings) {
      if (b === undefined) throw new TypeError("SqlStorage: undefined binding");
    }
    const rows = this.db.prepare(oneStatement(query)).all(...bindings);
    return new FakeCursor(rows.map((r) => ({ ...r })));
  }

  get databaseSize(): number {
    return 0;
  }

  /** Same shape as `DurableObjectStorage.transactionSync`. */
  transactionSync<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  asSql(): SqlStorage {
    return this as unknown as SqlStorage;
  }
}

export class FakeCursor {
  constructor(private readonly rows: Row[]) {}

  toArray(): Row[] {
    return this.rows;
  }

  /** Like the real cursor: throws unless exactly one row came back. */
  one(): Row {
    if (this.rows.length !== 1)
      throw new Error(`Expected exactly one result, got ${this.rows.length}`);
    return this.rows[0]!;
  }

  [Symbol.iterator](): Iterator<Row> {
    return this.rows[Symbol.iterator]();
  }
}

/** The alarm part of `DurableObjectStorage`. */
export class FakeStorage {
  alarm: number | null = null;
  setAlarmCalls = 0;

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(time: number | Date): Promise<void> {
    this.setAlarmCalls++;
    this.alarm = typeof time === "number" ? time : time.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  asStorage(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }
}

interface FakeD1Result {
  success: true;
  results: Row[];
  meta: { changes: number; last_row_id: number; rows_written: number; changed_db: boolean };
}

export class FakeD1Statement {
  constructor(
    private readonly d1: FakeD1Database,
    readonly query: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1Statement {
    return new FakeD1Statement(this.d1, this.query, values);
  }

  /** Runs synchronously; D1 rejects undefined values and more than 100 params. */
  execute(): FakeD1Result {
    if (this.params.length > 100) throw new Error("D1_ERROR: too many SQL variables");
    if (this.params.some((p) => p === undefined)) {
      throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported");
    }
    const stmt = this.d1.db.prepare(oneStatement(this.query));
    let results: Row[] = [];
    let changes = 0;
    let lastRowId = 0;
    if (stmt.columns().length === 0) {
      const info = stmt.run(...this.params);
      changes = Number(info.changes);
      lastRowId = Number(info.lastInsertRowid);
    } else {
      results = stmt.all(...this.params).map((r) => ({ ...r }));
      if (!/^\s*(select|with|pragma)\b/i.test(this.query)) {
        changes = Number(this.d1.db.prepare("SELECT changes() AS c").get()!.c);
      }
    }
    return {
      success: true,
      results,
      meta: { changes, last_row_id: lastRowId, rows_written: changes, changed_db: changes > 0 },
    };
  }

  async run(): Promise<FakeD1Result> {
    return this.execute();
  }

  async all(): Promise<FakeD1Result> {
    return this.execute();
  }

  async first(column?: string): Promise<unknown> {
    const row = this.execute().results[0];
    if (!row) return null;
    return column === undefined ? row : row[column];
  }
}

/** `D1Database` with `batch()` executed as one transaction. */
export class FakeD1Database {
  readonly db = new DatabaseSync(":memory:");
  /** Statement count of every `batch()` call, in order. */
  readonly batchSizes: number[] = [];

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.db.exec(query);
    return { count: 1, duration: 0 };
  }

  async batch(statements: FakeD1Statement[]): Promise<FakeD1Result[]> {
    if (statements.length === 0) throw new Error("D1: batch requires at least one statement");
    this.batchSizes.push(statements.length);
    this.db.exec("BEGIN");
    try {
      const results = statements.map((s) => s.execute());
      this.db.exec("COMMIT");
      return results;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** All rows of a table ordered by its first column, for assertions. */
  rows(table: string): Row[] {
    return this.db
      .prepare(`SELECT * FROM "${table}" ORDER BY 1`)
      .all()
      .map((r) => ({ ...r }));
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
