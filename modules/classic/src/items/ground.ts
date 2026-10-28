/**
 * Pickup, drop, bag moves and grants (OWNER: T5). Loot entities are created
 * by drops.ts (monster deaths) and execDrop (hero drops an item).
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { ERR, fail, OK, PICKUP_RANGE, type OpResult } from "../actions.ts";
import { AreaTag, Belt, Inventory, Loot, Pos, Wallet } from "../components.ts";
import { emit } from "../events.ts";
import { pct, within } from "../fixed.ts";
import { currentDepth } from "../resources.ts";
import { addRunStat, anyHero, balanceOf, baseOf, heroFind, liveHero, noteFound } from "./common.ts";
import { beltAccept } from "./belt.ts";
import { fitsAt, placeItem, removeItem, sortEntries, type GridBag } from "./inventory.ts";
import { rollItem } from "./generate.ts";
import { stashAdd } from "./stash.ts";
import type { ItemCategory, ItemInstance, ItemRarity } from "../types.ts";

function bagOf(world: World, hero: Entity): GridBag | undefined {
  return world.get(hero, Inventory);
}

/** Picks up a Loot entity of the current area within PICKUP_RANGE. */
export function execPickup(world: World, ctx: SimContext, target: Entity): OpResult {
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  const hero = h.hero;
  if (!world.has(target, Loot) || !world.has(target, Pos) || !world.has(target, AreaTag)) {
    return fail(ERR.badTarget, "there is nothing to pick up");
  }
  if (world.read(target, AreaTag).depth !== currentDepth(world)) {
    return fail(ERR.badTarget, "that loot is in another area");
  }
  const hp = world.read(hero, Pos);
  const lp = world.read(target, Pos);
  if (!within(hp.x, hp.y, lp.x, lp.y, PICKUP_RANGE)) return fail(ERR.tooFar, "too far away");

  const loot = world.read(target, Loot);
  const reg = ctx.registry;
  if (loot.kind === "gold") {
    const wallet = world.get(hero, Wallet);
    if (!wallet) return fail(ERR.noHero, "the hero has no wallet yet");
    const total = wallet.gold + loot.gold;
    world.update(hero, Wallet, { gold: total });
    addRunStat(world, "goldEarned", loot.gold);
    emit(ctx, { type: "classic.gold", amount: loot.gold, total, reason: "pickup" });
    emit(ctx, {
      type: "classic.loot.picked",
      kind: "gold",
      name: `${loot.gold} gold`,
      rarity: "normal",
      gold: loot.gold,
    });
    world.destroy(target);
    return OK;
  }

  if (loot.kind === "potion") {
    const belt = world.get(hero, Belt);
    if (!belt) return fail(ERR.noHero, "the hero has no belt yet");
    const base = baseOf(reg, loot.potion);
    if (!base) return fail(ERR.unknownId, `unknown potion "${loot.potion}"`);
    const res = beltAccept(belt.slots, loot.potion, 1, balanceOf(reg).beltStack);
    if (res.left > 0) return fail(ERR.beltFull, "the potion belt is full");
    world.update(hero, Belt, { slots: res.slots });
    emit(ctx, {
      type: "classic.loot.picked",
      kind: "potion",
      name: base.name,
      rarity: "normal",
      gold: 0,
    });
    world.destroy(target);
    return OK;
  }

  const item = loot.item;
  const bag = bagOf(world, hero);
  if (!item || !bag) return fail(ERR.badTarget, "that loot is empty");
  const next = placeItem(reg, bag, item);
  if (!next) {
    emit(ctx, { type: "classic.bag.full" });
    return fail(ERR.bagFull, "the bag is full");
  }
  world.update(hero, Inventory, { items: next.items });
  addRunStat(world, "itemsFound", 1);
  noteFound(world, item);
  emit(ctx, {
    type: "classic.loot.picked",
    kind: "item",
    name: item.name,
    rarity: item.rarity,
    gold: 0,
  });
  world.destroy(target);
  return OK;
}

/** Drops a bag item on the ground at the hero's feet. */
export function execDrop(world: World, ctx: SimContext, uid: number): OpResult {
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  const hero = h.hero;
  const bag = bagOf(world, hero);
  if (!bag) return fail(ERR.noHero, "the hero has no inventory yet");
  const removed = removeItem(bag, uid);
  if (!removed) return fail(ERR.unknownId, `item ${uid} is not in the bag`);
  world.update(hero, Inventory, { items: removed.bag.items });
  const p = world.read(hero, Pos);
  const e = world.create();
  const depth = currentDepth(world);
  world.add(e, Loot, {
    kind: "item",
    item: removed.item,
    gold: 0,
    potion: "",
    droppedAt: ctx.tick,
  });
  world.add(e, Pos, { x: p.x, y: p.y });
  world.add(e, AreaTag, { depth });
  emit(ctx, {
    type: "classic.loot.dropped",
    entity: e,
    kind: "item",
    name: removed.item.name,
    rarity: removed.item.rarity,
    x: p.x,
    y: p.y,
  });
  return OK;
}

/** Moves a bag item to a free cell of the grid. */
export function execMoveItem(
  world: World,
  ctx: SimContext,
  uid: number,
  x: number,
  y: number,
): OpResult {
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  const bag = bagOf(world, h.hero);
  if (!bag) return fail(ERR.noHero, "the hero has no inventory yet");
  const entry = bag.items.find((e) => e.item.uid === uid);
  if (!entry) return fail(ERR.unknownId, `item ${uid} is not in the bag`);
  if (!fitsAt(ctx.registry, bag, entry.item, x, y, uid)) {
    return fail(ERR.blocked, "no room at that cell");
  }
  const items = sortEntries(bag.items.map((e) => (e === entry ? { item: e.item, x, y } : e)));
  world.update(h.hero, Inventory, { items });
  return OK;
}

/** Adds gold (may be negative; the wallet never goes below 0). */
export function execGrantGold(
  world: World,
  ctx: SimContext,
  amount: number,
  reason: string,
): OpResult {
  if (!Number.isSafeInteger(amount)) return fail(ERR.badPayload, "gold must be an integer");
  const h = anyHero(world);
  if (!("hero" in h)) return h;
  const wallet = world.get(h.hero, Wallet);
  if (!wallet) return fail(ERR.noHero, "the hero has no wallet yet");
  const total = Math.max(0, wallet.gold + amount);
  const applied = total - wallet.gold;
  world.update(h.hero, Wallet, { gold: total });
  if (applied > 0) addRunStat(world, "goldEarned", applied);
  if (applied !== 0) emit(ctx, { type: "classic.gold", amount: applied, total, reason });
  return OK;
}

/**
 * Rolls `count` items (rarity at least minRarity, optionally one category)
 * into the stash (first tab with room) or the bag. Items that do not fit are
 * sold at 10% of their value.
 */
export function execGrantItems(
  world: World,
  ctx: SimContext,
  o: {
    count: number;
    ilvl: number;
    minRarity: ItemRarity;
    category?: ItemCategory;
    setItem?: string;
    toStash: boolean;
    reason: string;
  },
): OpResult {
  if (!Number.isSafeInteger(o.count) || o.count < 0 || o.count > 200) {
    return fail(ERR.badPayload, "count must be 0..200");
  }
  const h = anyHero(world);
  const hero = "hero" in h ? h.hero : 0;
  const { magicFind } = heroFind(world);
  for (let i = 0; i < o.count; i++) {
    const item: ItemInstance | null = rollItem(world, ctx, {
      ilvl: o.ilvl,
      rarity: null,
      magicFind,
      minRarity: o.minRarity,
      ...(o.category !== undefined ? { category: o.category } : {}),
      ...(o.setItem !== undefined ? { setItem: o.setItem } : {}),
    });
    if (!item) continue;
    if (o.toStash) {
      if (stashAdd(world, ctx.registry, item)) {
        noteFound(world, item);
        emit(ctx, {
          type: "classic.loot.picked",
          kind: "item",
          name: item.name,
          rarity: item.rarity,
          gold: 0,
        });
        continue;
      }
    } else if (hero !== 0) {
      const bag = bagOf(world, hero);
      const next = bag ? placeItem(ctx.registry, bag, item) : null;
      if (next) {
        world.update(hero, Inventory, { items: next.items });
        noteFound(world, item);
        emit(ctx, {
          type: "classic.loot.picked",
          kind: "item",
          name: item.name,
          rarity: item.rarity,
          gold: 0,
        });
        continue;
      }
    }
    // No room: sell the overflow at 10% of its value.
    const price = Math.max(1, pct(item.value, 10));
    const wallet = hero !== 0 ? world.get(hero, Wallet) : undefined;
    if (wallet) {
      const total = wallet.gold + price;
      world.update(hero, Wallet, { gold: total });
      emit(ctx, {
        type: "classic.gold",
        amount: price,
        total,
        reason: `${o.reason}: overflow sold`,
      });
    }
  }
  return OK;
}
