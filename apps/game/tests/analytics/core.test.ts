/**
 * Analytics core (docs/design/admin-dashboard.md §4.1, §13 "Analytics core"):
 * the stored layout, the AE writer, the per-isolate local buffer (flush at 50,
 * on flush(), and the automatic delayed flush), the sampler weights, the
 * localSinkOn matrix and the query backend selection.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_QUERY,
  LOCAL_FLUSH_DELAY_MS,
  MAX_INDEX_BYTES,
  NOOP_ANALYTICS,
  admitLocal,
  analyticsFor,
  analyticsQueryFor,
  createAnalytics,
  cutUtf8,
  localSinkOn,
  newLocalSinkState,
} from "../../src/server/analytics/index.ts";
import { localQuery } from "../../src/server/analytics/query-local.ts";
import { toStoredPoint, type StoredPoint } from "../../src/server/analytics/schema.ts";
import {
  LOCAL_LIMITS,
  type AnalyticsEnv,
  type MetricsApi,
} from "../../src/server/analytics/types.ts";

interface AeCall {
  blobs?: unknown[];
  doubles?: number[];
  indexes?: unknown[];
}

function fakeAe(opts: { throws?: boolean } = {}) {
  const calls: AeCall[] = [];
  const binding = {
    writeDataPoint(p: AeCall) {
      if (opts.throws) throw new Error("AE down");
      calls.push(p);
    },
  };
  return { calls, binding: binding as unknown as AnalyticsEngineDataset };
}

function fakeMetrics(opts: { throws?: boolean; rejects?: boolean } = {}) {
  const batches: StoredPoint[][] = [];
  const names: string[] = [];
  const api: MetricsApi = {
    ingest: async (points) => {
      if (opts.rejects) throw new Error("DO down");
      batches.push(points);
    },
    totals: async () => [{ keys: { route: "/api/me" }, value: 3 }],
    series: async () => [],
    quantiles: async (q) => q.q.map(() => 7),
    distinct: async () => 2,
  };
  const ns = {
    getByName(name: string) {
      if (opts.throws) throw new Error("no namespace");
      names.push(name);
      return api;
    },
  };
  return { batches, names, ns: ns as unknown as AnalyticsEnv["METRICS"] };
}

/** A waitUntil that collects the promises it is given. */
function collector() {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    settle: () => Promise.all(promises),
  };
}

/** A sleep the test releases by hand. */
function manualSleep() {
  const pending: { ms: number; release: () => void }[] = [];
  return {
    pending,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ ms, release: resolve });
      }),
    releaseAll: () => {
      for (const p of pending.splice(0)) p.release();
    },
  };
}

describe("toStoredPoint layout", () => {
  it("puts the metric in blob1, then blobs and doubles in schema order", () => {
    const p = toStoredPoint(
      "http.request",
      { method: "GET", route: "/api/me", country: "BR", statusClass: "2xx" },
      { status: 200, ms: 12.5 },
      "",
      1000,
    );
    expect(p).toEqual({
      t: 1000,
      blobs: ["http.request", "/api/me", "GET", "2xx", "BR"],
      doubles: [12.5, 200],
      index: "",
      sample: 1,
    });
  });

  it("fills missing fields, cuts long blobs and zeroes non-finite doubles", () => {
    const p = toStoredPoint("sync.batch", { source: "x".repeat(500) }, { lagMs: NaN }, "i", 5);
    expect(p.blobs).toEqual(["sync.batch", "x".repeat(120), ""]);
    expect(p.doubles).toEqual([0, 0, 0, 0]);
  });
});

describe("cutUtf8", () => {
  it("keeps short strings and cuts at 96 bytes without splitting code points", () => {
    expect(cutUtf8("acc-1")).toBe("acc-1");
    expect(cutUtf8("a".repeat(200))).toBe("a".repeat(96));
    const emoji = "😀".repeat(30); // 4 bytes each
    const cut = cutUtf8(emoji);
    expect(new TextEncoder().encode(cut).length).toBe(96);
    expect(cut).toBe("😀".repeat(24));
    const mixed = "é".repeat(60); // 2 bytes each
    expect(new TextEncoder().encode(cutUtf8(mixed)).length).toBeLessThanOrEqual(MAX_INDEX_BYTES);
  });
});

describe("localSinkOn", () => {
  const m = fakeMetrics().ns;
  it.each([
    [{}, false],
    [{ METRICS: m }, true],
    [{ METRICS: m, ANALYTICS_LOCAL: "0" }, false],
    [{ METRICS: m, ANALYTICS_ACCOUNT_ID: "a", ANALYTICS_API_TOKEN: "t" }, false],
    [{ METRICS: m, ANALYTICS_ACCOUNT_ID: "a" }, true],
    [
      { METRICS: m, ANALYTICS_ACCOUNT_ID: "a", ANALYTICS_API_TOKEN: "t", ANALYTICS_LOCAL: "1" },
      true,
    ],
    [{ ANALYTICS_LOCAL: "1" }, false],
  ] as [AnalyticsEnv, boolean][])("dev build: %o -> %s", (env, want) => {
    expect(localSinkOn(env, true)).toBe(want);
  });

  // A production build with the AE binding never writes the global MetricsDO by default:
  // every Worker request would be an ingest RPC to one DO.
  const ae = fakeAe().binding;
  it.each([
    [{ METRICS: m, ANALYTICS: ae }, false],
    [{ METRICS: m, ANALYTICS: ae, ANALYTICS_ACCOUNT_ID: "a" }, false],
    [{ METRICS: m, ANALYTICS: ae, ANALYTICS_LOCAL: "1" }, true],
    [{ METRICS: m, ANALYTICS: ae, ANALYTICS_LOCAL: "0" }, false],
    // Nothing else records without an AE binding: the stub is the only sink.
    [{ METRICS: m }, true],
  ] as [AnalyticsEnv, boolean][])("production build: %o -> %s", (env, want) => {
    expect(localSinkOn(env, false)).toBe(want);
  });

  it("a production writer with the AE binding sends nothing to MetricsDO", async () => {
    const metrics = fakeMetrics();
    const c = collector();
    const w = createAnalytics({ ANALYTICS: fakeAe().binding, METRICS: metrics.ns }, c.waitUntil, {
      dev: false,
      state: newLocalSinkState(),
      sleep: () => Promise.resolve(),
    });
    for (let i = 0; i < 60; i++) w.write("ws.open", { kind: "chat" });
    await w.flush();
    await c.settle();
    expect(metrics.batches).toEqual([]);
  });
});

describe("analyticsFor: AE binding", () => {
  it("writes the stored layout with the index, without the local sink", () => {
    const ae = fakeAe();
    const w = createAnalytics({ ANALYTICS: ae.binding }, () => {}, { now: () => 42 });
    w.write(
      "ws.close",
      { kind: "instance", mode: "classic", code: "1000" },
      { durationS: 30 },
      "x",
    );
    expect(ae.calls).toEqual([
      { blobs: ["ws.close", "instance", "classic", "1000"], doubles: [30], indexes: ["x"] },
    ]);
  });

  it("cuts the index to 96 bytes and coerces non-string blobs", () => {
    const ae = fakeAe();
    const w = createAnalytics({ ANALYTICS: ae.binding }, () => {});
    w.write("do.active", { class: 7 as unknown as string }, {}, "d".repeat(300));
    expect(ae.calls[0]!.indexes).toEqual(["d".repeat(96)]);
    expect(ae.calls[0]!.blobs).toEqual(["do.active", "7"]);
  });

  it("never throws: unknown metric, throwing binding, missing namespace", () => {
    const ae = fakeAe({ throws: true });
    const m = fakeMetrics({ throws: true });
    const c = collector();
    const w = createAnalytics({ ANALYTICS: ae.binding, METRICS: m.ns }, c.waitUntil, {
      state: newLocalSinkState(),
      sleep: () => Promise.resolve(),
    });
    expect(() => w.write("nope" as "ws.open", {})).not.toThrow();
    expect(() => w.write("ws.open", { kind: "chat" })).not.toThrow();
    for (let i = 0; i < 60; i++) w.write("ws.open", { kind: "chat" });
    return expect(c.settle()).resolves.toBeDefined();
  });

  it("is the no-op writer without any sink", () => {
    expect(analyticsFor({}, () => {})).toBe(NOOP_ANALYTICS);
    expect(analyticsFor({ METRICS: fakeMetrics().ns, ANALYTICS_LOCAL: "0" }, () => {})).toBe(
      NOOP_ANALYTICS,
    );
  });
});

describe("analyticsFor: local buffer", () => {
  it("flushes through waitUntil when the buffer reaches flushAt", async () => {
    const m = fakeMetrics();
    const c = collector();
    const s = manualSleep();
    const w = createAnalytics({ METRICS: m.ns }, c.waitUntil, {
      state: newLocalSinkState(),
      sleep: s.sleep,
      now: () => 10_000,
    });
    for (let i = 0; i < LOCAL_LIMITS.flushAt - 1; i++) w.write("ws.open", { kind: "presence" });
    await Promise.resolve();
    expect(m.batches).toHaveLength(0);
    w.write("ws.open", { kind: "presence" });
    await Promise.resolve();
    expect(m.batches).toHaveLength(1);
    expect(m.batches[0]).toHaveLength(LOCAL_LIMITS.flushAt);
    expect(m.names).toEqual(["local"]);
    expect(m.batches[0]![0]).toEqual({
      t: 10_000,
      blobs: ["ws.open", "presence", ""],
      doubles: [],
      index: "",
      sample: 1,
    });
    // The scheduled flush (first write) finds an empty buffer.
    s.releaseAll();
    await c.settle();
    expect(m.batches).toHaveLength(1);
  });

  it("flush() sends what is buffered and is kept alive by waitUntil", async () => {
    const m = fakeMetrics();
    const c = collector();
    const w = createAnalytics({ METRICS: m.ns }, c.waitUntil, {
      state: newLocalSinkState(),
      sleep: manualSleep().sleep,
    });
    w.write("mod.action", { action: "mute", by: "admin" });
    w.write("mod.action", { action: "hide", by: "admin" });
    const before = c.promises.length;
    await w.flush();
    expect(c.promises.length).toBe(before + 1);
    expect(m.batches).toHaveLength(1);
    expect(m.batches[0]!.map((p) => p.blobs[1])).toEqual(["mute", "hide"]);
    await w.flush();
    expect(m.batches).toHaveLength(1);
  });

  it("flushes automatically after a short delay when nobody calls flush()", async () => {
    const m = fakeMetrics();
    const c = collector();
    const s = manualSleep();
    const w = createAnalytics({ METRICS: m.ns }, c.waitUntil, {
      state: newLocalSinkState(),
      sleep: s.sleep,
    });
    w.write("chat.message", { channelKind: "global", outcome: "ok" }, { chars: 5 });
    w.write("chat.message", { channelKind: "guild", outcome: "ok" }, { chars: 9 });
    expect(s.pending.map((p) => p.ms)).toEqual([LOCAL_FLUSH_DELAY_MS]);
    expect(c.promises).toHaveLength(1);
    s.releaseAll();
    await c.settle();
    expect(m.batches).toHaveLength(1);
    expect(m.batches[0]).toHaveLength(2);
    // A later write schedules a new flush.
    w.write("chat.message", { channelKind: "mode", outcome: "ok" });
    expect(s.pending).toHaveLength(1);
  });

  it("shares the per-isolate buffer between writers", async () => {
    const m = fakeMetrics();
    const state = newLocalSinkState();
    const s = manualSleep();
    const c = collector();
    const a = createAnalytics({ METRICS: m.ns }, c.waitUntil, { state, sleep: s.sleep });
    const b = createAnalytics({ METRICS: m.ns }, c.waitUntil, { state, sleep: s.sleep });
    a.write("ws.open", { kind: "chat" });
    b.write("ws.open", { kind: "instance" });
    expect(s.pending).toHaveLength(1);
    await b.flush();
    expect(m.batches[0]!.map((p) => p.blobs[1])).toEqual(["chat", "instance"]);
  });

  it("swallows a failing ingest", async () => {
    const m = fakeMetrics({ rejects: true });
    const c = collector();
    const w = createAnalytics({ METRICS: m.ns }, c.waitUntil, {
      state: newLocalSinkState(),
      sleep: manualSleep().sleep,
    });
    w.write("ws.open", { kind: "chat" });
    await expect(w.flush()).resolves.toBeUndefined();
  });

  it("writes both AE and local when both are on", async () => {
    const ae = fakeAe();
    const m = fakeMetrics();
    const w = createAnalytics({ ANALYTICS: ae.binding, METRICS: m.ns }, () => {}, {
      state: newLocalSinkState(),
      sleep: manualSleep().sleep,
    });
    w.write("verify.resync", { mode: "classic", code: "gap" }, {}, "acc-1");
    await w.flush();
    expect(ae.calls).toHaveLength(1);
    expect(m.batches[0]![0]!.index).toBe("acc-1");
  });
});

describe("local sampler", () => {
  it("keeps every point up to perSecond, then 1 in N with weight N (sums stay right)", () => {
    const state = newLocalSinkState();
    const weights: number[] = [];
    for (let i = 0; i < 1000; i++) weights.push(admitLocal(state, 5_000, 200));
    const kept = weights.filter((w) => w > 0);
    expect(weights.slice(0, 200).every((w) => w === 1)).toBe(true);
    expect(kept.length).toBe(200 + 100 + 100 + 25);
    expect(kept.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("starts a continuing burst at last second's rate and resets after a quiet second", () => {
    const state = newLocalSinkState();
    for (let i = 0; i < 1600; i++) admitLocal(state, 1_000, 200);
    const next: number[] = [];
    for (let i = 0; i < 210; i++) next.push(admitLocal(state, 2_000, 200));
    // First 200 of the new second are unsampled; the overflow starts at N = 8.
    expect(next[200]).toBe(8);
    expect(admitLocal(state, 4_000, 200)).toBe(1);
    expect(state.prevSeen).toBe(0);
  });

  it("weights the buffered points through the writer", async () => {
    const m = fakeMetrics();
    const w = createAnalytics({ METRICS: m.ns }, () => {}, {
      state: newLocalSinkState(),
      sleep: manualSleep().sleep,
      now: () => 77_000,
    });
    const total = LOCAL_LIMITS.perSecond * 3;
    for (let i = 0; i < total; i++) w.write("http.request", { route: "/api/me" });
    await w.flush();
    const points = m.batches.flat();
    expect(points.length).toBeLessThan(total);
    expect(points.reduce((a, p) => a + p.sample, 0)).toBe(total);
  });
});

describe("analyticsQueryFor", () => {
  it("picks AE SQL with credentials, local with METRICS, else EMPTY_QUERY", () => {
    const m = fakeMetrics().ns;
    expect(
      analyticsQueryFor({ METRICS: m, ANALYTICS_ACCOUNT_ID: "a", ANALYTICS_API_TOKEN: "t" }).source,
    ).toBe("ae");
    expect(analyticsQueryFor({ METRICS: m }).source).toBe("local");
    expect(analyticsQueryFor({ METRICS: m, ANALYTICS_ACCOUNT_ID: "a" }).source).toBe("local");
    expect(analyticsQueryFor({ METRICS: m, ANALYTICS_LOCAL: "0" })).toBe(EMPTY_QUERY);
    expect(analyticsQueryFor({})).toBe(EMPTY_QUERY);
  });

  it("EMPTY_QUERY answers empty shapes", async () => {
    expect(EMPTY_QUERY.source).toBe("none");
    const base = { metric: "http.request" as const, from: 0, to: 1 };
    await expect(
      EMPTY_QUERY.totals({ ...base, groupBy: ["route"], value: { op: "count" } }),
    ).resolves.toEqual([]);
    await expect(EMPTY_QUERY.quantiles({ ...base, field: "ms", q: [0.5, 0.95] })).resolves.toEqual([
      0, 0,
    ]);
    await expect(EMPTY_QUERY.distinct(base)).resolves.toBe(0);
  });

  it("the local query forwards every call to MetricsDO 'local'", async () => {
    const m = fakeMetrics();
    const q = localQuery(m.ns as unknown as { getByName(n: string): MetricsApi });
    const base = { metric: "http.request" as const, from: 0, to: 1 };
    await expect(
      q.totals({ ...base, groupBy: ["route"], value: { op: "count" } }),
    ).resolves.toEqual([{ keys: { route: "/api/me" }, value: 3 }]);
    await expect(q.quantiles({ ...base, field: "ms", q: [0.5] })).resolves.toEqual([7]);
    await expect(q.distinct(base)).resolves.toBe(2);
    await expect(
      q.series({ ...base, groupBy: [], value: { op: "count" }, bucketMs: 1000 }),
    ).resolves.toEqual([]);
    expect(m.names).toEqual(["local", "local", "local", "local"]);
  });
});
