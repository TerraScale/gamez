/** Leaderboard query parsing, SQL rules and the D1 read against migrated tables. */
import { describe, expect, it } from "vite-plus/test";
import {
  buildLeaderboardSql,
  clampLimit,
  mapLeaderboardRows,
  parseLeaderboardQuery,
} from "../../src/server/leaderboards/query.ts";
import { readLeaderboard } from "../../src/server/leaderboards/read.ts";
import { FakeD1, insertHero, insertRift } from "./fake-d1.ts";

const MIGRATIONS = ["0001_init.sql", "0002_leaderboards.sql"];

function migrated(): FakeD1 {
  const d1 = new FakeD1();
  d1.migrate(MIGRATIONS);
  return d1;
}

const params = (qs: string) => new URLSearchParams(qs);

describe("parseLeaderboardQuery", () => {
  it("accepts the three boards and defaults mode, limit and class", () => {
    for (const board of ["level", "depth", "rift"]) {
      const r = parseLeaderboardQuery(params(`board=${board}`));
      expect(r).toEqual({
        ok: true,
        query: { board, mode: "classic", classId: null, limit: 50 },
      });
    }
  });

  it("rejects a missing or unknown board", () => {
    expect(parseLeaderboardQuery(params("")).ok).toBe(false);
    expect(parseLeaderboardQuery(params("board=xp")).ok).toBe(false);
    expect(parseLeaderboardQuery(params("board=LEVEL")).ok).toBe(false);
  });

  it("rejects any mode other than classic", () => {
    expect(parseLeaderboardQuery(params("board=level&mode=steps")).ok).toBe(false);
    expect(parseLeaderboardQuery(params("board=level&mode=classic")).ok).toBe(true);
  });

  it("rejects class ids that do not look like classic.<name>", () => {
    expect(parseLeaderboardQuery(params("board=level&classId=classic.rogue")).ok).toBe(true);
    expect(parseLeaderboardQuery(params("board=level&classId=rogue")).ok).toBe(false);
    expect(parseLeaderboardQuery(params("board=level&classId=classic.x'%20OR%201=1--")).ok).toBe(
      false,
    );
  });

  it("treats an empty classId as no filter", () => {
    const r = parseLeaderboardQuery(params("board=depth&classId="));
    expect(r.ok && r.query.classId).toBe(null);
  });
});

describe("clampLimit", () => {
  it("clamps to 1..100 and defaults to 50", () => {
    expect(clampLimit(null)).toBe(50);
    expect(clampLimit("")).toBe(50);
    expect(clampLimit("abc")).toBe(50);
    expect(clampLimit("0")).toBe(1);
    expect(clampLimit("-5")).toBe(1);
    expect(clampLimit("7.9")).toBe(7);
    expect(clampLimit("100")).toBe(100);
    expect(clampLimit("9999")).toBe(100);
  });
});

describe("buildLeaderboardSql", () => {
  it("binds the class filter as a parameter, never as text", () => {
    const q = buildLeaderboardSql({
      board: "level",
      mode: "classic",
      classId: "classic.rogue",
      limit: 5,
    });
    expect(q.sql).toContain("class_id = ?");
    expect(q.sql).not.toContain("classic.rogue");
    expect(q.params).toEqual(["classic", "classic.rogue", 5]);
  });

  it("always excludes deleted rows", () => {
    for (const board of ["level", "depth", "rift"] as const) {
      const q = buildLeaderboardSql({ board, mode: "classic", classId: null, limit: 1 });
      expect(q.sql).toContain("_deleted = 0");
    }
  });
});

describe("readLeaderboard against migrated tables", () => {
  it("level: orders by level then xp, numbers ranks from 1", async () => {
    const d1 = migrated();
    insertHero(d1, { id: "a", level: 10, xp: 500, _updated_at: 1 });
    insertHero(d1, { id: "b", level: 12, xp: 100, _updated_at: 2 });
    insertHero(d1, { id: "c", level: 10, xp: 900, _updated_at: 3 });
    const res = await readLeaderboard(d1.asD1(), {
      board: "level",
      mode: "classic",
      classId: null,
      limit: 50,
    });
    expect(res.available).toBe(true);
    expect(res.rows.map((r) => [r.rank, r.accountId, r.value])).toEqual([
      [1, "acc-b", 12],
      [2, "acc-c", 10],
      [3, "acc-a", 10],
    ]);
    expect(res.rows[1]).toMatchObject({
      displayName: "c",
      heroName: "Hero",
      classId: "classic.warrior",
      heroLevel: 10,
      imported: false,
      updatedAt: 3,
      extra: { xp: 900 },
    });
  });

  it("depth: orders by deepest depth then level", async () => {
    const d1 = migrated();
    insertHero(d1, { id: "a", deepest_depth: 5, level: 20 });
    insertHero(d1, { id: "b", deepest_depth: 7, level: 3 });
    insertHero(d1, { id: "c", deepest_depth: 5, level: 25 });
    const res = await readLeaderboard(d1.asD1(), {
      board: "depth",
      mode: "classic",
      classId: null,
      limit: 50,
    });
    expect(res.rows.map((r) => r.accountId)).toEqual(["acc-b", "acc-c", "acc-a"]);
    expect(res.rows.map((r) => r.value)).toEqual([7, 5, 5]);
  });

  it("filters every board by class", async () => {
    const d1 = migrated();
    insertHero(d1, { id: "w", class_id: "classic.warrior", level: 30 });
    insertHero(d1, { id: "r", class_id: "classic.rogue", level: 20 });
    const res = await readLeaderboard(d1.asD1(), {
      board: "level",
      mode: "classic",
      classId: "classic.rogue",
      limit: 50,
    });
    expect(res.classId).toBe("classic.rogue");
    expect(res.rows.map((r) => r.accountId)).toEqual(["acc-r"]);
  });

  it("rift: keeps each account's best completed run and ranks by score", async () => {
    const d1 = migrated();
    insertRift(d1, { id: "x1", account_id: "acc-x", score: 300, run: 1 });
    insertRift(d1, { id: "x2", account_id: "acc-x", score: 900, run: 2, rift_level: 4 });
    insertRift(d1, { id: "x3", account_id: "acc-x", score: 5000, run: 3, completed: 0 });
    insertRift(d1, { id: "y1", account_id: "acc-y", score: 700, run: 1 });
    insertRift(d1, { id: "z1", account_id: "acc-z", score: 2000, run: 1, _deleted: 1 });
    const res = await readLeaderboard(d1.asD1(), {
      board: "rift",
      mode: "classic",
      classId: null,
      limit: 50,
    });
    expect(res.rows.map((r) => [r.accountId, r.value])).toEqual([
      ["acc-x", 900],
      ["acc-y", 700],
    ]);
    expect(res.rows[0]!.extra).toEqual({ riftLevel: 4, ticks: 0, deaths: 0 });
  });

  it("limit caps the number of rows", async () => {
    const d1 = migrated();
    for (let i = 0; i < 5; i++) insertHero(d1, { id: `p${i}`, level: i + 1 });
    const res = await readLeaderboard(d1.asD1(), {
      board: "level",
      mode: "classic",
      classId: null,
      limit: 2,
    });
    expect(res.rows.map((r) => r.value)).toEqual([5, 4]);
  });

  it("excludes tombstoned heroes", async () => {
    const d1 = migrated();
    insertHero(d1, { id: "gone", level: 99, _deleted: 1 });
    insertHero(d1, { id: "here", level: 2 });
    const res = await readLeaderboard(d1.asD1(), {
      board: "level",
      mode: "classic",
      classId: null,
      limit: 50,
    });
    expect(res.rows.map((r) => r.accountId)).toEqual(["acc-here"]);
  });

  it("never ranks imported heroes or their rift runs on any board (ADR 0007 R1)", async () => {
    const d1 = migrated();
    insertHero(d1, { id: "forged", level: 99, xp: 9e9, deepest_depth: 99, imported: 1 });
    insertHero(d1, { id: "honest", level: 5, xp: 10, deepest_depth: 3 });
    insertRift(d1, { id: "f1", account_id: "acc-forged", score: 99_999, run: 1, imported: 1 });
    insertRift(d1, { id: "h1", account_id: "acc-honest", score: 400, run: 1 });
    // An account's imported best run must not hide its honest (lower) run.
    insertRift(d1, { id: "m1", account_id: "acc-mixed", score: 50_000, run: 1, imported: 1 });
    insertRift(d1, { id: "m2", account_id: "acc-mixed", score: 300, run: 2 });
    const read = (board: "level" | "depth" | "rift", classId: string | null = null) =>
      readLeaderboard(d1.asD1(), { board, mode: "classic", classId, limit: 50 });
    expect((await read("level")).rows.map((r) => r.accountId)).toEqual(["acc-honest"]);
    expect((await read("depth")).rows.map((r) => r.accountId)).toEqual(["acc-honest"]);
    expect((await read("rift")).rows.map((r) => [r.accountId, r.value])).toEqual([
      ["acc-honest", 400],
      ["acc-mixed", 300],
    ]);
    // With a class filter too.
    const byClass = await read("level", "classic.warrior");
    expect(byClass.rows.map((r) => r.accountId)).toEqual(["acc-honest"]);
    for (const board of ["level", "depth", "rift"] as const) {
      for (const row of (await read(board)).rows) expect(row.imported).toBe(false);
      const q = buildLeaderboardSql({ board, mode: "classic", classId: null, limit: 1 });
      expect(q.sql).toContain("COALESCE(imported, 0) = 0");
    }
  });

  it("answers available: false with no rows when the tables are missing", async () => {
    const d1 = new FakeD1();
    for (const board of ["level", "depth", "rift"] as const) {
      const res = await readLeaderboard(d1.asD1(), {
        board,
        mode: "classic",
        classId: null,
        limit: 50,
      });
      expect(res).toEqual({ board, mode: "classic", classId: null, rows: [], available: false });
    }
  });

  it("maps rows without touching column order", () => {
    const rows = mapLeaderboardRows("depth", [
      {
        account_id: "a",
        display_name: "A",
        hero_name: "H",
        class_id: "classic.sorcerer",
        level: 4,
        xp: 3,
        deepest_depth: 2,
        imported: 0,
        _updated_at: 9,
      },
    ]);
    expect(rows).toEqual([
      {
        rank: 1,
        accountId: "a",
        displayName: "A",
        heroName: "H",
        classId: "classic.sorcerer",
        heroLevel: 4,
        value: 2,
        extra: { xp: 3 },
        imported: false,
        updatedAt: 9,
      },
    ]);
  });
});
