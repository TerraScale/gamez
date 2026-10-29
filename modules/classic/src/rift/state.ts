/**
 * Rift state helpers (classic.rift, wave A). RES.rift is created lazily: old
 * saves and partial module sets never have it (docs/design/wave-A.md §7).
 */
import type { Entity, World } from "@gamez/kernel";
import { Hero, Level, Wallet } from "../components.ts";
import { actingLeaderOf, partyMembers } from "../party/shared.ts";
import {
  gameOf,
  RES,
  type RiftRecord,
  type RiftRun,
  type RiftState,
  type RunStats,
} from "../resources.ts";

/** Rift history kept (newest first). */
export const RIFT_HISTORY_MAX = 10;

/** The RiftState, created empty when missing. */
export function riftStateOf(world: World): RiftState {
  const existing = world.getResource<RiftState>(RES.rift);
  if (existing) return existing;
  world.setResource<RiftState>(RES.rift, {
    unlocked: false,
    maxCompleted: 0,
    best: null,
    history: [],
    active: null,
    nextRun: 1,
  });
  const created = world.getResource<RiftState>(RES.rift);
  if (!created) throw new Error("classic.rift: could not create the rift state");
  return created;
}

/** Adds one record to the history (newest first, capped). */
export function pushHistory(state: RiftState, record: RiftRecord): void {
  state.history = [record, ...state.history].slice(0, RIFT_HISTORY_MAX);
}

/**
 * The record of the active run, ended at `endTick`. `completed` runs score
 * through rules.riftScore by the caller; failed runs score 0.
 */
export function recordOf(
  world: World,
  run: RiftRun,
  endTick: number,
  o: { completed: boolean; score: number; reason: "" | "death" | "left"; deaths: number },
): RiftRecord {
  // Party (docs/design/party.md §7.4): the hero fields describe the acting leader at the end.
  const leader = actingLeaderOf(world);
  const info = leader !== 0 ? world.get(leader, Hero) : undefined;
  const lvl = leader !== 0 ? world.get(leader, Level) : undefined;
  const record: RiftRecord = {
    level: run.level,
    ticks: Math.max(0, endTick - run.startTick),
    score: o.score,
    deaths: o.deaths,
    completed: o.completed,
    reason: o.reason,
    heroLevel: lvl?.level ?? 1,
    classId: info?.classId ?? "",
    heroName: info?.name ?? "",
    worldSeed: gameOf(world).worldSeed,
    endTick,
    run: run.run,
  };
  const members = partyMembers(world);
  if (members.length > 1) record.party = members.map((e) => partyMemberSummary(world, e));
  return record;
}

/** One party roster entry of a rift record (name, class, level). */
function partyMemberSummary(
  world: World,
  e: Entity,
): { name: string; classId: string; level: number } {
  const info = world.get(e, Hero);
  return {
    name: info?.name ?? "",
    classId: info?.classId ?? "",
    level: world.get(e, Level)?.level ?? 1,
  };
}

/**
 * Spends gold from `payer` (the party purse, see purseOf; caller checked the
 * balance). Counts RunStats.goldSpent.
 */
export function spendGold(world: World, payer: Entity, amount: number): void {
  const wallet = world.get(payer, Wallet);
  if (wallet) world.update(payer, Wallet, { gold: wallet.gold - amount });
  const rs = world.getResource<RunStats>(RES.stats);
  if (rs) rs.goldSpent = (rs.goldSpent ?? 0) + amount;
}
