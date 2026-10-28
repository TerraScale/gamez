/**
 * Slot names, panel ids, widget order and the compact bottom-bar order of the
 * classic HUD (docs/design/classic.md §13). Pure constants: no React here, so
 * tests and other modules can read the table without rendering anything.
 */
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
];

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
