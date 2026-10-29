/**
 * QA round 1 (classic HUD): Settings slider alignment, the phone More menu (outside press closes it,
 * anchored above the bottom bar), the bag scroller's overflow fades, and tip placement. No DOM
 * environment is installed, so the pointer and scroll rules are tested through their pure helpers
 * and the markup is rendered with react-dom/server.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ClassicClientApi, HudSnapshot, Settings, UiState } from "../src/client/contract.ts";
import { SettingsPanel, SLIDER_LABEL_WIDTH } from "../src/client/hud/panels/SettingsPanel.tsx";
import { MoreMenu, dismissOutside, type MoreItem } from "../src/client/hud/widgets/MoreMenu.tsx";
import { HUD_EDGE, moreMenuAnchor, tipLayout, type HudInsets } from "../src/client/hud/layout.ts";
import { scrollEdges } from "../src/client/hud/hooks.ts";
import { DEFAULT_AUTO_CONFIG } from "../src/resources.ts";

const SETTINGS = {
  outlineHero: true,
  showDamageNumbers: true,
  showLootLabels: true,
  showMinimap: true,
  zoom: 1,
  lighting: true,
  showPerf: false,
  masterVolume: 80,
  sfxVolume: 70,
  musicVolume: 60,
  muted: false,
  quality: "auto",
  tips: true,
} as unknown as Settings;

function staticStore<T>(value: T) {
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

function fakeApi(): ClassicClientApi {
  const ui = { settings: SETTINGS, panels: [], compact: true, toasts: [] } as unknown as UiState;
  const hud = {
    phase: "play",
    control: { mode: "manual", speed: 1, config: DEFAULT_AUTO_CONFIG },
  } as unknown as HudSnapshot;
  return {
    ui: staticStore(ui),
    hud: staticStore(hud),
    updateSettings: () => {},
    openPanel: () => {},
    closeAll: () => {},
    newGame: () => {},
    exit: () => {},
    act: () => {},
  } as unknown as ClassicClientApi;
}

// The label span of a slider row: React renders the minWidth of SLIDER_LABEL_WIDTH as inline style.
function labelSpan(text: string): string {
  return `<span style="min-width:${SLIDER_LABEL_WIDTH}px">${text}</span>`;
}

describe("settings sliders share one label width", () => {
  it("Zoom and the audio sliders use the same label column", () => {
    expect(SLIDER_LABEL_WIDTH).toBe(120);
    const markup = renderToStaticMarkup(<SettingsPanel api={fakeApi()} />);
    for (const label of ["Zoom", "Master volume", "Sound effects", "Music"]) {
      expect(markup).toContain(labelSpan(label));
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).not.toContain("min-width:70px");
  });

  it("Zoom keeps its range (0.5 to 2, step 0.1) and its x-format through the shared slider", () => {
    const markup = renderToStaticMarkup(<SettingsPanel api={fakeApi()} />);
    expect(markup).toMatch(/aria-label="Zoom"[^>]*min="0\.5"/);
    expect(markup).toMatch(/aria-label="Zoom"[^>]*max="2"/);
    expect(markup).toContain("1.0×");
  });
});

describe("phone More menu", () => {
  const items: MoreItem[] = [
    { id: "log", text: "Log", title: "Log", onSelect: () => {} },
    { id: "chat", text: "Chat", title: "Chat", onSelect: () => {} },
  ];

  it("a press inside the control keeps it open, a press outside closes it", () => {
    const inside = { tag: "inside" };
    const outside = { tag: "outside" };
    const root = { contains: (node: unknown) => node === inside };
    let closed = 0;
    const onDown = dismissOutside(
      () => root,
      () => {
        closed += 1;
      },
    );
    onDown({ target: inside });
    expect(closed).toBe(0);
    onDown({ target: outside });
    expect(closed).toBe(1);
  });

  it("does nothing when the control is no longer mounted", () => {
    let closed = 0;
    dismissOutside(
      () => null,
      () => {
        closed += 1;
      },
    )({ target: {} });
    expect(closed).toBe(0);
  });

  it("the open list is anchored above the whole bottom bar, not over the orbs row", () => {
    const markup = renderToStaticMarkup(
      <MoreMenu
        items={items}
        open
        setOpen={() => {}}
        anchorBottom={moreMenuAnchor("compact", 0)}
      />,
    );
    // Phone portrait (390x844): the bar takes 270 px (no measurement yet), the list sits 8 px above it.
    expect(markup).toContain('role="menu"');
    expect(markup).toContain("position:fixed");
    expect(markup).toContain("bottom:278px");
  });

  it("without an anchor the list keeps its old place above the trigger", () => {
    const markup = renderToStaticMarkup(<MoreMenu items={items} open setOpen={() => {}} />);
    expect(markup).toContain("position:absolute");
    expect(markup).not.toContain("position:fixed");
  });

  it("anchors above a measured bar that is taller than the layout constant", () => {
    expect(moreMenuAnchor("compact", 0)).toBe(270 + HUD_EDGE);
    expect(moreMenuAnchor("compact", 300)).toBe(300 + HUD_EDGE);
    expect(moreMenuAnchor("short", 0)).toBe(156 + HUD_EDGE);
  });
});

describe("bag scroller overflow affordance", () => {
  // The bag of a 9-column grid (9 x 44 px) in a 375 px phone card leaves 330 px of visible width.
  const CONTENT = 9 * 44;
  const VISIBLE = 330;

  it("shows the end fade when the bag is wider than its card and not yet scrolled", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: CONTENT, clientWidth: VISIBLE })).toEqual({
      start: false,
      end: true,
    });
  });

  it("shows both fades in the middle of the bag, and only the start fade at the end", () => {
    expect(scrollEdges({ scrollLeft: 40, scrollWidth: CONTENT, clientWidth: VISIBLE })).toEqual({
      start: true,
      end: true,
    });
    const atEnd = CONTENT - VISIBLE;
    expect(scrollEdges({ scrollLeft: atEnd, scrollWidth: CONTENT, clientWidth: VISIBLE })).toEqual({
      start: true,
      end: false,
    });
  });

  it("shows no fade when every cell fits (desktop bag, short bags)", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 396, clientWidth: 600 })).toEqual({
      start: false,
      end: false,
    });
    expect(scrollEdges({ scrollLeft: 0.5, scrollWidth: 330, clientWidth: 330 })).toEqual({
      start: false,
      end: false,
    });
  });
});

describe("tip placement stays off the playfield centre", () => {
  const insets: HudInsets = { top: 60, bottom: 150 };

  it("desktop: a bottom-right card, never centred", () => {
    const style = tipLayout("desktop", insets, false, false);
    expect(style).not.toBeNull();
    expect(style?.right).toBe(HUD_EDGE);
    expect(style?.left).toBeUndefined();
    expect(style?.transform).toBeUndefined();
    expect(style?.bottom).toBe(150 + HUD_EDGE + 4);
  });

  it("phone portrait: under the top region, clear of the minimap column", () => {
    const style = tipLayout("compact", { top: 60, bottom: 270 }, false, false);
    expect(style?.top).toBe(60 + HUD_EDGE);
    expect(style?.bottom).toBeUndefined();
    expect(style?.left).toBe(HUD_EDGE);
    // topRightInset("compact") = minimap width 106 + 2 x HUD_EDGE.
    expect(style?.right).toBe(106 + HUD_EDGE * 2);
  });

  it("phone portrait: full width once the top region is taller than the minimap column", () => {
    // The compact minimap block is 96 + 10 px; with HUD_EDGE above it, 114 px clears it.
    const tall = tipLayout("compact", { top: 150, bottom: 270 }, false, false);
    expect(tall?.top).toBe(150 + HUD_EDGE);
    expect(tall?.right).toBe(HUD_EDGE);
    expect(tipLayout("compact", { top: 113, bottom: 270 }, false, false)?.right).toBe(
      106 + HUD_EDGE * 2,
    );
  });

  it("phone landscape: bottom-right above the bar", () => {
    const style = tipLayout("short", { top: 40, bottom: 0 }, false, false);
    expect(style?.right).toBe(HUD_EDGE);
    expect(style?.bottom).toBe(156 + HUD_EDGE + 4);
  });

  it("is hidden while a panel is open, and on phones while toasts show", () => {
    expect(tipLayout("desktop", insets, true, false)).toBeNull();
    expect(tipLayout("compact", insets, false, true)).toBeNull();
    expect(tipLayout("short", insets, false, true)).toBeNull();
  });
});
