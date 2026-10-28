/** GET /api/admin/overview reader (admin/metrics/overview.ts): D1 numbers, AE approximations, source flags. */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { AdminRange, AdminSource } from "@gamez/protocol";
import type { AnalyticsQuery, AnalyticsSourceKind } from "../../src/server/analytics/types.ts";
import type { Analytics } from "../../src/server/analytics/types.ts";
import { readOverview } from "../../src/server/admin/metrics/overview.ts";
import type { MetricsDeps } from "../../src/server/admin/metrics/util.ts";
import { DAY_MS, HOUR_MS } from "../../src/server/admin/metrics/util.ts";
import type { Env } from "../../src/server/contracts.ts";
import { FakeD1 } from "../leaderboards/fake-d1.ts";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const TODAY = Math.floor(NOW / DAY_MS);
const ALL_MIGRATIONS = readdirSync(new URL("../../migrations", import.meta.url))
  .filter((n) => n.endsWith(".sql"))
  .sort();

/** Three days ending today: [today-2, today]. */
const RANGE: AdminRange = {
  from: (TODAY - 2) * DAY_MS,
  to: (TODAY + 1) * DAY_MS,
  bucket: "day",
  bucketMs: DAY_MS,
};

type Call = { op: string; q: Record<string, unknown> };

/** A fake AnalyticsQuery: records every query and answers from `answer`. */
function fakeAq(
  answer: (op: string, q: Record<string, unknown>) => unknown,
  source: AnalyticsSourceKind = "ae",
) {
  const calls: Call[] = [];
  const run =
    (op: string) =>
    (q: Record<string, unknown>): Promise<unknown> => {
      calls.push({ op, q });
      try {
        return Promise.resolve(answer(op, q));
      } catch (err) {
        return Promise.reject(err);
      }
    };
  return {
    source,
    calls,
    totals: run("totals"),
    series: run("series"),
    quantiles: run("quantiles"),
    distinct: run("distinct"),
  } as unknown as AnalyticsQuery & { calls: Call[] };
}

const noopAnalytics = { write() {}, flush: async () => {} } as unknown as Analytics;

function seed(d1: FakeD1, withPurchases = true): void {
  const acc = (id: string, kind: string, deleted = 0) =>
    d1.db
      .prepare(
        `INSERT INTO account_summary (account_id, display_name, kind, created_at, _version, _deleted, _updated_at)
         VALUES (?, ?, ?, 0, 1, ?, 0)`,
      )
      .run(id, id, kind, deleted);
  acc("acc-g1", "guest");
  acc("acc-g2", "guest");
  acc("acc-r1", "google");
  acc("acc-r2", "password");
  acc("acc-deleted", "guest", 1);

  const act = (account: string, day: number, deleted = 0) =>
    d1.db
      .prepare(
        `INSERT INTO account_activity (id, account_id, day, kind, first_at, _version, _deleted, _updated_at)
         VALUES (?, ?, ?, 'guest', 0, 1, ?, 0)`,
      )
      .run(`${account}/${day}`, account, day, deleted);
  act("acc-g1", TODAY); // DAU, WAU, MAU
  act("acc-r1", TODAY); // DAU, WAU, MAU
  act("acc-r1", TODAY - 1); // WAU, MAU (same account, not double-counted)
  act("acc-g2", TODAY - 6); // WAU, MAU
  act("acc-m", TODAY - 20); // MAU only
  act("acc-old", TODAY - 40); // none
  act("acc-deleted", TODAY, 1); // tombstone: ignored

  const pay = (
    id: string,
    currency: string,
    amount: number,
    status: string,
    at: number,
    deleted = 0,
  ) =>
    d1.db
      .prepare(
        `INSERT INTO purchase (id, account_id, sku, provider, currency, amount_minor, status, provider_ref,
           created_at, updated_at, _version, _deleted, _updated_at)
         VALUES (?, 'acc-g1', 'sku', 'stub', ?, ?, ?, '', 0, ?, 1, ?, 0)`,
      )
      .run(id, currency, amount, status, at, deleted);
  if (!withPurchases) return;
  pay("p1", "USD", 1000, "paid", NOW - HOUR_MS); // counted
  pay("p2", "BRL", 5000, "paid", NOW - 23 * HOUR_MS); // counted
  pay("p3", "USD", 700, "paid", NOW - 25 * HOUR_MS); // older than 24 h
  pay("p4", "USD", 300, "refunded", NOW - HOUR_MS); // not paid
  pay("p5", "USD", 9999, "paid", NOW - HOUR_MS, 1); // tombstone
}

function migratedD1(): FakeD1 {
  const d1 = new FakeD1();
  d1.migrate(ALL_MIGRATIONS);
  return d1;
}

/** The AE answers of a healthy backend. */
function healthyAnswer(op: string, q: Record<string, unknown>): unknown {
  if (op === "distinct") {
    const where = q.where as { phase: string };
    return where.phase === "start" ? 5 : 7;
  }
  if (op === "totals" && (q.groupBy as string[])[0] === "statusClass") {
    return [
      { keys: { statusClass: "2xx" }, value: 90 },
      { keys: { statusClass: "5xx" }, value: 10 },
      // WebSocket upgrades are left out of the error-rate denominator.
      { keys: { statusClass: "101" }, value: 400 },
    ];
  }
  if (op === "quantiles") return [4500];
  return [];
}

function deps(d1: FakeD1, aq: AnalyticsQuery): MetricsDeps {
  return { env: {} as Env, db: d1.asD1(), aq, analytics: noopAnalytics, now: NOW };
}

function sourceOf(sources: AdminSource[], name: string): AdminSource | undefined {
  return sources.find((s) => s.name === name);
}

describe("readOverview", () => {
  it("answers exact D1 numbers: accounts, DAU/WAU/MAU, revenue, daily DAU", async () => {
    const d1 = migratedD1();
    seed(d1);
    const out = await readOverview(deps(d1, fakeAq(healthyAnswer)), RANGE);

    expect(out.at).toBe(NOW);
    expect(out.range).toEqual(RANGE);
    expect(out.accounts).toEqual({ total: 4, guest: 2, registered: 2 });
    expect(out.dau).toBe(2);
    expect(out.wau).toBe(3);
    expect(out.mau).toBe(4);
    expect(out.revenueMinor24h).toEqual({ USD: 1000, BRL: 5000 });

    expect(out.activeSeries).toHaveLength(1);
    expect(out.activeSeries[0]).toEqual({
      key: "dau",
      label: "DAU",
      points: [
        { t: (TODAY - 2) * DAY_MS, v: 0 },
        { t: (TODAY - 1) * DAY_MS, v: 1 },
        { t: TODAY * DAY_MS, v: 2 },
      ],
    });
  });

  it("reads concurrency as the larger distinct count of start and heartbeat, over the window", async () => {
    const d1 = migratedD1();
    const aq = fakeAq(healthyAnswer);
    const out = await readOverview(deps(d1, aq), RANGE);

    expect(out.concurrent).toBe(7);
    const distinct = aq.calls.filter((c) => c.op === "distinct");
    expect(distinct).toHaveLength(2);
    for (const c of distinct) {
      expect(c.q.metric).toBe("client.session");
      expect(c.q.from).toBe(NOW - 120_000);
      expect(c.q.to).toBe(NOW);
    }
    expect(distinct.map((c) => (c.q.where as { phase: string }).phase).sort()).toEqual([
      "heartbeat",
      "start",
    ]);
  });

  it("computes the 5xx share of the last hour and the p95 sync lag", async () => {
    const d1 = migratedD1();
    const aq = fakeAq(healthyAnswer);
    const out = await readOverview(deps(d1, aq), RANGE);

    expect(out.errorRate1h).toBeCloseTo(0.1, 12);
    expect(out.syncLagP95Ms).toBe(4500);

    const http = aq.calls.find((c) => c.op === "totals" && c.q.metric === "http.request");
    expect(http?.q).toMatchObject({ from: NOW - HOUR_MS, to: NOW, groupBy: ["statusClass"] });
    const lag = aq.calls.find((c) => c.op === "quantiles" && c.q.metric === "sync.batch");
    expect(lag?.q).toMatchObject({ field: "lagMs", from: NOW - HOUR_MS, to: NOW, q: [0.95] });
  });

  it("reports every source it read, all ok on a healthy backend", async () => {
    const d1 = migratedD1();
    seed(d1);
    const out = await readOverview(deps(d1, fakeAq(healthyAnswer)), RANGE);

    expect(sourceOf(out.sources, "account_summary")).toEqual({
      name: "account_summary",
      kind: "d1",
      ok: true,
    });
    expect(sourceOf(out.sources, "purchase")?.ok).toBe(true);
    expect(sourceOf(out.sources, "client.session")).toEqual({
      name: "client.session",
      kind: "ae",
      ok: true,
    });
    expect(sourceOf(out.sources, "http.request")?.ok).toBe(true);
    expect(sourceOf(out.sources, "sync.batch")?.ok).toBe(true);
  });

  it("labels a local backend as kind local", async () => {
    const d1 = migratedD1();
    const out = await readOverview(deps(d1, fakeAq(healthyAnswer, "local")), RANGE);
    expect(sourceOf(out.sources, "client.session")?.kind).toBe("local");
  });

  it("answers empty data with no analytics backend, and still reads D1", async () => {
    const d1 = migratedD1();
    seed(d1);
    const aq = fakeAq(healthyAnswer, "none");
    const out = await readOverview(deps(d1, aq), RANGE);

    expect(aq.calls).toEqual([]);
    expect(out.concurrent).toBe(0);
    expect(out.errorRate1h).toBe(0);
    expect(out.syncLagP95Ms).toBe(0);
    expect(out.dau).toBe(2);
    expect(out.accounts.total).toBe(4);
    // A backend-less read is labelled "local" by SourceLog (util.ts, frozen).
    expect(sourceOf(out.sources, "client.session")).toEqual({
      name: "client.session",
      kind: "local",
      ok: false,
      note: "no analytics backend",
    });
  });

  it("falls back to zero and marks the source failed when an AE query throws", async () => {
    const d1 = migratedD1();
    const failing = fakeAq((op, q) => {
      if (op === "totals" && q.metric === "http.request") throw new Error("AE 429");
      return healthyAnswer(op, q);
    });
    const out = await readOverview(deps(d1, failing), RANGE);

    expect(out.errorRate1h).toBe(0);
    expect(out.concurrent).toBe(7);
    expect(sourceOf(out.sources, "http.request")).toEqual({
      name: "http.request",
      kind: "ae",
      ok: false,
      note: "query failed",
    });
  });

  it("marks a D1 table that was not migrated as such, and answers zeros", async () => {
    const d1 = new FakeD1();
    d1.migrate(["0003_accounts.sql", "0010_admin.sql"]);
    seed(d1, false);
    const out = await readOverview(deps(d1, fakeAq(healthyAnswer)), RANGE);

    expect(out.revenueMinor24h).toEqual({});
    expect(sourceOf(out.sources, "purchase")).toEqual({
      name: "purchase",
      kind: "d1",
      ok: false,
      note: "table not migrated",
    });
    expect(out.accounts.total).toBe(4);
  });
});
