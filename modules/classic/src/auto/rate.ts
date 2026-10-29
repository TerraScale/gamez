/**
 * classic.auto.rate (post 950, SYSTEM.autoRate): measures the hero's online
 * Auto/Idle rate for the offline grant (docs/design/offline-idle.md §4.1).
 *
 * Per sim tick, while phase is "play", a hero exists and control.mode is not
 * "manual" (dead heroes and town visits included):
 *  - ticks += 1;
 *  - every credited death (the same filter as progression/kills.ts) adds one
 *    kill, and its XP (xpForKill at the hero's current level) when d.xp > 0,
 *    and its raw XP d.xp to pool (the party grant's hero-independent measure);
 *  - the gold picked up from the ground since the last run is added to gold;
 *  - the upkeep paid since the last run (alchemist potions and scrolls, smith
 *    repairs: noteUpkeepGold) is added to upkeep.
 * When ticks exceed AUTO_RATE_WINDOW_TICKS, ticks, kills, xp, pool, gold and upkeep
 * are halved (floor), a decaying window of about 30 minutes at x1.
 *
 * Ineligible ticks only drop the pending loot and upkeep, so manual pickups
 * and manual purchases never count.
 * The resource is created on the first eligible tick, so manual-only games
 * never have it.
 */
import type { SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, type DeathRecord } from "../bus.ts";
import { Level } from "../components.ts";
import { SYSTEM } from "../ids.ts";
import { heroOf, RES, type AutoRate, type ControlState, type GameState } from "../resources.ts";
import { partySize } from "../party/shared.ts";
import { partyKillXp, partyProtoOf, xpForKill } from "../rules.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../types.ts";

/** The decaying window: halve everything once the window is exceeded (30 min at x1). */
export const AUTO_RATE_WINDOW_TICKS = 36_000;
/** Minimum measured ticks (5 min at x1) before the rate replaces the fallback model. */
export const AUTO_RATE_MIN_TICKS = 6_000;

/** A death the hero's side gets credit for, excluding the hero's own units and summons. */
function isCreditedKill(d: DeathRecord): boolean {
  return d.creditTeam === "hero" && !d.isHero && d.rarity !== "summon";
}

export const rateSystem: SystemDef = {
  ...SYSTEM.autoRate,
  run(world, ctx) {
    const existing = world.getResource<AutoRate>(RES.autoRate);
    const game = world.getResource<GameState>(RES.game);
    const control = world.getResource<ControlState>(RES.control);
    const hero = heroOf(world);
    const eligible =
      game?.phase === "play" && hero !== 0 && control !== undefined && control.mode !== "manual";
    if (!eligible) {
      // Manual pickups and purchases never count: drop the pending loot and
      // upkeep, nothing else.
      if (existing && (existing.loot !== 0 || (existing.spent ?? 0) !== 0)) {
        existing.loot = 0;
        if (existing.spent !== undefined) existing.spent = 0;
        world.setResource(RES.autoRate, existing);
      }
      return;
    }

    const rate: AutoRate = existing ?? {
      ticks: 0,
      kills: 0,
      xp: 0,
      pool: 0,
      gold: 0,
      loot: 0,
      upkeep: 0,
      spent: 0,
    };
    rate.ticks += 1;
    accumulateKills(world, ctx, hero, rate);
    rate.gold += rate.loot;
    rate.loot = 0;
    // Old saves have no upkeep fields: they read 0 and are written from now on.
    rate.upkeep = (rate.upkeep ?? 0) + (rate.spent ?? 0);
    rate.spent = 0;
    if (rate.ticks > AUTO_RATE_WINDOW_TICKS) {
      rate.ticks = Math.floor(rate.ticks / 2);
      rate.kills = Math.floor(rate.kills / 2);
      rate.xp = Math.floor(rate.xp / 2);
      if (rate.pool !== undefined) rate.pool = Math.floor(rate.pool / 2);
      rate.gold = Math.floor(rate.gold / 2);
      rate.upkeep = Math.floor(rate.upkeep / 2);
    }
    world.setResource(RES.autoRate, rate);
  },
};

/**
 * Adds this tick's credited kills and their XP to the rate. In a party
 * (docs/design/party.md §6.8) kills are the whole party's, and the XP is the
 * controlled hero's own share of each kill (partyKillXp for the party size,
 * as progression/kills.ts pays it). `pool` adds the kill's raw XP, which no
 * hero's level or control changes; partyOfflineGrant pays each member from it.
 */
function accumulateKills(world: World, ctx: SimContext, hero: number, rate: AutoRate): void {
  const size = partySize(world);
  for (const d of busOf(world).deaths) {
    if (!isCreditedKill(d)) continue;
    rate.kills += 1;
    if (d.xp > 0) {
      // Old rates have no pool: it is measured from now on.
      rate.pool = (rate.pool ?? 0) + d.xp;
      const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
      const heroLevel = world.get(hero, Level)?.level ?? 1;
      rate.xp +=
        size > 1
          ? partyKillXp(bal, partyProtoOf(ctx.registry), size, heroLevel, d.level, d.xp)
          : xpForKill(bal, heroLevel, d.level, d.xp);
    }
  }
}
