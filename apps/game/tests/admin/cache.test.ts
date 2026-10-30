/**
 * Per-isolate metric cache (admin/metrics/cache.ts): entries live for the ttl the
 * caller passes, tech lives longer than the default, and fresh=1 bypasses both.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  cached,
  METRICS_CACHE_MS,
  resetMetricsCache,
  TECH_CACHE_MS,
} from "../../src/server/admin/metrics/cache.ts";

describe("admin metrics cache", () => {
  beforeEach(() => resetMetricsCache());

  it("tech is cached longer than the default section ttl", () => {
    expect(TECH_CACHE_MS).toBeGreaterThan(METRICS_CACHE_MS);
    expect(TECH_CACHE_MS).toBe(300_000);
  });

  it("serves a default-ttl entry for 30 s and then reloads", async () => {
    const t0 = 1_000_000;
    let loads = 0;
    const load = async () => ++loads;
    expect(await cached("k", t0, false, load)).toEqual({ body: 1, hit: false });
    expect(await cached("k", t0 + METRICS_CACHE_MS - 1, false, load)).toEqual({
      body: 1,
      hit: true,
    });
    expect(await cached("k", t0 + METRICS_CACHE_MS, false, load)).toEqual({ body: 2, hit: false });
  });

  it("serves a tech entry (longer ttl) past the default window", async () => {
    const t0 = 1_000_000;
    let loads = 0;
    const load = async () => ++loads;
    await cached("tech", t0, false, load, TECH_CACHE_MS);
    const later = await cached("tech", t0 + METRICS_CACHE_MS + 1_000, false, load, TECH_CACHE_MS);
    expect(later).toEqual({ body: 1, hit: true });
    const expired = await cached("tech", t0 + TECH_CACHE_MS, false, load, TECH_CACHE_MS);
    expect(expired).toEqual({ body: 2, hit: false });
  });

  it("fresh=1 bypasses the cache and refills it", async () => {
    const t0 = 1_000_000;
    let loads = 0;
    const load = async () => ++loads;
    await cached("k", t0, false, load, TECH_CACHE_MS);
    expect(await cached("k", t0 + 1, true, load, TECH_CACHE_MS)).toEqual({ body: 2, hit: false });
    expect(await cached("k", t0 + 2, false, load, TECH_CACHE_MS)).toEqual({ body: 2, hit: true });
  });

  it("a null body (missing account) is cached like any other", async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      return null;
    };
    await cached("player", 1, false, load);
    const again = await cached("player", 2, false, load);
    expect(again).toEqual({ body: null, hit: true });
    expect(loads).toBe(1);
  });

  it("a body that keep() rejects is not cached, and drops the older entry", async () => {
    let loads = 0;
    const load = async () => ++loads;
    const keepEven = (n: number) => n % 2 === 0;
    expect(await cached("search", 1, false, load, METRICS_CACHE_MS, keepEven)).toEqual({
      body: 1,
      hit: false,
    });
    expect(await cached("search", 2, false, load, METRICS_CACHE_MS, keepEven)).toEqual({
      body: 2,
      hit: false,
    });
    expect(await cached("search", 3, false, load, METRICS_CACHE_MS, keepEven)).toEqual({
      body: 2,
      hit: true,
    });
    expect(await cached("search", 4, true, load, METRICS_CACHE_MS, keepEven)).toEqual({
      body: 3,
      hit: false,
    });
    expect(await cached("search", 5, false, load, METRICS_CACHE_MS, keepEven)).toEqual({
      body: 4,
      hit: false,
    });
  });
});
