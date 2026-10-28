/**
 * In-memory D1 stand-in over node:sqlite for leaderboard tests (the same
 * pattern as packages/sync/tests/fakes.ts). Only the statement API the
 * leaderboard code uses: prepare().bind().all() / first() / run().
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

type Row = Record<string, unknown>;

export class FakeD1Statement {
  constructor(
    private readonly d1: FakeD1,
    private readonly query: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1Statement {
    if (values.some((v) => v === undefined)) throw new TypeError("D1_TYPE_ERROR: undefined");
    return new FakeD1Statement(this.d1, this.query, values);
  }

  /** Runs synchronously; a missing table throws the same message as D1. */
  private execute(): { success: true; results: Row[]; meta: Record<string, unknown> } {
    this.d1.statements.push({ sql: this.query, params: [...this.params] });
    const stmt = this.d1.db.prepare(this.query);
    const results = stmt.all(...(this.params as never[])).map((r) => ({ ...r }));
    return { success: true, results, meta: { changes: 0, rows_read: results.length } };
  }

  async all<T = Row>(): Promise<{ success: true; results: T[]; meta: Record<string, unknown> }> {
    return this.execute() as never;
  }

  async first<T = Row>(): Promise<T | null> {
    return (this.execute().results[0] ?? null) as T | null;
  }

  async run(): Promise<{ success: true; results: Row[]; meta: Record<string, unknown> }> {
    return this.execute();
  }
}

export class FakeD1 {
  readonly db = new DatabaseSync(":memory:");
  /** Every statement executed, in order (for bound-parameter assertions). */
  readonly statements: { sql: string; params: unknown[] }[] = [];

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Applies the given migration files from apps/game/migrations, in order. */
  migrate(names: string[]): void {
    const dir = join(import.meta.dirname, "..", "..", "migrations");
    for (const name of names) this.db.exec(readFileSync(join(dir, name), "utf8"));
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

/** Inserts a classic_hero row with defaults for every column. */
export function insertHero(
  d1: FakeD1,
  row: Partial<Record<string, unknown>> & { id: string },
): void {
  const full: Record<string, unknown> = {
    account_id: `acc-${row.id}`,
    display_name: row.id,
    mode: "classic",
    imported: 0,
    hero_name: "Hero",
    class_id: "classic.warrior",
    level: 1,
    xp: 0,
    deepest_depth: 0,
    rift_best_level: 0,
    rift_best_score: 0,
    play_ticks: 0,
    kills: 0,
    deaths: 0,
    _version: 1,
    _deleted: 0,
    _updated_at: 1000,
    ...row,
  };
  insertInto(d1, "classic_hero", full);
}

/** Inserts a leaderboard_rift row with defaults for every column. */
export function insertRift(
  d1: FakeD1,
  row: Partial<Record<string, unknown>> & { id: string },
): void {
  const full: Record<string, unknown> = {
    account_id: `acc-${row.id}`,
    display_name: row.id,
    mode: "classic",
    imported: 0,
    hero_name: "Hero",
    class_id: "classic.warrior",
    hero_level: 1,
    rift_level: 1,
    score: 0,
    ticks: 0,
    deaths: 0,
    completed: 1,
    run: 1,
    end_tick: 100,
    _version: 1,
    _deleted: 0,
    _updated_at: 1000,
    ...row,
  };
  insertInto(d1, "leaderboard_rift", full);
}

function insertInto(d1: FakeD1, table: string, values: Record<string, unknown>): void {
  const cols = Object.keys(values);
  d1.db
    .prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(...(cols.map((c) => values[c]) as never[]));
}
