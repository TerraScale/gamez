import { describe, expect, it } from "vite-plus/test";
import { newGuest, signToken } from "../../src/server/auth.ts";
import { AccountEconomy } from "../../src/server/account/economy.ts";
import type { Env } from "../../src/server/contracts.ts";
import { accountRoutes } from "../../src/server/routes/account.ts";
import type { RouteContext } from "../../src/server/routes/types.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const SECRET = "test-secret";
const HOST = "http://localhost:5173";

/**
 * A fake Env whose ACCOUNT namespace hands out one in-memory AccountEconomy per
 * account name, like AccountDO.getByName does for real DOs.
 */
function fakeEnv(overrides: Partial<Env> = {}): {
  env: Env;
  economy: (name: string) => AccountEconomy;
} {
  const economies = new Map<string, AccountEconomy>();
  const economy = (name: string): AccountEconomy => {
    let e = economies.get(name);
    if (!e) {
      e = new AccountEconomy(fakeSqlStore());
      e.init();
      economies.set(name, e);
    }
    return e;
  };
  const env = {
    AUTH_SECRET: SECRET,
    ACCOUNT: { getByName: (name: string) => economy(name) },
    ...overrides,
  } as unknown as Env;
  return { env, economy };
}

async function guestToken(): Promise<{ token: string; accountId: string }> {
  const identity = newGuest();
  return { token: await signToken(SECRET, identity), accountId: identity.accountId };
}

function ctxFor(
  env: Env,
  path: string,
  init: { method?: string; token?: string; body?: unknown; base?: string } = {},
): RouteContext {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(path, init.base ?? HOST);
  const request = new Request(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { request, env, url, ctx: {} as ExecutionContext };
}

async function call(
  env: Env,
  path: string,
  init: Parameters<typeof ctxFor>[2] = {},
): Promise<Response> {
  const res = await accountRoutes(ctxFor(env, path, init));
  if (!res) throw new Error(`route did not answer ${path}`);
  return res;
}

describe("account routes: authentication", () => {
  it("answers 401 without a valid bearer token", async () => {
    const { env } = fakeEnv();
    const missing = await call(env, "/api/account/wallet");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: "unauthorized" } });

    const forged = await call(env, "/api/account/wallet", { token: "abc.def" });
    expect(forged.status).toBe(401);
  });

  it("does not answer paths it does not own", async () => {
    const { env } = fakeEnv();
    expect(await accountRoutes(ctxFor(env, "/api/account/name", { method: "POST" }))).toBeNull();
    expect(await accountRoutes(ctxFor(env, "/api/guilds"))).toBeNull();
  });
});

describe("GET /api/account/wallet, stash, cosmetics", () => {
  it("reads zeros and empty lists for a new account", async () => {
    const { env } = fakeEnv();
    const { token } = await guestToken();
    expect(await (await call(env, "/api/account/wallet", { token })).json()).toEqual({
      balances: { coin: 0, gem: 0 },
    });
    expect(await (await call(env, "/api/account/stash", { token })).json()).toEqual([]);
    expect(await (await call(env, "/api/account/cosmetics", { token })).json()).toEqual({
      owned: [],
      equipped: {},
    });
  });

  it("reads the balances of the caller's own account only", async () => {
    const { env, economy } = fakeEnv();
    const mine = await guestToken();
    const theirs = await guestToken();
    economy(mine.accountId).applyWalletTx({
      txId: "seed",
      currency: "gem",
      amount: 12,
      reason: "test",
    });
    expect(await (await call(env, "/api/account/wallet", { token: mine.token })).json()).toEqual({
      balances: { coin: 0, gem: 12 },
    });
    expect(await (await call(env, "/api/account/wallet", { token: theirs.token })).json()).toEqual({
      balances: { coin: 0, gem: 0 },
    });
  });

  it("shows the stash contents", async () => {
    const { env, economy } = fakeEnv();
    const { token, accountId } = await guestToken();
    economy(accountId).stashAdd("s", {
      itemId: "universal.material.ember_dust",
      count: 2,
      origin: "classic",
    });
    expect(await (await call(env, "/api/account/stash", { token })).json()).toEqual([
      { uid: "stk:s", itemId: "universal.material.ember_dust", count: 2, origin: "classic" },
    ]);
  });

  it("rejects the wrong method with 405", async () => {
    const { env } = fakeEnv();
    const { token } = await guestToken();
    const res = await call(env, "/api/account/wallet", { token, method: "POST", body: {} });
    expect(res.status).toBe(405);
  });
});

describe("POST /api/account/cosmetics/equip", () => {
  it("equips an owned cosmetic and unequips with id null", async () => {
    const { env, economy } = fakeEnv();
    const { token, accountId } = await guestToken();
    economy(accountId).grantEntitlement({
      txId: "g",
      sku: "cosmetic.title.founder",
      source: "dev",
    });
    const equip = await call(env, "/api/account/cosmetics/equip", {
      token,
      method: "POST",
      body: { slot: "title", id: "cosmetic.title.founder" },
    });
    expect(equip.status).toBe(200);
    expect(await equip.json()).toEqual({
      owned: ["cosmetic.title.founder"],
      equipped: { title: "cosmetic.title.founder" },
    });

    const off = await call(env, "/api/account/cosmetics/equip", {
      token,
      method: "POST",
      body: { slot: "title", id: null },
    });
    expect(await off.json()).toEqual({ owned: ["cosmetic.title.founder"], equipped: {} });
  });

  it("refuses a cosmetic the account does not own", async () => {
    const { env } = fakeEnv();
    const { token } = await guestToken();
    const res = await call(env, "/api/account/cosmetics/equip", {
      token,
      method: "POST",
      body: { slot: "title", id: "cosmetic.title.founder" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "not_owned" } });
  });

  it("validates the body", async () => {
    const { env } = fakeEnv();
    const { token } = await guestToken();
    const post = (body: unknown) =>
      call(env, "/api/account/cosmetics/equip", { token, method: "POST", body });
    expect((await post({ slot: "hat", id: null })).status).toBe(400);
    expect((await post({ slot: "title", id: 7 })).status).toBe(400);
    expect((await post({ slot: "title", id: "" })).status).toBe(400);
    expect((await post({ id: null })).status).toBe(400);
    const raw = await accountRoutes(
      ctxFor(env, "/api/account/cosmetics/equip", { token, method: "POST" }),
    );
    expect(raw!.status).toBe(400);
  });
});

describe("POST /api/dev/grant", () => {
  it("grants on a dev host and the grant shows up in cosmetics", async () => {
    const { env } = fakeEnv();
    const { token } = await guestToken();
    const res = await call(env, "/api/dev/grant", {
      token,
      method: "POST",
      body: { sku: "cosmetic.nameplate.gold" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      granted: boolean;
      entitlement: { sku: string; source: string; id: string };
    };
    expect(body.granted).toBe(true);
    expect(body.entitlement).toMatchObject({ sku: "cosmetic.nameplate.gold", source: "dev" });
    expect(body.entitlement.id.startsWith("dev:")).toBe(true);

    const cosmetics = await (await call(env, "/api/account/cosmetics", { token })).json();
    expect(cosmetics).toEqual({ owned: ["cosmetic.nameplate.gold"], equipped: {} });
  });

  it("gives every call a fresh txId", async () => {
    const { env } = fakeEnv();
    const { token } = await guestToken();
    const grant = () =>
      call(env, "/api/dev/grant", { token, method: "POST", body: { sku: "cosmetic.title.x" } });
    const a = (await (await grant()).json()) as { entitlement: { id: string } };
    const b = (await (await grant()).json()) as { entitlement: { id: string } };
    expect(a.entitlement.id).not.toBe(b.entitlement.id);
  });

  it("is invisible (404) on production hosts", async () => {
    const { env } = fakeEnv({ OAUTH_STUB: "0" });
    const { token } = await guestToken();
    const res = await call(env, "/api/dev/grant", {
      token,
      method: "POST",
      body: { sku: "cosmetic.title.x" },
      base: "https://gamez.example.com",
    });
    expect(res.status).toBe(404);
  });

  it("requires a bearer token and a valid sku on dev hosts", async () => {
    const { env } = fakeEnv();
    const { token } = await guestToken();
    const noAuth = await call(env, "/api/dev/grant", {
      method: "POST",
      body: { sku: "cosmetic.title.x" },
    });
    expect(noAuth.status).toBe(401);

    const badSku = await call(env, "/api/dev/grant", {
      token,
      method: "POST",
      body: { sku: "not valid!" },
    });
    expect(badSku.status).toBe(400);

    const noBody = await accountRoutes(ctxFor(env, "/api/dev/grant", { token, method: "POST" }));
    expect(noBody!.status).toBe(400);
  });
});
