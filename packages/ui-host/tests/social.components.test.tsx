import { describe, expect, it } from "vite-plus/test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ChatMessage,
  GuildInfo,
  GuildSummary,
  LeaderboardResponse,
  ProviderInfo,
} from "@gamez/protocol";
import {
  AccountPanel,
  ChatWindow,
  GuildView,
  LeaderboardView,
  type ChatWindowProps,
} from "../src/social/index.ts";
import { ChatComposer, ChatLog, ChatTabs } from "../src/social/ChatWindow.tsx";
import { LeaderboardBody, LeaderboardList } from "../src/social/LeaderboardView.tsx";
import { CreateGuild, GuildList, GuildRoster } from "../src/social/GuildView.tsx";
import {
  accountChangeText,
  LoginFormView,
  ProviderButtons,
  RegisteredAccount,
} from "../src/social/AccountPanel.tsx";
import type {
  AccountView,
  AuthApi,
  ChatApi,
  ChatChannelClient,
  ChatChannelView,
  GuildApi,
  LeaderboardApi,
} from "../src/platform.ts";

// ---------------------------------------------------------------------------
// Fakes (no effects run in static rendering, so these are only handed over)
// ---------------------------------------------------------------------------

function fakeChatClient(channel: string): ChatChannelClient {
  const view: ChatChannelView = {
    channel,
    status: "connecting",
    messages: [],
    mutedUntil: null,
    blocked: [],
    error: null,
  };
  return {
    channel,
    getView: () => view,
    subscribe: () => () => {},
    send: async () => ({ ok: true, value: { id: "x" } }),
    report: () => {},
    block: () => {},
    close: () => {},
  };
}

const fakeChat: ChatApi = { join: (channel) => fakeChatClient(channel) };

const leaderboardApi: LeaderboardApi = {
  fetch: async () => ({
    ok: true,
    value: { board: "level", mode: "classic", classId: null, rows: [], available: true },
  }),
};

const guildApi: GuildApi = {
  mine: async () => ({ ok: true, value: null }),
  list: async () => ({ ok: true, value: [] }),
  get: async () => ({ ok: false, code: "not_found", message: "" }),
  create: async () => ({ ok: false, code: "bad_request", message: "" }),
  join: async () => ({ ok: false, code: "closed", message: "" }),
  leave: async () => ({ ok: true, value: null }),
  kick: async () => ({ ok: true, value: guildInfo }),
};

const authApi: AuthApi = {
  me: async () => ({ ok: true, value: guest }),
  providers: async () => [],
  register: async () => ({ ok: false, code: "email_taken", message: "" }),
  login: async () => ({ ok: false, code: "bad_credentials", message: "" }),
  logout: async () => {},
  oauthUrl: (p, o) => `/api/auth/${p}?link=${o.link ? 1 : 0}`,
  setDisplayName: async () => ({ ok: false, code: "bad_name", message: "" }),
  onSessionChange: () => () => {},
};

const guest: AccountView = {
  accountId: "guest-1",
  displayName: "Wanderer",
  kind: "guest",
  identities: [],
  guildId: null,
  guildTag: null,
  createdAt: 1,
};

const registered: AccountView = {
  accountId: "acc-1",
  displayName: "Brann",
  kind: "registered",
  identities: [{ provider: "email", email: "brann@example.com" }],
  guildId: "iron-wolves",
  guildTag: "IRW",
  createdAt: 1,
};

const guildInfo: GuildInfo = {
  id: "iron-wolves",
  name: "Iron Wolves",
  tag: "IRW",
  open: false,
  createdAt: 1,
  members: [
    { accountId: "acc-1", displayName: "Brann", role: "officer", joinedAt: 1 },
    { accountId: "acc-2", displayName: "Lyra", role: "leader", joinedAt: 1 },
    { accountId: "acc-3", displayName: "Tomas", role: "member", joinedAt: 2 },
  ],
};

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  channel: "global",
  from: "acc-9",
  name: "Lyra",
  tag: "IRW",
  text: "hello friends",
  at: 1_700_000_000_000,
  ...over,
});

const html = (el: ReactElement) => renderToStaticMarkup(el);

// ---------------------------------------------------------------------------
// ChatWindow
// ---------------------------------------------------------------------------

const chatProps = (over: Partial<ChatWindowProps> = {}): ChatWindowProps => ({
  chat: fakeChat,
  channels: [
    { id: "global", label: "Global" },
    { id: "mode:classic", label: "Classic" },
  ],
  selfId: "acc-1",
  ...over,
});

describe("<ChatWindow>", () => {
  it("renders channel tabs with the first selected and a connecting status", () => {
    const out = html(<ChatWindow {...chatProps()} />);
    expect(out).toContain('aria-label="Chat channels"');
    expect(out).toContain(">Global</button>");
    expect(out).toContain(">Classic</button>");
    expect(out).toMatch(/role="tab" aria-selected="true"[^>]*>Global/);
    expect(out).toContain("Connecting…");
    expect(out).toContain("No messages yet. Say hello.");
  });

  it("shows the empty state for no channels", () => {
    expect(html(<ChatWindow {...chatProps({ channels: [] })} />)).toContain(
      "No chat channels here.",
    );
  });

  it("offers a close button only when given onClose", () => {
    expect(html(<ChatWindow {...chatProps()} />)).not.toContain("Close chat");
    expect(html(<ChatWindow {...chatProps({ onClose: () => {} })} />)).toContain("Close chat");
  });
});

describe("<ChatTabs>", () => {
  it("gives only the selected tab a tab stop (roving tabindex)", () => {
    const out = html(
      <ChatTabs
        channels={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ]}
        selected="b"
        onSelect={() => {}}
      />,
    );
    expect(out).toMatch(/aria-selected="false" tabindex="-1"[^>]*>A</);
    expect(out).toMatch(/aria-selected="true" tabindex="0"[^>]*>B</);
  });
});

describe("<ChatLog>", () => {
  it("styles own messages, offers actions for others, and shows the guild tag", () => {
    const out = html(
      <ChatLog
        messages={[message({ id: "m1", from: "acc-1", name: "Brann", text: "mine" }), message()]}
        selfId="acc-1"
        reported={{}}
        onBlock={() => {}}
        onReport={() => {}}
      />,
    );
    expect(out).toContain('data-own="true"');
    expect(out.match(/aria-label="More actions for Lyra"/g)?.length).toBe(1);
    expect(out).not.toContain("More actions for Brann");
    expect(out).toContain("&lt;IRW&gt;");
    expect(out).toContain("hello friends");
  });

  it("confirms a sent report with the actions menu closed (QA wave B)", () => {
    const m = message();
    const out = html(
      <ChatLog
        messages={[m]}
        selfId="acc-1"
        reported={{ [m.id]: true }}
        onBlock={() => {}}
        onReport={() => {}}
      />,
    );
    expect(out).toContain("Report sent. Thank you.");
    expect(out).toContain('aria-expanded="false"');
    expect(
      html(
        <ChatLog
          messages={[m]}
          selfId="acc-1"
          reported={{}}
          onBlock={() => {}}
          onReport={() => {}}
        />,
      ),
    ).not.toContain("Report sent");
  });

  it("renders system notices without a sender or actions", () => {
    const out = html(
      <ChatLog
        messages={[message({ id: "s1", system: true, from: "", name: "", text: "Welcome in." })]}
        selfId="acc-1"
        reported={{}}
        onBlock={() => {}}
        onReport={() => {}}
      />,
    );
    expect(out).toContain("Welcome in.");
    expect(out).not.toContain("More actions");
    expect(out).toContain("font-style:italic");
  });
});

describe("<ChatComposer>", () => {
  const base = {
    draft: "",
    onDraft: () => {},
    onSubmit: () => {},
    canSend: true,
    sending: false,
    status: "online" as const,
    mutedUntil: null,
    error: null,
  };

  it("says 'Connecting' during the handshake, 'unavailable' only when offline", () => {
    expect(html(<ChatComposer {...base} status="connecting" />)).toContain("Connecting to chat…");
    expect(html(<ChatComposer {...base} status="connecting" />)).not.toContain("unavailable");
    expect(html(<ChatComposer {...base} status="offline" />)).toContain(
      "Chat is unavailable right now",
    );
  });

  it("counts characters against CHAT_MAX_LEN", () => {
    expect(html(<ChatComposer {...base} draft="hi" />)).toContain(">2/280<");
  });

  it("turns the counter red and disables send past the limit", () => {
    const out = html(<ChatComposer {...base} draft={"x".repeat(281)} />);
    expect(out).toContain(">281/280<");
    expect(out).toMatch(/<button type="submit" disabled=""/);
  });

  it("disables send while offline and says why in the placeholder", () => {
    const out = html(<ChatComposer {...base} status="offline" canSend={false} />);
    expect(out).toContain("Chat is unavailable right now");
    expect(out).toMatch(/<button type="submit" disabled=""/);
  });

  it("shows the mute notice and the last error in alert text", () => {
    const until = new Date(2026, 9, 28, 9, 30).getTime();
    const out = html(
      <ChatComposer
        {...base}
        canSend={false}
        mutedUntil={until}
        error="Slow down a little, then try again."
      />,
    );
    expect(out).toContain("You are muted until 09:30.");
    expect(out).toContain('role="alert"');
    expect(out).toContain("Slow down a little");
  });
});

// ---------------------------------------------------------------------------
// LeaderboardView
// ---------------------------------------------------------------------------

const classes = [
  { id: "classic.class.warrior", name: "Warrior" },
  { id: "classic.class.ranger", name: "Ranger" },
];

describe("<LeaderboardView>", () => {
  it("renders board tabs, the class filter and the loading state", () => {
    const out = html(
      <LeaderboardView api={leaderboardApi} mode="classic" classes={classes} selfId={null} />,
    );
    expect(out).toContain(">Level</button>");
    expect(out).toContain(">Deepest depth</button>");
    expect(out).toContain(">Rift</button>");
    expect(out).toContain('aria-label="Class filter"');
    expect(out).toContain(">All</option>");
    expect(out).toContain(">Warrior</option>");
    expect(out).toContain("Loading rankings…");
  });

  it("hides the class filter when there are no classes", () => {
    const out = html(
      <LeaderboardView api={leaderboardApi} mode="classic" classes={[]} selfId={null} />,
    );
    expect(out).not.toContain('aria-label="Class filter"');
  });
});

describe("<LeaderboardBody>", () => {
  const common = {
    board: "level" as const,
    valueLabel: "Hero level",
    selfId: null,
    classNames: {},
  };

  it("shows the loading, warming, error and empty states", () => {
    expect(html(<LeaderboardBody {...common} state={undefined} />)).toContain("Loading rankings…");
    expect(html(<LeaderboardBody {...common} state={{ status: "warming" }} />)).toContain(
      "Leaderboards are warming up",
    );
    const err = html(<LeaderboardBody {...common} state={{ status: "error", message: "Down" }} />);
    expect(err).toContain('role="alert"');
    expect(err).toContain("Rankings could not load. Down");
    const empty: LeaderboardResponse = {
      board: "level",
      mode: "classic",
      classId: null,
      rows: [],
      available: true,
    };
    expect(
      html(<LeaderboardBody {...common} state={{ status: "ready", response: empty }} />),
    ).toContain("No one has ranked here yet.");
  });
});

describe("<LeaderboardList>", () => {
  const response: LeaderboardResponse = {
    board: "level",
    mode: "classic",
    classId: null,
    available: true,
    rows: [
      {
        rank: 1,
        accountId: "acc-1",
        displayName: "Brann",
        heroName: "Brann the Bold",
        classId: "classic.class.warrior",
        heroLevel: 12,
        value: 12,
        extra: { xp: 900 },
        imported: true,
        updatedAt: 1,
      },
      {
        rank: 2,
        accountId: "acc-2",
        displayName: "Lyra",
        heroName: "Lyra",
        classId: "classic.class.ranger",
        heroLevel: 9,
        value: 9,
        extra: { xp: 40 },
        imported: false,
        updatedAt: 1,
      },
    ],
  };

  it("highlights own rows, marks imported ones and maps class names", () => {
    const out = html(
      <LeaderboardList
        response={response}
        board="level"
        valueLabel="Hero level"
        selfId="acc-1"
        classNames={{ "classic.class.warrior": "Warrior", "classic.class.ranger": "Ranger" }}
      />,
    );
    expect(out).toMatch(/data-own="true"/);
    expect(out.match(/data-own=/g)?.length).toBe(1);
    expect(out).toContain("Imported");
    expect(out).toContain("Brann the Bold · Lv 12 · Warrior");
    expect(out).toContain("Lv 12");
    expect(out).toContain("#2");
  });

  it("formats values per board", () => {
    const depth = html(
      <LeaderboardList
        response={{ ...response, rows: [{ ...response.rows[1]!, value: 1234 }] }}
        board="depth"
        valueLabel="Depth"
        selfId={null}
        classNames={{}}
      />,
    );
    expect(depth).toContain("Depth 1,234");
    const rift = html(
      <LeaderboardList
        response={{ ...response, rows: [{ ...response.rows[1]!, value: 5600 }] }}
        board="rift"
        valueLabel="Rift score"
        selfId={null}
        classNames={{}}
      />,
    );
    expect(rift).toContain(">5,600<");
  });
});

// ---------------------------------------------------------------------------
// GuildView
// ---------------------------------------------------------------------------

describe("<GuildView>", () => {
  it("tells guests to create an account, and still offers the search", () => {
    const out = html(<GuildView guilds={guildApi} account={guest} />);
    expect(out).toContain("Create an account to join a guild.");
    expect(out).toContain('aria-label="Search guilds"');
    expect(out).toContain('aria-label="Refresh guilds"');
    expect(out).not.toContain('aria-label="Create a guild"');
  });

  it("shows only the loading line while the guild is fetched (no create form flash)", () => {
    const out = html(<GuildView guilds={guildApi} account={registered} />);
    expect(out).toContain("Loading your guild…");
    expect(out).not.toContain('aria-label="Create a guild"');
    expect(out).not.toContain("Create an account to join a guild.");
  });
});

describe("<GuildRoster>", () => {
  it("shows roles, kick buttons only where allowed, and the embedded guild chat", () => {
    const out = html(
      <GuildRoster
        info={guildInfo}
        selfId="acc-1"
        guilds={guildApi}
        chat={fakeChat}
        onChanged={() => {}}
      />,
    );
    expect(out).toContain("Iron Wolves");
    expect(out).toContain("&lt;IRW&gt;");
    expect(out).toContain("Your role: Officer");
    expect(out).toContain("Leader");
    expect(out).toContain('aria-label="Kick Tomas"');
    expect(out).not.toContain('aria-label="Kick Lyra"');
    expect(out).not.toContain('aria-label="Kick Brann"');
    expect(out).toContain("Leave guild");
    expect(out).toContain(">Guild chat</button>");
  });

  it("omits the guild chat when no chat service is given", () => {
    const out = html(
      <GuildRoster info={guildInfo} selfId="acc-3" guilds={guildApi} onChanged={() => {}} />,
    );
    expect(out).not.toContain("Guild chat");
    expect(out).not.toContain('aria-label="Kick');
  });
});

describe("<GuildList>", () => {
  const summary = (over: Partial<GuildSummary> = {}): GuildSummary => ({
    id: "g",
    name: "Iron Wolves",
    tag: "IRW",
    open: true,
    memberCount: 3,
    ...over,
  });
  const common = {
    account: registered,
    canUse: true,
    pendingId: null,
    joinError: null,
    onJoin: () => {},
  };

  it("renders loading, error and empty states", () => {
    expect(html(<GuildList {...common} list={{ status: "loading" }} />)).toContain(
      "Loading guilds…",
    );
    const err = html(<GuildList {...common} list={{ status: "error", message: "Gone" }} />);
    expect(err).toContain("Guilds could not load. Gone");
    expect(html(<GuildList {...common} list={{ status: "ready", value: [] }} />)).toContain(
      "No guilds match.",
    );
  });

  it("explains join blocks on each row (invite only, full, guest)", () => {
    const out = html(
      <GuildList
        {...common}
        account={{ ...registered, guildId: null }}
        list={{
          status: "ready",
          value: [
            summary({ id: "a", name: "Closed Ones", open: false }),
            summary({ id: "b", name: "Packed", memberCount: 50 }),
            summary({ id: "c", name: "Open Door" }),
          ],
        }}
      />,
    );
    expect(out).toContain(">Invite only</button>");
    expect(out).toContain(">Full</button>");
    expect(out).toMatch(/aria-label="Join Open Door"[^>]*>Join</);
    expect(out).toContain("3 members");
  });

  it("disables joins for guests with the account message", () => {
    const out = html(
      <GuildList
        {...common}
        account={guest}
        canUse={false}
        list={{ status: "ready", value: [summary()] }}
      />,
    );
    // Short label so the row fits a 375px phone (QA wave B); the long copy is GuildView's status line.
    expect(out).toMatch(/disabled=""[^>]*aria-label="Join Iron Wolves"[^>]*>Sign in</);
    expect(out).not.toContain("Create an account to join a guild.");
    // Rows never shrink inside the scrolling list (they overlapped at 375px).
    expect(out).toMatch(/<li style="[^"]*flex-shrink:0/);
  });

  it("only promises a create form when one is shown", () => {
    const empty = { status: "ready" as const, value: [] };
    const guestOut = html(<GuildList {...common} account={guest} canUse={false} list={empty} />);
    expect(guestOut).toContain("No guilds match.");
    expect(guestOut).not.toContain("Create the first one below");
    const memberOut = html(<GuildList {...common} account={registered} canUse list={empty} />);
    expect(memberOut).toContain("No guilds match. Create the first one below.");
  });
});

describe("<CreateGuild>", () => {
  it("renders the name, tag and open fields with the naming rules", () => {
    const out = html(<CreateGuild guilds={guildApi} onCreated={() => {}} />);
    expect(out).toContain("Guild name");
    expect(out).toContain("Tag");
    expect(out).toContain("Open to everyone");
    expect(out).toContain("Names are 3 to 24 letters or numbers.");
    expect(out).toContain("Found guild");
  });
});

// ---------------------------------------------------------------------------
// AccountPanel
// ---------------------------------------------------------------------------

const stubProviders: ProviderInfo[] = [
  { id: "email", enabled: true, stub: false },
  { id: "google", enabled: true, stub: true },
  { id: "discord", enabled: true, stub: false },
  { id: "apple", enabled: false, stub: false },
];

describe("<AccountPanel>", () => {
  it("guest: save-progress copy, register form and the sign-in tab", () => {
    const out = html(<AccountPanel auth={authApi} account={guest} />);
    expect(out).toContain("Save your progress");
    expect(out).toContain('aria-label="Create account"');
    expect(out).toContain("I have an account");
    expect(out).toContain('type="password"');
    expect(out).toContain("At least 10 characters");
  });

  it("account forms skip native validation so the app's own messages show (QA wave B)", () => {
    const out = html(<AccountPanel auth={authApi} account={guest} />);
    expect(out).toMatch(/<form[^>]*aria-label="Create account"[^>]*noValidate=""/);
    expect(html(<LoginFormView auth={authApi} />)).toMatch(
      /<form[^>]*aria-label="Sign in"[^>]*noValidate=""/,
    );
  });

  it("names each change for the host's notice (sign out is not 'Account updated')", () => {
    expect(accountChangeText("signed-out")).toBe("Signed out.");
    expect(accountChangeText("signed-in")).toBe("Signed in.");
    expect(accountChangeText("registered")).toContain("Account created");
    expect(accountChangeText("renamed")).toBe("Name saved.");
  });

  it("shows a loading line until the account is known", () => {
    expect(html(<AccountPanel auth={authApi} account={null} />)).toContain("Loading account…");
  });

  it("registered: name, linked logins and sign out", () => {
    const out = html(
      <RegisteredAccount auth={authApi} account={registered} providers={stubProviders} />,
    );
    expect(out).toContain("Brann");
    expect(out).toContain("brann@example.com");
    expect(out).toContain("Linked");
    expect(out).toContain('aria-label="Linked logins"');
    expect(out).toContain("Sign out");
    expect(out).toContain("Continue with Google (dev stub)");
    expect(out).toContain("Continue with Discord");
    expect(out).not.toContain("Continue with Apple");
  });

  it("OAuth buttons: stub labels, disabled providers, no email provider", () => {
    const out = html(<ProviderButtons providers={stubProviders} auth={authApi} link={false} />);
    expect(out).toContain("Continue with Google (dev stub)");
    expect(out).toContain("Continue with Discord");
    expect(out).toMatch(/disabled=""[^>]*>Apple sign-in is not set up here/);
    expect(out).not.toContain("Continue with Email");
  });

  it("OAuth buttons render nothing without providers", () => {
    expect(html(<ProviderButtons providers={[]} auth={authApi} link={false} />)).toBe("");
  });
});
