/**
 * Wave B classic HUD: the social panels (chat, guild, leaderboard, account), the sync badge and
 * the social entry points (desktop bar, phone More menu). Rendered with react-dom/server and a fake
 * ClassicClientApi and fake PlatformServices. OWNER: T-classic-hud.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { PlatformServices, AccountView } from "@gamez/ui-host";
import type {
  PanelId,
  Store,
  SyncView,
  UiState,
  ClassicClientApi,
  HudSnapshot,
} from "../src/client/contract.ts";
import { LOCAL_SYNC_VIEW } from "../src/client/contract.ts";
import { describe, expect, it } from "vite-plus/test";
import { PANEL_COMPONENTS } from "../src/client/hud/index.tsx";
import { PANEL_IDS } from "../src/client/hud/layout.ts";
import {
  PanelButtons,
  SOCIAL_BUTTONS,
  buildMoreItems,
} from "../src/client/hud/widgets/PanelButtons.tsx";
import {
  SAVED_PENDING_TICKS,
  savedPendingLimit,
  SyncBadge,
  SyncBadgeView,
  ageText,
  syncLabel,
} from "../src/client/hud/widgets/SyncBadge.tsx";
import { ChatPanel } from "../src/client/hud/panels/ChatPanel.tsx";
import { GuildPanel } from "../src/client/hud/panels/GuildPanel.tsx";
import { LeaderboardPanel, FALLBACK_CLASSES } from "../src/client/hud/panels/LeaderboardPanel.tsx";
import { AccountPanel } from "../src/client/hud/panels/AccountPanel.tsx";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function staticStore<T>(value: T): Store<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

const ACCOUNT: AccountView = {
  accountId: "acc_test_1",
  displayName: "Aria",
  kind: "registered",
  identities: [{ provider: "email", email: "aria@example.test" }],
  guildId: null,
  guildTag: null,
  createdAt: 0,
};

const okResult = <T,>(value: T) => ({ ok: true as const, value });

/** Structural fake of PlatformServices: every method resolves or returns a no-op. */
export function fakePlatform(): PlatformServices {
  const channel = (id: string) => ({
    channel: id,
    getView: () => ({
      channel: id,
      status: "offline" as const,
      messages: [],
      mutedUntil: null,
      blocked: [],
      error: null,
    }),
    subscribe: () => () => {},
    send: async () => ({ ok: true as const, value: { id: "m1" } }),
    report() {},
    block() {},
    close() {},
  });
  return {
    auth: {
      me: async () => okResult(ACCOUNT),
      providers: async () => [],
      register: async () => ({ ok: false as const, code: "x", message: "x" }),
      login: async () => ({ ok: false as const, code: "x", message: "x" }),
      logout: async () => {},
      oauthUrl: () => "",
      setDisplayName: async () => okResult(ACCOUNT),
      onSessionChange: () => () => {},
    },
    leaderboards: {
      fetch: async () =>
        okResult({
          board: "level" as const,
          mode: "classic",
          classId: null,
          rows: [],
          available: true,
        }),
    },
    chat: { join: (id: string) => channel(id) },
    guilds: {
      mine: async () => okResult(null),
      list: async () => okResult([]),
      get: async () => ({ ok: false as const, code: "not_found", message: "none" }),
      create: async () => ({ ok: false as const, code: "bad_request", message: "none" }),
      join: async () => ({ ok: false as const, code: "bad_request", message: "none" }),
      leave: async () => ({ ok: false as const, code: "not_in_guild", message: "none" }),
      kick: async () => ({ ok: false as const, code: "forbidden", message: "none" }),
    },
    account: {
      wallet: async () => ({ ok: false as const, code: "x", message: "x" }),
      cosmetics: async () => ({ ok: false as const, code: "x", message: "x" }),
    },
  } as unknown as PlatformServices;
}

function makeUi(compact: boolean): UiState {
  return {
    panels: [],
    toasts: [],
    settings: {
      showDamageNumbers: true,
      showLootLabels: true,
      showMinimap: false,
      zoom: 1,
      lighting: true,
      showPerf: false,
      masterVolume: 70,
      sfxVolume: 80,
      musicVolume: 45,
      muted: false,
      quality: "auto",
      tips: true,
      outlineHero: true,
    },
    hover: null,
    compact,
    perf: { fps: 60, tickMs: 0.5, ticksPerSecond: 20, entities: 10, monsters: 0 },
    error: null,
  } as unknown as UiState;
}

interface FakeOpts {
  platform?: PlatformServices | null;
  sync?: SyncView;
  noSync?: boolean;
  session?: { accountId: string; name: string } | null;
  compact?: boolean;
  panels?: PanelId[];
}

/** A fake ClassicClientApi that records togglePanel / exit calls. */
export function fakeApi(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const hud = {
    classes: [
      { id: "classic.warrior", name: "Warrior", description: "" },
      { id: "classic.rogue", name: "Rogue", description: "" },
    ],
  } as unknown as HudSnapshot;
  const ui = makeUi(opts.compact === true);
  if (opts.panels) ui.panels = opts.panels;
  const api = {
    hud: staticStore(hud),
    log: staticStore([]),
    ui: staticStore(ui),
    act: () => ({ ok: true, events: [], tick: 0 }) as never,
    togglePanel: (p: PanelId) => calls.push(`toggle:${p}`),
    openPanel() {},
    closePanel() {},
    closeAll() {},
    setHover() {},
    updateSettings() {},
    dismissToast() {},
    minimap: () => null,
    castSlot() {},
    drink() {},
    newGame() {},
    exit: () => calls.push("exit"),
    ...(opts.noSync ? {} : { sync: staticStore(opts.sync ?? LOCAL_SYNC_VIEW) }),
    platform: opts.platform === undefined ? fakePlatform() : opts.platform,
    session:
      opts.session === undefined ? { accountId: ACCOUNT.accountId, name: "Aria" } : opts.session,
  } as unknown as ClassicClientApi;
  return { api, calls };
}

function serverSync(over: Partial<SyncView> = {}): SyncView {
  return {
    mode: "server",
    status: "online",
    verifiedTick: 1200,
    pendingTicks: 0,
    overflow: false,
    lastResync: null,
    imported: false,
    ...over,
  };
}

const OFFLINE_NOTE = "Offline:";

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

describe("social panels with a platform", () => {
  it("chat renders the shared chat window and no offline note", () => {
    const { api } = fakeApi();
    const html = renderToStaticMarkup(<ChatPanel api={api} />);
    expect(html).toContain('aria-label="Chat"');
    expect(html).not.toContain(OFFLINE_NOTE);
  });

  it("guild and account start with a loading line (the account is fetched in an effect)", () => {
    const { api } = fakeApi();
    for (const html of [
      renderToStaticMarkup(<GuildPanel api={api} />),
      renderToStaticMarkup(<AccountPanel api={api} />),
    ]) {
      expect(html).toContain("Loading");
      expect(html).not.toContain(OFFLINE_NOTE);
    }
  });

  it("leaderboards render without the offline note and in the compact sheet too", () => {
    const { api } = fakeApi({ compact: true });
    const html = renderToStaticMarkup(<LeaderboardPanel api={api} />);
    expect(html).toContain('aria-label="Leaderboards"');
    expect(html).not.toContain(OFFLINE_NOTE);
  });

  it("the fallback classes are the three starting classes of the content", () => {
    expect(FALLBACK_CLASSES.map((c) => c.id)).toEqual([
      "classic.warrior",
      "classic.rogue",
      "classic.sorcerer",
    ]);
  });
});

describe("social panels without a platform (offline note)", () => {
  it("every social panel shows the offline note when api.platform is null", () => {
    const { api } = fakeApi({ platform: null, session: null });
    const panels = [
      ["Chat", <ChatPanel key="c" api={api} />],
      ["Guild", <GuildPanel key="g" api={api} />],
      ["Leaderboards", <LeaderboardPanel key="l" api={api} />],
      ["Account", <AccountPanel key="a" api={api} />],
    ] as const;
    for (const [title, el] of panels) {
      const html = renderToStaticMarkup(el);
      expect(html).toContain(`aria-label="${title}"`);
      expect(html).toContain(OFFLINE_NOTE);
      expect(html).toContain("game server");
    }
  });

  it("the panel ids map to the four social components", () => {
    expect(PANEL_COMPONENTS.chat).toBe(ChatPanel);
    expect(PANEL_COMPONENTS.guild).toBe(GuildPanel);
    expect(PANEL_COMPONENTS.leaderboard).toBe(LeaderboardPanel);
    expect(PANEL_COMPONENTS.account).toBe(AccountPanel);
  });
});

// ---------------------------------------------------------------------------
// Sync badge
// ---------------------------------------------------------------------------

describe("syncLabel: every state", () => {
  it("local mode is 'Local game' whatever the other fields say", () => {
    expect(syncLabel(LOCAL_SYNC_VIEW)).toEqual({ tone: "local", text: "Local game" });
    expect(syncLabel({ ...LOCAL_SYNC_VIEW, pendingTicks: 500 }).text).toBe("Local game");
  });

  it("online with few pending ticks is 'Saved'", () => {
    expect(syncLabel(serverSync({ pendingTicks: 0 })).text).toBe("Saved");
    expect(syncLabel(serverSync({ pendingTicks: SAVED_PENDING_TICKS - 1 })).text).toBe("Saved");
  });

  it("online with pending ticks at or above the threshold is 'Saving…'", () => {
    expect(syncLabel(serverSync({ pendingTicks: SAVED_PENDING_TICKS })).text).toBe("Saving…");
    expect(syncLabel(serverSync({ pendingTicks: 900 })).tone).toBe("busy");
  });

  it("offline and connecting play locally", () => {
    expect(syncLabel(serverSync({ status: "offline" })).text).toBe("Offline — playing locally");
    expect(syncLabel(serverSync({ status: "connecting" })).text).toBe("Offline — playing locally");
    expect(syncLabel(serverSync({ status: "offline" })).tone).toBe("offline");
  });

  it("the threshold is 60 ticks (3 s at 20 Hz)", () => {
    expect(SAVED_PENDING_TICKS).toBe(60);
  });

  it("scales the threshold with the sim speed, so Idle x8 reads 'Saved' while verification keeps up", () => {
    // QA wave B: at x8 pendingTicks sat around 200 (max 400, one segment) while healthy.
    expect(savedPendingLimit(1)).toBe(60);
    expect(savedPendingLimit(8)).toBe(480);
    expect(savedPendingLimit(Number.NaN)).toBe(60);
    expect(syncLabel(serverSync({ pendingTicks: 202 }), 8).text).toBe("Saved");
    expect(syncLabel(serverSync({ pendingTicks: 400 }), 8).text).toBe("Saved");
    expect(syncLabel(serverSync({ pendingTicks: 202 }), 1).text).toBe("Saving…");
    expect(syncLabel(serverSync({ pendingTicks: 480 }), 8).text).toBe("Saving…");
    expect(syncLabel(serverSync({ pendingTicks: 100 }), 2).text).toBe("Saved");
  });
});

describe("SyncBadge widget", () => {
  it("reads the sim speed from the HUD control view", () => {
    const { api } = fakeApi({ sync: serverSync({ pendingTicks: 200 }) });
    const fast = {
      ...api,
      hud: staticStore({ control: { speed: 8 } } as unknown as HudSnapshot),
    } as ClassicClientApi;
    expect(renderToStaticMarkup(<SyncBadge api={fast} />)).toContain("Sync status: Saved");
    expect(renderToStaticMarkup(<SyncBadge api={api} />)).toContain("Sync status: Saving…");
  });

  it("shows the label of api.sync", () => {
    const { api } = fakeApi({ sync: serverSync({ pendingTicks: 200 }) });
    const html = renderToStaticMarkup(<SyncBadge api={api} />);
    expect(html).toContain("Saving…");
    expect(html).toContain('aria-expanded="false"');
  });

  it("falls back to the local label when api.sync is absent", () => {
    const { api } = fakeApi({ noSync: true });
    expect(renderToStaticMarkup(<SyncBadge api={api} />)).toContain("Local game");
  });

  it("the closed badge has no popover; the open one lists the save details", () => {
    const view = serverSync({ verifiedTick: 4321, pendingTicks: 7 });
    const closed = renderToStaticMarkup(
      <SyncBadgeView view={view} open={false} onToggle={() => {}} />,
    );
    expect(closed).not.toContain("Verified tick");
    const open = renderToStaticMarkup(<SyncBadgeView view={view} open onToggle={() => {}} />);
    expect(open).toContain("Verified tick");
    expect(open).toContain("4321");
    expect(open).toContain("Pending ticks");
    expect(open).toContain('aria-expanded="true"');
  });

  it("the popover names the last correction and the imported marker", () => {
    const html = renderToStaticMarkup(
      <SyncBadgeView
        view={serverSync({
          imported: true,
          lastResync: { code: "hash_mismatch", message: "state diverged", at: 1 },
        })}
        open
        onToggle={() => {}}
      />,
    );
    expect(html).toContain("hash_mismatch");
    expect(html).toContain("state diverged");
    expect(html).toContain("imported from a local save");
  });

  it("the popover says when the pending progress is over the limit", () => {
    const html = renderToStaticMarkup(
      <SyncBadgeView
        view={serverSync({ overflow: true, pendingTicks: 9000 })}
        open
        onToggle={() => {}}
      />,
    );
    expect(html).toContain("Over the limit");
  });

  it("the badge button keeps a 44 px target", () => {
    const html = renderToStaticMarkup(
      <SyncBadgeView view={LOCAL_SYNC_VIEW} open={false} onToggle={() => {}} />,
    );
    expect(html).toContain("min-height:44px");
  });
});

describe("ageText", () => {
  it("reads a resync age in plain words", () => {
    expect(ageText(0, 3_000)).toBe("just now");
    expect(ageText(0, 42_000)).toBe("42 s ago");
    expect(ageText(0, 180_000)).toBe("3 min ago");
    expect(ageText(0, 7_200_000)).toBe("2 h ago");
    expect(ageText(10_000, 5_000)).toBe("just now");
  });
});

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

describe("social entry points", () => {
  it("the social panels are four buttons after the secondary ones", () => {
    expect(SOCIAL_BUTTONS.map((b) => b.id)).toEqual(["chat", "guild", "leaderboard", "account"]);
    for (const b of SOCIAL_BUTTONS) expect(PANEL_IDS).toContain(b.id);
  });

  it("the phone More menu lists the social rows and each one toggles its panel", () => {
    const { api, calls } = fakeApi({ compact: true });
    const items = buildMoreItems(api, [], true);
    const ids = items.map((i) => i.id);
    for (const id of ["chat", "guild", "leaderboard", "account", "log", "achievements", "modes"]) {
      expect(ids).toContain(id);
    }
    items.find((i) => i.id === "guild")?.onSelect();
    items.find((i) => i.id === "leaderboard")?.onSelect();
    items.find((i) => i.id === "modes")?.onSelect();
    expect(calls).toEqual(["toggle:guild", "toggle:leaderboard", "exit"]);
  });

  it("a social row is pressed while its panel is open", () => {
    const { api } = fakeApi({ compact: true, panels: ["chat"] });
    const items = buildMoreItems(api, ["chat"], false);
    expect(items.find((i) => i.id === "chat")?.pressed).toBe(true);
    expect(items.find((i) => i.id === "guild")?.pressed).toBe(false);
    expect(items.some((i) => i.id === "modes")).toBe(false);
  });

  it("the desktop bar carries the four social buttons", () => {
    const { api } = fakeApi({ compact: false });
    const html = renderToStaticMarkup(<PanelButtons api={api} />);
    for (const title of ["Chat", "Guild", "Leaderboards", "Account"]) {
      expect(html).toContain(`title="${title}"`);
    }
    expect(html).not.toContain("More panels");
  });

  it("the phone bar has a More control and no social buttons of its own", () => {
    const { api } = fakeApi({ compact: true });
    const html = renderToStaticMarkup(<PanelButtons api={api} />);
    expect(html).toContain('aria-label="More panels"');
    expect(html).not.toContain('title="Leaderboards"');
  });
});
