import type { AccountView, AuthResponse, GuestResponse } from "@gamez/protocol";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { verifyToken } from "../../src/server/auth.ts";
import { flowConfig } from "../../src/server/auth/flows.ts";
import { IpLimiter } from "../../src/server/auth/limiter.ts";
import { exchangeCode, providerMode } from "../../src/server/auth/oauth/providers.ts";
import {
  checkCallbackState,
  newOAuthState,
  OAUTH_COOKIE,
  openState,
  pkceChallenge,
  readCookie,
  sealState,
} from "../../src/server/auth/oauth/state.ts";
import { decodeStubCode, encodeStubCode, stubPage } from "../../src/server/auth/oauth/stub.ts";
import type { Env } from "../../src/server/contracts.ts";
import { isDevHost } from "../../src/server/http.ts";
import { authRoutes, setAuthLimiter } from "../../src/server/routes/auth.ts";
import { ctxFor, fakeWorld, req, SECRET, type FakeWorld } from "./fakes.ts";

flowConfig.iterations = 1000;

/** The browser's fragment nonce (ADR 0007 R4). */
const NONCE = "test-nonce-0123456789abcdef";

let w: FakeWorld;
beforeEach(() => {
  w = fakeWorld();
  setAuthLimiter(new IpLimiter({ burst: 1000, perSecond: 1000 }));
});

async function route(env: Env, request: Request): Promise<Response> {
  const res = await authRoutes(ctxFor(env, request));
  if (!res) throw new Error("not routed");
  return res;
}

async function guest(env: Env): Promise<GuestResponse> {
  return (await (await route(env, req("/api/guest", { method: "POST" }))).json()) as GuestResponse;
}

/**
 * Walks start -> stub page -> stub form -> callback like a browser; returns the final fragment.
 * A link flow (`link` = the SPA's bearer) then redeems the #oauth_link code with
 * POST /api/auth/oauth/link, and its outcome is reported as `auth=` / `auth_error=`.
 */
async function stubFlow(
  env: Env,
  provider: string,
  opts: { subject: string; email?: string; name?: string; link?: string; origin?: string },
): Promise<{ fragment: string; start: Response; callback: Response }> {
  const origin = opts.origin ?? "http://localhost:5173";
  const q = `?n=${NONCE}&link=${opts.link ? 1 : 0}`;
  const start = await route(env, req(`/api/auth/oauth/${provider}/start${q}`, { origin }));
  expect(start.status).toBe(302);
  const setCookie = start.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]!;
  const stubUrl = new URL(start.headers.get("location")!);
  if (!stubUrl.pathname.endsWith("/stub")) {
    return { fragment: new URL(stubUrl).hash.slice(1), start, callback: start };
  }
  const page = await route(env, new Request(stubUrl));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const form = new URLSearchParams({
    state: stubUrl.searchParams.get("state")!,
    code_challenge: stubUrl.searchParams.get("code_challenge")!,
    subject: opts.subject,
    email: opts.email ?? "",
    name: opts.name ?? "",
  });
  const posted = await route(
    env,
    new Request(stubUrl.origin + stubUrl.pathname, {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
  );
  expect(posted.status).toBe(303);
  const callbackUrl = posted.headers.get("location")!;
  const callback = await route(env, new Request(callbackUrl, { headers: { cookie } }));
  expect(callback.status).toBe(302);
  expect(callback.headers.get("set-cookie")).toContain("Max-Age=0");
  const fragment = new URL(callback.headers.get("location")!).hash.slice(1);
  const params = new URLSearchParams(fragment);
  expect(params.get("n")).toBe(NONCE);
  if (!opts.link) return { fragment, start, callback };
  const code = params.get("oauth_link");
  expect(code).toBeTruthy();
  const redeemed = await route(
    env,
    req("/api/auth/oauth/link", { origin, token: opts.link, body: { code } }),
  );
  const body = (await redeemed.json()) as AuthResponse & { error?: { code: string } };
  return {
    fragment: redeemed.ok
      ? `auth=${encodeURIComponent(body.token)}`
      : `auth_error=${body.error?.code ?? "?"}`,
    start,
    callback,
  };
}

function tokenOf(fragment: string): string {
  const token = new URLSearchParams(fragment).get("auth");
  expect(token).toBeTruthy();
  return token!;
}

describe("state cookie and PKCE", () => {
  it("computes the RFC 7636 S256 challenge", async () => {
    // RFC 7636 appendix B example.
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("seals, opens and checks the state", async () => {
    const st = newOAuthState({
      provider: "google",
      stub: true,
      link: false,
      nonce: NONCE,
      redirectUri: "http://localhost/api/auth/oauth/google/callback",
      now: 1000,
    });
    expect(st.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sealed = await sealState(SECRET, st);
    expect(await openState(SECRET, sealed, 1000)).toEqual(st);
    expect(await openState("other", sealed, 1000)).toBeNull();
    expect(await openState(SECRET, sealed, 1000 + 10 * 60_000 + 1)).toBeNull();
    expect(await checkCallbackState(SECRET, sealed, "google", st.state, 1000)).toEqual(st);
    expect(await checkCallbackState(SECRET, sealed, "discord", st.state, 1000)).toBeNull();
    expect(await checkCallbackState(SECRET, sealed, "google", "nope", 1000)).toBeNull();
    expect(await checkCallbackState(SECRET, null, "google", st.state, 1000)).toBeNull();
    // A session token signed with AUTH_SECRET is not a valid cookie (separate key).
    const { signValue } = await import("../../src/server/auth.ts");
    expect(await openState(SECRET, await signValue(SECRET, st), 1000)).toBeNull();
  });

  it("parses cookies", () => {
    expect(readCookie("a=1; gz_oauth=abc.def; b=2", OAUTH_COOKIE)).toBe("abc.def");
    expect(readCookie("a=1", OAUTH_COOKIE)).toBeNull();
    expect(readCookie(null, OAUTH_COOKIE)).toBeNull();
  });

  it("sets an HttpOnly SameSite=Lax 10-minute cookie, Secure on https", async () => {
    const dev = await route(w.env, req(`/api/auth/oauth/google/start?n=${NONCE}&link=0`));
    const c = dev.headers.get("set-cookie")!;
    expect(c).toMatch(
      /^gz_oauth=[^;]+; Path=\/api\/auth\/oauth; Max-Age=600; HttpOnly; SameSite=Lax$/,
    );
    const live = fakeWorld({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs" });
    const prod = await route(
      live.env,
      req(`/api/auth/oauth/google/start?n=${NONCE}&link=0`, {
        origin: "https://gamez.example.com",
      }),
    );
    expect(prod.headers.get("set-cookie")).toMatch(/; Secure$/);
  });
});

describe("provider modes (stub host rule)", () => {
  it("uses the stub only on dev hosts when a provider is unconfigured", () => {
    const local = new URL("http://localhost:5173/");
    const tailnet = new URL("https://box.tail1234.ts.net/");
    const prod = new URL("https://gamez.example.com/");
    const dev = { DEV_ROUTES_ENABLED: "1" };
    expect(providerMode("google", dev, local)).toBe("stub");
    expect(providerMode("google", dev, tailnet)).toBe("stub");
    expect(providerMode("google", dev, new URL("http://127.0.0.1:5302/"))).toBe("stub");
    expect(providerMode("google", dev, prod)).toBe("disabled");
    expect(providerMode("google", { ...dev, OAUTH_STUB: "1" }, prod)).toBe("stub");
    expect(providerMode("google", { ...dev, OAUTH_STUB: "0" }, local)).toBe("disabled");
    expect(providerMode("google", { ...dev, GOOGLE_CLIENT_ID: "x" }, prod)).toBe("disabled");
    expect(
      providerMode("google", { GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" }, local),
    ).toBe("real");
    expect(providerMode("apple", { ...dev, APPLE_CLIENT_ID: "x" }, prod)).toBe("disabled");
    expect(providerMode("apple", dev, local)).toBe("stub");
    expect(isDevHost(new URL("https://evil-localhost.com/"), dev)).toBe(false);
    expect(isDevHost(new URL("https://ts.net.evil.com/"), dev)).toBe(false);
  });

  it("never uses the stub without DEV_ROUTES_ENABLED=1, on any host (tailnet included)", () => {
    for (const host of ["http://localhost:5173/", "https://box.tail1234.ts.net/"]) {
      const url = new URL(host);
      expect(providerMode("google", {}, url)).toBe("disabled");
      expect(providerMode("google", { OAUTH_STUB: "1" }, url)).toBe("disabled");
      expect(providerMode("apple", { DEV_ROUTES_ENABLED: "0" }, url)).toBe("disabled");
      expect(isDevHost(url, {})).toBe(false);
      expect(isDevHost(url, { OAUTH_STUB: "1" })).toBe(false);
      expect(isDevHost(url, { DEV_ROUTES_ENABLED: "true" })).toBe(false);
    }
    expect(isDevHost(new URL("https://gamez.example.com/"), { OAUTH_STUB: "1" })).toBe(false);
  });

  it("refuses the stub page and flows on production hosts", async () => {
    const origin = "https://gamez.example.com";
    const start = await route(w.env, req("/api/auth/oauth/apple/start", { origin }));
    expect(start.headers.get("location")).toBe(`${origin}/#auth_error=provider_disabled`);
    const page = await route(
      w.env,
      req("/api/auth/oauth/google/stub?state=abcdefgh&code_challenge=abcdefghijklmnop", { origin }),
    );
    expect(page.status).toBe(404);
    const cb = await route(
      w.env,
      req("/api/auth/oauth/google/callback?code=stub:x&state=y", { origin }),
    );
    expect(cb.headers.get("location")).toBe(`${origin}/#auth_error=provider_disabled`);
    expect((await route(w.env, req("/api/auth/oauth/github/start"))).status).toBe(404);
  });
});

describe("OAuth stub flow", () => {
  it("signs up with a new account, then signs in to the same one", async () => {
    const first = await stubFlow(w.env, "google", {
      subject: "alice",
      email: "Alice@Example.test",
      name: "Alice Ember",
    });
    const t1 = tokenOf(first.fragment);
    const p1 = await verifyToken(SECRET, t1);
    expect(p1).toMatchObject({ kind: "registered", name: "Alice Ember" });
    const me = (await (await route(w.env, req("/api/me", { token: t1 }))).json()) as AccountView;
    expect(me.identities).toEqual([{ provider: "google", email: "alice@example.test" }]);
    const second = await stubFlow(w.env, "google", { subject: "alice" });
    expect((await verifyToken(SECRET, tokenOf(second.fragment)))?.accountId).toBe(p1?.accountId);
    expect(w.identities.has("google:stub-alice")).toBe(true);
  });

  it("links to a guest in place, and refuses a login owned by someone else", async () => {
    const g = await guest(w.env);
    const linked = await stubFlow(w.env, "discord", { subject: "d-42", link: g.token });
    const t = tokenOf(linked.fragment);
    expect(await verifyToken(SECRET, t)).toMatchObject({
      accountId: g.accountId,
      kind: "registered",
    });
    // the guest token died with the upgrade
    expect((await route(w.env, req("/api/me", { token: g.token }))).status).toBe(401);

    const other = await guest(w.env);
    const taken = await stubFlow(w.env, "discord", { subject: "d-42", link: other.token });
    expect(taken.fragment).toBe("auth_error=identity_taken");
    const otherMe = (await (
      await route(w.env, req("/api/me", { token: other.token }))
    ).json()) as AccountView;
    expect(otherMe.kind).toBe("guest");

    // A registered account links a second provider and keeps its session.
    const again = await stubFlow(w.env, "google", { subject: "g-42", link: t });
    const t2 = tokenOf(again.fragment);
    expect((await verifyToken(SECRET, t2))?.sid).toBe((await verifyToken(SECRET, t))?.sid);
    const me = (await (await route(w.env, req("/api/me", { token: t2 }))).json()) as AccountView;
    expect(me.identities.map((i) => i.provider)).toEqual(["discord", "google"]);
  });

  it("link mode reads no token at /start; the redeem needs a valid bearer (ADR 0007 R3)", async () => {
    const start = await route(
      w.env,
      req(`/api/auth/oauth/google/start?n=${NONCE}&link=1&token=nope`),
    );
    expect(new URL(start.headers.get("location")!).pathname).toBe("/api/auth/oauth/google/stub");
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!.slice("gz_oauth=".length);
    const st = await openState(SECRET, cookie);
    expect(st).toMatchObject({ link: true, nonce: NONCE });
    expect(JSON.stringify(st)).not.toContain("nope");
    const redeem = await route(w.env, req("/api/auth/oauth/link", { token: "nope", body: {} }));
    expect(redeem.status).toBe(401);
  });

  it("an email account can register after OAuth on the same account", async () => {
    const t = tokenOf((await stubFlow(w.env, "apple", { subject: "apl" })).fragment);
    const r = await route(
      w.env,
      req("/api/auth/register", {
        token: t,
        body: { email: "apl@example.test", password: "correct-horse-battery-9" },
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as AuthResponse;
    expect(body.account.identities.map((i) => i.provider)).toEqual(["apple", "email"]);
  });

  it("rejects a missing or forged cookie, a wrong state and a PKCE mismatch", async () => {
    const start = await route(w.env, req(`/api/auth/oauth/google/start?n=${NONCE}`));
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const loc = new URL(start.headers.get("location")!);
    const state = loc.searchParams.get("state")!;
    const challenge = loc.searchParams.get("code_challenge")!;
    const good = encodeStubCode({ sub: "mallory", email: null, name: null, cc: challenge });
    const cb = (q: string, c?: string) =>
      route(
        w.env,
        new Request(`http://localhost:5173/api/auth/oauth/google/callback?${q}`, {
          headers: c ? { cookie: c } : {},
        }),
      );
    const frag = (r: Response) => new URL(r.headers.get("location")!).hash;
    const q = (code: string, s = state) =>
      `code=${encodeURIComponent(code)}&state=${encodeURIComponent(s)}`;
    expect(frag(await cb(q(good)))).toBe("#auth_error=oauth_failed");
    expect(frag(await cb(q(good, "other-state"), cookie))).toBe("#auth_error=oauth_failed");
    expect(frag(await cb(q(good), `${cookie}x`))).toBe("#auth_error=oauth_failed");
    const wrongPkce = encodeStubCode({
      sub: "mallory",
      email: null,
      name: null,
      cc: "A".repeat(43),
    });
    // With a valid state the flow's nonce is known and echoed.
    expect(frag(await cb(q(wrongPkce), cookie))).toBe(`#auth_error=oauth_failed&n=${NONCE}`);
    expect(frag(await cb(`error=access_denied&state=${state}`, cookie))).toBe(
      `#auth_error=oauth_failed&n=${NONCE}`,
    );
    // Another provider's callback with this cookie fails too.
    const discord = await route(
      w.env,
      new Request(`http://localhost:5173/api/auth/oauth/discord/callback?${q(good)}`, {
        headers: { cookie },
      }),
    );
    expect(frag(discord)).toBe("#auth_error=oauth_failed");
    // The honest callback works.
    expect(frag(await cb(q(good), cookie))).toMatch(new RegExp(`^#auth=[^&]+&n=${NONCE}$`));
  });

  it("validates stub codes and form fields", async () => {
    expect(decodeStubCode("nope")).toBeNull();
    expect(decodeStubCode("stub:!!!")).toBeNull();
    const cc = "c".repeat(43);
    expect(decodeStubCode(encodeStubCode({ sub: "ok", email: null, name: null, cc }))).toEqual({
      sub: "ok",
      email: null,
      name: null,
      cc,
    });
    expect(decodeStubCode(encodeStubCode({ sub: "bad sub", email: null, name: null, cc }))).toBe(
      null,
    );
    expect(
      decodeStubCode(encodeStubCode({ sub: "ok", email: "not-an-email", name: null, cc })),
    ).toBeNull();
    const bad = await route(
      w.env,
      new Request("http://localhost:5173/api/auth/oauth/google/stub", {
        method: "POST",
        body: new URLSearchParams({
          state: "abcdefghij",
          code_challenge: cc,
          subject: "<script>",
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(bad.status).toBe(400);
    const html = await bad.text();
    expect(html).not.toContain("<script>");
    expect(bad.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("real providers", () => {
  it("sends Google to its authorize endpoint with PKCE S256", async () => {
    const live = fakeWorld({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gs" });
    const res = await route(
      live.env,
      req(`/api/auth/oauth/google/start?n=${NONCE}&link=0`, {
        origin: "https://gamez.example.com",
      }),
    );
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({
      client_id: "gid",
      redirect_uri: "https://gamez.example.com/api/auth/oauth/google/callback",
      response_type: "code",
      scope: "openid email profile",
      code_challenge_method: "S256",
    });
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!.slice("gz_oauth=".length);
    const st = await openState(SECRET, cookie);
    expect(st?.stub).toBe(false);
    expect(loc.searchParams.get("code_challenge")).toBe(await pkceChallenge(st!.verifier));
    expect(loc.searchParams.get("state")).toBe(st!.state);
  });

  it("sends Discord to its authorize endpoint", async () => {
    const live = fakeWorld({ DISCORD_CLIENT_ID: "did", DISCORD_CLIENT_SECRET: "ds" });
    const res = await route(
      live.env,
      req(`/api/auth/oauth/discord/start?n=${NONCE}`, { origin: "https://gamez.example.com" }),
    );
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(loc.searchParams.get("scope")).toBe("identify email");
  });

  it("exchanges the code with the verifier and keeps only verified emails", async () => {
    const seen: { url: string; body: string; auth: string }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      seen.push({
        url,
        body: init?.body instanceof URLSearchParams ? init.body.toString() : "",
        auth: new Headers(init?.headers).get("authorization") ?? "",
      });
      if (url.includes("token")) return Response.json({ access_token: "at-1" });
      if (url.includes("userinfo")) {
        return Response.json({ sub: "g-sub", email: "x@y.zz", email_verified: false, name: "X" });
      }
      return Response.json({ id: "d-id", username: "dd", email: "d@y.zz", verified: true });
    }) as typeof fetch;
    const env = {
      GOOGLE_CLIENT_ID: "gid",
      GOOGLE_CLIENT_SECRET: "gs",
      DISCORD_CLIENT_ID: "did",
      DISCORD_CLIENT_SECRET: "ds",
    };
    const g = await exchangeCode(
      "google",
      env,
      { code: "c1", verifier: "v1", redirectUri: "https://h/cb" },
      fakeFetch,
    );
    expect(g).toEqual({ subject: "g-sub", email: null, name: "X" });
    const body = new URLSearchParams(seen[0]!.body);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "c1",
      redirect_uri: "https://h/cb",
      client_id: "gid",
      client_secret: "gs",
      code_verifier: "v1",
    });
    expect(seen[1]!.auth).toBe("Bearer at-1");
    const d = await exchangeCode(
      "discord",
      env,
      { code: "c2", verifier: "v2", redirectUri: "https://h/cb" },
      fakeFetch,
    );
    expect(d).toEqual({ subject: "d-id", email: "d@y.zz", name: "dd" });
    const failing = (async () => new Response("no", { status: 400 })) as typeof fetch;
    await expect(
      exchangeCode("google", env, { code: "c", verifier: "v", redirectUri: "r" }, failing),
    ).rejects.toThrow();
  });
});

describe("stub authorize page", () => {
  it("uses a subject pattern that compiles with the v flag, as browsers do (QA wave B)", async () => {
    const res = stubPage("google", { state: "s", challenge: "c" });
    const html = await res.text();
    const pattern = /pattern="([^"]+)"/.exec(html)?.[1];
    expect(pattern).toBeDefined();
    // Browsers compile `pattern` as ^(?:<pattern>)$ with the v flag.
    const re = new RegExp(`^(?:${pattern})$`, "v");
    expect(re.test("tester-ab_c.d@e")).toBe(true);
    expect(re.test("has space")).toBe(false);
  });
});
