/**
 * /api/pass* routes (wave-C.md §7): auth, guest access, claim validation,
 * premium through gems (walletTx + grantEntitlement), dev xp gated to stub hosts.
 */
import { describe, expect, it } from "vite-plus/test";
import { PASS_PREMIUM_GEMS } from "@gamez/economy";
import type { PassView } from "@gamez/protocol";
import { newGuest, signToken } from "../../src/server/auth.ts";
import type { Env } from "../../src/server/contracts.ts";
import { passRoutes, buyPremium, type PremiumAccount } from "../../src/server/routes/pass.ts";
import type { RouteContext } from "../../src/server/routes/types.ts";
import { fakeAccount, fakeStub, type FakeAccount } from "./support.ts";

const SECRET = "test-secret";
const DEV = "http://localhost:5173";
const PROD = "https://gamez.example";

function setup() {
  const accounts = new Map<string, FakeAccount>();
  const acct = (name: string): FakeAccount => {
    let a = accounts.get(name);
    if (!a) {
      a = fakeAccount();
      accounts.set(name, a);
    }
    return a;
  };
  const env = {
    AUTH_SECRET: SECRET,
    ACCOUNT: {
      getByName: (name: string) => ({
        ...fakeStub(acct(name)),
        checkSession: async (sid: string) => sid === `sid-${name}`,
      }),
    },
  } as unknown as Env;
  return { env, acct };
}

async function guest(): Promise<{ token: string; accountId: string }> {
  const identity = newGuest();
  return { token: await signToken(SECRET, identity), accountId: identity.accountId };
}

/** A registered login (its sid is open in the fake AccountDO). */
async function registered(): Promise<{ token: string; accountId: string }> {
  const base = newGuest();
  const identity = { ...base, kind: "registered" as const, sid: `sid-${base.accountId}` };
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
  const url = new URL(path, init.base ?? DEV);
  const request = new Request(url, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { request, env, url, ctx: {} as ExecutionContext };
}

async function call(
  env: Env,
  path: string,
  init: Parameters<typeof ctxFor>[2] = {},
): Promise<{ status: number; body: unknown }> {
  const res = await passRoutes(ctxFor(env, path, init));
  if (!res) throw new Error(`no route answered ${path}`);
  return { status: res.status, body: await res.json() };
}

describe("GET /api/pass", () => {
  it("needs a session", async () => {
    const { env } = setup();
    const r = await call(env, "/api/pass");
    expect(r.status).toBe(401);
  });

  it("answers the running season to a guest", async () => {
    const { env } = setup();
    const g = await guest();
    const r = await call(env, "/api/pass", { token: g.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ seasonId: "2026-s1", xp: 0, tier: 0, premium: false });
  });

  it("is not a write: other methods are refused", async () => {
    const { env } = setup();
    const g = await guest();
    const r = await call(env, "/api/pass", { token: g.token, method: "POST", body: {} });
    expect(r.status).toBe(405);
  });

  it("leaves unrelated paths to the next route", async () => {
    const { env } = setup();
    const res = await passRoutes(ctxFor(env, "/api/passes"));
    expect(res).toBeNull();
  });
});

describe("POST /api/pass/claim", () => {
  it("validates the body", async () => {
    const { env } = setup();
    const g = await guest();
    const bad = [
      { tier: "2", track: "free" },
      { tier: 0, track: "free" },
      { tier: 2, track: "gold" },
      { tier: 2.5, track: "free" },
    ];
    for (const body of bad) {
      const r = await call(env, "/api/pass/claim", { token: g.token, body });
      expect(r.status).toBe(400);
    }
    const r = await call(env, "/api/pass/claim", { token: g.token, body: null as never });
    expect(r.status).toBe(400);
  });

  it("refuses a tier that is not reached", async () => {
    const { env } = setup();
    const g = await guest();
    const r = await call(env, "/api/pass/claim", {
      token: g.token,
      body: { tier: 1, track: "free" },
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: "too_low" } });
  });

  it("claims a reached free reward for a guest", async () => {
    const { env } = setup();
    const g = await guest();
    await call(env, "/api/dev/pass/xp", { token: g.token, body: { xp: 400 } });
    const r = await call(env, "/api/pass/claim", {
      token: g.token,
      body: { tier: 1, track: "free" },
    });
    expect(r.status).toBe(200);
    expect((r.body as PassView).claimed.free).toEqual([1]);
  });

  it("refuses the premium track without premium", async () => {
    const { env } = setup();
    const g = await guest();
    await call(env, "/api/dev/pass/xp", { token: g.token, body: { xp: 400 } });
    const r = await call(env, "/api/pass/claim", {
      token: g.token,
      body: { tier: 1, track: "premium" },
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("POST /api/pass/premium", () => {
  it("validates the opId", async () => {
    const { env } = setup();
    const g = await registered();
    const r = await call(env, "/api/pass/premium", { token: g.token, body: { opId: "x" } });
    expect(r.status).toBe(400);
  });

  it("refuses without gems and grants nothing", async () => {
    const { env, acct } = setup();
    const g = await registered();
    const r = await call(env, "/api/pass/premium", {
      token: g.token,
      body: { opId: "premium-op-1" },
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: "insufficient_funds" } });
    expect(acct(g.accountId).economy.entitlements()).toEqual([]);
  });

  it("charges the gems once, unlocks premium, and unlocks the premium track", async () => {
    const { env, acct } = setup();
    const g = await registered();
    const a = acct(g.accountId);
    a.economy.applyWalletTx({ txId: "gift-gems", currency: "gem", amount: 800, reason: "test" });

    const r = await call(env, "/api/pass/premium", {
      token: g.token,
      body: { opId: "premium-op-2" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ premium: true });
    expect(a.economy.wallet().balances.gem).toBe(800 - PASS_PREMIUM_GEMS);

    // A replay (same opId) charges nothing more.
    const again = await call(env, "/api/pass/premium", {
      token: g.token,
      body: { opId: "premium-op-2" },
    });
    expect(again.status).toBe(200);
    expect(a.economy.wallet().balances.gem).toBe(800 - PASS_PREMIUM_GEMS);

    await call(env, "/api/dev/pass/xp", { token: g.token, body: { xp: 400 } });
    const claim = await call(env, "/api/pass/claim", {
      token: g.token,
      body: { tier: 1, track: "premium" },
    });
    expect(claim.status).toBe(200);
    expect(a.economy.cosmetics().owned).toContain("cosmetic.nameplate.gilded-plate");
  });

  it("does not charge again once premium is owned", async () => {
    const { env, acct } = setup();
    const g = await registered();
    const a = acct(g.accountId);
    a.economy.grantEntitlement({
      txId: "store-1",
      sku: a.pass.view().premiumSku,
      source: "store",
    });
    a.economy.applyWalletTx({ txId: "gift-gems", currency: "gem", amount: 900, reason: "test" });
    const r = await call(env, "/api/pass/premium", {
      token: g.token,
      body: { opId: "premium-op-3" },
    });
    expect(r.status).toBe(200);
    expect(a.economy.wallet().balances.gem).toBe(900);
  });

  it("refuses a guest before charging, even with gems", async () => {
    const { env, acct } = setup();
    const g = await guest();
    const a = acct(g.accountId);
    a.economy.applyWalletTx({ txId: "gift-gems", currency: "gem", amount: 900, reason: "test" });
    const r = await call(env, "/api/pass/premium", {
      token: g.token,
      body: { opId: "premium-op-guest" },
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: "guest_forbidden" } });
    expect(a.economy.wallet().balances.gem).toBe(900);
    expect(a.economy.entitlements()).toEqual([]);
  });

  it("needs a session", async () => {
    const { env } = setup();
    const r = await call(env, "/api/pass/premium", { body: { opId: "premium-op-4" } });
    expect(r.status).toBe(401);
  });
});

describe("buyPremium", () => {
  it("debits gems as a sink with a stable txId, then grants the premium sku", async () => {
    const calls: string[] = [];
    let premium = false;
    const acct: PremiumAccount = {
      pass: async () => ({
        seasonId: "2026-s1",
        name: "Season of Embers",
        startsAt: 0,
        endsAt: 0,
        xp: 0,
        tier: 0,
        premium,
        premiumSku: "pass.premium.2026-s1",
        tiers: [],
        claimed: { free: [], premium: [] },
      }),
      walletTx: async (tx) => {
        calls.push(`wallet ${tx.txId} ${tx.currency} ${tx.amount} ${tx.flow} ${tx.reason}`);
        return { ok: true, balance: 0, replayed: false };
      },
      grantEntitlement: async (g) => {
        calls.push(`grant ${g.txId} ${g.sku} ${g.source}`);
        premium = true;
        return {
          granted: true,
          entitlement: { id: g.txId, sku: g.sku, grantedAt: 0, source: g.source },
        };
      },
    };
    const res = await buyPremium(acct, "op-abcdefgh");
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      "wallet passprem:2026-s1:op-abcdefgh gem -500 sink pass.premium:2026-s1",
      "grant passprem:2026-s1:op-abcdefgh pass.premium.2026-s1 pass",
    ]);
  });

  it("maps a failed charge to insufficient_funds", async () => {
    const acct: PremiumAccount = {
      pass: async () => ({ premium: false }) as PassView,
      walletTx: async () => ({ ok: false, code: "insufficient_funds", balance: 10 }),
      grantEntitlement: async () => {
        throw new Error("must not grant");
      },
    };
    const res = await buyPremium(acct, "op-abcdefgh");
    expect(res).toMatchObject({ ok: false, code: "insufficient_funds" });
  });
});

describe("POST /api/dev/pass/xp", () => {
  it("adds season xp on a stub host", async () => {
    const { env } = setup();
    const g = await guest();
    const r = await call(env, "/api/dev/pass/xp", { token: g.token, body: { xp: 250 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ xp: 250, tier: 2 });
    const again = await call(env, "/api/dev/pass/xp", { token: g.token, body: { xp: 250 } });
    expect((again.body as PassView).xp).toBe(500);
  });

  it("is invisible (404) on production hosts", async () => {
    const { env } = setup();
    const g = await guest();
    const res = await passRoutes(
      ctxFor(env, "/api/dev/pass/xp", {
        token: g.token,
        body: { xp: 10 },
        base: PROD,
        method: "POST",
      }),
    );
    expect(res?.status).toBe(404);
  });

  it("validates xp and needs a session", async () => {
    const { env } = setup();
    const g = await guest();
    for (const xp of [0, -1, 10_001, 1.5, "5"]) {
      const r = await call(env, "/api/dev/pass/xp", { token: g.token, body: { xp } });
      expect(r.status).toBe(400);
    }
    const anon = await call(env, "/api/dev/pass/xp", { body: { xp: 5 } });
    expect(anon.status).toBe(401);
  });

  it("refuses GET", async () => {
    const { env } = setup();
    const g = await guest();
    const r = await call(env, "/api/dev/pass/xp", { token: g.token });
    expect(r.status).toBe(405);
  });
});
