/**
 * Rift state helpers (classic.rift, wave A). RES.rift is created lazily: old
 * saves and partial module sets never have it (docs/design/wave-A.md §7).
 */
import type { World } from "@gamez/kernel";
import { Hero, Level, Wallet } from "../components.ts";
import {
  gameOf,
  heroOf,
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
  const hero = heroOf(world);
  const info = hero !== 0 ? world.get(hero, Hero) : undefined;
  const lvl = hero !== 0 ? world.get(hero, Level) : undefined;
  return {
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
}

/** Spends gold from the hero wallet (caller checked the balance). Counts RunStats.goldSpent. */
export function spendGold(world: World, hero: number, amount: number): void {
  const wallet = world.get(hero, Wallet);
  if (wallet) world.update(hero, Wallet, { gold: wallet.gold - amount });
  const rs = world.getResource<RunStats>(RES.stats);
  if (rs) rs.goldSpent = (rs.goldSpent ?? 0) + amount;
}
