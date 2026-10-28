/** GET /api/leaderboards: status codes, headers, body shape (fake D1, no auth). */
import type { LeaderboardResponse } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import type { Env } from "../../src/server/contracts.ts";
import { leaderboardRoutes } from "../../src/server/routes/leaderboards.ts";
import type { RouteContext } from "../../src/server/routes/types.ts";
import { FakeD1, insertHero } from "./fake-d1.ts";

function call(d1: FakeD1, path: string, init: RequestInit = {}) {
  const url = new URL(path, "https://gamez.test");
  const c: RouteContext = {
    request: new Request(url, init),
    env: { DB: d1.asD1() } as unknown as Env,
    url,
    ctx: {} as ExecutionContext,
  };
  return leaderboardRoutes(c);
}

function migrated(): FakeD1 {
  const d1 = new FakeD1();
  d1.migrate(["0001_init.sql", "0002_leaderboards.sql"]);
  return d1;
}

describe("GET /api/leaderboards", () => {
  it("ignores other paths", async () => {
    expect(await call(migrated(), "/api/other?board=level")).toBe(null);
  });

  it("answers 200 with rows, public cache headers and no auth", async () => {
    const d1 = migrated();
    insertHero(d1, { id: "a", level: 7, xp: 40 });
    insertHero(d1, { id: "b", level: 9, xp: 10 });
    const res = (await call(d1, "/api/leaderboards?board=level&mode=classic&limit=1"))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=15");
    const body = (await res.json()) as LeaderboardResponse;
    expect(body.available).toBe(true);
    expect(body.board).toBe("level");
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ rank: 1, accountId: "acc-b", value: 9 });
  });

  it("answers available: false for a fresh database", async () => {
    const res = (await call(new FakeD1(), "/api/leaderboards?board=rift"))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      board: "rift",
      mode: "classic",
      classId: null,
      rows: [],
      available: false,
    });
  });

  it("rejects bad parameters with 400 bad_request", async () => {
    const d1 = migrated();
    for (const qs of [
      "",
      "?board=xp",
      "?board=level&mode=steps",
      "?board=level&classId=evil%27--",
    ]) {
      const res = (await call(d1, `/api/leaderboards${qs}`))!;
      expect(res.status, qs).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("bad_request");
    }
  });

  it("filters by class and clamps the limit", async () => {
    const d1 = migrated();
    for (let i = 0; i < 3; i++) insertHero(d1, { id: `w${i}`, level: 10 + i });
    insertHero(d1, { id: "r", class_id: "classic.rogue", level: 99 });
    const rogue = (await (await call(
      d1,
      "/api/leaderboards?board=level&classId=classic.rogue",
    ))!.json()) as LeaderboardResponse;
    expect(rogue.rows.map((r) => r.accountId)).toEqual(["acc-r"]);
    const all = (await (await call(
      d1,
      "/api/leaderboards?board=level&limit=0",
    ))!.json()) as LeaderboardResponse;
    expect(all.rows).toHaveLength(1);
    const big = (await (await call(
      d1,
      "/api/leaderboards?board=level&limit=5000",
    ))!.json()) as LeaderboardResponse;
    expect(big.rows).toHaveLength(4);
  });

  it("rejects other methods with 405", async () => {
    const res = (await call(migrated(), "/api/leaderboards?board=level", { method: "POST" }))!;
    expect(res.status).toBe(405);
  });
});
