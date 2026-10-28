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
import { BANK_ACTION, BANK_EVENT } from "./bank.ts";
import { classicArenaBuild } from "./build.ts";
import { classicReports } from "./reports.ts";
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
  },
  reports: classicReports,
  // Wave C (docs/design/wave-C.md §2, §6, §7).
  platform: {
    bankAction: BANK_ACTION,
    bankEvent: BANK_EVENT,
    build: (world, registry) =>
      classicArenaBuild(world, registry) as Record<string, unknown> | null,
    seasonTotal: classicSeasonTotal,
  },
};
