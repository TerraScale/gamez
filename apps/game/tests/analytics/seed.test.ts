/**
 * Dev seeder (routes/dev-metrics.ts): 404 off dev hosts, 401/403 for
 * non-admins, 405 for other methods; deterministic synthetic points for every
 * metric in schema.ts, real classic ids, only into MetricsDO "local".
 */
import { describe, expect, it } from "vite-plus/test";
import { signToken } from "../../src/server/auth.ts";
import { MetricsStore } from "../../src/server/analytics/local-store.ts";
import { METRICS, type MetricName, type StoredPoint } from "../../src/server/analytics/schema.ts";
import type { Env } from "../../src/server/contracts.ts";
import {
  SEED_BUILD,
  SEED_PATH,
  classicSeedIds,
  clampDays,
  devMetricsRoutes,
  lengthBand,
  seedLevelBand,
  seedPoints,
} from "../../src/server/routes/dev-metrics.ts";
import type { RouteContext } from "../../src/server/routes/types.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const SECRET = "test-secret";
const ADMIN = "acc-env-admin";
const PLAYER = "acc-player";
const NOW = Date.UTC(2026, 9, 28, 15, 30, 0);
const DAY = 86_400_000;

const tokenFor = (accountId: string) =>
  signToken(SECRET, { accountId, name: accountId, issuedAt: Date.now() });

function metricsNs() {
  const store = new MetricsStore(fakeSqlStore(), { now: () => Date.now() });
  const calls = { ingest: 0, reset: [] as boolean[], points: 0, analyticsWrites: 0 };
  const stub = {
    ingest: async (points: StoredPoint[]) => {
      calls.ingest++;
      calls.points += points.length;
      store.ingest(points);
    },
    reset: async (seedOnly: boolean) => {
      calls.reset.push(seedOnly);
      return store.reset(seedOnly);
    },
  };
  return { store, calls, ns: { getByName: () => stub } };
}

function makeEnv(over: Partial<Env> = {}) {
  const m = metricsNs();
  const env = {
    AUTH_SECRET: SECRET,
    DEV_ROUTES_ENABLED: "1",
    ADMIN_ACCOUNT_IDS: ADMIN,
    ACCOUNT: {
      getByName: () => ({ profile: async () => null, checkSession: async () => true }),
    },
    CONFIG: { getByName: () => ({ isDevAdmin: async () => false }) },
    METRICS: m.ns,
    // Writing to AE or D1 would show up here.
    ANALYTICS: {
      writeDataPoint: () => {
        m.calls.analyticsWrites++;
      },
    },
    DB: new Proxy(
      {},
      {
        get() {
          throw new Error("seed must not touch D1");
        },
      },
    ),
    ...over,
  } as unknown as Env;
  return { env, m };
}

async function call(
  url: string,
  init: { method?: string; token?: string } = {},
  env = makeEnv().env,
): Promise<Response | null> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const request = new Request(url, { method: init.method ?? "POST", headers });
  const c = {
    request,
    env,
    url: new URL(url),
    ctx: { waitUntil() {}, passThroughOnException() {} },
  } as unknown as RouteContext;
  return devMetricsRoutes(c);
}

describe("seed route access", () => {
  it("ignores other paths", async () => {
    expect(await call("http://localhost:5173/api/dev/admin/self")).toBeNull();
  });

  it("is 404 off dev hosts, even for admins", async () => {
    const res = await call(`https://gamez.example.com${SEED_PATH}`, {
      token: await tokenFor(ADMIN),
    });
    expect(res!.status).toBe(404);
  });

  it("is 401 without a token and 403 for players", async () => {
    expect((await call(`http://localhost:5173${SEED_PATH}`))!.status).toBe(401);
    const res = await call(`http://localhost:5173${SEED_PATH}`, { token: await tokenFor(PLAYER) });
    expect(res!.status).toBe(403);
  });

  it("is 405 for GET from an admin", async () => {
    const res = await call(`http://localhost:5173${SEED_PATH}`, {
      method: "GET",
      token: await tokenFor(ADMIN),
    });
    expect(res!.status).toBe(405);
  });

  it("is 503 without the METRICS binding", async () => {
    const { env } = makeEnv({ METRICS: undefined } as Partial<Env>);
    const res = await call(
      `http://localhost:5173${SEED_PATH}`,
      { token: await tokenFor(ADMIN) },
      env,
    );
    expect(res!.status).toBe(503);
  });
});

describe("seed route writes", () => {
  it("writes every metric into the local stub only, in chunks; reset=1 clears seeds first", async () => {
    const { env, m } = makeEnv();
    const token = await tokenFor(ADMIN);
    const res = await call(`http://localhost:5173${SEED_PATH}?days=2`, { token }, env);
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { ok: boolean; points: number; days: number };
    expect(body.ok).toBe(true);
    expect(body.days).toBe(2);
    expect(body.points).toBeGreaterThan(500);
    expect(m.calls.points).toBe(body.points);
    expect(m.calls.ingest).toBe(Math.ceil(body.points / 1000));
    expect(m.calls.analyticsWrites).toBe(0);
    expect(m.calls.reset).toEqual([]);
    expect(m.store.count()).toBe(body.points);

    const now = Date.now();
    for (const metric of Object.keys(METRICS) as MetricName[]) {
      const [row] = m.store.totals({
        metric,
        from: now - 3 * DAY,
        to: now + 1,
        groupBy: [],
        value: { op: "count" },
      });
      expect(row!.value, metric).toBeGreaterThan(0);
    }

    const again = await call(`http://localhost:5173${SEED_PATH}?days=2&reset=1`, { token }, env);
    const body2 = (await again!.json()) as { points: number; removed: number };
    expect(m.calls.reset).toEqual([true]);
    expect(body2.removed).toBe(body.points);
    expect(m.store.count()).toBe(body2.points);
  });
});

describe("seedPoints", () => {
  const ids = classicSeedIds();
  const points = seedPoints({ now: NOW, days: 3, ids });

  it("reads real ids from the classic registry", () => {
    expect(ids.classes).toEqual(
      expect.arrayContaining(["classic.warrior", "classic.rogue", "classic.sorcerer"]),
    );
    expect(ids.monsters.length).toBeGreaterThan(5);
    expect(ids.monsters.every((id) => id.startsWith("classic.monster."))).toBe(true);
    expect(ids.bosses.map((b) => b.id)).toContain("classic.monster.boss_warden");
    expect(ids.quests).toContain("classic.quest.rats_in_the_cellar");
    expect(ids.skills.every((id) => id.startsWith("classic.skill."))).toBe(true);
    expect(ids.talents.every((id) => id.startsWith("classic.talent."))).toBe(true);
    expect(ids.achievements.length).toBeGreaterThan(0);
    expect(ids.contentHash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic for a fixed time", () => {
    expect(seedPoints({ now: NOW, days: 3, ids })).toEqual(points);
    expect(seedPoints({ now: NOW, days: 3, ids, seed: 1 })).not.toEqual(points);
  });

  it("covers every metric, inside the window, with seed indexes and the seed build", () => {
    const metrics = new Set(points.map((p) => p.blobs[0]!));
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...metrics].sort(byName)).toEqual(Object.keys(METRICS).sort(byName));
    for (const p of points) {
      expect(p.t).toBeLessThanOrEqual(NOW);
      expect(p.t).toBeGreaterThanOrEqual(NOW - 3 * DAY);
      expect(p.index.startsWith("seed")).toBe(true);
      expect(p.sample).toBeGreaterThanOrEqual(1);
      expect(p.doubles.every((d) => Number.isFinite(d))).toBe(true);
    }
    const builds = points.filter((p) => p.blobs[0] === "client.session").map((p) => p.blobs[6]);
    expect(new Set(builds)).toEqual(new Set([SEED_BUILD]));
    expect(
      points.filter((p) => p.blobs[0] === "client.perf").every((p) => p.blobs[4] === SEED_BUILD),
    ).toBe(true);
  });

  it("uses registry ids in sim.tally keys and plausible client numbers", () => {
    const tally = points.filter((p) => p.blobs[0] === "sim.tally");
    const byMetric = (m: string) => tally.filter((p) => p.blobs[2] === m);
    const monsterIds = new Set([...ids.monsters, ...ids.bosses.map((b) => b.id), "unknown"]);
    expect(byMetric("kill").every((p) => monsterIds.has(p.blobs[3]!))).toBe(true);
    expect(byMetric("death").every((p) => monsterIds.has(p.blobs[4]!))).toBe(true);
    expect(byMetric("boss.killed").every((p) => ids.bosses.some((b) => b.id === p.blobs[3]))).toBe(
      true,
    );
    expect(byMetric("quest.accepted").every((p) => ids.quests.includes(p.blobs[3]!))).toBe(true);
    expect(byMetric("cast").every((p) => ids.skills.includes(p.blobs[3]!))).toBe(true);
    expect(byMetric("level").every((p) => ids.classes.includes(p.blobs[4]!))).toBe(true);
    expect(byMetric("drop").every((p) => ids.itemRarities.includes(p.blobs[3]!))).toBe(true);
    for (const m of ["play.ms", "kill", "xp", "gold", "drop", "cast", "quest.accepted"]) {
      expect(byMetric(m).length, m).toBeGreaterThan(0);
    }
    const perf = points.filter((p) => p.blobs[0] === "client.perf");
    expect(perf.every((p) => p.doubles[0]! >= 45 && p.doubles[0]! <= 60)).toBe(true);
    expect(perf.every((p) => p.doubles[1]! >= 45 && p.doubles[1]! <= 60)).toBe(true);
    // Somebody is online "now" (concurrent players in the last 120 s).
    const live = points.filter(
      (p) => p.blobs[0] === "client.session" && p.blobs[1] === "heartbeat" && p.t >= NOW - 120_000,
    );
    expect(new Set(live.map((p) => p.index)).size).toBeGreaterThanOrEqual(5);
    const ends = points.filter((p) => p.blobs[0] === "client.session" && p.blobs[1] === "end");
    expect(ends.every((p) => p.blobs[9] === lengthBand(p.doubles[0]!))).toBe(true);
  });

  it("helpers", () => {
    expect(clampDays(0)).toBe(1);
    expect(clampDays(99)).toBe(30);
    expect(clampDays(NaN)).toBe(7);
    expect(seedLevelBand(1)).toBe("1-9");
    expect(seedLevelBand(10)).toBe("10-19");
    expect(seedLevelBand(89)).toBe("80-89");
    expect(seedLevelBand(90)).toBe("90+");
    expect(lengthBand(59)).toBe("<1m");
    expect(lengthBand(7200)).toBe("2h+");
  });
});
