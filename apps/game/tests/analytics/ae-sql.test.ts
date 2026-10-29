/**
 * AE SQL backend (analytics/ae-sql.ts): the SQL of each query shape (pinned
 * strings), escaping of hostile values, columns only from the schema, and
 * response parsing over a fake fetch. UNVERIFIED against the live AE SQL API
 * (no credentials in this environment): these pin what we send and how we
 * read the documented `{ data: [...] }` JSON.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  AE_SQL_URL,
  aeSqlQuery,
  distinctSql,
  quantilesSql,
  seriesSql,
  sqlString,
  totalsSql,
} from "../../src/server/analytics/ae-sql.ts";
import { analyticsQueryFor } from "../../src/server/analytics/index.ts";
import type { MetricName } from "../../src/server/analytics/schema.ts";

const FROM = 1_800_000_000_000;
const TO = FROM + 3_600_000;
const W = `blob1 = 'http.request' AND timestamp >= toDateTime(1800000000) AND timestamp < toDateTime(1800003600)`;

interface Call {
  url: string;
  init: RequestInit;
  /** The request body (always a string here). */
  sql: string;
  self: unknown;
}

function fakeFetch(answer: (sql: string) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = function (this: unknown, url: RequestInfo | URL, init?: RequestInit) {
    const sql = typeof init?.body === "string" ? init.body : "";
    calls.push({
      url: url instanceof URL ? url.href : (url as string),
      init: init ?? {},
      sql,
      self: this,
    });
    const a = answer(sql);
    const text = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
    return Promise.resolve(new Response(text, { status: a.status ?? 200 }));
  } as typeof fetch;
  return { calls, fn };
}

describe("AE SQL strings", () => {
  it("totals: count and weighted sum, grouped, ordered, limited", () => {
    expect(
      totalsSql({
        metric: "http.request",
        from: FROM,
        to: TO,
        groupBy: ["route", "statusClass"],
        value: { op: "count" },
      }),
    ).toBe(
      `SELECT blob2 AS k0, blob4 AS k1, SUM(_sample_interval) AS v FROM gamez_events WHERE ${W}` +
        ` GROUP BY k0, k1 ORDER BY v DESC, k0, k1 LIMIT 50 FORMAT JSON`,
    );
    expect(
      totalsSql(
        {
          metric: "http.request",
          from: FROM,
          to: TO,
          where: { statusClass: "5xx", method: "GET" },
          index: "acc-1",
          groupBy: [],
          value: { op: "sum", field: "ms" },
          limit: 9999,
        },
        "my_dataset",
      ),
    ).toBe(
      `SELECT SUM(_sample_interval * double1) AS v FROM my_dataset WHERE ${W}` +
        ` AND blob3 = 'GET' AND blob4 = '5xx' AND index1 = 'acc-1' FORMAT JSON`,
    );
  });

  it("series: second buckets from intDiv(toUInt32(timestamp))", () => {
    expect(
      seriesSql({
        metric: "http.request",
        from: FROM,
        to: TO,
        groupBy: ["statusClass"],
        value: { op: "count" },
        bucketMs: 3_600_000,
      }),
    ).toBe(
      `SELECT intDiv(toUInt32(timestamp), 3600) * 3600 AS bt, blob4 AS k0, SUM(_sample_interval) AS v` +
        ` FROM gamez_events WHERE ${W} GROUP BY bt, k0 ORDER BY bt ASC LIMIT 20000 FORMAT JSON`,
    );
  });

  it("quantiles: quantileExactWeighted per q", () => {
    expect(
      quantilesSql({ metric: "http.request", from: FROM, to: TO, field: "ms", q: [0.5, 0.95] }),
    ).toBe(
      `SELECT quantileExactWeighted(0.5)(double1, _sample_interval) AS q0,` +
        ` quantileExactWeighted(0.95)(double1, _sample_interval) AS q1 FROM gamez_events WHERE ${W} FORMAT JSON`,
    );
  });

  it("distinct: COUNT(DISTINCT index1) over non-empty keys", () => {
    expect(
      distinctSql({
        metric: "client.session",
        from: FROM,
        to: TO,
        where: { phase: "heartbeat" },
      }),
    ).toBe(
      `SELECT COUNT(DISTINCT index1) AS v FROM gamez_events WHERE blob1 = 'client.session'` +
        ` AND timestamp >= toDateTime(1800000000) AND timestamp < toDateTime(1800003600)` +
        ` AND blob2 = 'heartbeat' AND index1 != '' FORMAT JSON`,
    );
  });
});

describe("escaping and schema-only columns", () => {
  it("doubles single quotes", () => {
    expect(sqlString("O'Brien")).toBe("'O''Brien'");
    expect(
      totalsSql({
        metric: "http.request",
        from: FROM,
        to: TO,
        where: { route: "x' OR '1'='1" },
        groupBy: [],
        value: { op: "count" },
      }),
    ).toContain(`blob2 = 'x'' OR ''1''=''1'`);
  });

  it.each(["a\nb", "a\u0000", "tab\there", "back\\slash", "del\u007f"])(
    "rejects control characters and backslashes: %j",
    (v) => {
      expect(() => sqlString(v)).toThrow();
      expect(() =>
        totalsSql({
          metric: "http.request",
          from: FROM,
          to: TO,
          index: v,
          groupBy: [],
          value: { op: "count" },
        }),
      ).toThrow();
    },
  );

  it("throws on unknown metrics, fields, datasets and bad numbers", () => {
    const base = { from: FROM, to: TO, groupBy: [], value: { op: "count" as const } };
    expect(() => totalsSql({ metric: "x; DROP" as MetricName, ...base })).toThrow();
    expect(() =>
      totalsSql({ metric: "http.request", ...base, groupBy: ["blob1" as "route"] }),
    ).toThrow();
    expect(() =>
      totalsSql({ metric: "http.request", ...base, where: { "1=1 --": "x" } as never }),
    ).toThrow();
    expect(() => totalsSql({ metric: "http.request", ...base }, "gamez; DROP")).toThrow();
    expect(() => totalsSql({ metric: "http.request", ...base, from: NaN })).toThrow();
    expect(() =>
      quantilesSql({ metric: "http.request", from: FROM, to: TO, field: "ms", q: [2] }),
    ).toThrow();
  });
});

describe("aeSqlQuery over a fake fetch", () => {
  it("POSTs the SQL with the bearer token to the account endpoint, as a plain call", async () => {
    const f = fakeFetch(() => ({
      body: { meta: [], data: [{ k0: "/api/me", v: "12" }], rows: 1 },
    }));
    const q = aeSqlQuery({ accountId: "acc123", token: "tok", fetchFn: f.fn });
    const rows = await q.totals({
      metric: "http.request",
      from: FROM,
      to: TO,
      groupBy: ["route"],
      value: { op: "count" },
    });
    expect(rows).toEqual([{ keys: { route: "/api/me" }, value: 12 }]);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql",
    );
    expect(call.url).toBe(AE_SQL_URL("acc123"));
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(call.sql).toMatch(/^SELECT blob2 AS k0/);
    // Workers' fetch throws "Illegal invocation" when called with another `this`.
    expect(call.self).toBeUndefined();
  });

  it("parses series, quantiles (nan/null -> 0) and distinct", async () => {
    const f = fakeFetch((sql) => {
      if (sql.includes("intDiv")) {
        return {
          body: {
            data: [
              { bt: 1800000000, k0: "2xx", v: 5 },
              { bt: "1800003600", k0: "2xx", v: "2" },
              { bt: 1800000000, k0: "5xx", v: 1 },
            ],
          },
        };
      }
      if (sql.includes("quantileExactWeighted"))
        return { body: { data: [{ q0: 12.5, q1: null }] } };
      return { body: { data: [{ v: "42" }] } };
    });
    const q = aeSqlQuery({ accountId: "a", token: "t", dataset: "ds", fetchFn: f.fn });
    const series = await q.series({
      metric: "http.request",
      from: FROM,
      to: TO,
      groupBy: ["statusClass"],
      value: { op: "count" },
      bucketMs: 3_600_000,
      limit: 1,
    });
    expect(series).toEqual([
      { t: 1_800_000_000_000, keys: { statusClass: "2xx" }, value: 5 },
      { t: 1_800_003_600_000, keys: { statusClass: "2xx" }, value: 2 },
    ]);
    await expect(
      q.quantiles({ metric: "http.request", from: FROM, to: TO, field: "ms", q: [0.5, 0.95] }),
    ).resolves.toEqual([12.5, 0]);
    await expect(
      q.quantiles({ metric: "http.request", from: FROM, to: TO, field: "ms", q: [] }),
    ).resolves.toEqual([]);
    await expect(q.distinct({ metric: "client.session", from: FROM, to: TO })).resolves.toBe(42);
    expect(f.calls[0]!.sql).toContain("FROM ds WHERE");
  });

  it("an ungrouped total is one row, 0 when AE returns nothing", async () => {
    const f = fakeFetch(() => ({ body: { data: [] } }));
    const q = aeSqlQuery({ accountId: "a", token: "t", fetchFn: f.fn });
    await expect(
      q.totals({ metric: "ws.open", from: FROM, to: TO, groupBy: [], value: { op: "count" } }),
    ).resolves.toEqual([{ keys: {}, value: 0 }]);
  });

  it("rejects HTTP errors, non-JSON and bodies without data", async () => {
    const base = {
      metric: "ws.open" as const,
      from: FROM,
      to: TO,
      groupBy: ["kind" as const],
      value: { op: "count" as const },
    };
    const q = (answer: { status?: number; body: unknown }) =>
      aeSqlQuery({ accountId: "a", token: "t", fetchFn: fakeFetch(() => answer).fn });
    await expect(q({ status: 401, body: "unauthorized" }).totals(base)).rejects.toThrow(/401/);
    await expect(q({ body: "<html>" }).totals(base)).rejects.toThrow(/non-JSON/);
    await expect(q({ body: { errors: ["x"] } }).totals(base)).rejects.toThrow(/no data/);
  });

  it("analyticsQueryFor passes the dataset and fetch through", async () => {
    const f = fakeFetch(() => ({ body: { data: [{ v: 3 }] } }));
    const q = analyticsQueryFor(
      { ANALYTICS_ACCOUNT_ID: "acc", ANALYTICS_API_TOKEN: "tok", ANALYTICS_DATASET: "other_ds" },
      f.fn,
    );
    expect(q.source).toBe("ae");
    await expect(q.distinct({ metric: "verify.resync", from: FROM, to: TO })).resolves.toBe(3);
    expect(f.calls[0]!.sql).toContain("FROM other_ds WHERE");
  });
});
