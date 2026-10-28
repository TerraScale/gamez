/**
 * Wave C entry points (docs/design/wave-C.md §10.4): the shell screens a classic
 * player opens over the game (Market, Trade, Shops, Arena, Pass, Store) and the
 * bank panel key. Pure constants and builders: no React, so tests read them.
 * OWNER: T-classic-ui.
 */
import type { PlatformScreen } from "@gamez/ui-host";
import { PRESENCE_WORLD } from "../presence/index.ts";

export interface ShellSpec {
  id: string;
  /** Button text (short, fits 44 px). */
  label: string;
  /** Tooltip and aria label. */
  title: string;
  screen: PlatformScreen;
}

/** The shell screens of the classic town. Each opens through api.openScreen (hidden when absent). */
export const SHELL_BUTTONS: readonly ShellSpec[] = [
  { id: "market", label: "Market", title: "Auction house", screen: { id: "market" } },
  { id: "trade", label: "Trade", title: "Trade with a player", screen: { id: "trade" } },
  {
    id: "shops",
    label: "Shops",
    title: "Player shops in town",
    screen: { id: "plots", world: PRESENCE_WORLD },
  },
  {
    id: "arena",
    label: "Arena",
    title: "Arena (ghost fights)",
    screen: { id: "arena", mode: "classic" },
  },
  { id: "pass", label: "Pass", title: "Battle pass", screen: { id: "pass" } },
  { id: "store", label: "Store", title: "Store", screen: { id: "store" } },
];

/** The bank panel's key and labels (the panel itself is a HUD panel, not a shell screen). */
export const BANK_KEY = "K";
export const BANK_TITLE = `Bank (${BANK_KEY})`;
