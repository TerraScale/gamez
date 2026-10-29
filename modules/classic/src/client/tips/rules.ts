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

/**
 * Visible time after which a shown tip dismisses itself (and is remembered as dismissed). The card
 * also goes after the first action that answers it (tipsSatisfied), so this is only the fallback.
 */
export const TIP_TIMEOUT_MS = 30_000;

/**
 * Tips answered by the player's actions, from the previous and the current facts and the open
 * panels (pure). A dismissal is remembered, so a tip is dismissed only when its own condition held:
 * - welcome: the player's first own action: a walk under manual control, or any command that takes
 *   over from Auto/Idle (control.overridden turns on). Auto walking by itself does not count.
 * - skillPoint: a skill point was spent, or the Skills panel is open while one is unspent.
 * - talentPoint: a talent point was spent, or the Talents panel is open while one is unspent.
 */
export function tipsSatisfied(
  prev: TipFacts | null,
  next: TipFacts,
  panels: readonly PanelId[],
): TipId[] {
  const out: TipId[] = [];
  const moved = prev !== null && (prev.heroX !== next.heroX || prev.heroY !== next.heroY);
  const tookOver = next.overridden && prev !== null && !prev.overridden;
  if ((moved && next.mode === "manual") || tookOver) out.push("welcome");
  if (prev !== null && next.skillPoints < prev.skillPoints) out.push("skillPoint");
  if (next.skillPoints > 0 && panels.includes("skills")) out.push("skillPoint");
  if (prev !== null && next.talentPoints < prev.talentPoints) out.push("talentPoint");
  if (next.talentPoints > 0 && panels.includes("talents")) out.push("talentPoint");
  return out;
}

/** The first due tip that was not dismissed, or null (nothing due, tips off, dead, or a panel open). */
export function pickTip(facts: TipFacts, ctx: TipContext): TipId | null {
  if (!ctx.enabled || !facts.playing || ctx.panels.length > 0) return null;
  for (const id of TIP_IDS) {
    if (ctx.dismissed.has(id)) continue;
    if (DUE[id](facts)) return id;
  }
  return null;
}
