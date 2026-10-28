/** GET /api/admin/tech reader (admin/metrics/tech.ts): AE numbers, quantiles, routes, sources. */
import { describe, expect, it } from "vite-plus/test";
import type { AdminRange, AdminSource } from "@gamez/protocol";
import type {
  Analytics,
  AnalyticsQuery,
  AnalyticsSourceKind,
} from "../../src/server/analytics/types.ts";
import { readTech } from "../../src/server/admin/metrics/tech.ts";
import { DAY_MS, HOUR_MS, type MetricsDeps } from "../../src/server/admin/metrics/util.ts";
import type { Env } from "../../src/server/contracts.ts";
import { FakeD1 } from "../leaderboards/fake-d1.ts";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const RANGE: AdminRange = { from: NOW - 2 * DAY_MS, to: NOW, bucket: "day", bucketMs: DAY_MS };
const HOUR_RANGE: AdminRange = {
  from: NOW - 3 * HOUR_MS,
  to: NOW,
  bucket: "hour",
  bucketMs: HOUR_MS,
};

type Call = { op: string; q: Record<string, unknown> };

/** Fake AnalyticsQuery: records queries, answers from `answer`; a throw is a failed read. */
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

function deps(aq: AnalyticsQuery): MetricsDeps {
  return { env: {} as Env, db: new FakeD1().asD1(), aq, analytics: noopAnalytics, now: NOW };
}

const groupOf = (q: Record<string, unknown>) => (q.groupBy as string[] | undefined)?.[0];

/** The AE answers of a healthy backend (exact numbers asserted below). */
function healthy(op: string, q: Record<string, unknown>): unknown {
  const metric = q.metric as string;
  const where = (q.where ?? {}) as Record<string, string>;
  const field = q.field as string | undefined;
  const group = groupOf(q);
  if (metric === "http.request") {
    if (op === "totals" && group === "route") {
      return [
        { keys: { route: "/api/market/listings/:id", statusClass: "2xx" }, value: 80 },
        { keys: { route: "/api/market/listings/:id", statusClass: "5xx" }, value: 5 },
        { keys: { route: "/api/admin/me", statusClass: "2xx" }, value: 10 },
        { keys: { route: "/api/admin/me", statusClass: "4xx" }, value: 2 },
      ];
    }
    if (op === "quantiles" && field === "ms") {
      return where.route === "/api/market/listings/:id" ? [12, 90] : [3, 9];
    }
    if (op === "series" && where.statusClass === "5xx") {
      return ["/a", "/b", "/c", "/d", "/e", "/f"].map((route, i) => ({
        t: RANGE.from,
        keys: { route },
        value: 6 - i,
      }));
    }
    if (op === "series") {
      return [
        { t: RANGE.from, keys: { statusClass: "2xx" }, value: 5 },
        { t: RANGE.from + DAY_MS, keys: { statusClass: "5xx" }, value: 1 },
        { t: RANGE.from + DAY_MS, keys: { statusClass: "2xx" }, value: 7 },
        { t: RANGE.from, keys: { statusClass: "101" }, value: 2 },
      ];
    }
  }
  if (metric === "ws.open" && op === "totals") {
    return [
      { keys: { kind: "presence" }, value: 30 },
      { keys: { kind: "instance" }, value: 12 },
    ];
  }
  if (metric === "ws.open" && op === "series") {
    return [{ t: RANGE.from, keys: { kind: "presence" }, value: 30 }];
  }
  if (metric === "ws.close") {
    if (op === "quantiles") return [30, 600];
    if (op === "totals") return [{ keys: { kind: "presence" }, value: 4 }];
  }
  if (metric === "do.active" && op === "totals") {
    return [
      { keys: { class: "ChunkDO" }, value: 3 },
      { keys: { class: "InstanceDO" }, value: 9 },
    ];
  }
  if (metric === "verify.segment") {
    if (op === "totals") {
      return [
        { keys: { outcome: "ok" }, value: 90 },
        { keys: { outcome: "desync" }, value: 3 },
      ];
    }
    if (op === "series") return [{ t: RANGE.from, keys: { outcome: "ok" }, value: 90 }];
  }
  if (metric === "verify.resync" && op === "totals") {
    return [
      { keys: { code: "hash" }, value: 1 },
      { keys: { code: "position" }, value: 2 },
    ];
  }
  if (metric === "sync.batch") {
    if (op === "totals" && q.value && (q.value as { op: string }).op === "sum") {
      return [
        { keys: { outcome: "ok" }, value: 900 },
        { keys: { outcome: "retry" }, value: 40 },
      ];
    }
    if (op === "totals") {
      return [
        { keys: { outcome: "ok" }, value: 100 },
        { keys: { outcome: "retry" }, value: 4 },
        { keys: { outcome: "dead" }, value: 1 },
      ];
    }
    if (op === "quantiles" && field === "lagMs") return [200, 3000];
    if (op === "quantiles" && field === "applyMs") return [5, 40];
    if (op === "series") return [{ t: RANGE.from, keys: { outcome: "ok" }, value: 100 }];
  }
  if (metric === "d1.query") {
    if (op === "totals") {
      return [
        { keys: { label: "admin.overview" }, value: 12 },
        { keys: { label: "admin.tech" }, value: 3 },
      ];
    }
    if (op === "quantiles") return [4, 40];
  }
  if (metric === "client.perf") {
    if (op === "quantiles" && field === "fpsP50") return [58];
    if (op === "quantiles" && field === "fpsP95") return [30];
    if (op === "quantiles" && field === "frameMsP95") return [18, 33];
    if (op === "totals" && group === "mode") {
      return [
        { keys: { mode: "classic" }, value: 40 },
        { keys: { mode: "steps" }, value: 2 },
      ];
    }
  }
  if (metric === "client.session") {
    if (op === "quantiles" && field === "loadMs") return [800, 2400];
    if (op === "totals" && group === "phase") return [{ keys: { phase: "start" }, value: 30 }];
    if (op === "totals" && group === "build") {
      return [
        { keys: { build: "b-1" }, value: 5 },
        { keys: { build: "b-2" }, value: 25 },
      ];
    }
    if (op === "totals" && group === "contentHash") {
      return [
        { keys: { contentHash: "hash-x" }, value: 30 },
        { keys: { contentHash: "" }, value: 4 },
      ];
    }
  }
  if (metric === "client.error" && op === "totals") {
    return [{ keys: { build: "b-2", kind: "error", messageKey: "boom" }, value: 7 }];
  }
  return [];
}

function sourceOf(sources: AdminSource[], name: string): AdminSource | undefined {
  return sources.find((s) => s.name === name);
}

describe("readTech", () => {
  it("builds the route table from request totals and per-route latency", async () => {
    const out = await readTech(deps(fakeAq(healthy)), RANGE);
    expect(out.routes).toEqual([
      {
        route: "/api/market/listings/:id",
        requests: 85,
        errors5xx: 5,
        errors4xx: 0,
        p50Ms: 12,
        p95Ms: 90,
      },
      { route: "/api/admin/me", requests: 12, errors5xx: 0, errors4xx: 2, p50Ms: 3, p95Ms: 9 },
    ]);
  });

  it("asks for per-route quantiles with the route filter", async () => {
    const aq = fakeAq(healthy);
    await readTech(deps(aq), RANGE);
    const perRoute = aq.calls.filter(
      (c) => c.op === "quantiles" && c.q.metric === "http.request" && c.q.field === "ms",
    );
    expect(perRoute.map((c) => (c.q.where as { route: string }).route).sort()).toEqual([
      "/api/admin/me",
      "/api/market/listings/:id",
    ]);
    for (const c of perRoute) expect(c.q.q).toEqual([0.5, 0.95]);
  });

  it("maps the status series, and keeps the top five routes for 5xx", async () => {
    const out = await readTech(deps(fakeAq(healthy)), RANGE);
    const statuses = out.requests.map((s) => s.key);
    expect(statuses).toEqual(["2xx", "101", "5xx"]);
    expect(out.requests.find((s) => s.key === "101")?.label).toBe("1xx (WebSocket upgrade)");
    expect(out.requests[0]!.points).toEqual([
      { t: RANGE.from, v: 5 },
      { t: RANGE.from + DAY_MS, v: 7 },
    ]);
    expect(out.errors.map((s) => s.key)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
  });

  it("computes websocket opens, kinds and close durations", async () => {
    const out = await readTech(deps(fakeAq(healthy)), RANGE);
    expect(out.websockets.opens).toBe(42);
    expect(out.websockets.byKind).toEqual({
      key: "wsByKind",
      label: "Sockets",
      buckets: [
        { label: "presence", value: 30 },
        { label: "instance", value: 12 },
      ],
    });
    expect(out.websockets.durationS).toEqual({ p50: 30, p95: 600, n: 4 });
    expect(out.websockets.series.map((s) => s.key)).toEqual(["presence"]);
  });

  it("counts DO activity by class, sorted by value", async () => {
    const out = await readTech(deps(fakeAq(healthy)), RANGE);
    expect(out.durableObjects.buckets).toEqual([
      { label: "InstanceDO", value: 9 },
      { label: "ChunkDO", value: 3 },
    ]);
  });

  it("totals segments and resyncs, with resyncs by code", async () => {
    const out = await readTech(deps(fakeAq(healthy)), RANGE);
    expect(out.verification.segments).toBe(93);
    expect(out.verification.resyncs).toBe(3);
    expect(out.verification.byCode.buckets).toEqual([
      { label: "position", value: 2 },
      { label: "hash", value: 1 },
    ]);
    expect(out.verification.series.map((s) => s.key)).toEqual(["ok"]);
  });

  it("reads sync batches: total, records, dead and retries, lag and apply quantiles", async () => {
    const out = await readTech(deps(fakeAq(healthy)), RANGE);
    expect(out.sync.batches).toBe(105);
    expect(out.sync.records).toBe(940);
    expect(out.sync.dead).toBe(1);
    expect(out.sync.retries).toBe(4);
    expect(out.sync.lagMs).toEqual({ p50: 200, p95: 3000, n: 105 });
    expect(out.sync.applyMs).toEqual({ p50: 5, p95: 40, n: 105 });
  });

  it("reads D1 query latency and counts by label", async () => {
    const out = await readTech(deps(fakeAq(healthy)), RANGE);
    expect(out.d1.queries).toBe(15);
    expect(out.d1.latencyMs).toEqual({ p50: 4, p95: 40, n: 15 });
    expect(out.d1.byLabel.buckets).toEqual([
      { label: "admin.overview", value: 12 },
      { label: "admin.tech", value: 3 },
    ]);
  });

  it("computes client fps as medians of fpsP50 and fpsP95, and the frame and load quantiles", async () => {
    const aq = fakeAq(healthy);
    const out = await readTech(deps(aq), RANGE);
    expect(out.client.fps).toEqual({ p50: 58, p95: 30, n: 42 });
    expect(out.client.frameMsP95).toEqual({ p50: 18, p95: 33, n: 42 });
    expect(out.client.loadMs).toEqual({ p50: 800, p95: 2400, n: 30 });

    const load = aq.calls.find((c) => c.op === "quantiles" && c.q.field === "loadMs");
    expect(load?.q.where).toEqual({ phase: "start" });
  });

  it("lists client errors and version adoption", async () => {
    const out = await readTech(deps(fakeAq(healthy)), RANGE);
    expect(out.client.errors).toEqual([
      { build: "b-2", kind: "error", messageKey: "boom", count: 7 },
    ]);
    expect(out.client.builds.buckets).toEqual([
      { label: "b-2", value: 25 },
      { label: "b-1", value: 5 },
    ]);
    expect(out.client.contentHashes.buckets).toEqual([
      { label: "hash-x", value: 30 },
      { label: "(none, outside a mode)", value: 4 },
    ]);
  });

  it("reports every source it read, all ok on a healthy backend", async () => {
    const out = await readTech(deps(fakeAq(healthy)), RANGE);
    expect(out.sources.every((s) => s.ok)).toBe(true);
    expect(sourceOf(out.sources, "http.request")).toEqual({
      name: "http.request",
      kind: "ae",
      ok: true,
    });
    expect(sourceOf(out.sources, "sync.batch")?.ok).toBe(true);
    expect(out.at).toBe(NOW);
  });

  it("answers empty data on a missing backend, without querying", async () => {
    const aq = fakeAq(healthy, "none");
    const out = await readTech(deps(aq), HOUR_RANGE);
    expect(aq.calls).toEqual([]);
    expect(out.routes).toEqual([]);
    expect(out.client.fps).toEqual({ p50: 0, p95: 0, n: 0 });
    expect(out.sync.batches).toBe(0);
    expect(out.websockets.opens).toBe(0);
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.sources.every((s) => !s.ok && s.note === "no analytics backend")).toBe(true);
  });

  it("fails one source without failing the others", async () => {
    const aq = fakeAq((op, q) => {
      if (q.metric === "client.perf") throw new Error("AE 503");
      return healthy(op, q);
    });
    const out = await readTech(deps(aq), RANGE);
    expect(out.client.fps).toEqual({ p50: 0, p95: 0, n: 0 });
    expect(out.client.frameMsP95).toEqual({ p50: 0, p95: 0, n: 0 });
    expect(sourceOf(out.sources, "client.perf")).toEqual({
      name: "client.perf",
      kind: "ae",
      ok: false,
      note: "query failed",
    });
    // The rest is unaffected.
    expect(out.sync.batches).toBe(105);
    expect(out.routes).toHaveLength(2);
  });
});
