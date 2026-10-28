/**
 * ADR 0007 R3 + R4 (findings 1, 2, 18): the OAuth link flow takes no account
 * from the URL, a link returns a sealed code that the SPA redeems with its own
 * bearer, every fragment carries the browser's nonce, and `?token=` only
 * authenticates WebSocket upgrades.
 */
import type { AccountView, AuthResponse, GuestResponse } from "@gamez/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { flowConfig } from "../../src/server/auth/flows.ts";
import { IpLimiter } from "../../src/server/auth/limiter.ts";
import { authenticateRequest } from "../../src/server/auth/session.ts";
import type { Env } from "../../src/server/contracts.ts";
import { authRoutes, setAuthLimiter } from "../../src/server/routes/auth.ts";
import { ctxFor, fakeWorld, req, type FakeWorld } from "./fakes.ts";

flowConfig.iterations = 1000;

const NONCE = "nonce-ABCDEFGHIJKLMNOP_123";

let w: FakeWorld;
beforeEach(() => {
  w = fakeWorld();
  setAuthLimiter(new IpLimiter({ burst: 1000, perSecond: 1000 }));
});
afterEach(() => {
  vi.useRealTimers();
});

async function route(env: Env, request: Request): Promise<Response> {
  const res = await authRoutes(ctxFor(env, request));
  if (!res) throw new Error(`not routed: ${request.url}`);
  return res;
}

async function guest(env: Env): Promise<GuestResponse> {
  return (await (await route(env, req("/api/guest", { method: "POST" }))).json()) as GuestResponse;
}

/** Fragment params of a redirect. */
function fragmentOf(res: Response): URLSearchParams {
  return new URLSearchParams(new URL(res.headers.get("location")!).hash.slice(1));
}

/**
 * Drives a browser through /start<query> -> stub page -> stub form -> callback
 * and returns the callback's redirect. Only the browser's cookie travels:
 * no bearer, like a cross-site top-level navigation.
 */
async function browserFlow(env: Env, query: string, subject: string): Promise<Response> {
  const start = await route(env, req(`/api/auth/oauth/google/start${query}`));
  expect(start.status).toBe(302);
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
  const stubUrl = new URL(start.headers.get("location")!);
  if (!stubUrl.pathname.endsWith("/stub")) return start;
  const posted = await route(
    env,
    new Request(stubUrl.origin + stubUrl.pathname, {
      method: "POST",
      body: new URLSearchParams({
        state: stubUrl.searchParams.get("state")!,
        code_challenge: stubUrl.searchParams.get("code_challenge")!,
        subject,
        email: "",
        name: "",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
  );
  expect(posted.status).toBe(303);
  return route(env, new Request(posted.headers.get("location")!, { headers: { cookie } }));
}

async function redeem(env: Env, code: string, token?: string): Promise<Response> {
  return route(env, req("/api/auth/oauth/link", { body: { code }, ...(token ? { token } : {}) }));
}

async function linkCode(env: Env, subject: string): Promise<string> {
  const cb = await browserFlow(env, `?n=${NONCE}&link=1`, subject);
  const code = fragmentOf(cb).get("oauth_link");
  expect(code).toBeTruthy();
  return code!;
}

describe("OAuth link CSRF (R3)", () => {
  it("a forged ?link=1&token=<attacker> start never binds the victim's login to the attacker", async () => {
    const attacker = await guest(w.env);
    const victim = await guest(w.env);
    const cb = await browserFlow(
      w.env,
      `?link=1&token=${encodeURIComponent(attacker.token)}&n=${NONCE}`,
      "victim-g",
    );
    const frag = fragmentOf(cb);
    // No session for anyone: a one-time link code the SPA must redeem itself.
    expect(frag.get("auth")).toBeNull();
    expect(frag.get("oauth_link")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(frag.get("n")).toBe(NONCE);
    // Nothing was claimed, and the attacker's account is untouched.
    expect(await w.env.IDENTITY.getByName("google:stub-victim-g").get()).toBeNull();
    const attackerMe = (await (
      await route(w.env, req("/api/me", { token: attacker.token }))
    ).json()) as AccountView;
    expect(attackerMe.kind).toBe("guest");
    expect(attackerMe.identities).toEqual([]);

    // The victim's SPA redeems the code with its own bearer: the login is the victim's.
    const res = await redeem(w.env, frag.get("oauth_link")!, victim.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuthResponse;
    expect(body.account.accountId).toBe(victim.accountId);
    expect(body.account.kind).toBe("registered");
    expect(body.account.identities).toEqual([{ provider: "google" }]);
    expect((await w.env.IDENTITY.getByName("google:stub-victim-g").get())?.accountId).toBe(
      victim.accountId,
    );
  });

  it("a link callback answers an oauth_link code and claims nothing until it is redeemed", async () => {
    const code = await linkCode(w.env, "pending");
    expect(await w.env.IDENTITY.getByName("google:stub-pending").get()).toBeNull();
    const g = await guest(w.env);
    const res = await redeem(w.env, code, g.token);
    expect(res.status).toBe(200);
    // The guest was upgraded in place; its guest token died with the upgrade.
    expect(((await res.json()) as AuthResponse).account.accountId).toBe(g.accountId);
    expect((await route(w.env, req("/api/me", { token: g.token }))).status).toBe(401);
  });

  it("redeeming needs a bearer: none, a bad one, or ?token= gives 401", async () => {
    const code = await linkCode(w.env, "nobody");
    expect((await redeem(w.env, code)).status).toBe(401);
    expect((await redeem(w.env, code, "nope")).status).toBe(401);
    const g = await guest(w.env);
    const viaQuery = await route(
      w.env,
      req(`/api/auth/oauth/link?token=${encodeURIComponent(g.token)}`, { body: { code } }),
    );
    expect(viaQuery.status).toBe(401);
    expect(await w.env.IDENTITY.getByName("google:stub-nobody").get()).toBeNull();
  });

  it("refuses an expired, tampered or foreign code", async () => {
    const g = await guest(w.env);
    const code = await linkCode(w.env, "late");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    const expired = await redeem(w.env, code, g.token);
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe("oauth_failed");
    vi.useRealTimers();

    const fresh = await linkCode(w.env, "tamper");
    const [payload, mac] = fresh.split(".") as [string, string];
    const tampered = `${payload.slice(0, 3)}${payload[3] === "A" ? "B" : "A"}${payload.slice(4)}`;
    expect((await redeem(w.env, `${tampered}.${mac}`, g.token)).status).toBe(400);
    // The state cookie is sealed with another key: it is not a link code.
    const start = await route(w.env, req(`/api/auth/oauth/google/start?n=${NONCE}&link=1`));
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!.slice("gz_oauth=".length);
    expect((await redeem(w.env, cookie, g.token)).status).toBe(400);
    expect((await redeem(w.env, "", g.token)).status).toBe(400);
    expect(await w.env.IDENTITY.getByName("google:stub-tamper").get()).toBeNull();
    expect(await w.env.IDENTITY.getByName("google:stub-late").get()).toBeNull();
    // The untouched code still works.
    expect((await redeem(w.env, fresh, g.token)).status).toBe(200);
  });

  it("a link to a login owned by another account is identity_taken", async () => {
    const owner = await guest(w.env);
    expect((await redeem(w.env, await linkCode(w.env, "shared"), owner.token)).status).toBe(200);
    const other = await guest(w.env);
    const res = await redeem(w.env, await linkCode(w.env, "shared"), other.token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("identity_taken");
  });
});

describe("fragment nonce (R4)", () => {
  it("every fragment carries the nonce the browser sent to /start", async () => {
    const login = fragmentOf(await browserFlow(w.env, `?n=${NONCE}&link=0`, "alice"));
    expect(login.get("auth")).toBeTruthy();
    expect(login.get("n")).toBe(NONCE);

    // A cancelled sign-in (error=access_denied with the right state and cookie).
    const start = await route(w.env, req(`/api/auth/oauth/google/start?n=${NONCE}`));
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cancelled = await route(
      w.env,
      new Request(
        `http://localhost:5173/api/auth/oauth/google/callback?error=access_denied&state=${state}`,
        { headers: { cookie } },
      ),
    );
    const err = fragmentOf(cancelled);
    expect(err.get("auth_error")).toBe("oauth_failed");
    expect(err.get("n")).toBe(NONCE);

    // A disabled provider answers at /start, with the nonce.
    const disabled = await route(
      w.env,
      req(`/api/auth/oauth/apple/start?n=${NONCE}`, { origin: "https://gamez.example.com" }),
    );
    expect(fragmentOf(disabled).get("auth_error")).toBe("provider_disabled");
    expect(fragmentOf(disabled).get("n")).toBe(NONCE);
  });

  it("/start refuses a missing or malformed nonce and sets no state cookie", async () => {
    for (const q of ["", "?n=short", `?n=${"x".repeat(65)}`, "?n=has%20space-0123456789"]) {
      const res = await route(w.env, req(`/api/auth/oauth/google/start${q}`));
      expect(res.status).toBe(302);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(fragmentOf(res).get("auth_error")).toBe("oauth_failed");
      expect(fragmentOf(res).get("n")).toBeNull();
    }
  });
});

describe("?token= is for WebSocket upgrades only (R3)", () => {
  it("a plain GET with ?token= is not authenticated", async () => {
    const g = await guest(w.env);
    const t = encodeURIComponent(g.token);
    expect((await route(w.env, req(`/api/me?token=${t}`))).status).toBe(401);
    expect((await route(w.env, req("/api/me", { token: g.token }))).status).toBe(200);
    const plain = new Request(`https://g.test/api/me?token=${t}`);
    expect(await authenticateRequest(plain, w.env)).toBeNull();
    const upgrade = new Request(`https://g.test/ws?token=${t}`, {
      headers: { Upgrade: "WebSocket" },
    });
    expect((await authenticateRequest(upgrade, w.env))?.accountId).toBe(g.accountId);
  });
});
