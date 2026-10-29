/**
 * XP and level ups (docs/design/classic.md §6.3). `addXp` is the only way XP
 * grows; kills, quest rewards and the grantXp command all call it.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { Life, Level, Mana } from "../components.ts";
import { emit } from "../events.ts";
import { levelForXp } from "../rules.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../types.ts";
import { heroTag } from "../items/common.ts";
import { applyHeroStats } from "./stats.ts";

/** Restores life and mana to the current maxima. */
export function healFull(world: World, hero: Entity): void {
  if (world.has(hero, Life)) {
    const l = world.read(hero, Life);
    world.update(hero, Life, { hp: l.max, acc: 0 });
  }
  if (world.has(hero, Mana)) {
    const m = world.read(hero, Mana);
    world.update(hero, Mana, { mp: m.max, acc: 0 });
  }
}

/**
 * Adds `amount` XP (>= 0) to `hero` (any hero entity: the controlled hero,
 * a follower, or a fresh recruit right after spawnHeroEntity), then runs the
 * level-up loop: each new level adds the per-level stat and skill points and
 * emits classic.levelUp. After any level up, stats are recomputed and life
 * and mana are full. Events carry `hero` while a party exists. Talent points
 * for the new levels come from classic.talents (Talents.levelSeen).
 * Returns the number of levels gained.
 */
export function addXp(
  world: World,
  ctx: SimContext,
  hero: Entity,
  amount: number,
  reason: string,
): number {
  if (amount <= 0) return 0;
  const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
  const lvl = world.read(hero, Level);
  const total = lvl.xp + amount;
  world.update(hero, Level, { xp: total });
  const tag = heroTag(world, hero);
  emit(ctx, { type: "classic.xp", amount, total, reason, ...tag });

  const target = Math.min(bal.maxLevel, levelForXp(bal, total));
  let level = lvl.level;
  let statPoints = lvl.statPoints;
  let skillPoints = lvl.skillPoints;
  while (level < target) {
    level++;
    statPoints += bal.statPointsPerLevel;
    skillPoints += bal.skillPointsPerLevel;
    emit(ctx, { type: "classic.levelUp", level, statPoints, skillPoints, ...tag });
  }
  const gained = level - lvl.level;
  if (gained > 0) {
    world.update(hero, Level, { level, statPoints, skillPoints });
    applyHeroStats(world, ctx.registry, hero, ctx.tick);
    healFull(world, hero);
  }
  return gained;
}
