/**
 * HUD general tests on real world snapshots (testSim + buildHud, not hand-made fixtures):
 * toasts and open panels (desktop reserve), panel buttons and the phone More menu, the settings
 * controls and their handlers, the onboarding tip card, and the character DPS panel.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createSlotRegistry } from "@gamez/ui-host";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { DEFAULT_AUTO_CONFIG, type AutoConfig } from "../src/resources.ts";
import { buildHud } from "../src/client/hudModel.ts";
import type {
  ClassicClientApi,
  HudSnapshot,
  PanelId,
  Settings,
  Store,
  UiState,
} from "../src/client/contract.ts";
import { ClassicHud, registerDefaultHud } from "../src/client/hud/index.tsx";
import { PanelButtons } from "../src/client/hud/widgets/PanelButtons.tsx";
import { MoreMenu, type MoreItem } from "../src/client/hud/widgets/MoreMenu.tsx";
import { CharacterPanel } from "../src/client/hud/panels/CharacterPanel.tsx";
import {
  QUALITY_OPTIONS,
  SettingsPanel,
  clampVolume,
  fullAutoConfig,
  settingsHandlers,
} from "../src/client/hud/panels/SettingsPanel.tsx";
import { tipsStore } from "../src/client/tips/index.ts";
import { spawnTestHero, testSim, useOpenMap } from "./support/harness.ts";

const SETTINGS: Settings = {
  showDamageNumbers: true,
  showLootLabels: true,
  showMinimap: true,
  zoom: 1,
  lighting: true,
  showPerf: false,
  masterVolume: 80,
  sfxVolume: 70,
  musicVolume: 50,
  muted: false,
  quality: "auto",
  tips: true,
};

function staticStore<T>(value: T): Store<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

/** A real play snapshot: a hero in the test world (tick 100). */
function playSnapshot(mut: (hud: HudSnapshot) => HudSnapshot = (h) => h): HudSnapshot {
  const sim = testSim([]);
  useOpenMap(sim, 1);
  spawnTestHero(sim.world, { x: 5, y: 5, gold: 42 });
  return mut(
    buildHud(sim.world, sim.loaded.registry, { tick: 100, hovered: 0, vendor: 0, prev: null }),
  );
}

function uiState(over: Partial<UiState> = {}): UiState {
  return {
    panels: [],
    toasts: [],
    settings: { ...SETTINGS },
    hover: null,
    compact: false,
    perf: { fps: 60, tickMs: 1, ticksPerSecond: 20, entities: 0, monsters: 0 },
    error: null,
    ...over,
  };
}

function fakeApi(opts: { hud?: (h: HudSnapshot) => HudSnapshot; ui?: Partial<UiState> } = {}) {
  const calls: { name: string; payload: unknown }[] = [];
  const updates: Partial<Settings>[] = [];
  const opened: PanelId[] = [];
  const hud = playSnapshot(opts.hud);
  const api: ClassicClientApi = {
    hud: staticStore(hud),
    log: staticStore([]),
    ui: staticStore(uiState(opts.ui)),
    act(name, payload) {
      calls.push({ name, payload });
      return { ok: true, events: [], tick: hud.tick };
    },
    togglePanel() {},
    openPanel(p) {
      opened.push(p);
    },
    closePanel() {},
    closeAll() {},
    setHover() {},
    updateSettings(patch) {
      updates.push(patch);
    },
    dismissToast() {},
    minimap: () => null,
    castSlot() {},
    drink() {},
    newGame() {},
    exit() {},
  };
  return { api, calls, updates, opened };
}

function renderHud(api: ClassicClientApi): string {
  const slots = createSlotRegistry();
  registerDefaultHud(slots);
  return renderToStaticMarkup(<ClassicHud api={api} slots={slots} />);
}

/** Every <button ...> start tag of a markup string. */
function buttonTags(markup: string): string[] {
  return markup.match(/<button[^>]*>/g) ?? [];
}

beforeEach(() => {
  tipsStore.reset();
});

describe("toasts and open panels (desktop)", () => {
  it("reserves the toast column on the right of the panel row while a panel is open", () => {
    const markup = renderHud(fakeApi({ ui: { panels: ["vendor"] } }).api);
    expect(markup).toMatch(/padding:64px 296px /);
  });

  it("keeps the panel row full width (no reserve) when no panel is open", () => {
    const markup = renderHud(fakeApi().api);
    expect(markup).not.toMatch(/padding:64px 296px /);
  });

  it("places the toast column at the right edge, 280 px wide", () => {
    const api = fakeApi({
      ui: {
        toasts: [{ id: 1, kind: "loot", title: "Found a sword", body: "", until: 1e12 }],
        panels: ["vendor"],
      },
    }).api;
    const markup = renderHud(api);
    expect(markup).toContain("Found a sword");
    expect(markup).toMatch(/right:8px;width:280px/);
  });
});

describe("panel buttons", () => {
  it("desktop: Talents (N) and Achievements (Y) sit with the other panel buttons", () => {
    const { api } = fakeApi();
    const markup = renderToStaticMarkup(<PanelButtons api={api} />);
    expect(markup).toContain('aria-label="Talents (N)"');
    expect(markup).toContain('aria-label="Achievements (Y)"');
    expect(markup).toContain('aria-label="Automap (Tab)"');
    expect(markup).toContain('aria-label="Settings"');
    expect(markup).not.toContain('aria-label="More panels"');
  });

  it("phone: the rarely used buttons live in a More menu, closed by default", () => {
    const { api } = fakeApi({ ui: { compact: true } });
    const markup = renderToStaticMarkup(<PanelButtons api={api} />);
    expect(markup).toContain('aria-label="More panels"');
    expect(markup).toContain('aria-label="Talents (N)"');
    expect(markup).not.toContain('aria-label="Achievements (Y)"');
    expect(markup).not.toContain('role="menu"');
  });

  it("every button on desktop and phone is at least 44 px tall", () => {
    for (const compact of [false, true]) {
      const { api } = fakeApi({ ui: { compact } });
      const markup = renderToStaticMarkup(<PanelButtons api={api} />);
      const tags = buttonTags(markup);
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(tag).toMatch(/min-height:44px/);
    }
  });

  it("the whole HUD keeps the 44 px rule for every button of the bottom bar on a phone", () => {
    const markup = renderHud(fakeApi({ ui: { compact: true } }).api);
    const panelRow = markup.slice(markup.indexOf('aria-label="Panels"'));
    for (const tag of buttonTags(panelRow).slice(0, 8)) expect(tag).toMatch(/min-height:44px/);
  });

  it("the More menu lists each item as a 44 px row and closes after a pick (controlled)", () => {
    const items: MoreItem[] = [
      {
        id: "achievements",
        text: "Achievements (Y)",
        title: "Achievements (Y)",
        onSelect: () => {},
      },
      { id: "log", text: "Log", title: "Log", onSelect: () => {} },
    ];
    const open = renderToStaticMarkup(<MoreMenu items={items} open setOpen={() => {}} />);
    expect(open).toContain('role="menu"');
    expect(open).toContain("Achievements (Y)");
    for (const tag of buttonTags(open)) expect(tag).toMatch(/min-height:44px/);
    const closed = renderToStaticMarkup(<MoreMenu items={items} open={false} setOpen={() => {}} />);
    expect(closed).not.toContain('role="menu"');
    expect(closed).toContain('aria-label="More panels"');
  });

  it("the More menu renders nothing when it has no items", () => {
    expect(renderToStaticMarkup(<MoreMenu items={[]} open={false} setOpen={() => {}} />)).toBe("");
  });
});

describe("settings", () => {
  it("shows the audio sliders, mute, graphics quality, tips and the loot filter entry", () => {
    const { api } = fakeApi({ ui: { panels: ["settings"] } });
    const markup = renderToStaticMarkup(<SettingsPanel api={api} />);
    expect(markup).toContain('aria-label="Master volume"');
    expect(markup).toContain('aria-label="Sound effects"');
    expect(markup).toContain('aria-label="Music"');
    expect(markup).toContain("Mute");
    expect(markup).toContain('aria-label="Graphics quality: Auto"');
    expect(markup).toContain('aria-label="Graphics quality: High"');
    expect(markup).toContain("Show tips");
    expect(markup).toContain("Reset tips");
    expect(markup).toContain("Loot filter...");
  });

  it("shows the new automation toggles next to the wave 0 ones", () => {
    const { api } = fakeApi({ ui: { panels: ["settings"] } });
    const markup = renderToStaticMarkup(<SettingsPanel api={api} />);
    expect(markup).toContain("Repair worn gear at the smith");
    expect(markup).toContain("Craft with spare gold (smith)");
    expect(markup).toContain("Gamble with spare gold");
    expect(markup).toContain("Run Rifts once the dungeon is done");
    expect(markup).toContain("Apply automation");
  });

  it("the graphics segments are the four qualities in order", () => {
    expect(QUALITY_OPTIONS.map((q) => q.value)).toEqual(["auto", "low", "medium", "high"]);
  });

  it("clamps volumes to whole numbers 0..100", () => {
    expect(clampVolume(150)).toBe(100);
    expect(clampVolume(-4)).toBe(0);
    expect(clampVolume(42.6)).toBe(43);
    expect(clampVolume(Number.NaN)).toBe(0);
  });

  it("every control calls updateSettings or openPanel with its payload", () => {
    const { api, updates, opened } = fakeApi();
    const h = settingsHandlers(api);
    h.volume("masterVolume", 150);
    h.volume("sfxVolume", -3);
    h.volume("musicVolume", 42.4);
    h.muted(true);
    h.quality("low");
    h.tips(false);
    h.flag("showPerf", true);
    h.zoom(1.5);
    h.lootFilter();
    expect(updates).toEqual([
      { masterVolume: 100 },
      { sfxVolume: 0 },
      { musicVolume: 42 },
      { muted: true },
      { quality: "low" },
      { tips: false },
      { showPerf: true },
      { zoom: 1.5 },
    ]);
    expect(opened).toEqual(["lootFilter"]);
  });

  it("Reset tips forgets the dismissed tips", () => {
    tipsStore.dismiss("boss");
    expect(tipsStore.dismissed().has("boss")).toBe(true);
    settingsHandlers(fakeApi().api).resetTips();
    expect(tipsStore.dismissed().has("boss")).toBe(false);
  });

  it("Apply automation sends the whole draft as classic.setAutoConfig", () => {
    const { api, calls } = fakeApi();
    const draft: AutoConfig = { ...DEFAULT_AUTO_CONFIG, autoRepair: false, autoRift: false };
    settingsHandlers(api).applyAutomation(draft);
    expect(calls).toEqual([{ name: ACTION.setAutoConfig, payload: { config: draft } }]);
    expect(calls[0]?.name).toBe("classic.setAutoConfig");
  });

  it("fills the wave A automation fields of an older stored config with their defaults", () => {
    const full = fullAutoConfig({ lifePotionPct: 40 });
    expect(full.lifePotionPct).toBe(40);
    expect(full.autoRepair).toBe(true);
    expect(full.autoRift).toBe(true);
  });
});

describe("onboarding tip card", () => {
  it("shows the one due tip with Got it and a dismiss button", () => {
    const { api } = fakeApi({
      // Past level 3 the welcome tip is not due, so the skill point tip shows.
      hud: (h) => ({
        ...h,
        hero: h.hero ? { ...h.hero, level: 9, skillPoints: 1 } : null,
        control: { ...h.control, mode: "auto" },
      }),
    });
    const markup = renderHud(api);
    expect(markup).toContain('aria-label="Tip: Skill point"');
    expect(markup).toContain('aria-label="Got it: Skill point"');
    expect(markup).toContain('aria-label="Dismiss tip"');
  });

  it("hides the tip while a panel is open, and when Show tips is off", () => {
    const hud = (h: HudSnapshot): HudSnapshot => ({
      ...h,
      hero: h.hero ? { ...h.hero, level: 9, skillPoints: 1 } : null,
      control: { ...h.control, mode: "auto" },
    });
    expect(renderHud(fakeApi({ hud, ui: { panels: ["character"] } }).api)).not.toContain(
      'aria-label="Tip: Skill point"',
    );
    expect(
      renderHud(fakeApi({ hud, ui: { settings: { ...SETTINGS, tips: false } } }).api),
    ).not.toContain('aria-label="Tip: Skill point"');
  });

  it("does not show a dismissed tip again", () => {
    tipsStore.dismiss("skillPoint");
    const hud = (h: HudSnapshot): HudSnapshot => ({
      ...h,
      hero: h.hero ? { ...h.hero, level: 9, skillPoints: 1 } : null,
      control: { ...h.control, mode: "auto" },
    });
    expect(renderHud(fakeApi({ hud }).api)).not.toContain('aria-label="Tip: Skill point"');
  });
});

describe("character panel", () => {
  it("shows the damage table of the bar skills, effective life and the sources", () => {
    const { api } = fakeApi({ ui: { panels: ["character"] } });
    const markup = renderToStaticMarkup(<CharacterPanel api={api} />);
    expect(markup).toContain('aria-label="Damage per second of the bar skills"');
    expect(markup).toContain("Strike");
    expect(markup).toContain("Bolt");
    expect(markup).toContain("Effective life (physical hit)");
    for (const source of ["Items", "Sets", "Talents", "Buffs"]) {
      expect(markup).toContain(`>${source}<`);
    }
  });

  it("shows the achievement title under the hero line", () => {
    const { api } = fakeApi({
      hud: (h) => ({
        ...h,
        achievements: { unlocked: 0, total: 0, list: [], title: "Keeper of the Keys" },
      }),
    });
    expect(renderToStaticMarkup(<CharacterPanel api={api} />)).toContain("Keeper of the Keys");
  });
});
