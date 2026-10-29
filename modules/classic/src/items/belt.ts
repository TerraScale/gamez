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
import { balanceOf, baseOf, heroTag, liveHero } from "./common.ts";

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

/** Error code of a drink that restores nothing (the potion is kept). */
export const POTION_USELESS = ERR.potionUseless;

/** `hero` drinks the potion of one of its belt slots (heal / mana / rejuvenation). */
export function execDrink(world: World, ctx: SimContext, hero: Entity, slot: number): OpResult {
  const h = liveHero(world, hero);
  if (!("hero" in h)) return h;
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
  // Values before the drink (world.update may mutate the component objects read above).
  const lifeBefore = life?.hp ?? 0;
  const manaBefore = mana?.mp ?? 0;
  let lifeAdd = 0;
  let manaAdd = 0;
  if (potion.kind === "life") lifeAdd = pct(potion.amount, 100 + potionPct);
  else if (potion.kind === "mana") manaAdd = pct(potion.amount, 100 + potionPct);
  else {
    lifeAdd = pct(pct(life?.max ?? 0, potion.pct), 100 + potionPct);
    manaAdd = pct(pct(mana?.max ?? 0, potion.pct), 100 + potionPct);
  }
  // Refuse a drink that restores nothing: the potion is not consumed.
  const lifeGain = life && lifeAdd > 0 ? Math.min(life.max, life.hp + lifeAdd) - life.hp : 0;
  const manaGain = mana && manaAdd > 0 ? Math.min(mana.max, mana.mp + manaAdd) - mana.mp : 0;
  if (lifeGain <= 0 && manaGain <= 0) {
    const message =
      potion.kind === "life"
        ? "Life is already full"
        : potion.kind === "mana"
          ? "Mana is already full"
          : "Life and mana are already full";
    return fail(POTION_USELESS, message);
  }

  const slots = belt.slots.map((c) => ({ base: c.base, count: c.count }));
  const cur = slots[slot]!;
  cur.count -= 1;
  if (cur.count === 0) cur.base = null;
  if (life && lifeGain > 0) world.update(hero, Life, { hp: lifeBefore + lifeGain });
  if (mana && manaGain > 0) world.update(hero, Mana, { mp: manaBefore + manaGain });
  world.update(hero, Belt, { slots, readyAt: ctx.tick + bal.potionCooldown });
  const stats = world.getResource<RunStats>(RES.stats);
  if (stats) stats.potionsUsed++;
  emit(ctx, {
    type: "classic.potion",
    base: s.base,
    kind: potion.kind,
    amount: potion.kind === "mana" ? manaAdd : lifeAdd,
    lifeBefore,
    lifeAfter: lifeBefore + lifeGain,
    manaBefore,
    manaAfter: manaBefore + manaGain,
    ...heroTag(world, hero),
  });
  return OK;
}
