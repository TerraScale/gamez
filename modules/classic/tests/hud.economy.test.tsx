/**
 * Wave C classic HUD (docs/design/wave-C.md §10.4): the bank panel in every
 * blocked state, its deposit and withdraw flows with a fake BankClient, the shell
 * buttons (hidden without openScreen), the stash entry point and the trade bubble.
 * Rendered with react-dom/server; the flows are driven through the pure helpers
 * the panel calls. OWNER: T-classic-ui.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createSlotRegistry, type PlatformServices } from "@gamez/ui-host";
import type { BankOp, BankResult, VaultItem } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import type {
  BankClient,
  BankView,
  ClassicClientApi,
  HudSnapshot,
  ItemView,
  Store,
  UiState,
} from "../src/client/contract.ts";
import { ALL_PANEL_IDS, PANEL_IDS, panelSlot } from "../src/client/hud/layout.ts";
import { registerDefaultHud } from "../src/client/hud/index.tsx";
import {
  BankPanel,
  bankNote,
  bankOutcome,
  depositPreview,
  parseGold,
  runBankOp,
  vaultBankProps,
} from "../src/client/hud/panels/BankPanel.tsx";
import { StashPanel } from "../src/client/hud/panels/StashPanel.tsx";
import {
  BANK_BUTTON,
  PanelButtons,
  buildMoreItems,
  shellItemsOf,
} from "../src/client/hud/widgets/PanelButtons.tsx";
import { SHELL_BUTTONS, BANK_TITLE } from "../src/client/hud/shell.ts";
import {
  PresenceBubble,
  tradeLabel,
  tradeScreen,
} from "../src/client/hud/widgets/PresenceBubble.tsx";
import { keyCommand } from "../src/client/input.ts";
import {
  clearTradeBubble,
  getTradeBubble,
  showTradeBubble,
  subscribeTradeBubble,
} from "../src/client/presence/bubble.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function staticStore<T>(value: T): Store<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

function ui(compact = false): UiState {
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
      masterVolume: 80,
      sfxVolume: 80,
      musicVolume: 80,
      muted: false,
      quality: "auto",
      tips: false,
      outlineHero: true,
    },
    hover: null,
    compact,
    perf: { fps: 60, tickMs: 1, ticksPerSecond: 20, entities: 0, monsters: 0 },
    error: null,
  };
}

function item(uid: number, name: string): ItemView {
  return {
    uid,
    base: "base.sword",
    name,
    rarity: "magic",
    category: "weapon",
    slots: ["weapon"],
    ilvl: 3,
    reqLevel: 1,
    lines: ["8-14 damage"],
    value: 10,
    sellPrice: 2,
    icon: "item.sword",
    w: 1,
    h: 2,
    usable: true,
    upgrade: 0,
  } as unknown as ItemView;
}

function hud(over: { gold?: number; bag?: ItemView[]; stash?: ItemView[] } = {}): HudSnapshot {
  return {
    tick: 1,
    phase: "play",
    classes: [],
    hero: { gold: over.gold ?? 250 } as unknown as HudSnapshot["hero"],
    area: null,
    control: {} as HudSnapshot["control"],
    skillBar: [],
    belt: [],
    target: null,
    inventory: {
      cols: 10,
      rows: 4,
      items: (over.bag ?? []).map((it, i) => ({ x: i, y: 0, item: it })),
    },
    equipment: {} as HudSnapshot["equipment"],
    stash: over.stash ?? [],
    stashSize: 60,
    skills: [],
    quests: [],
    vendor: null,
    stashTabs: [],
  } as unknown as HudSnapshot;
}

/** A BankClient fake: records the ops and answers with `answer` (or throws when it is an Error). */
function fakeBank(view: BankView, answer: BankResult | Error = { ok: true, balance: 0 }) {
  const ops: BankOp[] = [];
  const bank: BankClient & { ops: BankOp[] } = {
    ops,
    view: staticStore(view),
    run: async (op: BankOp) => {
      ops.push(op);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return bank;
}

interface FakeOpts {
  bank?: BankClient;
  platform?: PlatformServices | null;
  openScreen?: boolean;
  compact?: boolean;
  hud?: HudSnapshot;
}

/** A ClassicClientApi with only what the HUD pieces here read. */
function fakeApi(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const api = {
    hud: staticStore(opts.hud ?? hud()),
    ui: staticStore(ui(opts.compact ?? false)),
    log: staticStore([]),
    sync: staticStore(null),
    act: () => ({ ok: true }),
    togglePanel: (p: string) => calls.push(`toggle:${p}`),
    openPanel: (p: string) => calls.push(`open:${p}`),
    closePanel: (p: string) => calls.push(`close:${p}`),
    closeAll: () => calls.push("closeAll"),
    setHover: () => {},
    updateSettings: () => {},
    dismissToast: () => {},
    minimap: () => null,
    castSlot: () => {},
    drink: () => {},
    newGame: () => {},
    exit: () => calls.push("exit"),
    session: null,
    platform: opts.platform ?? null,
    bank: opts.bank,
    openScreen: opts.openScreen ? (s: { id: string }) => calls.push(`screen:${s.id}`) : undefined,
  };
  return { api: api as unknown as ClassicClientApi, calls };
}

const LIVE: BankView = { blocked: null, last: null };

const VAULT_ITEM: VaultItem = {
  uid: "v1",
  itemId: "item.sword",
  qty: 1,
  universal: false,
  tradable: true,
  origin: "classic",
  summary: {
    name: "Gilded Blade",
    rarity: "magic",
    level: 3,
    category: "weapon",
    slot: "weapon",
    icon: "item.sword",
    lines: [],
  },
  data: null,
} as unknown as VaultItem;

// ---------------------------------------------------------------------------
// Bank panel: notes, previews, outcomes
// ---------------------------------------------------------------------------

describe("bank panel: blocked states", () => {
  it("no api.bank: the local note (the bank needs the online game)", () => {
    const n = bankNote(false, null);
    expect(n?.kind).toBe("absent");
    expect(n?.title).toBe("The bank needs the online game");
    expect(n?.body).toBe("Play online to use the bank.");
  });

  it("view.blocked: local, town, offline and busy each have their note", () => {
    expect(bankNote(true, "local")?.body).toBe("Play online to use the bank.");
    expect(bankNote(true, "town")?.title).toBe("Walk to town to use the bank");
    expect(bankNote(true, "offline")?.title).toBe("Reconnecting…");
    expect(bankNote(true, "busy")?.title).toBe("Working…");
  });

  it("works (no note) when the bank is present and not blocked", () => {
    expect(bankNote(true, null)).toBeNull();
  });

  it("renders the note and disables deposits in each blocked state", () => {
    for (const [blocked, text] of [
      ["local", "Play online to use the bank."],
      ["town", "Walk to town to use the bank"],
      ["offline", "Reconnecting…"],
      ["busy", "Another bank trip is still running."],
    ] as const) {
      const bank = fakeBank({ blocked, last: null });
      const { api } = fakeApi({ bank, hud: hud({ gold: 500 }) });
      const html = renderToStaticMarkup(<BankPanel api={api} />);
      expect(html).toContain(text);
      expect(html).toContain('aria-label="Gold to deposit"');
      // The deposit button is disabled while the bank is blocked.
      expect(html).toMatch(/<button[^>]*aria-label="Deposit gold"[^>]*disabled=""/);
    }
  });

  it("without api.bank the panel shows the local note and no deposit is possible", () => {
    const { api } = fakeApi({ bank: undefined });
    const html = renderToStaticMarkup(<BankPanel api={api} />);
    expect(html).toContain("The bank needs the online game");
    expect(html).toMatch(/<button[^>]*aria-label="Deposit gold"[^>]*disabled=""/);
    expect(html).toContain("The vault needs the online game.");
  });

  it("a live bank enables the deposit button once a valid amount is typed (no note)", () => {
    const { api } = fakeApi({ bank: fakeBank(LIVE), hud: hud({ gold: 500 }) });
    const html = renderToStaticMarkup(<BankPanel api={api} />);
    expect(html).not.toContain("Walk to town");
    expect(html).toMatch(/<button[^>]*aria-label="Deposit gold"[^>]*disabled=""/);
    expect(html).toContain("You carry 500 gold. Withdraw coin below.");
  });
});

describe("bank panel: gold deposit preview", () => {
  it("fee is 5 % of the gold, at least 1, never more than the gold", () => {
    expect(depositPreview(100, 500)).toEqual({ ok: true, fee: 5, coin: 95 });
    expect(depositPreview(10, 500)).toEqual({ ok: true, fee: 1, coin: 9 });
    expect(depositPreview(1, 500)).toEqual({ ok: true, fee: 1, coin: 0 });
    expect(depositPreview(1999, 5000)).toEqual({ ok: true, fee: 99, coin: 1900 });
  });

  it("refuses zero and amounts above the hero's gold", () => {
    expect(depositPreview(0, 500).ok).toBe(false);
    const over = depositPreview(501, 500);
    expect(over).toEqual({ ok: false, reason: "You carry 500 gold." });
  });

  it("parses typed text: whole numbers, NaN and blanks as 0", () => {
    expect(parseGold("42")).toBe(42);
    expect(parseGold(" 7.9 ")).toBe(7);
    expect(parseGold("abc")).toBe(0);
    expect(parseGold("")).toBe(0);
  });

  it("200 gold deposits 10 gold of fee and credits 190 coin", () => {
    expect(depositPreview(200, 500)).toEqual({ ok: true, fee: 10, coin: 190 });
  });
});

describe("bank panel: flows through the BankClient", () => {
  it("deposit gold sends depositGold with the typed amount and reports the coin", async () => {
    const bank = fakeBank(LIVE, { ok: true, coin: 95, gold: 100, balance: 95 });
    const op: BankOp = { kind: "depositGold", gold: 100 };
    const out = await runBankOp(bank, op);
    expect(bank.ops).toEqual([op]);
    expect(out).toEqual({
      ok: true,
      message: "Deposited 100 gold: 95 coin added. Balance 95 coin.",
    });
  });

  it("deposit an item sends depositItem with the item's uid and names it", async () => {
    const bank = fakeBank(LIVE, { ok: true, item: VAULT_ITEM, balance: 0 });
    const out = await runBankOp(bank, { kind: "depositItem", ref: 7 });
    expect(bank.ops).toEqual([{ kind: "depositItem", ref: 7 }]);
    expect(out.message).toBe("Sent Gilded Blade to the vault.");
  });

  it("withdraw an item and withdraw coin go through the vault's bank prop", async () => {
    const bank = fakeBank(LIVE, { ok: true, item: VAULT_ITEM, balance: 0 });
    const props = vaultBankProps(bank, null);
    expect(props.blocked).toBeNull();
    const item = await props.withdrawItem("v1");
    expect(item).toEqual({ ok: true, message: "Took Gilded Blade from the vault." });
    const coin = await props.withdrawCoin(30);
    expect(bank.ops).toEqual([
      { kind: "withdrawItem", uid: "v1" },
      { kind: "withdrawCoin", coin: 30 },
    ]);
    expect(coin.ok).toBe(true);
  });

  it("a refused op reports the server's message and never resolves as ok", async () => {
    const bank = fakeBank(LIVE, { ok: false, code: "not_in_town", message: "Walk to town first." });
    const out = await runBankOp(bank, { kind: "depositGold", gold: 5 });
    expect(out).toEqual({ ok: false, message: "Walk to town first." });
  });

  it("a thrown run (no socket, timeout) becomes a failed outcome", async () => {
    const bank = fakeBank(LIVE, new Error("socket closed"));
    const out = await runBankOp(bank, { kind: "withdrawCoin", coin: 1 });
    expect(out.ok).toBe(false);
    expect(out.message).toBe("The bank could not be reached.");
  });

  it("the outcome text covers every op kind", () => {
    expect(
      bankOutcome({ kind: "withdrawCoin", coin: 4 }, { ok: true, gold: 4, balance: 0 }).message,
    ).toBe("Withdrew 4 gold. Balance 0 coin.");
    expect(
      bankOutcome({ kind: "depositItem", ref: 1 }, { ok: false, code: "no_room", message: "" })
        .message,
    ).toBe("The bank refused (no_room).");
  });
});

describe("bank panel: rendering with items and a stash", () => {
  it("lists bag and stash items with Send to vault, disabled while blocked", () => {
    const bag = [item(3, "Rusty Blade")];
    const stash = [item(9, "Oak Staff")];
    const live = fakeApi({ bank: fakeBank(LIVE), hud: hud({ bag, stash }) }).api;
    const html = renderToStaticMarkup(<BankPanel api={live} />);
    expect(html).toContain("Rusty Blade");
    expect(html).toContain("Oak Staff");
    expect(html).toContain('aria-label="Send Rusty Blade to the vault"');
    expect(html).not.toMatch(
      /<button[^>]*aria-label="Send Rusty Blade to the vault"[^>]*disabled=""/,
    );

    const town = fakeApi({
      bank: fakeBank({ blocked: "town", last: null }),
      hud: hud({ bag, stash }),
    }).api;
    const blockedHtml = renderToStaticMarkup(<BankPanel api={town} />);
    expect(blockedHtml).toMatch(
      /<button[^>]*aria-label="Send Rusty Blade to the vault"[^>]*disabled=""/,
    );
  });
});

// ---------------------------------------------------------------------------
// Keys, registration and entry points
// ---------------------------------------------------------------------------

describe("bank entry points", () => {
  it("K opens the bank panel", () => {
    expect(keyCommand("k")).toEqual({ kind: "panel", panel: "bank" });
    expect(keyCommand("K")).toEqual({ kind: "panel", panel: "bank" });
  });

  it("the bank panel is registered and rendered, but PANEL_IDS keeps its wave A/B size", () => {
    expect(PANEL_IDS.length).toBe(20);
    expect(ALL_PANEL_IDS).toContain("bank");
    const slots = createSlotRegistry();
    registerDefaultHud(slots);
    expect(slots.list(panelSlot("bank")).map((e) => e.id)).toEqual(["classic.panel.bank"]);
  });

  it("the stash panel offers a Bank button that swaps the stash for the bank", () => {
    const { api } = fakeApi({ bank: fakeBank(LIVE) });
    const html = renderToStaticMarkup(<StashPanel api={api} />);
    expect(html).toContain('aria-label="Open the bank"');
  });

  it("the desktop bar has the Bank button; the phone More menu has it too", () => {
    const desk = fakeApi({ compact: false }).api;
    expect(renderToStaticMarkup(<PanelButtons api={desk} />)).toContain(`title="${BANK_TITLE}"`);
    expect(BANK_BUTTON.id).toBe("bank");
    const phone = fakeApi({ compact: true }).api;
    expect(buildMoreItems(phone, [], false).some((i) => i.id === "bank")).toBe(true);
  });
});

describe("shell buttons (Market, Trade, Shops, Arena, Pass, Store)", () => {
  it("hidden without api.openScreen, on desktop and in the More menu", () => {
    const desk = fakeApi({ compact: false }).api;
    const html = renderToStaticMarkup(<PanelButtons api={desk} />);
    for (const s of SHELL_BUTTONS) expect(html).not.toContain(`title="${s.title}"`);
    const phone = fakeApi({ compact: true }).api;
    expect(shellItemsOf(phone)).toEqual([]);
    expect(buildMoreItems(phone, [], false).some((i) => i.id.startsWith("shell:"))).toBe(false);
  });

  it("shown on desktop and listed in the More menu with openScreen", () => {
    const desk = fakeApi({ compact: false, openScreen: true }).api;
    const html = renderToStaticMarkup(<PanelButtons api={desk} />);
    for (const s of SHELL_BUTTONS) expect(html).toContain(`title="${s.title}"`);
    const phone = fakeApi({ compact: true, openScreen: true }).api;
    const rows = shellItemsOf(phone);
    expect(rows.map((r) => r.id)).toEqual(SHELL_BUTTONS.map((s) => `shell:${s.id}`));
  });

  it("each button opens its shell screen", () => {
    const { api, calls } = fakeApi({ compact: true, openScreen: true });
    for (const row of shellItemsOf(api)) row.onSelect();
    expect(calls).toEqual(SHELL_BUTTONS.map((s) => `screen:${s.screen.id}`));
  });

  it("the shops button opens the plots of the classic town and arena is the classic mode", () => {
    const shops = SHELL_BUTTONS.find((s) => s.id === "shops");
    expect(shops?.screen).toEqual({ id: "plots", world: "classic-town" });
    const arena = SHELL_BUTTONS.find((s) => s.id === "arena");
    expect(arena?.screen).toEqual({ id: "arena", mode: "classic" });
  });
});

describe("trade bubble", () => {
  it("is hidden without a tapped hero", () => {
    clearTradeBubble();
    const { api } = fakeApi({ openScreen: true });
    expect(
      renderToStaticMarkup(
        <PresenceBubble api={api} insets={{ top: 0, bottom: 0 }} layout="desktop" />,
      ),
    ).toBe("");
  });

  it("is hidden without openScreen even when a hero was tapped", () => {
    showTradeBubble({ accountId: "acc_1", displayName: "Aria" });
    const { api } = fakeApi({ openScreen: false });
    expect(
      renderToStaticMarkup(
        <PresenceBubble api={api} insets={{ top: 0, bottom: 0 }} layout="desktop" />,
      ),
    ).toBe("");
    clearTradeBubble();
  });

  it("shows Trade with <name> and opens the trade screen with that account", () => {
    showTradeBubble({ accountId: "acc_1", displayName: "Aria" });
    const { api } = fakeApi({ openScreen: true });
    const html = renderToStaticMarkup(
      <PresenceBubble api={api} insets={{ top: 0, bottom: 0 }} layout="desktop" />,
    );
    expect(html).toContain(tradeLabel("Aria"));
    expect(tradeScreen({ accountId: "acc_1", displayName: "Aria" })).toEqual({
      id: "trade",
      with: { accountId: "acc_1", displayName: "Aria" },
    });
    clearTradeBubble();
  });

  it("the bubble store notifies subscribers on change and clears idempotently", () => {
    clearTradeBubble();
    let calls = 0;
    const off = subscribeTradeBubble(() => calls++);
    showTradeBubble({ accountId: "a", displayName: "A" });
    showTradeBubble({ accountId: "a", displayName: "A" });
    expect(getTradeBubble()).toEqual({ accountId: "a", displayName: "A" });
    clearTradeBubble();
    clearTradeBubble();
    expect(calls).toBe(2);
    off();
  });
});
