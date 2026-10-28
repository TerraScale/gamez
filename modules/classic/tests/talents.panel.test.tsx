/**
 * Talents panel render tests (wave A, T-talents): server markup with a fake
 * ClassicClientApi (the pattern of hud.test.tsx). Covers the header, the node
 * states, the phone layout (one branch at a time), the reset price and the
 * Talents tab of the Skills panel.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type {
  ClassicClientApi,
  HudSnapshot,
  Store,
  TalentNodeView,
  TalentsView,
  UiState,
} from "../src/client/contract.ts";
import { TalentsBody, TalentsPanel } from "../src/client/hud/panels/TalentsPanel.tsx";
import { SkillsPanel } from "../src/client/hud/panels/SkillsPanel.tsx";

function staticStore<T>(value: T): Store<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

function node(over: Partial<TalentNodeView> & { id: string; name: string }): TalentNodeView {
  return {
    description: "Adds {v} maximum life.",
    icon: "icon.talent.x",
    tier: 0,
    col: 0,
    rank: 0,
    maxRank: 3,
    learnable: false,
    locked: false,
    requires: null,
    lines: [],
    ...over,
  };
}

const VIEW: TalentsView = {
  tree: "classic.talents.warrior",
  name: "Warrior",
  branches: ["Bulwark", "Warcry", "Fury"],
  tierPoints: 3,
  points: 2,
  spent: 4,
  resetCost: 180,
  canReset: false,
  nodes: [
    node({
      id: "a.hardened",
      name: "Hardened",
      rank: 1,
      learnable: true,
      lines: ["Current: +6 maximum life"],
    }),
    node({
      id: "a.iron",
      name: "Iron Stance",
      tier: 1,
      col: 0,
      locked: true,
      requires: "a.hardened",
    }),
    node({ id: "a.war", name: "War Bellow", col: 1, maxRank: 3 }),
    node({ id: "a.fury", name: "Sharpened Edge", col: 2, rank: 5, maxRank: 5 }),
  ],
};

function makeApi(opts: { talents?: TalentsView | null; compact?: boolean } = {}): ClassicClientApi {
  const hud = {
    skills: [],
    hero: null,
    talents: opts.talents === undefined ? VIEW : opts.talents,
  } as unknown as HudSnapshot;
  const ui = {
    panels: [],
    toasts: [],
    compact: opts.compact ?? false,
    error: null,
  } as unknown as UiState;
  return {
    hud: staticStore(hud),
    log: staticStore([]),
    ui: staticStore(ui),
    act: () => ({ ok: true, events: [], tick: 0 }),
    togglePanel() {},
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
    exit() {},
  };
}

describe("TalentsPanel", () => {
  it("shows the header with points and the branch columns on desktop", () => {
    const html = renderToStaticMarkup(<TalentsPanel api={makeApi()} />);
    expect(html).toContain('aria-label="Talents"');
    expect(html).toContain("Warrior class tree");
    expect(html).toContain("2 to spend · 4 spent");
    expect(html).toContain("Bulwark");
    expect(html).toContain("Warcry");
    expect(html).toContain("Fury");
    expect(html).not.toContain("Show Warcry");
  });

  it("renders every node as a 44px button with its rank and state", () => {
    const html = renderToStaticMarkup(<TalentsPanel api={makeApi()} />);
    expect(html).toContain('aria-label="Hardened, rank 1 of 3"');
    expect(html).toContain('aria-label="Iron Stance, rank 0 of 3, locked"');
    expect(html).toContain('aria-label="Sharpened Edge, rank 5 of 5, maxed"');
    expect(html).toContain("min-height:44px");
    expect(html).toContain("Ready");
    expect(html).toContain("Locked");
  });

  it("shows the reset price and disables the reset when it cannot be done", () => {
    const html = renderToStaticMarkup(<TalentsPanel api={makeApi()} />);
    expect(html).toContain("Reset · 180 gold");
    const reset = html.match(/<button[^>]*aria-label="Reset talents"[^>]*>/);
    expect(reset?.[0]).toContain("disabled");
  });

  it("uses one branch at a time on phones, with a segmented control", () => {
    const html = renderToStaticMarkup(<TalentsPanel api={makeApi({ compact: true })} />);
    expect(html).toContain('aria-label="Show Bulwark"');
    expect(html).toContain('aria-label="Show Warcry"');
    expect(html).toContain('aria-label="Show Fury"');
    expect(html).toContain('aria-pressed="true"');
    // Only the first branch's nodes are drawn.
    expect(html).toContain("Hardened");
    expect(html).not.toContain("War Bellow");
    expect(html).not.toContain("Sharpened Edge");
  });

  it("says so when the hero has no talent tree", () => {
    const html = renderToStaticMarkup(<TalentsBody api={makeApi({ talents: null })} />);
    expect(html).toContain("Talents appear once your hero has a class tree.");
  });

  it("preselects the first learnable node and shows its learn action", () => {
    const html = renderToStaticMarkup(<TalentsPanel api={makeApi()} />);
    expect(html).not.toContain("Select a talent to see what it does.");
    expect(html).toContain('aria-label="Learn Hardened"');
    expect(html).toContain("Ready to learn");
  });

  it("keeps the details under the tree when embedded in the Skills panel", () => {
    const html = renderToStaticMarkup(<TalentsBody api={makeApi()} stacked />);
    expect(html).toContain("flex-direction:column;align-items:flex-start");
    expect(html).toContain('aria-label="Learn Hardened"');
  });
});

describe("SkillsPanel tabs", () => {
  it("opens on the Skills tab with a Talents tab next to it", () => {
    const html = renderToStaticMarkup(<SkillsPanel api={makeApi()} />);
    expect(html).toContain('aria-label="Skills tab"');
    expect(html).toContain('aria-label="Talents tab"');
    expect(html).toContain("No skills yet.");
    expect(html).not.toContain("Select a talent to see what it does.");
  });
});
