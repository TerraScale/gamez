/**
 * In-memory SQLite (node:sqlite) stand-ins for Durable Object storage, for
 * unit tests of the wave B DO logic classes (account/*, guild/*, chat/*,
 * instance/verified-*). Shared test support (architect-owned): add helpers in
 * your own test files instead of editing this one.
 */
import { DatabaseSync } from "node:sqlite";
import type { SqlStore } from "../../src/server/contracts.ts";

type Row = Record<string, unknown>;

class FakeCursor {
  constructor(private readonly rows: Row[]) {}
  toArray(): Row[] {
    return this.rows;
  }
  one(): Row {
    if (this.rows.length !== 1)
      throw new Error(`Expected exactly one result, got ${this.rows.length}`);
    return this.rows[0]!;
  }
  [Symbol.iterator](): Iterator<Row> {
    return this.rows[Symbol.iterator]();
  }
}

/** `ctx.storage.sql` + `transactionSync` over one in-memory database. */
export class FakeSqlStorage {
  readonly db = new DatabaseSync(":memory:");

  exec(query: string, ...bindings: unknown[]): FakeCursor {
    for (const b of bindings) {
      if (b === undefined) throw new TypeError("SqlStorage: undefined binding");
    }
    const body = query.trim().replace(/;\s*$/, "");
    if (body.includes(";")) throw new Error("fake supports a single statement per call");
    const rows = this.db.prepare(body).all(...bindings);
    return new FakeCursor(rows.map((r) => ({ ...r })));
  }

  get databaseSize(): number {
    return 0;
  }

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

/** A SqlStore for logic classes (contracts.ts SqlStore). */
export function fakeSqlStore(): SqlStore & { fake: FakeSqlStorage } {
  const fake = new FakeSqlStorage();
  return { fake, sql: fake.asSql(), transactionSync: (fn) => fake.transactionSync(fn) };
}

/** The alarm part of DurableObjectStorage (Outbox.scheduleFlush). */
export class FakeAlarmStorage {
  alarm: number | null = null;
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(time: number | Date): Promise<void> {
    this.alarm = typeof time === "number" ? time : time.getTime();
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
  asStorage(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }
}
