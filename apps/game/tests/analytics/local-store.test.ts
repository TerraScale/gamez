/**
 * MetricsStore (analytics/local-store.ts) on FakeSqlStorage: ingest, sample
 * weighted totals/series/quantiles/distinct, filters and groups through the
 * schema columns only, pruning by age and row cap, reset.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  MetricsStore,
  localColumn,
  topSeriesGroups,
  weightedQuantiles,
} from "../../src/server/analytics/local-store.ts";
import {
  toStoredPoint,
  type BlobsOf,
  type DoublesOf,
  type MetricName,
  type StoredPoint,
} from "../../src/server/analytics/schema.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function pt<M extends MetricName>(
  metric: M,
  t: number,
  blobs: BlobsOf<M>,
  doubles: DoublesOf<M> = {},
  index = "",
  sample = 1,
): StoredPoint {
  const p = toStoredPoint(metric, blobs, doubles, index, t);
  p.sample = sample;
  return p;
}

function store(opts: { maxRows?: number; keepMs?: number } = {}) {
  const s = fakeSqlStore();
  return { s, m: new MetricsStore(s, { now: () => NOW, ...opts }) };
}

const RANGE = { from: NOW - 60 * MIN, to: NOW };

function httpFixture(): StoredPoint[] {
  return [
    pt("http.request", NOW - 50 * MIN, { route: "/api/me", statusClass: "2xx" }, { ms: 10 }, "", 1),
    pt("http.request", NOW - 40 * MIN, { route: "/api/me", statusClass: "2xx" }, { ms: 20 }, "", 3),
    pt(
      "http.request",
      NOW - 30 * MIN,
      { route: "/api/me", statusClass: "5xx" },
      { ms: 500 },
      "",
      1,
    ),
    pt(
      "http.request",
      NOW - 20 * MIN,
      { route: "/api/config", statusClass: "2xx" },
      { ms: 5 },
      "",
      2,
    ),
    // Outside the range (too old, and exactly `to`).
    pt("http.request", NOW - 70 * MIN, { route: "/api/me", statusClass: "2xx" }, { ms: 1 }, "", 9),
    pt("http.request", NOW, { route: "/api/me", statusClass: "2xx" }, { ms: 1 }, "", 9),
    // Another metric never leaks in.
    pt("ws.open", NOW - 10 * MIN, { kind: "chat" }, {}, "", 5),
  ];
}

describe("MetricsStore schema", () => {
  it("creates metric_point with the indexes, idempotently", () => {
    const { s } = store();
    new MetricsStore(s);
    const names = s.fake.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'metric_point'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(names).toEqual(["metric_point_b1_t", "metric_point_idx_t", "metric_point_t"]);
  });

  it("maps AE columns to local columns and rejects anything else", () => {
    expect(localColumn("blob3")).toBe("b3");
    expect(localColumn("double10")).toBe("d10");
    expect(() => localColumn("blob11")).toThrow();
    expect(() => localColumn("t; DROP TABLE metric_point")).toThrow();
  });
});

describe("MetricsStore ingest", () => {
  it("stores valid points and drops malformed ones", () => {
    const { m } = store();
    const bad = [
      null,
      { t: NaN, blobs: ["ws.open"], doubles: [], index: "", sample: 1 },
      { t: NOW, blobs: [], doubles: [], index: "", sample: 1 },
    ] as unknown as StoredPoint[];
    expect(m.ingest([...bad, pt("ws.open", NOW - MIN, { kind: "chat" }, {}, "", 0)])).toBe(1);
    expect(m.count()).toBe(1);
    // sample < 1 is stored as 1.
    expect(m.totals({ metric: "ws.open", ...RANGE, groupBy: [], value: { op: "count" } })).toEqual([
      { keys: {}, value: 1 },
    ]);
  });
});

describe("MetricsStore queries", () => {
  it("totals: weighted counts and sums grouped by schema fields, top by value", () => {
    const { m } = store();
    m.ingest(httpFixture());
    expect(
      m.totals({ metric: "http.request", ...RANGE, groupBy: ["route"], value: { op: "count" } }),
    ).toEqual([
      { keys: { route: "/api/me" }, value: 5 },
      { keys: { route: "/api/config" }, value: 2 },
    ]);
    expect(
      m.totals({
        metric: "http.request",
        ...RANGE,
        groupBy: ["route", "statusClass"],
        value: { op: "sum", field: "ms" },
        limit: 2,
      }),
    ).toEqual([
      { keys: { route: "/api/me", statusClass: "5xx" }, value: 500 },
      { keys: { route: "/api/me", statusClass: "2xx" }, value: 70 },
    ]);
  });

  it("totals: where filters and an empty group give one row (0 when empty)", () => {
    const { m } = store();
    m.ingest(httpFixture());
    expect(
      m.totals({
        metric: "http.request",
        ...RANGE,
        where: { statusClass: "5xx" },
        groupBy: [],
        value: { op: "count" },
      }),
    ).toEqual([{ keys: {}, value: 1 }]);
    expect(
      m.totals({ metric: "client.error", ...RANGE, groupBy: [], value: { op: "count" } }),
    ).toEqual([{ keys: {}, value: 0 }]);
  });

  it("rejects unknown metrics and fields instead of building SQL from them", () => {
    const { m } = store();
    expect(() =>
      m.totals({ metric: "nope" as MetricName, ...RANGE, groupBy: [], value: { op: "count" } }),
    ).toThrow(/unknown metric/);
    expect(() =>
      m.totals({
        metric: "http.request",
        ...RANGE,
        groupBy: ["b1) OR 1=1 --" as "route"],
        value: { op: "count" },
      }),
    ).toThrow(/no blob/);
    expect(() =>
      m.totals({
        metric: "http.request",
        ...RANGE,
        groupBy: [],
        value: { op: "sum", field: "durationS" as "ms" },
      }),
    ).toThrow(/no double/);
  });

  it("series: aligned buckets, weighted, top groups by total", () => {
    const { m } = store();
    m.ingest(httpFixture());
    const rows = m.series({
      metric: "http.request",
      ...RANGE,
      groupBy: ["statusClass"],
      value: { op: "count" },
      bucketMs: 30 * MIN,
    });
    const bucket = (t: number) => Math.floor(t / (30 * MIN)) * 30 * MIN;
    expect(rows.every((r) => r.t % (30 * MIN) === 0)).toBe(true);
    expect(rows.map((r) => r.t)).toEqual(rows.map((r) => r.t).sort((a, b) => a - b));
    const total = rows.reduce((a, r) => a + r.value, 0);
    expect(total).toBe(7);
    expect(rows.find((r) => r.keys.statusClass === "5xx")).toEqual({
      t: bucket(NOW - 30 * MIN),
      keys: { statusClass: "5xx" },
      value: 1,
    });
    const top1 = m.series({
      metric: "http.request",
      ...RANGE,
      groupBy: ["statusClass"],
      value: { op: "count" },
      bucketMs: 30 * MIN,
      limit: 1,
    });
    expect(new Set(top1.map((r) => r.keys.statusClass))).toEqual(new Set(["2xx"]));
    expect(top1.reduce((a, r) => a + r.value, 0)).toBe(6);
  });

  it("quantiles: weighted, in order, zeros without data", () => {
    const { m } = store();
    m.ingest(httpFixture());
    // Weighted values: 10 x1, 20 x3, 500 x1, 5 x2 -> sorted 5,5,10,20,20,20,500 (W = 7).
    expect(
      m.quantiles({ metric: "http.request", ...RANGE, field: "ms", q: [0, 0.5, 0.95, 1] }),
    ).toEqual([5, 20, 500, 500]);
    expect(
      m.quantiles({
        metric: "http.request",
        ...RANGE,
        where: { route: "/api/config" },
        field: "ms",
        q: [0.5],
      }),
    ).toEqual([5]);
    expect(m.quantiles({ metric: "sync.batch", ...RANGE, field: "lagMs", q: [0.5, 0.95] })).toEqual(
      [0, 0],
    );
    expect(() =>
      m.quantiles({ metric: "http.request", ...RANGE, field: "ms", q: [1.5] }),
    ).toThrow();
  });

  it("distinct: non-empty index values, filterable by index", () => {
    const { m } = store();
    m.ingest([
      pt("client.session", NOW - 5 * MIN, { phase: "start" }, {}, "s1"),
      pt("client.session", NOW - 4 * MIN, { phase: "heartbeat" }, {}, "s1"),
      pt("client.session", NOW - 3 * MIN, { phase: "heartbeat" }, {}, "s2"),
      pt("client.session", NOW - 2 * MIN, { phase: "heartbeat" }, {}, ""),
      pt("client.session", NOW - 2 * MIN, { phase: "end" }, {}, "s3"),
    ]);
    expect(m.distinct({ metric: "client.session", ...RANGE })).toBe(3);
    expect(m.distinct({ metric: "client.session", ...RANGE, where: { phase: "heartbeat" } })).toBe(
      2,
    );
    expect(m.distinct({ metric: "client.session", ...RANGE, index: "s2" })).toBe(1);
    expect(
      m.totals({
        metric: "client.session",
        ...RANGE,
        index: "s1",
        groupBy: ["phase"],
        value: { op: "count" },
      }),
    ).toEqual([
      { keys: { phase: "heartbeat" }, value: 1 },
      { keys: { phase: "start" }, value: 1 },
    ]);
  });
});

describe("MetricsStore pruning and reset", () => {
  it("prunes rows older than keepMs on ingest", () => {
    const { m } = store({ keepMs: 10 * MIN });
    m.ingest([
      pt("ws.open", NOW - 20 * MIN, { kind: "chat" }),
      pt("ws.open", NOW - 5 * MIN, { kind: "chat" }),
    ]);
    expect(m.count()).toBe(1);
  });

  it("keeps at most maxRows, dropping the oldest by time", () => {
    const { m } = store({ maxRows: 3 });
    m.ingest([
      pt("ws.open", NOW - 1 * MIN, { kind: "a" }),
      pt("ws.open", NOW - 9 * MIN, { kind: "oldest" }),
      pt("ws.open", NOW - 2 * MIN, { kind: "b" }),
      pt("ws.open", NOW - 8 * MIN, { kind: "older" }),
      pt("ws.open", NOW - 3 * MIN, { kind: "c" }),
    ]);
    expect(m.count()).toBe(3);
    const kinds = m
      .totals({ metric: "ws.open", ...RANGE, groupBy: ["kind"], value: { op: "count" } })
      .map((r) => r.keys.kind)
      .sort((a, b) => a!.localeCompare(b!));
    expect(kinds).toEqual(["a", "b", "c"]);
  });

  it("reset clears everything, or only seeded points", () => {
    const { m } = store();
    m.ingest([
      pt("ws.open", NOW - MIN, { kind: "chat" }, {}, "seed"),
      pt("ws.open", NOW - MIN, { kind: "chat" }, {}, "seed-acc-001"),
      pt("ws.open", NOW - MIN, { kind: "chat" }, {}, "acc-real"),
      pt("ws.open", NOW - MIN, { kind: "chat" }, {}, ""),
    ]);
    expect(m.reset(true)).toBe(2);
    expect(m.count()).toBe(2);
    expect(m.reset()).toBe(2);
    expect(m.count()).toBe(0);
  });
});

describe("helpers", () => {
  it("weightedQuantiles", () => {
    expect(weightedQuantiles([], [0.5])).toEqual([0]);
    expect(
      weightedQuantiles(
        [
          { v: 1, w: 1 },
          { v: 2, w: 98 },
          { v: 3, w: 1 },
        ],
        [0, 0.01, 0.5, 0.99, 1],
      ),
    ).toEqual([1, 1, 2, 2, 3]);
    expect(
      weightedQuantiles(
        [
          { v: NaN, w: 1 },
          { v: 4, w: 0 },
        ],
        [0.5],
      ),
    ).toEqual([0]);
  });

  it("topSeriesGroups keeps the top groups by total and sorts by bucket", () => {
    const rows = [
      { t: 2, keys: { k: "a" }, value: 1 },
      { t: 1, keys: { k: "b" }, value: 5 },
      { t: 1, keys: { k: "a" }, value: 1 },
      { t: 2, keys: { k: "c" }, value: 1 },
    ];
    expect(topSeriesGroups(rows, ["k"], 2)).toEqual([
      { t: 1, keys: { k: "b" }, value: 5 },
      { t: 1, keys: { k: "a" }, value: 1 },
      { t: 2, keys: { k: "a" }, value: 1 },
    ]);
  });
});
