/**
 * Potion belt (OWNER: T5, design §11.4): stacking, drinking with the shared
 * cooldown, and the potion effect (life / mana / rejuvenation).
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { ERR, fail, OK, type OpResult } from "../actions.ts";
import { Belt, HeroStats, Life, Mana } from "../components.ts";
import { emit } from "../events.ts";
import { pct } from "../fixed.ts";
import { RES, type RunStats } from "../resources.ts";
import { balanceOf, baseOf, liveHero } from "./common.ts";

export interface BeltSlot {
  base: string | null;
  count: number;
}

/**
 * Puts up to `count` potions of `base` into the belt: first into matching
 * stacks, then into empty slots (each stack up to `stack`). Returns the new
 * slots and how many did not fit. Does not mutate `slots`.
 */
export function beltAccept(
  slots: readonly BeltSlot[],
  base: string,
  count: number,
  stack: number,
): { slots: BeltSlot[]; left: number } {
  const out = slots.map((s) => ({ base: s.base, count: s.count }));
  let left = count;
  for (const s of out) {
    if (left <= 0) break;
    if (s.base === base && s.count < stack) {
      const add = Math.min(stack - s.count, left);
      s.count += add;
      left -= add;
    }
  }
  for (const s of out) {
    if (left <= 0) break;
    if (s.base === null) {
      const add = Math.min(stack, left);
      s.base = base;
      s.count = add;
      left -= add;
    }
  }
  return { slots: out, left };
}

/** Drinks the potion of a belt slot (heal / mana / rejuvenation). */
export function execDrink(world: World, ctx: SimContext, slot: number): OpResult {
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  const hero: Entity = h.hero;
  const belt = world.get(hero, Belt);
  if (!belt) return fail(ERR.noHero, "the hero has no belt yet");
  if (!Number.isInteger(slot) || slot < 0 || slot >= belt.slots.length) {
    return fail(ERR.badTarget, `there is no belt slot ${slot}`);
  }
  const s = belt.slots[slot]!;
  if (s.base === null || s.count <= 0) return fail(ERR.empty, "that belt slot is empty");
  if (belt.readyAt > ctx.tick) {
    return fail(ERR.cooldown, `potions are ready in ${belt.readyAt - ctx.tick} ticks`);
  }
  const base = baseOf(ctx.registry, s.base);
  const potion = base?.potion;
  if (!base || !potion) return fail(ERR.unknownId, `unknown potion "${s.base}"`);

  const bal = balanceOf(ctx.registry);
  const potionPct = world.get(hero, HeroStats)?.potionPct ?? 0;
  const life = world.get(hero, Life);
  const mana = world.get(hero, Mana);
  let lifeAdd = 0;
  let manaAdd = 0;
  if (potion.kind === "life") lifeAdd = pct(potion.amount, 100 + potionPct);
  else if (potion.kind === "mana") manaAdd = pct(potion.amount, 100 + potionPct);
  else {
    lifeAdd = pct(pct(life?.max ?? 0, potion.pct), 100 + potionPct);
    manaAdd = pct(pct(mana?.max ?? 0, potion.pct), 100 + potionPct);
  }

  const slots = belt.slots.map((c) => ({ base: c.base, count: c.count }));
  const cur = slots[slot]!;
  cur.count -= 1;
  if (cur.count === 0) cur.base = null;
  if (life && lifeAdd > 0) {
    world.update(hero, Life, { hp: Math.min(life.max, life.hp + lifeAdd) });
  }
  if (mana && manaAdd > 0) {
    world.update(hero, Mana, { mp: Math.min(mana.max, mana.mp + manaAdd) });
  }
  world.update(hero, Belt, { slots, readyAt: ctx.tick + bal.potionCooldown });
  const stats = world.getResource<RunStats>(RES.stats);
  if (stats) stats.potionsUsed++;
  emit(ctx, {
    type: "classic.potion",
    base: s.base,
    kind: potion.kind,
    amount: potion.kind === "mana" ? manaAdd : lifeAdd,
  });
  return OK;
}
