import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  applyBatch,
  type OutboxOp,
  type OutboxRecord,
  type Projection,
  type ProjectionMap,
  type ReplicationBatch,
} from "../src/index.ts";
import type { FakeD1Database } from "./fakes.ts";
import { characterSummary, setupD1, type Summary } from "./fixtures.ts";

const SOURCE = "character:a:classic";
const projections: ProjectionMap = { character_summary: characterSummary };

function rec(
  seq: number,
  pk: string,
  op: OutboxOp,
  version: number,
  payload: Summary | null = null,
  table = "character_summary",
): OutboxRecord {
  return { seq, table, pk, op, version, payload, at: seq * 10 };
}

const up = (seq: number, pk: string, version: number, name: string, level = 1) =>
  rec(seq, pk, "upsert", version, { name, level });
const del = (seq: number, pk: string, version: number) => rec(seq, pk, "delete", version);
const batchOf = (...records: OutboxRecord[]): ReplicationBatch => ({ source: SOURCE, records });

let d1: FakeD1Database;
const apply = (b: ReplicationBatch, p = projections) => applyBatch(d1.asD1(), b, p);

beforeEach(async () => {
  d1 = await setupD1();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyBatch", () => {
  test("inserts new rows in exactly one db.batch()", async () => {
    const res = await apply(batchOf(up(1, "a", 1, "Ash", 5), up(2, "b", 1, "Misty", 7)));
    expect(res).toEqual({ applied: 2, stale: 0, unknown: 0 });
    expect(d1.batchSizes).toEqual([3]);
    expect(d1.rows("character_summary")).toEqual([
      { id: "a", name: "Ash", level: 5, _version: 1, _deleted: 0, _updated_at: 10 },
      { id: "b", name: "Misty", level: 7, _version: 1, _deleted: 0, _updated_at: 20 },
    ]);
  });

  test("updates a row with a newer version", async () => {
    await apply(batchOf(up(1, "a", 1, "Ash", 1)));
    const res = await apply(batchOf(up(2, "a", 2, "Ash", 2)));
    expect(res).toEqual({ applied: 1, stale: 0, unknown: 0 });
    expect(d1.rows("character_summary")).toMatchObject([
      { level: 2, _version: 2, _updated_at: 20 },
    ]);
  });

  test("skips an older or equal version arriving out of order", async () => {
    await apply(batchOf(up(2, "a", 2, "new")));
    expect(await apply(batchOf(up(1, "a", 1, "old")))).toEqual({
      applied: 0,
      stale: 1,
      unknown: 0,
    });
    expect(await apply(batchOf(up(2, "a", 2, "same")))).toEqual({
      applied: 0,
      stale: 1,
      unknown: 0,
    });
    expect(d1.rows("character_summary")).toMatchObject([{ name: "new", _version: 2 }]);
  });

  test("a duplicate batch is a no-op", async () => {
    const b = batchOf(up(1, "a", 1, "Ash"), up(2, "b", 1, "Brock"), del(3, "a", 2));
    expect(await apply(b)).toEqual({ applied: 2, stale: 1, unknown: 0 });
    const before = d1.rows("character_summary");
    expect(await apply(b)).toEqual({ applied: 0, stale: 3, unknown: 0 });
    expect(d1.rows("character_summary")).toEqual(before);
  });

  test("a tombstone blocks resurrection by an older upsert", async () => {
    await apply(batchOf(up(1, "a", 1, "Ash", 3)));
    expect(await apply(batchOf(del(2, "a", 2)))).toEqual({ applied: 1, stale: 0, unknown: 0 });
    // Columns are left untouched by the tombstone.
    expect(d1.rows("character_summary")).toEqual([
      { id: "a", name: "Ash", level: 3, _version: 2, _deleted: 1, _updated_at: 20 },
    ]);
    expect(await apply(batchOf(up(1, "a", 1, "Ash", 3)))).toEqual({
      applied: 0,
      stale: 1,
      unknown: 0,
    });
    expect(d1.rows("character_summary")).toMatchObject([{ _deleted: 1, _version: 2 }]);
  });

  test("a newer upsert revives a tombstoned row", async () => {
    await apply(batchOf(up(1, "a", 1, "Ash"), del(2, "a", 2)));
    await apply(batchOf(up(3, "a", 3, "Ash II", 9)));
    expect(d1.rows("character_summary")).toMatchObject([
      { name: "Ash II", level: 9, _version: 3, _deleted: 0 },
    ]);
  });

  test("a delete for an unknown pk creates a bare tombstone", async () => {
    expect(await apply(batchOf(del(1, "ghost", 4)))).toEqual({ applied: 1, stale: 0, unknown: 0 });
    expect(d1.rows("character_summary")).toEqual([
      { id: "ghost", name: null, level: null, _version: 4, _deleted: 1, _updated_at: 10 },
    ]);
    // The tombstone then wins against the older upsert arriving late.
    expect(await apply(batchOf(up(0, "ghost", 3, "late")))).toMatchObject({ applied: 0, stale: 1 });
  });

  test("records for unknown tables are counted, logged and dropped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await apply(
      batchOf(
        up(1, "a", 1, "Ash"),
        rec(2, "x", "upsert", 1, null, "not_a_table"),
        rec(3, "y", "delete", 1, null, "constructor"),
      ),
    );
    expect(res).toEqual({ applied: 1, stale: 0, unknown: 2 });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("not_a_table");
    expect(d1.rows("sync_cursor")).toMatchObject([{ source: SOURCE, last_seq: 3 }]);
  });

  test("sync_cursor keeps the max seq per source", async () => {
    await apply(batchOf(up(10, "a", 3, "x"), up(4, "b", 1, "y")));
    await apply(batchOf(up(5, "a", 1, "old")));
    await apply({ source: "character:b:classic", records: [up(2, "c", 1, "z")] });
    expect(d1.rows("sync_cursor")).toMatchObject([
      { source: SOURCE, last_seq: 10 },
      { source: "character:b:classic", last_seq: 2 },
    ]);
    await apply(batchOf(up(12, "a", 4, "x")));
    expect(d1.rows("sync_cursor")).toMatchObject([{ source: SOURCE, last_seq: 12 }, {}]);
  });

  test("coalesces records for the same pk to the newest version", async () => {
    const res = await apply(
      batchOf(up(1, "a", 1, "v1"), up(3, "a", 3, "v3"), up(2, "a", 2, "v2"), up(3, "a", 3, "v3")),
    );
    expect(res).toEqual({ applied: 1, stale: 3, unknown: 0 });
    expect(d1.batchSizes).toEqual([2]);
    expect(d1.rows("character_summary")).toMatchObject([{ name: "v3", _version: 3 }]);
  });

  test("splits more than 100 statements into sequential db.batch() calls", async () => {
    const records = Array.from({ length: 250 }, (_, i) => up(i + 1, `pk${i}`, 1, `n${i}`));
    expect(await apply(batchOf(...records))).toEqual({ applied: 250, stale: 0, unknown: 0 });
    expect(d1.batchSizes).toEqual([100, 100, 51]);
    expect(d1.rows("character_summary")).toHaveLength(250);
    expect(d1.rows("sync_cursor")).toMatchObject([{ last_seq: 250 }]);
  });

  test("an empty batch makes no D1 call", async () => {
    expect(await apply(batchOf())).toEqual({ applied: 0, stale: 0, unknown: 0 });
    expect(d1.batchSizes).toEqual([]);
  });

  test("quotes identifiers so keyword column names work", async () => {
    await d1.exec(
      `CREATE TABLE "order" ("group" TEXT PRIMARY KEY, "select" INTEGER, _version INTEGER NOT NULL, _deleted INTEGER NOT NULL DEFAULT 0, _updated_at INTEGER NOT NULL)`,
    );
    const order: Projection<{ n: number }> = {
      table: "order",
      pkColumn: "group",
      toRow: (p) => ({ select: p.n }),
    };
    const r = {
      seq: 1,
      table: "order",
      pk: "g",
      op: "upsert" as const,
      version: 1,
      payload: { n: 4 },
      at: 1,
    };
    expect(await apply(batchOf(r), { order })).toMatchObject({ applied: 1 });
    expect(d1.rows("order")).toMatchObject([{ group: "g", select: 4 }]);
  });
});

describe("applyBatch validation", () => {
  const bad = (p: Partial<Projection<Summary>>): ProjectionMap => ({
    character_summary: { ...characterSummary, ...p },
  });

  test.each([
    ["table", bad({ table: "character_summary; DROP TABLE sync_cursor" })],
    ["pk column", bad({ pkColumn: 'id" --' })],
    ["uppercase", bad({ table: "Character_Summary" })],
    ["column", bad({ toRow: () => ({ "name = 'x', level": 1 }) })],
  ])("rejects an invalid %s identifier before writing anything", async (_, p) => {
    await expect(apply(batchOf(up(1, "a", 1, "Ash")), p)).rejects.toThrow("invalid SQL identifier");
    expect(d1.batchSizes).toEqual([]);
  });

  test.each(["id", "_version", "_deleted", "_updated_at"])(
    "rejects toRow() returning the %s column",
    async (column) => {
      const p = bad({ toRow: () => ({ name: "x", [column]: 1 }) });
      await expect(apply(batchOf(up(1, "a", 1, "Ash")), p)).rejects.toThrow("must not return");
    },
  );

  test("rejects an invalid version", async () => {
    await expect(apply(batchOf(up(1, "a", 0, "Ash")))).rejects.toThrow("invalid version");
  });

  test("a failing statement rolls back its whole db.batch()", async () => {
    const p: ProjectionMap = {
      ...projections,
      missing: { table: "missing_table", pkColumn: "id", toRow: () => ({}) },
    };
    const b = batchOf(up(1, "a", 1, "Ash"), rec(2, "m", "upsert", 1, null, "missing"));
    await expect(apply(b, p)).rejects.toThrow();
    expect(d1.rows("character_summary")).toEqual([]);
    expect(d1.rows("sync_cursor")).toEqual([]);
  });
});
