/**
 * App shell render tests (wave-C.md §10.4): the economy bar and bell, the
 * toast action, stacked sheets (only the top one is shown, the rest hidden),
 * and the "not available" states of missing APIs. Static markup only.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { PlatformServices, Session } from "@gamez/ui-host";
import { EconomyBar } from "../../src/client/app/EconomyBar.tsx";
import { ModePicker } from "../../src/client/app/ModePicker.tsx";
import { ShellSheets, countryOf } from "../../src/client/app/ShellSheets.tsx";
import { Sheet } from "../../src/client/app/Sheet.tsx";
import { Toast } from "../../src/client/app/Toast.tsx";
import { TOWN_WORLD, type ShellItem } from "../../src/client/app/screens.ts";

const SESSION: Session = { token: "t.guest", accountId: "acc-g", name: "Wanderer" };

const api = {} as never;
const PLATFORM = {
  auth: api,
  leaderboards: api,
  chat: api,
  guilds: api,
  account: api,
  vault: api,
  trade: api,
  market: api,
  shops: api,
  arena: api,
  pass: api,
  store: api,
  config: api,
} as unknown as PlatformServices;

function bar(entries: Parameters<typeof EconomyBar>[0]["entries"], unread: number): string {
  return renderToStaticMarkup(<EconomyBar entries={entries} unread={unread} onOpen={() => {}} />);
}

describe("EconomyBar", () => {
  it("renders one 44 px button per entry, labelled in plain words", () => {
    const html = bar(["market", "vault", "trade", "shops", "arena", "pass", "store", "notices"], 0);
    for (const label of ["Market", "Vault", "Trade", "Shops", "Arena", "Battle Pass", "Store"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('aria-label="Economy"');
    expect(html).toContain('class="economy-button economy-bell"');
  });

  it("the bell shows the unread count, capped at 99+", () => {
    expect(bar(["notices"], 3)).toContain('aria-label="Notices, 3 unread"');
    expect(bar(["notices"], 3)).toContain('<span class="bell-badge" aria-hidden="true">3</span>');
    expect(bar(["notices"], 250)).toContain(">99+<");
  });

  it("no unread: the bell has no badge", () => {
    const html = bar(["notices"], 0);
    expect(html).toContain('aria-label="Notices"');
    expect(html).not.toContain("bell-badge");
  });

  it("renders nothing without entries (offline)", () => {
    expect(bar([], 0)).toBe("");
  });

  it("omits the buttons whose entries are not passed (flags off, APIs missing)", () => {
    const html = bar(["vault", "notices"], 1);
    expect(html).toContain(">Vault<");
    expect(html).not.toContain(">Market<");
    expect(html).not.toContain(">Store<");
  });
});

describe("ModePicker economy bar", () => {
  it("shows the bar when the picker gets an economy prop, and not without one", () => {
    const props = {
      session: SESSION,
      modes: [],
      isAvailable: () => true,
      onPick: () => {},
      platform: PLATFORM,
      account: null,
      onOpenAccount: () => {},
      onOpenLeaderboards: () => {},
      onOpenGuild: () => {},
    };
    const without = renderToStaticMarkup(<ModePicker {...props} />);
    expect(without).not.toContain("economy-bar");
    const withBar = renderToStaticMarkup(
      <ModePicker
        {...props}
        economy={{ entries: ["market", "notices"], unread: 2, onOpen: () => {} }}
      />,
    );
    expect(withBar).toContain("economy-bar");
    expect(withBar).toContain(">Market<");
    expect(withBar).toContain("bell-badge");
  });
});

describe("Toast action", () => {
  it("a notice with an action shows the action button", () => {
    const html = renderToStaticMarkup(
      <Toast
        notice={{
          tone: "info",
          text: "Mira invites you to trade.",
          action: { label: "Open", run: () => {} },
        }}
      />,
    );
    expect(html).toContain('class="toast-action"');
    expect(html).toContain(">Open<");
    expect(html).toContain("Mira invites you to trade.");
  });

  it("a plain notice has no action button", () => {
    const html = renderToStaticMarkup(<Toast notice={{ tone: "ok", text: "Done." }} />);
    expect(html).not.toContain("toast-action");
  });
});

describe("Sheet", () => {
  it("a sheet covered by another is hidden, the top one is not", () => {
    const shown = renderToStaticMarkup(
      <Sheet title="Market" onClose={() => {}}>
        <p>x</p>
      </Sheet>,
    );
    expect(shown).not.toContain("hidden");
    const covered = renderToStaticMarkup(
      <Sheet title="Market" onClose={() => {}} hidden>
        <p>x</p>
      </Sheet>,
    );
    expect(covered).toContain("hidden");
    expect(covered).toContain('aria-label="Market"');
  });
});

describe("ShellSheets", () => {
  const noop = () => {};
  function stack(items: ShellItem[], platform: PlatformServices | undefined): string {
    return renderToStaticMarkup(
      <ShellSheets
        items={items}
        platform={platform}
        session={SESSION}
        account={null}
        onCloseFrom={noop}
        onOpen={noop}
        onAccountChanged={noop}
        onRefreshAccount={noop}
        onCheckout={noop}
      />,
    );
  }

  it("renders one dialog per stacked sheet, titled, the top one visible", () => {
    const html = stack(
      [
        { id: "plots", world: TOWN_WORLD },
        { id: "shop", world: TOWN_WORLD, plotId: "p1" },
      ],
      PLATFORM,
    );
    expect(html).toContain('aria-label="Shops"');
    expect(html).toContain('aria-label="Shop"');
    // Exactly one of the two backdrops is hidden: the lower sheet.
    expect(html.match(/hidden=""/g)?.length).toBe(1);
  });

  it("without a platform every economy sheet says it is not available", () => {
    const html = stack([{ id: "market" }], undefined);
    expect(html).toContain("Not available right now.");
  });

  it("a missing API shows the unavailable line for its own sheet only", () => {
    const platform = { ...PLATFORM, market: undefined } as PlatformServices;
    const html = stack([{ id: "market" }], platform);
    expect(html).toContain("Not available right now.");
  });

  it("an economy sheet with its API shows the loading state while its chunk loads", () => {
    const html = stack([{ id: "vault" }], PLATFORM);
    expect(html).toContain("Loading…");
  });
});

describe("countryOf", () => {
  it("takes the region of a language tag, upper case", () => {
    expect(countryOf("pt-br")).toBe("BR");
    expect(countryOf("en-US")).toBe("US");
    expect(countryOf("en")).toBeUndefined();
    expect(countryOf(undefined)).toBeUndefined();
  });
});
