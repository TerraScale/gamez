/**
 * The classic mode's verification policy (wave-B.md §2): how the InstanceDO
 * replays and rate-limits a client-driven classic sim. CONTRACT (architect).
 *
 * - speedOf: Full Idle runs at ControlState.speed (1/2/4/8), every other mode at 1.
 * - offline: classic.offlineProgress is server-only; the server dispatches it
 *   on rejoin after >= 60 s of server-measured absence while the hero is in
 *   play and not in manual control (the rule the local client used, §15.4).
 */
import type { ClientDrivenPolicy, World } from "@gamez/kernel";
import { ACTION } from "../actions.ts";
import { RES, type ControlState, type GameState } from "../resources.ts";
import { classicAnalytics } from "./analytics.ts";
import { BANK_ACTION, BANK_EVENT } from "./bank.ts";
import { classicArenaBuild } from "./build.ts";
import { classicReports, REPORT_TABLES } from "./reports.ts";
import { classicSeasonTotal } from "./season.ts";

/** Min absence before offline progress is granted (same as the local client). */
export const OFFLINE_MIN_MS = 60_000;
/** Payload cap; computeOffline() caps further at BalanceProto.offlineCapMs (8 h). */
export const OFFLINE_MAX_MS = 7 * 24 * 3600 * 1000;
/** Segment limits: 400 ticks = 20 s at x1, 2.5 s at x8. */
export const MAX_TICKS_PER_SEGMENT = 400;
export const MAX_INPUTS_PER_SEGMENT = 256;

export function classicSpeedOf(world: World): number {
  const c = world.getResource<ControlState>(RES.control);
  return c && c.mode === "idle" ? c.speed : 1;
}

/** Admin tunable (protocol admin.ts TUNABLES) of the offline XP percent. */
export const OFFLINE_XP_TUNABLE = "classic.offlineXpPct";
/** Range of the payload's xpPct (matches the tunable spec; parse rejects anything else). */
export const OFFLINE_XP_PCT_MAX = 100;

/**
 * The server's offline payload (offline-idle.md §5): `{ elapsedMs }` plus
 * `xpPct` when the admin tunable is set (rounded, clamped 0..100); without
 * it the sim uses BalanceProto.offlineXpPct.
 */
export function classicOfflinePayload(
  elapsedMs: number,
  tunables: Readonly<Record<string, number>>,
): { elapsedMs: number; xpPct?: number } {
  const raw = tunables[OFFLINE_XP_TUNABLE];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { elapsedMs };
  return { elapsedMs, xpPct: Math.min(OFFLINE_XP_PCT_MAX, Math.max(0, Math.round(raw))) };
}

/**
 * Hero in play and the controller drives it (Auto or Idle). A Dead hero is
 * eligible: the offline action respawns it first (offline-idle.md §2).
 */
export function classicOfflineEligible(world: World): boolean {
  const g = world.getResource<GameState>(RES.game);
  const c = world.getResource<ControlState>(RES.control);
  return g?.phase === "play" && g.hero !== 0 && c !== undefined && c.mode !== "manual";
}

export const classicClientDriven: ClientDrivenPolicy = {
  maxTicksPerSegment: MAX_TICKS_PER_SEGMENT,
  maxInputsPerSegment: MAX_INPUTS_PER_SEGMENT,
  speedOf: classicSpeedOf,
  maxSpeed: 8,
  serverOnlyActions: [ACTION.offlineProgress, ACTION.bank],
  offline: {
    action: ACTION.offlineProgress,
    minMs: OFFLINE_MIN_MS,
    capMs: OFFLINE_MAX_MS,
    eligible: classicOfflineEligible,
    payload: classicOfflinePayload,
  },
  reports: classicReports,
  // One hero row per current member: a dismissed member's or a reset party's
  // rows are tombstoned (party.md §7.4), so recruit/dismiss cannot pile up rows.
  completeReportTables: [REPORT_TABLES.hero],
  // Admin dashboard hooks (docs/design/admin-dashboard.md §5, §11.3).
  analytics: classicAnalytics,
  // Wave C (docs/design/wave-C.md §2, §6, §7).
  platform: {
    bankAction: BANK_ACTION,
    bankEvent: BANK_EVENT,
    build: (world, registry) =>
      classicArenaBuild(world, registry) as Record<string, unknown> | null,
    seasonTotal: classicSeasonTotal,
  },
};
