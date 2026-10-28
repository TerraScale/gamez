/**
 * Onboarding tips, step 3: which tip is due. Pure trigger rules over TipFacts; one tip at a time.
 * A tip is due only while its condition holds, and it never comes back once dismissed.
 */
import type { PanelId } from "../contract.ts";
import { TIP_IDS, type TipId } from "./catalog.ts";
import type { TipFacts } from "./facts.ts";

export interface TipContext {
  /** Settings.tips: off hides every tip. */
  enabled: boolean;
  /** Open panels: while any is open no tip shows (a tip never sits over a panel). */
  panels: readonly PanelId[];
  /** Tip ids the player dismissed (remembered by tips/store.ts). */
  dismissed: ReadonlySet<string>;
}

const DUE: Record<TipId, (f: TipFacts) => boolean> = {
  // Shown to a new hero (any control mode) until it is dismissed or the hero passes level 3.
  welcome: (f) => f.level <= 3,
  skillPoint: (f) => f.skillPoints > 0,
  talentPoint: (f) => f.talentPoints > 0,
  // The first time the hero is back in town after a dungeon trip. Any open panel hides tips, so
  // the trigger is the town itself, not an open smith, gambler or stash panel.
  town: (f) => f.isTown && f.deepest >= 1,
  wornGear: (f) => f.wornGear,
  setOrUnique: (f) => f.setOrUnique,
  bagFull: (f) => f.bagFull,
  boss: (f) => f.bossAlive,
  rift: (f) => f.riftUnlocked,
  idleSpeed: (f) => f.mode === "idle" && f.speed === 1,
};

/** The first due tip that was not dismissed, or null (nothing due, tips off, dead, or a panel open). */
export function pickTip(facts: TipFacts, ctx: TipContext): TipId | null {
  if (!ctx.enabled || !facts.playing || ctx.panels.length > 0) return null;
  for (const id of TIP_IDS) {
    if (ctx.dismissed.has(id)) continue;
    if (DUE[id](facts)) return id;
  }
  return null;
}
