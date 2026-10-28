import { describe, expect, it } from "vite-plus/test";
import type { AccountView, AuthResponse } from "@gamez/protocol";
import { createAuthApi } from "../../src/client/platform/auth.ts";
import { createAccountApi } from "../../src/client/platform/account.ts";
import { createGuildApi } from "../../src/client/platform/guilds.ts";
import { buildQuery, createHttp, errorFromBody, wsUrl } from "../../src/client/platform/http.ts";
import { createLeaderboardApi } from "../../src/client/platform/leaderboards.ts";
import { createPlatform } from "../../src/client/platform/index.ts";
import type { GuestSession } from "../../src/client/session.ts";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake fetch that answers with the queued responses in order and records each request. */
function fakeFetch(answers: Array<{ status?: number; body?: unknown; text?: string } | Error>) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    if (next instanceof Error) throw next;
    const status = next.status ?? 200;
    const text = next.text ?? (next.body === undefined ? "" : JSON.stringify(next.body));
    return new Response(text, {
      status,
      statusText: status === 200 ? "OK" : "Status",
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, sent };
}

const ACCOUNT: AccountView = {
  accountId: "acc-1",
  displayName: "Hero Mario",
  kind: "registered",
  identities: [{ provider: "email", email: "m@example.com" }],
  guildId: null,
  guildTag: null,
  createdAt: 1,
};

const GUILD = {
  id: "iron-wolves",
  name: "Iron Wolves",
  tag: "IRW",
  open: true,
  createdAt: 5,
  members: [{ accountId: "acc-1", displayName: "Hero Mario", role: "leader", joinedAt: 5 }],
};

/** Stored session + saver spy for the auth API. */
function authHarness(token = "guest-token") {
  const saved: GuestSession[] = [];
  return {
    saved,
    make(
      answers: Array<{ status?: number; body?: unknown } | Error>,
      extra: Partial<Parameters<typeof createAuthApi>[0]> = {},
    ) {
      const f = fakeFetch(answers);
      const http = createHttp({ token: () => token, fetch: f.fetch });
      const api = createAuthApi({
        http,
        token: () => token,
        saveSession: (s) => saved.push(s),
        newGuest: async () => ({ token: "fresh", accountId: "guest-2", name: "Guest-2" }),
        subscribe: () => () => {},
        ...extra,
      });
      return { api, sent: f.sent };
    },
  };
}

describe("http helpers", () => {
  it("builds query strings from defined, non-empty values only", () => {
    expect(buildQuery(undefined)).toBe("");
    expect(buildQuery({ a: undefined, b: null, c: "", d: 0 })).toBe("?d=0");
    expect(buildQuery({ board: "level", mode: "classic", limit: 50 })).toBe(
      "?board=level&mode=classic&limit=50",
    );
  });

  it("maps server error bodies and falls back to the status", () => {
    expect(
      errorFromBody(409, "Conflict", { error: { code: "email_taken", message: "Taken" } }),
    ).toEqual({
      code: "email_taken",
      message: "Taken",
    });
    expect(errorFromBody(500, "", undefined)).toEqual({
      code: "http_500",
      message: "Request failed (HTTP 500)",
    });
  });

  it("builds ws URLs on the origin's host with the scheme switched", () => {
    expect(
      wsUrl("https://game.example", "/ws/chat", { token: "a b", channel: "mode:classic" }),
    ).toBe("wss://game.example/ws/chat?token=a+b&channel=mode%3Aclassic");
    expect(wsUrl("http://localhost:5173", "/ws/chat", { token: "t", channel: "global" })).toBe(
      "ws://localhost:5173/ws/chat?token=t&channel=global",
    );
  });
});

describe("http client", () => {
  it("sends the bearer token and JSON body, and returns the parsed value", async () => {
    const f = fakeFetch([{ body: { ok: 1 } }]);
    const http = createHttp({ token: () => "tok", fetch: f.fetch });
    const res = await http.request<{ ok: number }>({
      method: "POST",
      path: "/api/x",
      body: { a: 1 },
      query: { q: "z" },
    });
    expect(res).toEqual({ ok: true, value: { ok: 1 } });
    expect(f.sent[0]).toMatchObject({
      url: "/api/x?q=z",
      method: "POST",
      body: { a: 1 },
    });
    expect(f.sent[0]?.headers.authorization).toBe("Bearer tok");
    expect(f.sent[0]?.headers["content-type"]).toBe("application/json");
  });

  it("sends no authorization header without a token", async () => {
    const f = fakeFetch([{ body: null }]);
    const http = createHttp({ token: () => null, fetch: f.fetch });
    await http.request({ method: "GET", path: "/api/me" });
    expect(f.sent[0]?.headers.authorization).toBeUndefined();
  });

  it("maps HTTP errors to {ok:false, code, message}", async () => {
    const f = fakeFetch([
      { status: 401, body: { error: { code: "unauthorized", message: "Sign in" } } },
    ]);
    const http = createHttp({ token: () => "t", fetch: f.fetch });
    expect(await http.request({ method: "GET", path: "/api/me" })).toEqual({
      ok: false,
      code: "unauthorized",
      message: "Sign in",
    });
  });

  it("maps a network failure to code network", async () => {
    const f = fakeFetch([new TypeError("fetch failed")]);
    const http = createHttp({ token: () => "t", fetch: f.fetch });
    const res = await http.request({ method: "GET", path: "/api/me" });
    expect(res).toMatchObject({ ok: false, code: "network" });
  });

  it("treats a non-JSON success body as an empty value", async () => {
    const f = fakeFetch([{ text: "<html>not json</html>" }]);
    const http = createHttp({ token: () => "t", fetch: f.fetch });
    const res = await http.request({ method: "GET", path: "/api/me" });
    expect(res).toEqual({ ok: true, value: undefined });
  });
});

describe("auth api", () => {
  it("register upgrades with the guest bearer and stores the new session", async () => {
    const h = authHarness("guest-token");
    const { api, sent } = h.make([
      { body: { token: "reg-token", account: ACCOUNT } as AuthResponse },
    ]);
    const res = await api.register("m@example.com", "correct horse battery", "Hero Mario");
    expect(res).toEqual({ ok: true, value: ACCOUNT });
    expect(sent[0]).toMatchObject({
      url: "/api/auth/register",
      method: "POST",
      body: {
        email: "m@example.com",
        password: "correct horse battery",
        displayName: "Hero Mario",
      },
    });
    expect(sent[0]?.headers.authorization).toBe("Bearer guest-token");
    expect(h.saved).toEqual([
      { token: "reg-token", accountId: "acc-1", name: "Hero Mario", kind: "registered" },
    ]);
  });

  it("rejects a short password without a request", async () => {
    const h = authHarness();
    const { api, sent } = h.make([]);
    const res = await api.register("m@example.com", "short");
    expect(res).toMatchObject({ ok: false, code: "weak_password" });
    expect(sent).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });

  it("maps a registration conflict and keeps the old session", async () => {
    const h = authHarness();
    const { api } = h.make([
      { status: 409, body: { error: { code: "email_taken", message: "Taken" } } },
    ]);
    expect(await api.register("m@example.com", "correct horse battery")).toEqual({
      ok: false,
      code: "email_taken",
      message: "Taken",
    });
    expect(h.saved).toHaveLength(0);
  });

  it("login stores the session returned by the server", async () => {
    const h = authHarness();
    const { api, sent } = h.make([{ body: { token: "login-token", account: ACCOUNT } }]);
    const res = await api.login("m@example.com", "correct horse battery");
    expect(res.ok).toBe(true);
    expect(sent[0]?.url).toBe("/api/auth/login");
    expect(h.saved[0]?.token).toBe("login-token");
  });

  it("login reports bad credentials without touching the session", async () => {
    const h = authHarness();
    const { api } = h.make([
      { status: 401, body: { error: { code: "bad_credentials", message: "No" } } },
    ]);
    expect(await api.login("m@example.com", "wrong")).toMatchObject({
      ok: false,
      code: "bad_credentials",
    });
    expect(h.saved).toHaveLength(0);
  });

  it("setDisplayName posts the trimmed name and stores the new token", async () => {
    const h = authHarness();
    const { api, sent } = h.make([
      { body: { token: "t2", account: { ...ACCOUNT, displayName: "Renamed" } } },
    ]);
    const res = await api.setDisplayName("  Renamed  ");
    expect(res.ok).toBe(true);
    expect(sent[0]).toMatchObject({
      url: "/api/account/name",
      method: "POST",
      body: { displayName: "Renamed" },
    });
    expect(h.saved[0]).toMatchObject({ token: "t2", name: "Renamed" });
  });

  it("setDisplayName checks the length before sending", async () => {
    const h = authHarness();
    const { api, sent } = h.make([]);
    expect(await api.setDisplayName("ab")).toMatchObject({ ok: false, code: "bad_name" });
    expect(sent).toHaveLength(0);
  });

  it("logout revokes the session, then stores a fresh guest", async () => {
    const h = authHarness();
    const { api, sent } = h.make([{ body: null }]);
    await api.logout();
    expect(sent[0]).toMatchObject({ url: "/api/auth/logout", method: "POST" });
    expect(h.saved).toEqual([{ token: "fresh", accountId: "guest-2", name: "Guest-2" }]);
  });

  it("logout still starts a fresh guest when the revoke request fails", async () => {
    const h = authHarness();
    const { api } = h.make([new TypeError("offline")]);
    await api.logout();
    expect(h.saved).toHaveLength(1);
  });

  it("builds OAuth URLs: link carries the token, login does not", () => {
    const h = authHarness("a+b/c");
    const { api } = h.make([]);
    expect(api.oauthUrl("google", { link: true })).toBe(
      "/api/auth/oauth/google/start?link=1&token=a%2Bb%2Fc",
    );
    expect(api.oauthUrl("discord", { link: false })).toBe("/api/auth/oauth/discord/start?link=0");
  });

  it("providers answers [] when the request fails", async () => {
    const h = authHarness();
    const { api } = h.make([{ status: 500 }]);
    expect(await api.providers()).toEqual([]);
  });

  it("providers returns the list", async () => {
    const h = authHarness();
    const providers = [{ id: "email", enabled: true, stub: false }];
    const { api, sent } = h.make([{ body: { providers } }]);
    expect(await api.providers()).toEqual(providers);
    expect(sent[0]?.url).toBe("/api/auth/providers");
  });

  it("me reads the account", async () => {
    const h = authHarness();
    const { api, sent } = h.make([{ body: ACCOUNT }]);
    expect(await api.me()).toEqual({ ok: true, value: ACCOUNT });
    expect(sent[0]).toMatchObject({ url: "/api/me", method: "GET" });
  });

  it("notifies through the injected subscription", () => {
    const h = authHarness();
    let calls = 0;
    const { api } = h.make([], {
      subscribe: (cb) => {
        cb();
        return () => {};
      },
    });
    api.onSessionChange(() => calls++);
    expect(calls).toBe(1);
  });
});

describe("leaderboards, guilds and account", () => {
  it("leaderboard query defaults the mode to classic and omits empty filters", async () => {
    const f = fakeFetch([
      { body: { board: "rift", mode: "classic", classId: null, rows: [], available: false } },
    ]);
    const api = createLeaderboardApi(createHttp({ token: () => "t", fetch: f.fetch }));
    const res = await api.fetch({ board: "rift", limit: 10 });
    expect(res.ok).toBe(true);
    expect(f.sent[0]?.url).toBe("/api/leaderboards?board=rift&mode=classic&limit=10");
  });

  it("leaderboard rejects a body without rows", async () => {
    const f = fakeFetch([{ body: { nope: true } }]);
    const api = createLeaderboardApi(createHttp({ token: () => "t", fetch: f.fetch }));
    expect(await api.fetch({ board: "level" })).toMatchObject({ ok: false, code: "bad_response" });
  });

  it("guild mine answers null when the account has no guild", async () => {
    const f = fakeFetch([{ body: null }]);
    const api = createGuildApi(createHttp({ token: () => "t", fetch: f.fetch }));
    expect(await api.mine()).toEqual({ ok: true, value: null });
    expect(f.sent[0]?.url).toBe("/api/guilds/mine");
  });

  it("guild list sends the search query and unwraps a guilds key", async () => {
    const summary = {
      id: "iron-wolves",
      name: "Iron Wolves",
      tag: "IRW",
      open: true,
      memberCount: 1,
    };
    const f = fakeFetch([{ body: { guilds: [summary] } }, { body: [summary] }]);
    const api = createGuildApi(createHttp({ token: () => "t", fetch: f.fetch }));
    expect(await api.list("  iron ")).toEqual({ ok: true, value: [summary] });
    expect(f.sent[0]?.url).toBe("/api/guilds?q=iron");
    expect(await api.list()).toEqual({ ok: true, value: [summary] });
    expect(f.sent[1]?.url).toBe("/api/guilds");
  });

  it("guild create posts the request and returns the guild", async () => {
    const f = fakeFetch([{ body: GUILD }]);
    const api = createGuildApi(createHttp({ token: () => "t", fetch: f.fetch }));
    const res = await api.create({ name: "Iron Wolves", tag: "IRW", open: true });
    expect(res).toEqual({ ok: true, value: GUILD });
    expect(f.sent[0]).toMatchObject({
      url: "/api/guilds",
      method: "POST",
      body: { name: "Iron Wolves", tag: "IRW", open: true },
    });
  });

  it("guild join encodes the id, leave and kick send their routes", async () => {
    const f = fakeFetch([{ body: GUILD }, { body: {} }, { body: GUILD }]);
    const api = createGuildApi(createHttp({ token: () => "t", fetch: f.fetch }));
    expect(await api.join("iron wolves")).toEqual({ ok: true, value: GUILD });
    expect(f.sent[0]?.url).toBe("/api/guilds/iron%20wolves/join");
    expect(await api.leave()).toEqual({ ok: true, value: null });
    expect(f.sent[1]?.url).toBe("/api/guilds/leave");
    expect(await api.kick("acc-2")).toEqual({ ok: true, value: GUILD });
    expect(f.sent[2]).toMatchObject({ url: "/api/guilds/kick", body: { accountId: "acc-2" } });
  });

  it("guild errors pass through with their codes", async () => {
    const f = fakeFetch([
      { status: 403, body: { error: { code: "guest_forbidden", message: "Sign up" } } },
    ]);
    const api = createGuildApi(createHttp({ token: () => "t", fetch: f.fetch }));
    expect(await api.create({ name: "Iron Wolves", tag: "IRW", open: true })).toEqual({
      ok: false,
      code: "guest_forbidden",
      message: "Sign up",
    });
  });

  it("account wallet and cosmetics use their routes", async () => {
    const f = fakeFetch([
      { body: { balances: { coin: 10, gem: 0 } } },
      { body: { owned: [], equipped: {} } },
    ]);
    const api = createAccountApi(createHttp({ token: () => "t", fetch: f.fetch }));
    expect(await api.wallet()).toEqual({ ok: true, value: { balances: { coin: 10, gem: 0 } } });
    expect(await api.cosmetics()).toEqual({ ok: true, value: { owned: [], equipped: {} } });
    expect(f.sent.map((s) => s.url)).toEqual(["/api/account/wallet", "/api/account/cosmetics"]);
  });
});

describe("createPlatform", () => {
  it("returns every service and sends the session token", async () => {
    const f = fakeFetch([{ body: ACCOUNT }]);
    const platform = createPlatform(() => ({ token: "sess", accountId: "acc-1", name: "x" }), {
      fetch: f.fetch,
      origin: "http://localhost",
      WebSocket: class {
        constructor() {
          throw new Error("no sockets in this test");
        }
      } as never,
    });
    expect(platform).toBeDefined();
    if (!platform) return;
    expect(Object.keys(platform).sort()).toEqual([
      "account",
      "arena",
      "auth",
      "chat",
      "config",
      "guilds",
      "leaderboards",
      "market",
      "pass",
      "shops",
      "store",
      "trade",
      "vault",
    ]);
    await platform.auth.me();
    expect(f.sent[0]?.headers.authorization).toBe("Bearer sess");
  });
});
