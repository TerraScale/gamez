import type { GuildMembership } from "../../src/server/contracts.ts";
import { describe, expect, it } from "vite-plus/test";
import { signToken } from "../../src/server/auth.ts";
import { CHAT_HEADERS } from "../../src/server/contracts.ts";
import {
  adminIds,
  adminRoute,
  chatAccess,
  chatRoutes,
  connectChat,
  type ChatAccessEnv,
} from "../../src/server/routes/chat.ts";

const SECRET = "chat-test-secret";
const MODES = [{ id: "classic" }, { id: "steps" }];

/** AccountDO stand-in: `guilds` maps an account to its guild membership. */
function accountNs(guilds: Record<string, GuildMembership | "throw">) {
  return {
    getByName(accountId: string) {
      return {
        // Guest sessions: the account was never registered (auth/session.ts checks it).
        profile: async () => null,
        guild: async (): Promise<GuildMembership | null> => {
          const g = guilds[accountId];
          if (g === "throw") throw new Error("AccountDO down");
          return g ?? null;
        },
      };
    },
  };
}

async function tokenFor(accountId: string, name = `name-${accountId}`): Promise<string> {
  return signToken(SECRET, { accountId, name, issuedAt: Date.now() });
}

function wsRequest(path: string, token?: string): { request: Request; url: URL } {
  const url = new URL(`https://game.test${path}`);
  if (token) url.searchParams.set("token", token);
  return {
    request: new Request(url, { headers: { Upgrade: "websocket" } }),
    url,
  };
}

const GUILD: GuildMembership = { guildId: "iron-wolves", tag: "IRW", role: "member" };

describe("chatAccess", () => {
  const env = (guilds: Record<string, GuildMembership | "throw"> = {}): ChatAccessEnv => ({
    AUTH_SECRET: SECRET,
    ACCOUNT: accountNs(guilds) as unknown as ChatAccessEnv["ACCOUNT"],
  });

  it("refuses an unauthenticated socket with 4401", async () => {
    const { request, url } = wsRequest("/ws/chat?channel=global");
    expect(await chatAccess(request, env(), url, MODES)).toEqual({
      ok: false,
      close: 4401,
      reason: "unauthorized",
    });
  });

  it("refuses a bad token", async () => {
    const { request, url } = wsRequest("/ws/chat?channel=global", "garbage.token");
    expect((await chatAccess(request, env(), url, MODES)).ok).toBe(false);
  });

  it("allows global for guests and tags the viewer with their guild tag", async () => {
    const token = await tokenFor("acc-member");
    const { request, url } = wsRequest("/ws/chat?channel=global", token);
    expect(await chatAccess(request, env({ "acc-member": GUILD }), url, MODES)).toEqual({
      ok: true,
      channel: "global",
      accountId: "acc-member",
      name: "name-acc-member",
      kind: "guest",
      tag: "IRW",
    });
    const guest = wsRequest("/ws/chat?channel=global", await tokenFor("acc-solo"));
    expect(await chatAccess(guest.request, env(), guest.url, MODES)).toMatchObject({
      ok: true,
      tag: null,
    });
  });

  it("allows a catalog mode channel and refuses unknown modes", async () => {
    const token = await tokenFor("acc-a");
    const ok = wsRequest("/ws/chat?channel=mode:classic", token);
    expect(await chatAccess(ok.request, env(), ok.url, MODES)).toMatchObject({
      ok: true,
      channel: "mode:classic",
    });
    const unknown = wsRequest("/ws/chat?channel=mode:nope", token);
    expect(await chatAccess(unknown.request, env(), unknown.url, MODES)).toEqual({
      ok: false,
      close: 4404,
      reason: "unknown channel",
    });
  });

  it("refuses malformed channels with 4404", async () => {
    const token = await tokenFor("acc-a");
    for (const channel of ["", "private", "guild:AB", "guild:bad name", "guild:"]) {
      const { request, url } = wsRequest(`/ws/chat?channel=${encodeURIComponent(channel)}`, token);
      expect(await chatAccess(request, env(), url, MODES)).toMatchObject({
        ok: false,
        close: 4404,
      });
    }
  });

  it("allows a guild channel only to members of that guild", async () => {
    const token = await tokenFor("acc-member");
    const member = wsRequest("/ws/chat?channel=guild:iron-wolves", token);
    expect(
      await chatAccess(member.request, env({ "acc-member": GUILD }), member.url, MODES),
    ).toMatchObject({ ok: true, channel: "guild:iron-wolves", tag: "IRW" });

    const other = wsRequest("/ws/chat?channel=guild:silver-owls", token);
    expect(await chatAccess(other.request, env({ "acc-member": GUILD }), other.url, MODES)).toEqual(
      { ok: false, close: 4403, reason: "not a member" },
    );

    const guest = wsRequest("/ws/chat?channel=guild:iron-wolves", await tokenFor("acc-guest"));
    expect(await chatAccess(guest.request, env(), guest.url, MODES)).toMatchObject({ close: 4403 });
  });

  it("refuses guild channels when the membership lookup fails", async () => {
    const token = await tokenFor("acc-member");
    const { request, url } = wsRequest("/ws/chat?channel=guild:iron-wolves", token);
    expect(await chatAccess(request, env({ "acc-member": "throw" }), url, MODES)).toMatchObject({
      ok: false,
      close: 4403,
    });
  });
});

describe("connectChat", () => {
  it("forwards an authorised upgrade to the channel DO with trusted headers", async () => {
    const token = await tokenFor("acc-member");
    const seen: { channel: string; headers: Headers }[] = [];
    const env = {
      AUTH_SECRET: SECRET,
      ACCOUNT: accountNs({ "acc-member": GUILD }) as unknown as ChatAccessEnv["ACCOUNT"],
      CHAT: {
        getByName(channel: string) {
          return {
            fetch: async (request: Request) => {
              seen.push({ channel, headers: request.headers });
              return new Response("forwarded", { status: 200 });
            },
          };
        },
      },
    } as unknown as Parameters<typeof connectChat>[1];
    const url = new URL(`https://game.test/ws/chat?channel=global&token=${token}`);
    const request = new Request(url, {
      headers: {
        Upgrade: "websocket",
        [CHAT_HEADERS.accountId]: "spoofed",
        [CHAT_HEADERS.tag]: "FAKE",
      },
    });
    const res = await connectChat(request, env, url, MODES);
    expect(await res.text()).toBe("forwarded");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.channel).toBe("global");
    expect(seen[0]!.headers.get(CHAT_HEADERS.accountId)).toBe("acc-member");
    expect(seen[0]!.headers.get(CHAT_HEADERS.name)).toBe("name-acc-member");
    expect(seen[0]!.headers.get(CHAT_HEADERS.channel)).toBe("global");
    expect(seen[0]!.headers.get(CHAT_HEADERS.kind)).toBe("guest");
    expect(seen[0]!.headers.get(CHAT_HEADERS.tag)).toBe("IRW");
  });

  it("answers plain HTTP with 426", async () => {
    const url = new URL("https://game.test/ws/chat?channel=global");
    const res = await connectChat(
      new Request(url),
      { AUTH_SECRET: SECRET, ACCOUNT: accountNs({}) as never, CHAT: {} as never },
      url,
      MODES,
    );
    expect(res.status).toBe(426);
  });
});

describe("admin API", () => {
  const ADMIN = "acc-admin";
  const env = (over: Record<string, unknown> = {}) => {
    const calls: { op: string; args: unknown[] }[] = [];
    const stub = {
      mute: async (...args: unknown[]) => void calls.push({ op: "mute", args }),
      hide: async (...args: unknown[]) => void calls.push({ op: "hide", args }),
    };
    return {
      calls,
      env: {
        AUTH_SECRET: SECRET,
        ACCOUNT: accountNs({}) as never,
        ADMIN_ACCOUNT_IDS: `${ADMIN}, other-admin`,
        CHAT: { getByName: (channel: string) => ({ ...stub, channel }) },
        DB: {
          prepare: (sql: string) => ({
            all: async () => ({ results: [{ sql: sql.includes("chat_report") ? "ok" : "no" }] }),
          }),
        },
        ...over,
      } as never,
    };
  };

  it("parses ADMIN_ACCOUNT_IDS", () => {
    expect([...adminIds({ ADMIN_ACCOUNT_IDS: " a,b ,, c" })]).toEqual(["a", "b", "c"]);
    expect(adminIds({}).size).toBe(0);
  });

  it("answers 401 without a token and 403 for other accounts", async () => {
    const { env: e } = env();
    const url = new URL("https://game.test/api/admin/reports");
    expect((await adminRoute(new Request(url), e, url, MODES)).status).toBe(401);
    const guestUrl = new URL("https://game.test/api/admin/reports");
    const guestReq = new Request(guestUrl, {
      headers: { authorization: `Bearer ${await tokenFor("acc-player")}` },
    });
    expect((await adminRoute(guestReq, e, guestUrl, MODES)).status).toBe(403);
  });

  it("lists the newest reports for admins", async () => {
    const { env: e } = env();
    const url = new URL("https://game.test/api/admin/reports");
    const req = new Request(url, { headers: { authorization: `Bearer ${await tokenFor(ADMIN)}` } });
    const res = await adminRoute(req, e, url, MODES);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reports: [{ sql: "ok" }] });
  });

  it("mutes a channel account for N minutes and hides messages", async () => {
    const { env: e, calls } = env();
    const token = await tokenFor(ADMIN);
    const mute = new URL("https://game.test/api/admin/mute");
    const res = await adminRoute(
      new Request(mute, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ channel: "global", accountId: "acc-bad", minutes: 30 }),
      }),
      e,
      mute,
      MODES,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; until: number };
    expect(body.ok).toBe(true);
    expect(calls[0]).toMatchObject({ op: "mute" });
    expect(calls[0]!.args[0]).toBe("acc-bad");
    expect(calls[0]!.args[1]).toBe(body.until);
    expect(calls[0]!.args[2]).toBe(`admin:${ADMIN}`);

    const hide = new URL("https://game.test/api/admin/hide");
    const hidden = await adminRoute(
      new Request(hide, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ channel: "mode:classic", ids: ["abc-1", "abc-2"] }),
      }),
      e,
      hide,
      MODES,
    );
    expect(hidden.status).toBe(200);
    expect(calls[1]).toEqual({ op: "hide", args: [["abc-1", "abc-2"], `admin:${ADMIN}`] });
  });

  it("validates the admin input", async () => {
    const { env: e } = env();
    const token = await tokenFor(ADMIN);
    const post = async (path: string, body: unknown) => {
      const url = new URL(`https://game.test${path}`);
      return adminRoute(
        new Request(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        e,
        url,
        MODES,
      );
    };
    expect(
      (await post("/api/admin/mute", { channel: "nowhere", accountId: "x", minutes: 5 })).status,
    ).toBe(400);
    expect(
      (await post("/api/admin/mute", { channel: "global", accountId: "x", minutes: 0 })).status,
    ).toBe(400);
    expect(
      (await post("/api/admin/mute", { channel: "global", accountId: "x", minutes: 1.5 })).status,
    ).toBe(400);
    expect((await post("/api/admin/hide", { channel: "global", ids: [] })).status).toBe(400);
    expect((await post("/api/admin/hide", { channel: "global", ids: [3] })).status).toBe(400);
  });

  it("answers 404 for unknown admin paths", async () => {
    const { env: e } = env();
    const url = new URL("https://game.test/api/admin/nope");
    const req = new Request(url, { headers: { authorization: `Bearer ${await tokenFor(ADMIN)}` } });
    expect((await adminRoute(req, e, url, MODES)).status).toBe(404);
  });
});

describe("chatRoutes", () => {
  it("leaves other paths to the next route", async () => {
    const url = new URL("https://game.test/api/leaderboards");
    const res = await chatRoutes({
      request: new Request(url),
      env: {} as never,
      url,
      ctx: {} as ExecutionContext,
    });
    expect(res).toBeNull();
  });
});
