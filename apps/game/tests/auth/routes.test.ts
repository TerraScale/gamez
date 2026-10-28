import type { AccountView, AuthResponse, GuestResponse, ProvidersResponse } from "@gamez/protocol";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { verifyToken } from "../../src/server/auth.ts";
import { flowConfig } from "../../src/server/auth/flows.ts";
import { IpLimiter } from "../../src/server/auth/limiter.ts";
import { authRoutes, setAuthLimiter } from "../../src/server/routes/auth.ts";
import type { Env } from "../../src/server/contracts.ts";
import { ctxFor, fakeWorld, req, SECRET, type FakeWorld } from "./fakes.ts";

flowConfig.iterations = 1000;

interface ErrorBody {
  error: { code: string; message: string; retryAfterMs?: number };
}

async function call<T>(env: Env, request: Request): Promise<{ status: number; body: T }> {
  const res = await authRoutes(ctxFor(env, request));
  if (!res) throw new Error(`not routed: ${request.url}`);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function guest(env: Env): Promise<GuestResponse> {
  return (await call<GuestResponse>(env, req("/api/guest", { method: "POST" }))).body;
}

const PASSWORD = "correct-horse-battery-9";

let w: FakeWorld;
beforeEach(() => {
  w = fakeWorld();
  setAuthLimiter(new IpLimiter({ burst: 1000, perSecond: 1000 }));
});

describe("guest and /api/me", () => {
  it("issues v2 guest tokens and creates the profile lazily", async () => {
    const g = await guest(w.env);
    expect(g.kind).toBe("guest");
    expect(await verifyToken(SECRET, g.token)).toMatchObject({ kind: "guest", sid: null });
    expect(w.accounts.has(g.accountId)).toBe(false);
    const me = await call<AccountView>(w.env, req("/api/me", { token: g.token }));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      accountId: g.accountId,
      displayName: g.name,
      kind: "guest",
      identities: [],
    });
  });

  it("401s without a valid token and ignores other paths", async () => {
    expect((await call(w.env, req("/api/me"))).status).toBe(401);
    expect((await call(w.env, req("/api/me", { token: "bad.token" }))).status).toBe(401);
    expect(await authRoutes(ctxFor(w.env, req("/api/leaderboards")))).toBeNull();
    expect((await call(w.env, req("/api/guest"))).status).toBe(405);
    expect((await call(w.env, req("/api/auth/nope"))).status).toBe(404);
  });

  it("lists providers: stubs on dev hosts, disabled in production", async () => {
    const dev = await call<ProvidersResponse>(w.env, req("/api/auth/providers"));
    expect(dev.body.providers).toEqual([
      { id: "email", enabled: true, stub: false },
      { id: "google", enabled: true, stub: true },
      { id: "discord", enabled: true, stub: true },
      { id: "apple", enabled: true, stub: true },
    ]);
    const prodWorld = fakeWorld({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret" });
    const prod = await call<ProvidersResponse>(
      prodWorld.env,
      req("/api/auth/providers", { origin: "https://gamez.example.com" }),
    );
    expect(prod.body.providers).toEqual([
      { id: "email", enabled: true, stub: false },
      { id: "google", enabled: true, stub: false },
      { id: "discord", enabled: false, stub: false },
      { id: "apple", enabled: false, stub: false },
    ]);
  });
});

describe("register and login", () => {
  it("upgrades a guest in place (same accountId) and kills the guest token", async () => {
    const g = await guest(w.env);
    await call(w.env, req("/api/me", { token: g.token }));
    const r = await call<AuthResponse>(
      w.env,
      req("/api/auth/register", {
        token: g.token,
        body: { email: " Ember@Example.TEST ", password: PASSWORD, displayName: "Ember" },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body.account).toMatchObject({
      accountId: g.accountId,
      kind: "registered",
      displayName: "Ember",
      identities: [{ provider: "email", email: "ember@example.test" }],
    });
    const payload = await verifyToken(SECRET, r.body.token);
    expect(payload).toMatchObject({ accountId: g.accountId, kind: "registered", name: "Ember" });
    expect(payload?.sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const me = await call<AccountView>(w.env, req("/api/me", { token: r.body.token }));
    expect(me.body.kind).toBe("registered");
    expect((await call(w.env, req("/api/me", { token: g.token }))).status).toBe(401);
  });

  it("creates a new account without a bearer and names it from the email", async () => {
    const r = await call<AuthResponse>(
      w.env,
      req("/api/auth/register", { body: { email: "nova.star@example.test", password: PASSWORD } }),
    );
    expect(r.status).toBe(200);
    expect(r.body.account.kind).toBe("registered");
    expect(r.body.account.displayName).toBe("nova star");
  });

  it("validates input", async () => {
    const reg = (body: unknown, token?: string) =>
      call<ErrorBody>(w.env, req("/api/auth/register", { body, ...(token ? { token } : {}) }));
    expect((await reg({ email: "x", password: PASSWORD })).body.error.code).toBe("bad_email");
    expect((await reg({ email: "a@b.cd", password: "short" })).body.error.code).toBe(
      "weak_password",
    );
    expect(
      (await reg({ email: "a@b.cd", password: PASSWORD, displayName: "Guest-1" })).body.error.code,
    ).toBe("bad_name");
    expect((await reg([1, 2])).body.error.code).toBe("bad_request");
    const bad = await reg({ email: "a@b.cd", password: PASSWORD }, "garbage.token");
    expect(bad.status).toBe(401);
    const raw = await call<ErrorBody>(
      w.env,
      new Request("http://localhost:5173/api/auth/login", { method: "POST", body: "{" }),
    );
    expect(raw.body.error.code).toBe("bad_request");
  });

  it("refuses a taken email, also for another guest", async () => {
    const a = await guest(w.env);
    const b = await guest(w.env);
    const body = { email: "taken@example.test", password: PASSWORD };
    expect((await call(w.env, req("/api/auth/register", { token: a.token, body }))).status).toBe(
      200,
    );
    const second = await call<ErrorBody>(
      w.env,
      req("/api/auth/register", { token: b.token, body: { ...body, email: "TAKEN@example.test" } }),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("email_taken");
    // b stays a guest
    const me = await call<AccountView>(w.env, req("/api/me", { token: b.token }));
    expect(me.body.kind).toBe("guest");
  });

  it("logs in from a fresh guest to the same account; wrong passwords lock", async () => {
    const g = await guest(w.env);
    await call(
      w.env,
      req("/api/auth/register", {
        token: g.token,
        body: { email: "loop@example.test", password: PASSWORD },
      }),
    );
    const other = await guest(w.env);
    const ok = await call<AuthResponse>(
      w.env,
      req("/api/auth/login", {
        token: other.token,
        body: { email: "LOOP@example.test", password: PASSWORD },
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.account.accountId).toBe(g.accountId);
    // the other guest keeps its own account
    expect((await call<AccountView>(w.env, req("/api/me", { token: other.token }))).status).toBe(
      200,
    );

    const wrong = () =>
      call<ErrorBody>(
        w.env,
        req("/api/auth/login", {
          body: { email: "loop@example.test", password: "wrong-pass-123" },
        }),
      );
    for (let i = 0; i < 4; i++) {
      const r = await wrong();
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("bad_credentials");
    }
    const locked = await wrong();
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatchObject({ code: "locked", retryAfterMs: 60_000 });
    const unknown = await call<ErrorBody>(
      w.env,
      req("/api/auth/login", { body: { email: "nobody@example.test", password: PASSWORD } }),
    );
    expect(unknown.body.error.code).toBe("bad_credentials");
  });

  it("logout revokes the session token", async () => {
    const r = await call<AuthResponse>(
      w.env,
      req("/api/auth/register", { body: { email: "bye@example.test", password: PASSWORD } }),
    );
    const t = r.body.token;
    const second = await call<AuthResponse>(
      w.env,
      req("/api/auth/login", { body: { email: "bye@example.test", password: PASSWORD } }),
    );
    expect((await call(w.env, req("/api/auth/logout", { method: "POST", token: t }))).status).toBe(
      200,
    );
    expect((await call(w.env, req("/api/me", { token: t }))).status).toBe(401);
    // other sessions stay open
    expect((await call(w.env, req("/api/me", { token: second.body.token }))).status).toBe(200);
    expect((await call(w.env, req("/api/auth/logout", { method: "POST" }))).status).toBe(401);
  });

  it("changes the display name and returns a new token", async () => {
    const g = await guest(w.env);
    const n = await call<AuthResponse>(
      w.env,
      req("/api/account/name", { token: g.token, body: { displayName: "  Rune  Seeker " } }),
    );
    expect(n.status).toBe(200);
    expect(n.body.account.displayName).toBe("Rune Seeker");
    expect((await verifyToken(SECRET, n.body.token))?.name).toBe("Rune Seeker");
    const r = await call<AuthResponse>(
      w.env,
      req("/api/auth/register", {
        token: n.body.token,
        body: { email: "rune@example.test", password: PASSWORD },
      }),
    );
    expect(r.body.account.displayName).toBe("Rune Seeker");
    const bad = await call<ErrorBody>(
      w.env,
      req("/api/account/name", { token: r.body.token, body: { displayName: "Guest-9999" } }),
    );
    expect(bad.body.error.code).toBe("bad_name");
    expect(
      (await call(w.env, req("/api/account/name", { body: { displayName: "Abc" } }))).status,
    ).toBe(401);
  });

  it("rate-limits /api/auth/* per IP", async () => {
    setAuthLimiter(new IpLimiter({ burst: 2, perSecond: 0.001 }));
    const hit = (ip: string) =>
      call<ErrorBody>(w.env, req("/api/auth/providers", { headers: { "cf-connecting-ip": ip } }));
    expect((await hit("1.1.1.1")).status).toBe(200);
    expect((await hit("1.1.1.1")).status).toBe(200);
    const limited = await hit("1.1.1.1");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("locked");
    expect((await hit("2.2.2.2")).status).toBe(200);
  });
});
