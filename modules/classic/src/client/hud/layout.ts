/**
 * Slot names, panel ids, widget order and the compact bottom-bar order of the
 * classic HUD (docs/design/classic.md §13). Pure constants: no React here, so
 * tests and other modules can read the table without rendering anything.
 */
import type { CSSProperties } from "react";
import type { PanelId } from "../contract.ts";

export const HUD_MODULE_ID = "classic.hud";

export const SLOT = {
  top: "classic.hud.top",
  topRight: "classic.hud.topRight",
  target: "classic.hud.target",
  left: "classic.hud.left",
  bottom: "classic.hud.bottom",
  overlay: "classic.hud.overlay",
} as const;

/** Every panel id, in the fixed order panels stack in (desktop) and in the tab order. */
export const PANEL_IDS: readonly PanelId[] = [
  "character",
  "inventory",
  "skills",
  "quests",
  "vendor",
  "stash",
  "waypoint",
  "settings",
  "log",
  "map",
  "talents",
  "craft",
  "gamble",
  "rift",
  "achievements",
  "lootFilter",
  // wave B
  "chat",
  "guild",
  "leaderboard",
  "account",
];

/**
 * Wave C panel ids. Kept apart from PANEL_IDS (its size is pinned by the wave A
 * helper test); ALL_PANEL_IDS is what the HUD registers and renders.
 */
export const WAVE_C_PANEL_IDS: readonly PanelId[] = ["bank"];

/** Every panel the HUD renders: PANEL_IDS, then the wave C panels. */
export const ALL_PANEL_IDS: readonly PanelId[] = [...PANEL_IDS, ...WAVE_C_PANEL_IDS];

export function panelSlot(id: PanelId): string {
  return `classic.panel.${id}`;
}

export type BottomId = "xp" | "life" | "skill" | "belt" | "mana" | "panel";

/** Desktop: XP row on top, then life - skills - belt - mana centred, buttons last. */
const BOTTOM_DESKTOP: Record<BottomId, number> = {
  xp: 10,
  life: 20,
  skill: 30,
  belt: 40,
  mana: 50,
  panel: 60,
};

/**
 * Compact (< 700 px): XP, belt row, skill row (6 x 44 px), then the orbs in the
 * bottom corners on one row, and the panel buttons on their own row.
 */
const BOTTOM_COMPACT: Record<BottomId, number> = {
  xp: 10,
  belt: 20,
  skill: 30,
  life: 40,
  mana: 41,
  panel: 50,
};

export function bottomOrder(compact: boolean, id: BottomId): number {
  return compact ? BOTTOM_COMPACT[id] : BOTTOM_DESKTOP[id];
}

/** Compact breakpoint, matches ui.compact (below 700 px width). */
export const COMPACT_MAX_WIDTH = 699;

/**
 * Three layouts, chosen by viewport height first. short: under 500 px of height
 * (a phone in landscape, at any width): the bottom bar is one band with the orbs
 * in the corners. compact: width under 700 px (a phone in portrait): panels are
 * full-screen sheets. desktop: everything else.
 */
export type HudLayout = "desktop" | "compact" | "short";

/** Viewport height (CSS px) below which the short layout applies. */
export const SHORT_MAX_HEIGHT = 500;

export function hudLayoutFor(compact: boolean, viewportHeight: number): HudLayout {
  if (viewportHeight < SHORT_MAX_HEIGHT) return "short";
  return compact ? "compact" : "desktop";
}

/** Top-left and top-right corners sit this far from the viewport edges. */
export const HUD_EDGE = 8;

/** The minimap block: canvas size, block width, and whether Map/Hide buttons sit under it. */
export const MINIMAP_SIZE: Record<HudLayout, { width: number; canvas: number; buttons: boolean }> =
  {
    desktop: { width: 170, canvas: 160, buttons: true },
    compact: { width: 106, canvas: 96, buttons: false },
    short: { width: 122, canvas: 112, buttons: true },
  };

/** Height of the 44 px button row under the minimap canvas, with its gap. */
const MINIMAP_BUTTON_ROW = 48;
/** Border and padding around the minimap canvas. */
const MINIMAP_FRAME = 10;

/** Full height of the minimap block (border included). */
export function minimapBlockHeight(layout: HudLayout): number {
  const size = MINIMAP_SIZE[layout];
  return size.canvas + MINIMAP_FRAME + (size.buttons ? MINIMAP_BUTTON_ROW : 0);
}

/** Right inset of the top-left region: the minimap column plus its gap, so the area text never runs under it. */
export function topRightInset(layout: HudLayout): number {
  return MINIMAP_SIZE[layout].width + HUD_EDGE * 2;
}

/** Measured heights of the top and bottom regions (px). Columns and toasts clear the real bar, not the guess. */
export interface HudInsets {
  top: number;
  bottom: number;
}

export const NO_INSETS: HudInsets = { top: 0, bottom: 0 };

/**
 * Height the bottom bar really takes: the larger of the layout's constant and
 * the measured height, so columns never run under a wrapped bar.
 */
export function bottomBarInset(layout: HudLayout, measuredBottom: number): number {
  return Math.max(BOTTOM_BAR_HEIGHT[layout], Math.ceil(measuredBottom));
}

/** Bottom of the left column (quests, log): stops HUD_EDGE above the bottom bar. */
export function leftColumnBottom(layout: HudLayout, insets: HudInsets): number {
  return bottomBarInset(layout, insets.bottom) + HUD_EDGE;
}

/** Side length of the Map chip shown in the minimap's place while the minimap is hidden (a 44 px touch target). */
export const MINIMAP_CHIP = 44;

/** Top of the left column (quests, log): below the top region on the short layout. */
export const LEFT_TOP: { desktop: number; short: number } = { desktop: 96, short: 80 };
/** Top of the centred target bar. */
export const TARGET_TOP: Record<HudLayout, number> = { desktop: 84, compact: 150, short: 80 };
/** Width of the left column (quests, log). */
export const LEFT_WIDTH: Record<HudLayout, number> = { desktop: 250, compact: 180, short: 180 };
/**
 * Height the bottom bar takes from the viewport bottom (measured in QA on 390x844
 * and 812x375). Columns and toasts stop above it.
 */
export const BOTTOM_BAR_HEIGHT: Record<HudLayout, number> = {
  desktop: 0,
  compact: 270,
  short: 156,
};

/** Toasts: at most this many visible, at this width. */
export const TOAST_MAX: Record<HudLayout, number> = { desktop: 3, compact: 2, short: 2 };

/** Width of the desktop toast column (its right edge sits HUD_EDGE from the viewport edge). */
export const TOAST_WIDTH = 280;

/**
 * Right inset of the panel row. Desktop: the toast column plus the gap on both sides, so an open
 * panel always ends left of the toasts and never covers a toast or a panel button under it
 * (QA major 2: a toast covered the junk buyer's first Sell button). Phones show full-screen
 * sheets and hide toasts while one is open, so they reserve nothing.
 */
export const PANEL_ROW_RIGHT: Record<HudLayout, number> = {
  desktop: TOAST_WIDTH + HUD_EDGE * 2,
  compact: 0,
  short: 0,
};

export interface ToastLayout {
  visible: boolean;
  max: number;
  /** Absolute placement inside the overlay layer. */
  style: CSSProperties;
}

/**
 * Where toasts go. Desktop: a column right of the play area, below the minimap
 * block. Phone: stacked above the bottom bar, clear of the mode status and the
 * target bar. While a full-screen panel covers the phone screen toasts are
 * hidden, so they never sit over a panel's slots (the log keeps every line).
 */
export function toastLayout(
  layout: HudLayout,
  minimapShown: boolean,
  panelOpen: boolean,
  measuredBottom = 0,
): ToastLayout {
  if (layout === "desktop") {
    // Under the minimap block, or under the Map chip when the minimap is hidden.
    const top = minimapShown
      ? HUD_EDGE + minimapBlockHeight("desktop") + HUD_EDGE
      : HUD_EDGE + MINIMAP_CHIP + HUD_EDGE;
    return {
      visible: true,
      max: TOAST_MAX.desktop,
      style: { position: "absolute", top, right: HUD_EDGE, width: TOAST_WIDTH },
    };
  }
  if (panelOpen) return { visible: false, max: 0, style: {} };
  if (layout === "compact") {
    return {
      visible: true,
      max: TOAST_MAX.compact,
      style: {
        position: "absolute",
        left: LEFT_WIDTH.compact + HUD_EDGE * 2,
        right: HUD_EDGE,
        bottom: bottomBarInset("compact", measuredBottom) + HUD_EDGE,
      },
    };
  }
  return {
    visible: true,
    max: TOAST_MAX.short,
    style: {
      position: "absolute",
      left: "50%",
      transform: "translateX(-50%)",
      width: 260,
      maxWidth: `calc(100% - ${HUD_EDGE * 4}px)`,
      bottom: bottomBarInset("short", measuredBottom) + HUD_EDGE,
    },
  };
}

/**
 * The Modes control lives in the panel button row. It is hidden on phones while a
 * panel sheet is open, because the sheet covers the screen and the control
 * would sit over the panel's Close button.
 */
export function modesControlVisible(layout: HudLayout, panelOpen: boolean): boolean {
  return layout === "desktop" || !panelOpen;
}

/** Bottom-bar order of the short (landscape phone) layout: orbs in the corners, belt and skills between. */
const BOTTOM_SHORT: Record<BottomId, number> = {
  xp: 10,
  life: 20,
  belt: 30,
  skill: 40,
  mana: 50,
  panel: 60,
};

export function bottomOrderFor(layout: HudLayout, id: BottomId): number {
  if (layout === "short") return BOTTOM_SHORT[id];
  return bottomOrder(layout === "compact", id);
}

/**
 * Where the last-error flash goes. Desktop: above the desktop bar. Short: above
 * the measured bottom bar. Phone portrait: just under the top region, centred,
 * so it never covers the toast column, the Log row or the belt and skill bar.
 */
export function errorFlashStyle(
  layout: HudLayout,
  insets: HudInsets,
  panelOpen = false,
): CSSProperties {
  // A phone sheet covers the top region and its header, so the flash goes to the sheet's foot.
  if (layout !== "desktop" && panelOpen) return { bottom: HUD_EDGE * 2 };
  if (layout === "compact") {
    return { top: insets.top + HUD_EDGE * 2 };
  }
  // Desktop with a panel open: the toast column, which panels never cover (PANEL_ROW_RIGHT),
  // so a refusal never hides a panel row (QA: "nothing needs repair" sat over the smith's items).
  if (layout === "desktop" && panelOpen) {
    return { bottom: 190, left: "auto", right: HUD_EDGE, width: TOAST_WIDTH, transform: "none" };
  }
  if (layout === "desktop") return { bottom: 190 };
  return { bottom: bottomBarInset("short", insets.bottom) + 30 };
}

/**
 * Onboarding tip card (overlay). Above the measured bottom bar, never over a panel (hidden while
 * any panel is open), never over the phone toast column (hidden while toasts show), and clear of
 * the phone's left column. Null = hidden.
 */
export function tipLayout(
  layout: HudLayout,
  measuredBottom: number,
  panelOpen: boolean,
  toastsShown: boolean,
): CSSProperties | null {
  if (panelOpen) return null;
  const bottom = bottomBarInset(layout, measuredBottom) + HUD_EDGE + 4;
  if (layout === "desktop") {
    return {
      position: "absolute",
      left: "50%",
      transform: "translateX(-50%)",
      width: 360,
      maxWidth: `calc(100% - ${HUD_EDGE * 4}px)`,
      bottom,
    };
  }
  if (toastsShown) return null;
  return {
    position: "absolute",
    left: LEFT_WIDTH[layout] + HUD_EDGE * 2,
    right: HUD_EDGE,
    bottom,
  };
}
