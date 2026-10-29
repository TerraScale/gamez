/**
 * Tunables (docs/design/admin-dashboard.md §8): the strict patch parser, the
 * /api/admin/tunables route with a ConfigDO fake backed by FlagsStore, and
 * tunableValue (config/flags.ts) clamping and fallback.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { TUNABLES, type TunablesResponse } from "@gamez/protocol";
import { signToken } from "../../src/server/auth.ts";
import { FlagsStore } from "../../src/server/admin/flags-store.ts";
import { parseTunablesPatch } from "../../src/server/admin/metrics/tunables.ts";
import { resetMetricsCache } from "../../src/server/admin/metrics/cache.ts";
import { currentConfig, resetFlagsCache, tunableValue } from "../../src/server/config/flags.ts";
import type { Env } from "../../src/server/contracts.ts";
import { adminMetricsRoutes } from "../../src/server/routes/admin-metrics.ts";
import { FakeD1 } from "../leaderboards/fake-d1.ts";
import { FakeSqlStorage } from "../support/fake-sql.ts";

const OFFLINE = "classic.offlineXpPct";
const SECRET = "test-secret";
const ADMIN = "acc-admin";
const PLAYER = "acc-player";
const LOCAL = "http://localhost:5173";
const ALL_MIGRATIONS = [
  "0001_init.sql",
  "0002_leaderboards.sql",
  "0003_accounts.sql",
  "0004_guilds.sql",
  "0005_chat.sql",
  "0006_market.sql",
  "0007_shops.sql",
  "0008_arena.sql",
  "0009_economy.sql",
  "0010_admin.sql",
];

// ---------------------------------------------------------------------------
// parseTunablesPatch
// ---------------------------------------------------------------------------

describe("parseTunablesPatch", () => {
  it("accepts a known key with a number in range", () => {
    expect(parseTunablesPatch({ values: { [OFFLINE]: 35 } })).toEqual({ [OFFLINE]: 35 });
  });

  it("accepts both ends of the range", () => {
    expect(parseTunablesPatch({ values: { [OFFLINE]: 0 } })).toEqual({ [OFFLINE]: 0 });
    expect(parseTunablesPatch({ values: { [OFFLINE]: 100 } })).toEqual({ [OFFLINE]: 100 });
  });

  it("rejects a body that is not {values: {}}", () => {
    expect(parseTunablesPatch(null)).toMatch(/values/);
    expect(parseTunablesPatch([])).toMatch(/values/);
    expect(parseTunablesPatch({ values: [] })).toMatch(/values/);
    expect(parseTunablesPatch({ values: 20 })).toMatch(/values/);
    expect(parseTunablesPatch({ [OFFLINE]: 20 })).toMatch(/values/);
  });

  it("rejects an empty patch", () => {
    expect(parseTunablesPatch({ values: {} })).toMatch(/at least one/);
  });

  it("rejects an unknown key, naming it", () => {
    expect(parseTunablesPatch({ values: { "classic.nope": 1 } })).toContain("classic.nope");
  });

  it("rejects a non-number, naming the key", () => {
    expect(parseTunablesPatch({ values: { [OFFLINE]: "20" } })).toContain(OFFLINE);
    expect(parseTunablesPatch({ values: { [OFFLINE]: null } })).toContain(OFFLINE);
    expect(parseTunablesPatch({ values: { [OFFLINE]: true } })).toContain(OFFLINE);
  });

  it("rejects non-finite numbers, naming the key", () => {
    expect(parseTunablesPatch({ values: { [OFFLINE]: Number.NaN } })).toContain(OFFLINE);
    expect(parseTunablesPatch({ values: { [OFFLINE]: Number.POSITIVE_INFINITY } })).toContain(
      OFFLINE,
    );
  });

  it("rejects out-of-range values, naming the key and the bounds", () => {
    const spec = TUNABLES.find((t) => t.key === OFFLINE)!;
    const over = parseTunablesPatch({ values: { [OFFLINE]: 101 } });
    expect(over).toContain(OFFLINE);
    expect(over).toContain(`${spec.min} and ${spec.max}`);
    expect(parseTunablesPatch({ values: { [OFFLINE]: -1 } })).toContain(OFFLINE);
  });
});

// ---------------------------------------------------------------------------
// ConfigDO fake: the same FlagsStore the DO runs, behind the namespace API.
// ---------------------------------------------------------------------------

function configFake(counters: { config: number; setTunables: number }, failWrites = false) {
  const fake = new FakeSqlStorage();
  const store = new FlagsStore(
    {
      sql: fake.asSql(),
      transactionSync: (fn) => fake.transactionSync(fn),
    },
    () => 1_000,
  );
  const response = (): TunablesResponse => ({
    values: store.tunables(),
    specs: TUNABLES,
    audit: store.tunableAudit(100),
  });
  const stub = {
    config: async () => {
      counters.config++;
      return store.config();
    },
    setFlags: async () => store.config(),
    tunables: async () => response(),
    setTunables: async (patch: Record<string, number>, by: string) => {
      counters.setTunables++;
      if (failWrites) throw new Error("ConfigDO down");
      store.setTunables(patch, by);
      return response();
    },
    grantDevAdmin: async () => {},
    isDevAdmin: async () => false,
  };
  return { getByName: () => stub };
}

function accountNs() {
  return {
    getByName: () => ({
      profile: async () => null,
      checkSession: async () => true,
    }),
  };
}

async function tokenFor(accountId: string): Promise<string> {
  return signToken(SECRET, { accountId, name: accountId, issuedAt: Date.now() });
}

function makeEnv(counters = { config: 0, setTunables: 0 }, failWrites = false) {
  const d1 = new FakeD1();
  d1.migrate(ALL_MIGRATIONS);
  return {
    env: {
      AUTH_SECRET: SECRET,
      ACCOUNT: accountNs(),
      ADMIN_ACCOUNT_IDS: ADMIN,
      CONFIG: configFake(counters, failWrites),
      DB: d1.asD1(),
    } as unknown as Env,
    counters,
  };
}

async function call(
  env: Env,
  method: string,
  path: string,
  init: { token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(LOCAL + path);
  const res = await adminMetricsRoutes({
    request: new Request(url, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
    env,
    url,
    ctx: {} as ExecutionContext,
  });
  if (!res) throw new Error(`route returned null for ${path}`);
  return res;
}

beforeEach(() => {
  resetFlagsCache();
  resetMetricsCache();
});

describe("/api/admin/tunables", () => {
  it("GET answers the defaults for an admin", async () => {
    const { env } = makeEnv();
    const res = await call(env, "GET", "/api/admin/tunables", { token: await tokenFor(ADMIN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TunablesResponse;
    expect(body.values).toEqual({ [OFFLINE]: 20 });
    expect(body.specs.map((s) => s.key)).toEqual(TUNABLES.map((s) => s.key));
    expect(body.audit).toEqual([]);
  });

  it("POST writes a clamped value and returns the new state", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/api/admin/tunables", {
      token: await tokenFor(ADMIN),
      body: { values: { [OFFLINE]: 15 } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TunablesResponse;
    expect(body.values[OFFLINE]).toBe(15);
    expect(body.audit).toEqual([{ key: OFFLINE, value: 15, by: `admin:${ADMIN}`, at: 1_000 }]);
  });

  it("POST with a bad value is 400, naming the key, and writes nothing", async () => {
    const counters = { config: 0, setTunables: 0 };
    const { env } = makeEnv(counters);
    const cases: unknown[] = [
      { values: { [OFFLINE]: 500 } },
      { values: { [OFFLINE]: "20" } },
      { values: { "classic.unknown": 1 } },
      { values: {} },
      null,
    ];
    for (const body of cases) {
      const res = await call(env, "POST", "/api/admin/tunables", {
        token: await tokenFor(ADMIN),
        body,
      });
      expect(res.status).toBe(400);
    }
    const bad = await call(env, "POST", "/api/admin/tunables", {
      token: await tokenFor(ADMIN),
      body: { values: { [OFFLINE]: 500 } },
    });
    const err = (await bad.json()) as { error: { message: string } };
    expect(err.error.message).toContain(OFFLINE);
    expect(counters.setTunables).toBe(0);
  });

  it("POST by a player is 403, and by an anonymous caller is 401", async () => {
    const { env, counters } = makeEnv();
    const player = await call(env, "POST", "/api/admin/tunables", {
      token: await tokenFor(PLAYER),
      body: { values: { [OFFLINE]: 1 } },
    });
    expect(player.status).toBe(403);
    const anon = await call(env, "POST", "/api/admin/tunables", {
      body: { values: { [OFFLINE]: 1 } },
    });
    expect(anon.status).toBe(401);
    expect(counters.setTunables).toBe(0);
  });

  it("a write resets the flags cache (the next config read goes to ConfigDO)", async () => {
    const counters = { config: 0, setTunables: 0 };
    const { env } = makeEnv(counters);
    await currentConfig(env);
    await currentConfig(env);
    expect(counters.config).toBe(1);

    const res = await call(env, "POST", "/api/admin/tunables", {
      token: await tokenFor(ADMIN),
      body: { values: { [OFFLINE]: 25 } },
    });
    expect(res.status).toBe(200);
    expect((await currentConfig(env))?.tunables?.[OFFLINE]).toBe(25);
    expect(counters.config).toBe(2);
  });

  it("a write resets the metrics cache (the next overview is a miss)", async () => {
    const { env } = makeEnv();
    const token = await tokenFor(ADMIN);
    const first = await call(env, "GET", "/api/admin/overview", { token });
    expect(first.headers.get("x-admin-cache")).toBe("miss");
    const second = await call(env, "GET", "/api/admin/overview", { token });
    expect(second.headers.get("x-admin-cache")).toBe("hit");

    const write = await call(env, "POST", "/api/admin/tunables", {
      token,
      body: { values: { [OFFLINE]: 10 } },
    });
    expect(write.status).toBe(200);
    const third = await call(env, "GET", "/api/admin/overview", { token });
    expect(third.headers.get("x-admin-cache")).toBe("miss");
  });

  it("answers 503 when ConfigDO fails the write, and the cache is untouched", async () => {
    const counters = { config: 0, setTunables: 0 };
    const { env } = makeEnv(counters, true);
    const res = await call(env, "POST", "/api/admin/tunables", {
      token: await tokenFor(ADMIN),
      body: { values: { [OFFLINE]: 10 } },
    });
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// tunableValue (config/flags.ts): clamp, default, fallback
// ---------------------------------------------------------------------------

function configReturning(tunables: Record<string, number> | undefined) {
  return {
    getByName: () => ({
      config: async () => ({
        flags: {},
        seasonId: "s",
        serverTime: 1,
        ...(tunables === undefined ? {} : { tunables }),
      }),
    }),
  };
}

describe("tunableValue", () => {
  it("returns the stored value", async () => {
    const env = { CONFIG: configReturning({ [OFFLINE]: 37 }) } as unknown as Env;
    expect(await tunableValue(env, OFFLINE)).toBe(37);
  });

  it("clamps a stored value to the spec range", async () => {
    const high = { CONFIG: configReturning({ [OFFLINE]: 500 }) } as unknown as Env;
    expect(await tunableValue(high, OFFLINE)).toBe(100);
    resetFlagsCache();
    const low = { CONFIG: configReturning({ [OFFLINE]: -3 }) } as unknown as Env;
    expect(await tunableValue(low, OFFLINE)).toBe(0);
  });

  it("falls back to the spec default when ConfigDO throws", async () => {
    const broken = {
      CONFIG: {
        getByName: () => ({
          config: async () => {
            throw new Error("ConfigDO down");
          },
        }),
      },
    } as unknown as Env;
    expect(await tunableValue(broken, OFFLINE)).toBe(20);
  });

  it("falls back to the default when the key is missing or not a number", async () => {
    const missing = { CONFIG: configReturning(undefined) } as unknown as Env;
    expect(await tunableValue(missing, OFFLINE)).toBe(20);
    resetFlagsCache();
    const junk = { CONFIG: configReturning({ [OFFLINE]: Number.NaN }) } as unknown as Env;
    expect(await tunableValue(junk, OFFLINE)).toBe(20);
  });

  it("answers the default with no CONFIG binding, and NaN for an unknown key", async () => {
    expect(await tunableValue({}, OFFLINE)).toBe(20);
    expect(Number.isNaN(await tunableValue({}, "classic.unknown"))).toBe(true);
  });
});
