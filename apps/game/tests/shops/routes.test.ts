import { describe, expect, it } from "vite-plus/test";
import { newGuest, signToken } from "../../src/server/auth.ts";
import type { Env } from "../../src/server/contracts.ts";
import { shopRoutes } from "../../src/server/routes/shops.ts";
import type { RouteContext } from "../../src/server/routes/types.ts";

const SECRET = "test-secret";
const HOST = "http://localhost:5173";
const PUBLIC_HOST = "https://gamez.example.com";

/** Records the DO calls the routes make; the answers are plain fakes. */
function fakeEnv(): {
  env: Env;
  calls: { ns: string; name: string; method: string; arg: unknown }[];
} {
  const calls: { ns: string; name: string; method: string; arg: unknown }[] = [];
  const stub = (ns: string, name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (arg: unknown) => {
          calls.push({ ns, name, method, arg });
          if (method === "plots" || method === "devAdvance") return [];
          if (method === "bid") return { ok: true, value: { id: "p1" } };
          if (method === "view") return null;
          return { ok: true, value: {} };
        },
      },
    );
  const env = {
    AUTH_SECRET: SECRET,
    DEV_ROUTES_ENABLED: "1",
    // Registered sessions are open for every account in these tests.
    ACCOUNT: { getByName: () => ({ checkSession: async () => true }) },
    PLOTS: { getByName: (n: string) => stub("PLOTS", n) },
    SHOP: { getByName: (n: string) => stub("SHOP", n) },
  } as unknown as Env;
  return { env, calls };
}

async function guest(): Promise<{ token: string }> {
  const identity = newGuest();
  return { token: await signToken(SECRET, identity) };
}

async function registered(accountId = "acct-alice"): Promise<{ token: string }> {
  const token = await signToken(SECRET, {
    accountId,
    name: "Alice",
    issuedAt: Date.now(),
    kind: "registered",
    sid: "sess-1",
  });
  return { token };
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
  c: RouteContext,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await shopRoutes(c);
  if (!res) throw new Error(`no route answered ${c.url.pathname}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("shop routes: reads", () => {
  it("lists the plots of a world for guests too", async () => {
    const { env } = fakeEnv();
    const g = await guest();
    const r = await call(ctxFor(env, "/api/shops?world=classic-town", { token: g.token }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ world: "classic-town", plots: [] });
  });

  it("rejects an unknown world and a missing session", async () => {
    const { env } = fakeEnv();
    const g = await guest();
    expect((await call(ctxFor(env, "/api/shops?world=nowhere", { token: g.token }))).status).toBe(
      400,
    );
    expect((await call(ctxFor(env, "/api/shops?world=classic-town"))).status).toBe(401);
  });

  it("answers 404 for an unknown plot", async () => {
    const { env } = fakeEnv();
    const g = await guest();
    const r = await call(ctxFor(env, "/api/shops/classic-town/p99", { token: g.token }));
    expect(r.status).toBe(404);
  });
});

describe("shop routes: writes", () => {
  it("guests cannot bid: 403 guest_forbidden", async () => {
    const { env, calls } = fakeEnv();
    const g = await guest();
    const r = await call(
      ctxFor(env, "/api/shops/plots/bid", {
        method: "POST",
        token: g.token,
        body: { opId: "bid-guest-0001", world: "classic-town", plotId: "p1", amount: 100 },
      }),
    );
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: "guest_forbidden" } });
    expect(calls).toHaveLength(0);
  });

  it("validates a bid body for a registered account before any DO call", async () => {
    const { env, calls } = fakeEnv();
    const a = await registered();
    const send = (body: unknown) =>
      call(ctxFor(env, "/api/shops/plots/bid", { method: "POST", token: a.token, body }));
    expect((await send({ world: "classic-town", plotId: "p1", amount: 100 })).status).toBe(400);
    expect(
      (await send({ opId: "bid-ok-0001", world: "nowhere", plotId: "p1", amount: 100 })).status,
    ).toBe(400);
    expect(
      (await send({ opId: "bid-ok-0001", world: "classic-town", plotId: "p99", amount: 100 }))
        .status,
    ).toBe(404);
    expect(
      (await send({ opId: "bid-ok-0001", world: "classic-town", plotId: "p1", amount: 1.5 }))
        .status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
    const ok = await send({
      opId: "bid-ok-0001",
      world: "classic-town",
      plotId: "p1",
      amount: 100,
    });
    expect(ok.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      ns: "PLOTS",
      name: "classic-town",
      method: "bid",
      arg: { opId: "bid-ok-0001", bidder: { accountId: "acct-alice" }, plotId: "p1", amount: 100 },
    });
  });

  it("checks the owner-action bodies: stock needs a uid and a whole price", async () => {
    const { env, calls } = fakeEnv();
    const a = await registered();
    const post = (action: string, body: unknown) =>
      call(
        ctxFor(env, `/api/shops/classic-town/p1/${action}`, {
          method: "POST",
          token: a.token,
          body,
        }),
      );
    expect((await post("stock", { opId: "stock-ok-0001", price: 10 })).status).toBe(400);
    expect((await post("stock", { opId: "stock-ok-0002", uid: "u1", price: 0 })).status).toBe(400);
    expect((await post("buy", { opId: "buy-ok-00001" })).status).toBe(400);
    expect((await post("configure", { open: "yes" })).status).toBe(400);
    expect((await post("configure", { name: "x".repeat(65) })).status).toBe(400);
    expect((await post("nonsense", { opId: "nonsense-0001" })).status).toBe(404);
    expect(calls).toHaveLength(0);
    const ok = await post("configure", { name: "Alice Wares", open: true });
    expect(ok.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      ns: "SHOP",
      name: "classic-town/p1",
      method: "configure",
      arg: { accountId: "acct-alice", name: "Alice Wares", open: true },
    });
  });

  it("answers 405 for a wrong method on a write path", async () => {
    const { env } = fakeEnv();
    const g = await guest();
    const r = await call(ctxFor(env, "/api/shops/plots/bid", { token: g.token }));
    expect(r.status).toBe(405);
  });
});

describe("shop routes: dev advance", () => {
  it("is invisible (404) on a production host", async () => {
    const { env, calls } = fakeEnv();
    const g = await guest();
    const r = await call(
      ctxFor(env, "/api/dev/shops/advance", {
        method: "POST",
        token: g.token,
        body: { world: "classic-town", ms: 1000 },
        base: PUBLIC_HOST,
      }),
    );
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("advances the plot book on a dev host and rejects bad sizes", async () => {
    const { env, calls } = fakeEnv();
    const g = await guest();
    const ok = await call(
      ctxFor(env, "/api/dev/shops/advance", {
        method: "POST",
        token: g.token,
        body: { world: "classic-town", ms: 60_000 },
      }),
    );
    expect(ok.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      ns: "PLOTS",
      name: "classic-town",
      method: "devAdvance",
      arg: 60_000,
    });
    const bad = await call(
      ctxFor(env, "/api/dev/shops/advance", {
        method: "POST",
        token: g.token,
        body: { world: "classic-town", ms: 0 },
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("needs a session", async () => {
    const { env } = fakeEnv();
    const r = await call(
      ctxFor(env, "/api/dev/shops/advance", {
        method: "POST",
        body: { world: "classic-town", ms: 1000 },
      }),
    );
    expect(r.status).toBe(401);
  });
});
