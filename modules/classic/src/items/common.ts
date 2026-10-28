/**
 * Shared helpers of classic.items (OWNER: T5). Pure lookups and small
 * guards; nothing here is stored in the world.
 */
import type { Entity, FrozenRegistry, Rng, World } from "@gamez/kernel";
import { Attributes, Dead, HeroStats } from "../components.ts";
import { heroOf } from "../resources.ts";
import { ERR, fail, type OpResult } from "../actions.ts";
import { BALANCE_ID, KIND, type BalanceProto, type ItemBaseProto } from "../types.ts";

/** A registry entry as returned by registry.all(): [id, prototype]. */
export type Entry<T> = readonly [string, Readonly<T>];
export type Base = Readonly<ItemBaseProto>;

export function balanceOf(reg: FrozenRegistry): BalanceProto {
  return reg.require<BalanceProto>(KIND.balance, BALANCE_ID);
}

export function baseOf(reg: FrozenRegistry, id: string): Base | undefined {
  return reg.get<ItemBaseProto>(KIND.itemBase, id);
}

/** Weighted pick with integer weights (<= 0 never picked). undefined when nothing has weight. */
export function pickWeighted<T>(
  rng: Rng,
  items: readonly T[],
  weight: (t: T) => number,
): T | undefined {
  let total = 0;
  for (const t of items) total += Math.max(0, Math.floor(weight(t)));
  if (total <= 0) return undefined;
  let r = rng.int(1, total);
  for (const t of items) {
    const w = Math.max(0, Math.floor(weight(t)));
    if (r <= w) return t;
    r -= w;
  }
  return undefined;
}

/** Integer percent roll: true with probability p% (p >= 100 always, p <= 0 never). */
export function percentRoll(rng: Rng, p: number): boolean {
  return rng.int(1, 100) <= p;
}

export type HeroRef = { hero: Entity } | OpResult;

/** The living hero, or the failure to return from an op. */
export function liveHero(world: World): HeroRef {
  const hero = heroOf(world);
  if (hero === 0) return fail(ERR.noHero, "there is no hero yet");
  if (world.has(hero, Dead)) return fail(ERR.dead, "the hero is dead");
  return { hero };
}

/** The hero (dead or alive), or the failure to return. */
export function anyHero(world: World): HeroRef {
  const hero = heroOf(world);
  if (hero === 0) return fail(ERR.noHero, "there is no hero yet");
  return { hero };
}

/** Attribute totals for requirements: HeroStats (with items) when known, else base attributes. */
export function heroAttrs(world: World, hero: Entity): { str: number; dex: number } {
  const hs = world.get(hero, HeroStats);
  if (hs) return { str: hs.attrs.str, dex: hs.attrs.dex };
  const base = world.get(hero, Attributes);
  return { str: base?.str ?? 0, dex: base?.dex ?? 0 };
}

/** Magic find and gold find of the hero (0 without a hero or before stats exist). */
export function heroFind(world: World): { magicFind: number; goldFind: number } {
  const hero = heroOf(world);
  const hs = hero === 0 ? undefined : world.get(hero, HeroStats);
  return { magicFind: hs?.magicFind ?? 0, goldFind: hs?.goldFind ?? 0 };
}
