/**
 * Admin routes (routes/admin.ts) and auth (admin/auth.ts): who may call what,
 * dev admins only on dev hosts, the flags write and the flags cache reset.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { signToken } from "../../src/server/auth.ts";
import { adminRoutes } from "../../src/server/routes/admin.ts";
import { requireAdmin } from "../../src/server/admin/auth.ts";
import { currentConfig, DEFAULT_FLAGS, resetFlagsCache } from "../../src/server/config/flags.ts";
import type { Env } from "../../src/server/contracts.ts";
import { FakeD1 } from "../leaderboards/fake-d1.ts";

const SECRET = "test-secret";
const ADMIN_ENV = "acc-env-admin";
const DEV_ADMIN = "acc-dev-admin";
const PLAYER = "acc-player";
const LOCAL = "http://localhost:5173";
const PROD = "https://gamez.example.com";

async function tokenFor(accountId: string): Promise<string> {
  return signToken(SECRET, { accountId, name: accountId, issuedAt: Date.now() });
}

interface ConfigCalls {
  setFlags: { patch: unknown; by: string }[];
  grants: string[];
}

/** A CONFIG binding fake: flags answered from `flags`, devAdmins from the set. */
function configNs(
  calls: ConfigCalls,
  flags: Record<string, boolean> = {},
  devAdmins = new Set<string>([DEV_ADMIN]),
) {
  // Stateful like ConfigDO: a write is visible to the next config() call.
  const state: Record<string, boolean> = { ...DEFAULT_FLAGS, ...flags };
  const stub = {
    config: async () => ({ flags: { ...state }, seasonId: "s", serverTime: 1 }),
    setFlags: async (patch: Record<string, boolean>, by: string) => {
      calls.setFlags.push({ patch, by });
      Object.assign(state, patch);
      return { flags: { ...state }, seasonId: "s", serverTime: 1 };
    },
    grantDevAdmin: async (accountId: string) => {
      calls.grants.push(accountId);
      devAdmins.add(accountId);
    },
    isDevAdmin: async (accountId: string) => devAdmins.has(accountId),
  };
  return { getByName: () => stub };
}

function accountNs() {
  return {
    getByName: () => ({
      // Every test token is a guest session (never registered).
      profile: async () => null,
      checkSession: async () => true,
    }),
  };
}

function makeEnv(over: Partial<Env> = {}, calls: ConfigCalls = { setFlags: [], grants: [] }) {
  const d1 = new FakeD1();
  return {
    AUTH_SECRET: SECRET,
    ACCOUNT: accountNs(),
    ADMIN_ACCOUNT_IDS: ADMIN_ENV,
    CONFIG: configNs(calls),
    DB: d1.asD1(),
    ...over,
  } as unknown as Env;
}

function req(url: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function call(
  url: string,
  env: Env,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  const u = new URL(url);
  const res = await adminRoutes({
    request: req(url, init),
    env,
    url: u,
    ctx: {} as ExecutionContext,
  });
  if (!res) throw new Error(`route returned null for ${url}`);
  return res;
}

beforeEach(() => resetFlagsCache());

describe("requireAdmin", () => {
  it("401 without a token, 403 for a player", async () => {
    const env = makeEnv();
    const none = await requireAdmin(req(`${LOCAL}/api/admin/economy`), env, new URL(LOCAL + "/x"));
    expect(none).toBeInstanceOf(Response);
    expect((none as Response).status).toBe(401);
    const player = await requireAdmin(
      req(`${LOCAL}/api/admin/economy`, { token: await tokenFor(PLAYER) }),
      env,
      new URL(`${LOCAL}/api/admin/economy`),
    );
    expect((player as Response).status).toBe(403);
  });

  it("accepts ADMIN_ACCOUNT_IDS on any host", async () => {
    const env = makeEnv();
    const url = new URL(`${PROD}/api/admin/economy`);
    const res = await requireAdmin(req(url.href, { token: await tokenFor(ADMIN_ENV) }), env, url);
    expect(res).toEqual({ accountId: ADMIN_ENV, via: "env" });
  });

  it("accepts a dev admin on a dev host", async () => {
    const env = makeEnv();
    const url = new URL(`${LOCAL}/api/admin/economy`);
    const res = await requireAdmin(req(url.href, { token: await tokenFor(DEV_ADMIN) }), env, url);
    expect(res).toEqual({ accountId: DEV_ADMIN, via: "dev" });
  });

  it("ignores dev admins off dev hosts, even when granted", async () => {
    const env = makeEnv();
    const url = new URL(`${PROD}/api/admin/economy`);
    const res = await requireAdmin(req(url.href, { token: await tokenFor(DEV_ADMIN) }), env, url);
    expect((res as Response).status).toBe(403);
  });

  it("ignores dev admins when OAUTH_STUB=0 disables dev hosts on localhost", async () => {
    const env = makeEnv({ OAUTH_STUB: "0" } as Partial<Env>);
    const url = new URL(`${LOCAL}/api/admin/economy`);
    const res = await requireAdmin(req(url.href, { token: await tokenFor(DEV_ADMIN) }), env, url);
    expect((res as Response).status).toBe(403);
  });

  it("fails closed when ConfigDO is down (env admins still pass)", async () => {
    const broken = {
      getByName: () => ({
        isDevAdmin: async () => {
          throw new Error("down");
        },
      }),
    };
    const env = makeEnv({ CONFIG: broken as never });
    const url = new URL(`${LOCAL}/api/admin/economy`);
    const dev = await requireAdmin(req(url.href, { token: await tokenFor(DEV_ADMIN) }), env, url);
    expect((dev as Response).status).toBe(403);
    const env2 = await requireAdmin(req(url.href, { token: await tokenFor(ADMIN_ENV) }), env, url);
    expect(env2).toEqual({ accountId: ADMIN_ENV, via: "env" });
  });
});

describe("admin routes", () => {
  it("answers /api/admin/economy 401 then 403 for the wrong callers", async () => {
    const env = makeEnv();
    const url = `${LOCAL}/api/admin/economy`;
    expect((await call(url, env)).status).toBe(401);
    expect((await call(url, env, { token: await tokenFor(PLAYER) })).status).toBe(403);
  });

  it("answers the economy telemetry shape to an env admin", async () => {
    const env = makeEnv();
    const res = await call(`${LOCAL}/api/admin/economy?days=3`, env, {
      token: await tokenFor(ADMIN_ENV),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "accounts",
        "at",
        "flows",
        "market",
        "moneySupply",
        "priceIndex",
        "purchases",
        "shops",
      ].sort(),
    );
    expect((body.flows as unknown[]).length).toBe(3);
  });

  it("answers a dev admin on a dev host, and 403 for the same token on a prod host", async () => {
    const env = makeEnv();
    const token = await tokenFor(DEV_ADMIN);
    expect((await call(`${LOCAL}/api/admin/economy`, env, { token })).status).toBe(200);
    expect((await call(`${PROD}/api/admin/economy`, env, { token })).status).toBe(403);
  });

  it("POST /api/dev/admin/self grants the caller on dev hosts only", async () => {
    const calls: ConfigCalls = { setFlags: [], grants: [] };
    const env = makeEnv({}, calls);
    const token = await tokenFor(PLAYER);
    const ok = await call(`${LOCAL}/api/dev/admin/self`, env, { method: "POST", token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, accountId: PLAYER, admin: "dev" });
    expect(calls.grants).toEqual([PLAYER]);
    const prod = await call(`${PROD}/api/dev/admin/self`, env, { method: "POST", token });
    expect(prod.status).toBe(404);
    expect(calls.grants).toEqual([PLAYER]);
  });

  it("GET /api/admin/me answers players with 200, admins with the source, anonymous with 401", async () => {
    const env = makeEnv();
    const anon = await call(`${LOCAL}/api/admin/me`, env);
    expect(anon.status).toBe(401);
    const player = await call(`${LOCAL}/api/admin/me`, env, { token: await tokenFor(PLAYER) });
    expect(player.status).toBe(200);
    expect(await player.json()).toEqual({ admin: false, devHost: true });
    const playerProd = await call(`${PROD}/api/admin/me`, env, { token: await tokenFor(PLAYER) });
    expect(await playerProd.json()).toEqual({ admin: false, devHost: false });
    const dev = await call(`${LOCAL}/api/admin/me`, env, { token: await tokenFor(DEV_ADMIN) });
    expect(await dev.json()).toMatchObject({ admin: true, via: "dev", accountId: DEV_ADMIN });
    const envAdmin = await call(`${PROD}/api/admin/me`, env, { token: await tokenFor(ADMIN_ENV) });
    expect(await envAdmin.json()).toMatchObject({ admin: true, via: "env", devHost: false });
    const devOffHost = await call(`${PROD}/api/admin/me`, env, {
      token: await tokenFor(DEV_ADMIN),
    });
    expect(await devOffHost.json()).toEqual({ admin: false, devHost: false });
  });

  it("POST /api/dev/admin/self needs a token", async () => {
    const env = makeEnv();
    expect((await call(`${LOCAL}/api/dev/admin/self`, env, { method: "POST" })).status).toBe(401);
  });

  it("GET /api/config is public, cacheable for 30 s and reads the flags", async () => {
    const env = makeEnv({}, { setFlags: [], grants: [] });
    const res = await call(`${PROD}/api/config`, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    const body = (await res.json()) as { flags: Record<string, boolean> };
    expect(body.flags.market).toBe(true);
  });

  it("GET /api/config answers the defaults when ConfigDO fails", async () => {
    const env = makeEnv({
      CONFIG: {
        getByName: () => ({
          config: async () => {
            throw new Error("down");
          },
        }),
      } as never,
    });
    const body = (await (await call(`${PROD}/api/config`, env)).json()) as {
      flags: Record<string, boolean>;
      seasonId: string;
    };
    expect(body.flags).toEqual(DEFAULT_FLAGS);
    expect(body.seasonId.length).toBeGreaterThan(0);
  });

  it("POST /api/admin/flags writes through ConfigDO and resets the flags cache", async () => {
    const calls: ConfigCalls = { setFlags: [], grants: [] };
    const env = makeEnv({}, calls);
    const token = await tokenFor(ADMIN_ENV);
    // Warm the isolate cache with market on.
    expect((await currentConfig(env))?.flags.market).toBe(true);
    const res = await call(`${PROD}/api/admin/flags`, env, {
      method: "POST",
      token,
      body: { flags: { market: false } },
    });
    expect(res.status).toBe(200);
    expect(calls.setFlags).toEqual([{ patch: { market: false }, by: `admin:${ADMIN_ENV}` }]);
    // The cache was dropped by the write, so the next read sees the new value.
    expect((await currentConfig(env))?.flags.market).toBe(false);
  });

  it("POST /api/admin/flags rejects unknown flags and non-boolean values", async () => {
    const env = makeEnv();
    const token = await tokenFor(ADMIN_ENV);
    const unknown = await call(`${LOCAL}/api/admin/flags`, env, {
      method: "POST",
      token,
      body: { flags: { casino: false } },
    });
    expect(unknown.status).toBe(400);
    const typed = await call(`${LOCAL}/api/admin/flags`, env, {
      method: "POST",
      token,
      body: { flags: { market: "off" } },
    });
    expect(typed.status).toBe(400);
    const none = await call(`${LOCAL}/api/admin/flags`, env, { method: "POST", token, body: {} });
    expect(none.status).toBe(400);
  });

  it("POST /api/admin/flags is refused to players", async () => {
    const env = makeEnv();
    const res = await call(`${LOCAL}/api/admin/flags`, env, {
      method: "POST",
      token: await tokenFor(PLAYER),
      body: { flags: { market: false } },
    });
    expect(res.status).toBe(403);
  });

  it("forwards mute to the wave B handler for a dev admin", async () => {
    const muted: unknown[] = [];
    const env = makeEnv({
      CHAT: {
        getByName: (channel: string) => ({
          mute: async (...args: unknown[]) => void muted.push({ channel, args }),
        }),
      } as never,
    });
    const res = await call(`${LOCAL}/api/admin/mute`, env, {
      method: "POST",
      token: await tokenFor(DEV_ADMIN),
      body: { channel: "global", accountId: PLAYER, minutes: 5 },
    });
    expect(res.status).toBe(200);
    expect(muted).toHaveLength(1);
  });

  it("returns null for paths it does not own", async () => {
    const env = makeEnv();
    const res = await adminRoutes({
      request: req(`${LOCAL}/api/chat`),
      env,
      url: new URL(`${LOCAL}/api/chat`),
      ctx: {} as ExecutionContext,
    });
    expect(res).toBeNull();
  });
});

describe("flags cache", () => {
  it("serves the cached config until reset", async () => {
    let market = true;
    const env = {
      CONFIG: {
        getByName: () => ({
          config: async () => ({
            flags: { ...DEFAULT_FLAGS, market },
            seasonId: "s",
            serverTime: 1,
          }),
        }),
      },
    } as unknown as Pick<Env, "CONFIG">;
    expect((await currentConfig(env))?.flags.market).toBe(true);
    market = false;
    expect((await currentConfig(env))?.flags.market).toBe(true);
    resetFlagsCache();
    expect((await currentConfig(env))?.flags.market).toBe(false);
  });
});
