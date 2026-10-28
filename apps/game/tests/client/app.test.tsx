/**
 * App shell render tests (wave-B.md §8.2, §10): the picker header (guest vs
 * registered, offline) and the social entry points, rendered with
 * react-dom/server. Platform fakes only implement what the markup reads.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { AccountView, PlatformServices, Session } from "@gamez/ui-host";
import type { ModeInfo } from "@gamez/protocol";
import { AccountChip, isRegistered } from "../../src/client/app/AccountChip.tsx";
import { channelsFor } from "../../src/client/app/ChatDock.tsx";
import { ModePicker, type ModePickerProps } from "../../src/client/app/ModePicker.tsx";
import { SocialBar } from "../../src/client/app/SocialBar.tsx";
import { Toast } from "../../src/client/app/Toast.tsx";

const GUEST: Session = { token: "t.guest", accountId: "acc-g", name: "Wanderer" };
const REGISTERED: Session = {
  token: "t.reg",
  accountId: "acc-r",
  name: "Mira",
  kind: "registered",
};

function account(over: Partial<AccountView> = {}): AccountView {
  return {
    accountId: "acc-r",
    displayName: "Mira",
    kind: "registered",
    identities: [{ provider: "email", email: "mira@example.test" }],
    guildId: null,
    guildTag: null,
    createdAt: 1,
    ...over,
  };
}

/** A platform whose parts the picker never calls during a static render. */
const FAKE_PLATFORM = {
  auth: {},
  leaderboards: {},
  chat: {},
  guilds: {},
  account: {},
} as unknown as PlatformServices;

const MODES: ModeInfo[] = [
  { id: "classic", name: "Classic", description: "Idle ARPG", world: null },
  { id: "steps", name: "Steps", description: "Roguelike", world: null },
];

function picker(over: Partial<ModePickerProps> = {}): string {
  const props: ModePickerProps = {
    session: GUEST,
    modes: MODES,
    isAvailable: () => true,
    onPick: () => {},
    account: null,
    onOpenAccount: () => {},
    onOpenLeaderboards: () => {},
    onOpenGuild: () => {},
    ...over,
  };
  return renderToStaticMarkup(<ModePicker {...props} />);
}

describe("picker header", () => {
  it("guest with a platform: 'Save your progress' and the social entry points", () => {
    const html = picker({ platform: FAKE_PLATFORM, account: account({ kind: "guest" }) });
    expect(html).toContain("Save your progress");
    expect(html).toContain("Leaderboards");
    expect(html).toContain("Guild");
    expect(html).toContain("Chat");
    expect(html).not.toContain("Offline");
  });

  it("registered: the display name on the chip", () => {
    const html = picker({ platform: FAKE_PLATFORM, session: REGISTERED, account: account() });
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain(">Mira<");
    expect(html).not.toContain("Save your progress");
  });

  it("uses the session kind while the account is still loading", () => {
    const html = picker({ platform: FAKE_PLATFORM, session: REGISTERED, account: null });
    expect(html).toContain(">Mira<");
  });

  it("offline: no chip actions, no social entry points, no chat dock", () => {
    const html = picker({ platform: undefined, account: null });
    expect(html).toContain("Offline");
    expect(html).not.toContain("Save your progress");
    expect(html).not.toContain("Leaderboards");
    expect(html).not.toContain("social-bar");
    expect(html).not.toContain("chat-dock");
  });

  it("keeps the mode cards and the availability badge", () => {
    const html = picker({ isAvailable: (id) => id !== "steps" });
    expect(html).toContain('class="mode-card"');
    expect(html).toContain("Not available yet");
  });

  it("the collapsed chat dock is a 48 px toggle, closed by default", () => {
    const html = picker({ platform: FAKE_PLATFORM, account: account() });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("chat-window");
  });
});

describe("AccountChip", () => {
  it("guest and registered are told apart by the account, else by the session", () => {
    expect(isRegistered(GUEST, null)).toBe(false);
    expect(isRegistered(REGISTERED, null)).toBe(true);
    expect(isRegistered(GUEST, account())).toBe(true);
    expect(isRegistered(REGISTERED, account({ kind: "guest" }))).toBe(false);
  });

  it("renders the offline label without a platform", () => {
    const html = renderToStaticMarkup(
      <AccountChip session={GUEST} account={null} online={false} onOpen={() => {}} />,
    );
    expect(html).toBe('<span class="chip chip-offline">Offline</span>');
  });
});

describe("SocialBar and chat channels", () => {
  it("shows the guild tag when in a guild", () => {
    const html = renderToStaticMarkup(
      <SocialBar guildTag="ASH" onLeaderboards={() => {}} onGuild={() => {}} />,
    );
    expect(html).toContain("Guild [ASH]");
  });

  it("chat channels: global, plus the guild channel only in a guild", () => {
    expect(channelsFor(null).map((c) => c.id)).toEqual(["global"]);
    expect(channelsFor("ash-wolves").map((c) => c.id)).toEqual(["global", "guild:ash-wolves"]);
  });
});

describe("Toast", () => {
  it("is an alert for errors and a status otherwise", () => {
    expect(renderToStaticMarkup(<Toast notice={null} />)).toBe("");
    expect(renderToStaticMarkup(<Toast notice={{ tone: "error", text: "No." }} />)).toContain(
      'role="alert"',
    );
    expect(renderToStaticMarkup(<Toast notice={{ tone: "ok", text: "Yes." }} />)).toContain(
      'role="status"',
    );
  });
});
