import { describe, expect, it } from "vite-plus/test";
import type { ReportReason } from "@gamez/protocol";
import type {
  AccountView,
  ApiResult,
  AuthApi,
  ChatChannelClient,
  ChatChannelView,
  GuildApi,
  GuildInfo,
  GuildSummary,
  LeaderboardApi,
  LeaderboardResponse,
} from "../src/platform.ts";
import {
  checkCreateGuild,
  checkRegister,
  createGuild,
  guildJoinBlock,
  leaderboardQuery,
  linkedProviders,
  loadGuildList,
  loadLeaderboard,
  loginAccount,
  oauthProviders,
  registerAccount,
  saveDisplayName,
  sendChat,
} from "../src/social/flows.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function chatClient(sendResult: ApiResult<{ id: string }> = { ok: true, value: { id: "m1" } }) {
  const sent: string[] = [];
  const reports: { id: string; reason: ReportReason }[] = [];
  const blocks: { accountId: string; blocked: boolean }[] = [];
  const view: ChatChannelView = {
    channel: "global",
    status: "online",
    messages: [],
    mutedUntil: null,
    blocked: [],
    error: null,
  };
  const client: ChatChannelClient = {
    channel: "global",
    getView: () => view,
    subscribe: () => () => {},
    send: async (text) => {
      sent.push(text);
      return sendResult;
    },
    report: (id, reason) => {
      reports.push({ id, reason });
    },
    block: (accountId, blocked) => {
      blocks.push({ accountId, blocked });
    },
    close: () => {},
  };
  return { client, sent, reports, blocks };
}

const account = (over: Partial<AccountView> = {}): AccountView => ({
  accountId: "acc-1",
  displayName: "Hero",
  kind: "registered",
  identities: [{ provider: "email", email: "hero@example.com" }],
  guildId: null,
  guildTag: null,
  createdAt: 1,
  ...over,
});

function authFake(over: Partial<AuthApi> = {}): AuthApi & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const base: AuthApi & { calls: unknown[][] } = {
    calls,
    me: async () => ({ ok: true, value: account() }),
    providers: async () => [],
    register: async (...args) => {
      calls.push(["register", ...args]);
      return { ok: true, value: account() };
    },
    login: async (...args) => {
      calls.push(["login", ...args]);
      return { ok: true, value: account() };
    },
    logout: async () => {},
    oauthUrl: (provider, opts) => `/api/auth/${provider}?link=${opts.link ? 1 : 0}`,
    setDisplayName: async (name) => {
      calls.push(["setDisplayName", name]);
      return { ok: true, value: account({ displayName: name }) };
    },
    onSessionChange: () => () => {},
  };
  return { ...base, ...over, calls };
}

const guildInfo: GuildInfo = {
  id: "iron-wolves",
  name: "Iron Wolves",
  tag: "IRW",
  open: true,
  createdAt: 1,
  members: [{ accountId: "acc-1", displayName: "Hero", role: "leader", joinedAt: 1 }],
};

function guildFake(over: Partial<GuildApi> = {}): GuildApi & { created: unknown[] } {
  const created: unknown[] = [];
  return {
    created,
    mine: async () => ({ ok: true, value: null }),
    list: async () => ({ ok: true, value: [] }),
    get: async () => ({ ok: true, value: guildInfo }),
    create: async (req) => {
      created.push(req);
      return { ok: true, value: guildInfo };
    },
    join: async () => ({ ok: true, value: guildInfo }),
    leave: async () => ({ ok: true, value: null }),
    kick: async () => ({ ok: true, value: guildInfo }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

describe("sendChat", () => {
  it("trims and sends the text, returning the ack", async () => {
    const { client, sent } = chatClient();
    const r = await sendChat(client, "  hello there  ");
    expect(r).toEqual({ ok: true, value: { id: "m1" } });
    expect(sent).toEqual(["hello there"]);
  });

  it("refuses blank text without calling the socket", async () => {
    const { client, sent } = chatClient();
    const r = await sendChat(client, "   ");
    expect(r).toMatchObject({ ok: false, code: "empty" });
    expect(sent).toEqual([]);
  });

  it("refuses over-long text without calling the socket", async () => {
    const { client, sent } = chatClient();
    const r = await sendChat(client, "x".repeat(281));
    expect(r).toMatchObject({ ok: false, code: "too_long" });
    expect(sent).toEqual([]);
  });

  it("passes a server rejection through unchanged (rate limit)", async () => {
    const { client } = chatClient({ ok: false, code: "rate_limited", message: "slow" });
    const r = await sendChat(client, "again");
    expect(r).toEqual({ ok: false, code: "rate_limited", message: "slow" });
  });
});

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

describe("leaderboard queries", () => {
  it("omits classId for 'All classes' and includes it otherwise", () => {
    expect(leaderboardQuery("level", "classic", "")).toEqual({
      board: "level",
      mode: "classic",
      limit: 50,
    });
    expect(leaderboardQuery("depth", "classic", "classic.class.warrior")).toEqual({
      board: "depth",
      mode: "classic",
      classId: "classic.class.warrior",
      limit: 50,
    });
  });

  it("calls the API with the query and reads the rows", async () => {
    const seen: unknown[] = [];
    const response: LeaderboardResponse = {
      board: "rift",
      mode: "classic",
      classId: null,
      available: true,
      rows: [
        {
          rank: 1,
          accountId: "acc-1",
          displayName: "Hero",
          heroName: "Brann",
          classId: "classic.class.warrior",
          heroLevel: 12,
          value: 900,
          extra: {},
          imported: false,
          updatedAt: 1,
        },
      ],
    };
    const api: LeaderboardApi = {
      fetch: async (q) => {
        seen.push(q);
        return { ok: true, value: response };
      },
    };
    const state = await loadLeaderboard(api, leaderboardQuery("rift", "classic", ""));
    expect(seen).toEqual([{ board: "rift", mode: "classic", limit: 50 }]);
    expect(state).toEqual({ status: "ready", response });
  });

  it("reports warming up when the read model is not migrated yet", async () => {
    const api: LeaderboardApi = {
      fetch: async () => ({
        ok: true,
        value: { board: "level", mode: "classic", classId: null, rows: [], available: false },
      }),
    };
    expect(await loadLeaderboard(api, { board: "level" })).toEqual({ status: "warming" });
  });

  it("returns the error message on failure", async () => {
    const api: LeaderboardApi = {
      fetch: async () => ({ ok: false, code: "internal", message: "Down for a moment" }),
    };
    expect(await loadLeaderboard(api, { board: "level" })).toEqual({
      status: "error",
      message: "Down for a moment",
    });
  });
});

// ---------------------------------------------------------------------------
// Guilds
// ---------------------------------------------------------------------------

describe("guild flows", () => {
  it("validates the create form before any request", async () => {
    const guilds = guildFake();
    const r = await createGuild(guilds, { name: "A", tag: "ok", open: true });
    expect(r).toMatchObject({ ok: false, code: "bad_request" });
    expect(guilds.created).toEqual([]);
    expect(checkCreateGuild({ name: "Iron Wolves", tag: "T", open: true })).toMatch(/Tags/);
    expect(checkCreateGuild({ name: "Iron Wolves", tag: "IRW", open: false })).toBeNull();
  });

  it("creates with a trimmed name and an upper-case tag", async () => {
    const guilds = guildFake();
    const r = await createGuild(guilds, { name: "  Iron Wolves ", tag: "irw", open: false });
    expect(r.ok).toBe(true);
    expect(guilds.created).toEqual([{ name: "Iron Wolves", tag: "IRW", open: false }]);
  });

  it("maps a server name clash to plain words", async () => {
    const guilds = guildFake({
      create: async () => ({ ok: false, code: "name_taken", message: "" }),
    });
    const r = await createGuild(guilds, { name: "Iron Wolves", tag: "IRW", open: true });
    expect(r).toEqual({
      ok: false,
      code: "name_taken",
      message: "That guild name is already taken.",
    });
  });

  it("explains why a guild cannot be joined", () => {
    const summary: GuildSummary = { id: "g", name: "G", tag: "G", open: true, memberCount: 3 };
    expect(guildJoinBlock(summary, null)).toBe("Sign in");
    expect(guildJoinBlock(summary, account({ kind: "guest" }))).toBe("Sign in");
    expect(guildJoinBlock(summary, account({ guildId: "other" }))).toBe("In a guild");
    expect(guildJoinBlock({ ...summary, open: false }, account())).toBe("Invite only");
    expect(guildJoinBlock({ ...summary, memberCount: 50 }, account())).toBe("Full");
    expect(guildJoinBlock(summary, account())).toBeNull();
  });

  it("loads the guild list with a trimmed search", async () => {
    const seen: (string | undefined)[] = [];
    const guilds = guildFake({
      list: async (q) => {
        seen.push(q);
        return { ok: true, value: [] };
      },
    });
    expect(await loadGuildList(guilds, "  ")).toEqual({ status: "ready", value: [] });
    await loadGuildList(guilds, " wolf ");
    expect(seen).toEqual([undefined, "wolf"]);
  });
});

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

describe("account flows", () => {
  it("checks the register form locally first", async () => {
    const auth = authFake();
    const r = await registerAccount(auth, {
      email: "x",
      password: "long-enough-pw",
      displayName: "",
    });
    expect(r).toMatchObject({ ok: false, code: "bad_request" });
    expect(auth.calls).toEqual([]);
    expect(checkRegister({ email: "a@b.co", password: "short", displayName: "" })).toMatch(
      /at least/,
    );
  });

  it("registers with trimmed values and drops an empty display name", async () => {
    const auth = authFake();
    await registerAccount(auth, {
      email: " hero@example.com ",
      password: "long-enough-pw",
      displayName: "  ",
    });
    expect(auth.calls).toEqual([["register", "hero@example.com", "long-enough-pw", undefined]]);
  });

  it("maps register errors by code (email taken)", async () => {
    const auth = authFake({
      register: async () => ({ ok: false, code: "email_taken", message: "" }),
    });
    const r = await registerAccount(auth, {
      email: "hero@example.com",
      password: "long-enough-pw",
      displayName: "",
    });
    expect(r).toEqual({
      ok: false,
      code: "email_taken",
      message: "That email already has an account. Sign in instead.",
    });
  });

  it("maps login errors (bad credentials, locked)", async () => {
    const bad = authFake({
      login: async () => ({ ok: false, code: "bad_credentials", message: "" }),
    });
    expect(await loginAccount(bad, { email: "hero@example.com", password: "x" })).toMatchObject({
      ok: false,
      message: "Email or password is wrong.",
    });
    const locked = authFake({ login: async () => ({ ok: false, code: "locked", message: "" }) });
    const r = await loginAccount(locked, { email: "hero@example.com", password: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Too many attempts");
  });

  it("asks for a password and an email before logging in", async () => {
    const auth = authFake();
    expect(await loginAccount(auth, { email: "hero@example.com", password: "" })).toMatchObject({
      ok: false,
      message: "Enter your password.",
    });
    expect(auth.calls).toEqual([]);
  });

  it("validates and saves the display name", async () => {
    const auth = authFake();
    expect(await saveDisplayName(auth, "ab")).toMatchObject({ ok: false, code: "bad_name" });
    const ok = await saveDisplayName(auth, " Brann ");
    expect(ok.ok).toBe(true);
    expect(auth.calls).toEqual([["setDisplayName", "Brann"]]);
  });

  it("separates OAuth providers and reads linked logins", () => {
    const providers = [
      { id: "email" as const, enabled: true, stub: false },
      { id: "google" as const, enabled: true, stub: true },
    ];
    expect(oauthProviders(providers).map((p) => p.id)).toEqual(["google"]);
    expect([...linkedProviders(account())]).toEqual(["email"]);
  });
});
