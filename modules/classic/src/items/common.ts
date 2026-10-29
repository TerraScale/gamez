/**
 * Shared helpers of classic.items (OWNER: T5). Pure lookups and small
 * guards; nothing here is stored in the world.
 */
import type { Entity, FrozenRegistry, Rng, World } from "@gamez/kernel";
import {
  Attributes,
  Dead,
  HeroStats,
  Inventory,
  Summoned,
  Supplies,
  Wallet,
} from "../components.ts";
import { heroOf, RES, type RunStats } from "../resources.ts";
import { ERR, fail, type OpResult } from "../actions.ts";
import { commandHero, isPartyHero, partyOf, purseOf } from "../party/shared.ts";
import { placeItem, type GridBag } from "./inventory.ts";
import {
  BALANCE_ID,
  ECONOMY_ID,
  KIND,
  type BalanceProto,
  type EconomyProto,
  type ItemBaseProto,
  type ItemInstance,
} from "../types.ts";

/** A registry entry as returned by registry.all(): [id, prototype]. */
export type Entry<T> = readonly [string, Readonly<T>];
export type Base = Readonly<ItemBaseProto>;

export function balanceOf(reg: FrozenRegistry): BalanceProto {
  return reg.require<BalanceProto>(KIND.balance, BALANCE_ID);
}

/** The EconomyProto (wave A), or undefined when the content defines none. */
export function economyOf(reg: FrozenRegistry): Readonly<EconomyProto> | undefined {
  return reg.get<EconomyProto>(KIND.economy, ECONOMY_ID);
}

/** Numeric RunStats counters that classic.items and classic.crafting increment. */
export type RunCounter =
  | "goldEarned"
  | "itemsFound"
  | "goldSpent"
  | "uniquesFound"
  | "setItemsFound"
  | "itemsCrafted"
  | "gemsSocketed"
  | "gambles";

/** Adds `n` to a RunStats counter (optional wave A counters start at 0). No-op without RunStats. */
export function addRunStat(world: World, key: RunCounter, n: number): void {
  if (n === 0) return;
  const stats = world.getResource<RunStats>(RES.stats);
  if (stats) stats[key] = (stats[key] ?? 0) + n;
}

/** Counts a unique or set item that entered the hero's possession (pickup, gamble, grants). */
export function noteFound(world: World, item: ItemInstance): void {
  if (item.rarity === "unique") addRunStat(world, "uniquesFound", 1);
  else if (item.rarity === "set") addRunStat(world, "setItemsFound", 1);
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

/**
 * The living hero `hero` (default: the controlled hero), or the failure to
 * return from an op. Party ops pass the acting member explicitly.
 */
export function liveHero(world: World, hero: Entity = heroOf(world)): HeroRef {
  if (hero === 0 || !world.exists(hero)) return fail(ERR.noHero, "there is no hero yet");
  if (world.has(hero, Dead)) return fail(ERR.dead, "the hero is dead");
  return { hero };
}

/** The hero `hero` (default: the controlled hero), dead or alive, or the failure to return. */
export function anyHero(world: World, hero: Entity = heroOf(world)): HeroRef {
  if (hero === 0 || !world.exists(hero)) return fail(ERR.noHero, "there is no hero yet");
  return { hero };
}

/** Attribute totals for requirements: HeroStats (with items) when known, else base attributes. */
export function heroAttrs(world: World, hero: Entity): { str: number; dex: number } {
  const hs = world.get(hero, HeroStats);
  if (hs) return { str: hs.attrs.str, dex: hs.attrs.dex };
  const base = world.get(hero, Attributes);
  return { str: base?.str ?? 0, dex: base?.dex ?? 0 };
}

/** Magic find and gold find of `hero` (default: the controlled hero; 0 before stats exist). */
export function heroFind(
  world: World,
  hero: Entity = heroOf(world),
): { magicFind: number; goldFind: number } {
  const hs = hero === 0 ? undefined : world.get(hero, HeroStats);
  return { magicFind: hs?.magicFind ?? 0, goldFind: hs?.goldFind ?? 0 };
}

// ---------------------------------------------------------------------------
// Party (docs/design/party.md §2, §4.3): acting hero, purse, event tag
// ---------------------------------------------------------------------------

/**
 * The hero a HeroCommand acts for (party/shared.ts commandHero), or the
 * not_member failure when `cmd.hero` is set but is not a party member. A
 * command without `hero` acts for the controlled hero (0 before the first
 * hero: the op then fails with no_hero as before).
 */
export function commandActor(world: World, cmd: { hero?: Entity }): Entity | OpResult {
  const hero = commandHero(world, cmd);
  if (hero === 0 && cmd.hero !== undefined) {
    return fail(ERR.notMember, "that hero is not in the party");
  }
  return hero;
}

/** `{hero}` for events about one hero while a party exists; `{}` for a solo game (unchanged events). */
export function heroTag(world: World, hero: Entity): { hero?: Entity } {
  return hero !== 0 && partyOf(world) !== null ? { hero } : {};
}

/** `{hero}` for a command acting for a follower; `{}` for the controlled hero (docs/design/party.md §4.2). */
export function followerTag(world: World, hero: Entity): { hero?: Entity } {
  return hero !== 0 && hero !== heroOf(world) ? { hero } : {};
}

/** The purse entity (party/shared.ts purseOf) and its Wallet, or undefined without one. */
export function purseWallet(world: World): { purse: Entity; gold: number } | undefined {
  const purse = purseOf(world);
  const wallet = purse === 0 ? undefined : world.get(purse, Wallet);
  return wallet ? { purse, gold: wallet.gold } : undefined;
}

/** The purse's town portal scrolls, or undefined without Supplies. */
export function purseScrolls(world: World): { purse: Entity; tpScrolls: number } | undefined {
  const purse = purseOf(world);
  const supplies = purse === 0 ? undefined : world.get(purse, Supplies);
  return supplies ? { purse, tpScrolls: supplies.tpScrolls } : undefined;
}

/** Sets the purse gold (callers checked purseWallet first). */
export function setPurseGold(world: World, purse: Entity, gold: number): void {
  world.update(purse, Wallet, { gold });
}

/**
 * The party hero credited with a kill by `killer`: the killer itself when it
 * is a member, else the owner of a killing summon when that owner is a
 * member, else the controlled hero (projectiles, ground effects, unknown).
 * Solo: always the hero.
 */
export function creditedHero(world: World, killer: Entity): Entity {
  if (killer !== 0 && isPartyHero(world, killer)) return killer;
  if (killer !== 0 && world.exists(killer)) {
    const owner = world.get(killer, Summoned)?.owner ?? 0;
    if (owner !== 0 && isPartyHero(world, owner)) return owner;
  }
  return heroOf(world);
}

// ---------------------------------------------------------------------------
// Per-hero bag helpers (public: classic.auto gear distribution, classic.party give)
// ---------------------------------------------------------------------------

/** The bag of `hero` as a GridBag (undefined before items.heroInit). */
export function bagOf(world: World, hero: Entity): GridBag | undefined {
  return hero === 0 ? undefined : world.get(hero, Inventory);
}

/** True when `item` fits first-fit into `hero`'s bag. */
export function bagHasRoom(
  world: World,
  reg: FrozenRegistry,
  hero: Entity,
  item: ItemInstance,
): boolean {
  const bag = bagOf(world, hero);
  return bag !== undefined && placeItem(reg, bag, item) !== null;
}

/** Places `item` first-fit into `hero`'s bag (writes Inventory). False when there is no room. */
export function addToBag(
  world: World,
  reg: FrozenRegistry,
  hero: Entity,
  item: ItemInstance,
): boolean {
  const bag = bagOf(world, hero);
  const next = bag ? placeItem(reg, bag, item) : null;
  if (!next) return false;
  world.update(hero, Inventory, { items: next.items });
  return true;
}
