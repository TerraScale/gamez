/**
 * Town vendors (OWNER: T5, design §11.4 and §20): restock on town entry,
 * buy (smith items, alchemist potions and town portal scrolls), sell to the
 * junk buyer. Town-only ops need the NPC within INTERACT_RANGE. The stash is
 * in stash.ts, the gambler in gamble.ts (wave A). Purchases add
 * RunStats.goldSpent (wave A). Alchemist potions and scrolls are upkeep for
 * the offline rate (noteUpkeepGold, offline-idle.md §4.1); smith items are not.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { ERR, fail, INTERACT_RANGE, OK, type OpResult } from "../actions.ts";
import {
  AreaTag,
  Belt,
  Interactable,
  Inventory,
  Level,
  Npc,
  Pos,
  Supplies,
  Wallet,
} from "../components.ts";
import { emit } from "../events.ts";
import { within } from "../fixed.ts";
import {
  currentDepth,
  noteUpkeepGold,
  RES,
  type AreaState,
  type VendorStock,
  type VendorState,
  type DungeonState,
} from "../resources.ts";
import { monsterLevel, potionUnlocked, sellPrice } from "../rules.ts";
import { KIND, type ItemInstance, type ItemRarity, type NpcProto } from "../types.ts";
import { addRunStat, balanceOf, baseOf, liveHero, noteFound } from "./common.ts";
import { beltAccept } from "./belt.ts";
import { placeItem, removeItem } from "./inventory.ts";
import { rollItem } from "./generate.ts";

/** Rolls every vendor stock with sells.count > 0 (design §20): on the first town visit, or when the hero enters town. */
export function restockVendors(world: World, ctx: SimContext): void {
  const area = world.getResource<AreaState>(RES.area);
  if (!area || area.depth !== 0) return;
  const vendors = world.getResource<VendorState>(RES.vendors);
  if (!vendors) return;
  if (vendors.stocks.length > 0 && area.enteredAt !== ctx.tick) return;
  const sellers = ctx.registry.all<NpcProto>(KIND.npc).filter(([, p]) => (p.sells?.count ?? 0) > 0);
  if (sellers.length === 0) return;
  const deepest = world.getResource<DungeonState>(RES.dungeon)?.deepest ?? 0;
  const ilvl = monsterLevel(Math.max(1, deepest));
  const stocks: VendorStock[] = [];
  for (const [id, proto] of sellers) {
    const sells = proto.sells!;
    const items: ItemInstance[] = [];
    for (let i = 0; i < sells.count; i++) {
      // 15 % rare, 45 % magic, 40 % normal: rares are the smith's gold sink.
      const roll = ctx.rng.int(1, 100);
      const rarity: ItemRarity = roll <= 15 ? "rare" : roll <= 60 ? "magic" : "normal";
      const category = sells.categories.length > 0 ? ctx.rng.pick(sells.categories) : undefined;
      const item = rollItem(world, ctx, { ilvl, rarity, magicFind: 0, category });
      if (item) items.push(item);
    }
    stocks.push({ npc: id, items, rolledAt: ctx.tick });
  }
  world.setResource(RES.vendors, { stocks });
}

export type NpcRef = { id: string; proto: Readonly<NpcProto> } | OpResult;

/** The NPC entity as a prototype, when it is within INTERACT_RANGE of the hero. */
export function npcInReach(world: World, ctx: SimContext, hero: Entity, npc: Entity): NpcRef {
  if (!world.has(npc, Npc) || !world.has(npc, Pos)) return fail(ERR.badTarget, "no such npc");
  const id = world.read(npc, Npc).proto;
  const proto = ctx.registry.get<NpcProto>(KIND.npc, id);
  if (!proto) return fail(ERR.unknownId, `unknown npc "${id}"`);
  const hp = world.read(hero, Pos);
  const np = world.read(npc, Pos);
  if (!within(hp.x, hp.y, np.x, np.y, INTERACT_RANGE))
    return fail(ERR.tooFar, "too far from the npc");
  return { id, proto };
}

/** The town stash chest within reach of the hero, or 0. */
export function stashInReach(world: World, hero: Entity): Entity {
  const hp = world.read(hero, Pos);
  for (const e of world.query(Interactable, Pos, AreaTag)) {
    if (world.read(e, Interactable).kind !== "stash") continue;
    if (world.read(e, AreaTag).depth !== 0) continue;
    const p = world.read(e, Pos);
    if (within(hp.x, hp.y, p.x, p.y, INTERACT_RANGE)) return e;
  }
  return 0;
}

export function townOnly(world: World): OpResult | null {
  return currentDepth(world) === 0 ? null : fail(ERR.notInTown, "this is only possible in town");
}

export interface BuyOrder {
  npc: Entity;
  index: number;
  potion: string | null;
  count: number;
}

/** Buys a smith item (by stock index), an alchemist potion or a town portal scroll ("tp"). */
export function execBuy(world: World, ctx: SimContext, o: BuyOrder): OpResult {
  const town = townOnly(world);
  if (town) return town;
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  const hero = h.hero;
  const npc = npcInReach(world, ctx, hero, o.npc);
  if (!("proto" in npc)) return npc;
  const bal = balanceOf(ctx.registry);
  const wallet = world.get(hero, Wallet);
  if (!wallet) return fail(ERR.noHero, "the hero has no wallet yet");

  if (o.potion !== null) {
    const sells = npc.proto.sells;
    if (npc.proto.role !== "alchemist" || !sells) {
      return fail(ERR.badTarget, "this npc does not sell potions");
    }
    if (!Number.isSafeInteger(o.count) || o.count < 1 || o.count > 20) {
      return fail(ERR.badPayload, "count must be 1..20");
    }
    if (o.potion === "tp") {
      if (!sells.tpScroll) return fail(ERR.badTarget, "this npc does not sell scrolls");
      const supplies = world.get(hero, Supplies);
      if (!supplies) return fail(ERR.noHero, "the hero has no supplies yet");
      if (supplies.tpScrolls + o.count > bal.maxTpScrolls) {
        return fail(ERR.badPayload, `the hero carries at most ${bal.maxTpScrolls} scrolls`);
      }
      const total = bal.tpScrollPrice * o.count;
      if (wallet.gold < total) return fail(ERR.noGold, `need ${total} gold`);
      world.update(hero, Wallet, { gold: wallet.gold - total });
      world.update(hero, Supplies, { tpScrolls: supplies.tpScrolls + o.count });
      addRunStat(world, "goldSpent", total);
      noteUpkeepGold(world, total);
      emit(ctx, {
        type: "classic.vendor.bought",
        npc: npc.id,
        name: "Town Portal Scroll",
        price: total,
      });
      return OK;
    }
    if (!sells.potions.includes(o.potion))
      return fail(ERR.badTarget, "this npc does not sell that potion");
    const base = baseOf(ctx.registry, o.potion);
    if (!base || base.category !== "potion")
      return fail(ERR.unknownId, `unknown potion "${o.potion}"`);
    const level = world.get(hero, Level)?.level ?? 1;
    if (!potionUnlocked(base, level))
      return fail(ERR.badTarget, `${base.name} is sold from level ${Math.max(1, base.ilvl - 2)}`);
    const belt = world.get(hero, Belt);
    if (!belt) return fail(ERR.noHero, "the hero has no belt yet");
    const accepted = beltAccept(belt.slots, o.potion, o.count, bal.beltStack);
    if (accepted.left > 0) return fail(ERR.beltFull, "the potion belt has no room for that many");
    const total = base.value * o.count;
    if (wallet.gold < total) return fail(ERR.noGold, `need ${total} gold`);
    world.update(hero, Wallet, { gold: wallet.gold - total });
    world.update(hero, Belt, { slots: accepted.slots });
    addRunStat(world, "goldSpent", total);
    noteUpkeepGold(world, total);
    emit(ctx, { type: "classic.vendor.bought", npc: npc.id, name: base.name, price: total });
    return OK;
  }

  // Smith: one item from the stock, by index.
  if (npc.proto.role !== "smith") return fail(ERR.badTarget, "this npc does not sell items");
  if (o.count !== 1) return fail(ERR.badPayload, "buy one item at a time");
  const vendors = world.getResource<VendorState>(RES.vendors);
  const stockIdx = vendors?.stocks.findIndex((s) => s.npc === npc.id) ?? -1;
  const stock = vendors && stockIdx >= 0 ? vendors.stocks[stockIdx] : undefined;
  const item = stock?.items[o.index];
  if (!stock || !item) return fail(ERR.badTarget, "that item is not in stock");
  const bag = world.get(hero, Inventory);
  if (!bag) return fail(ERR.noHero, "the hero has no inventory yet");
  if (wallet.gold < item.value) return fail(ERR.noGold, `need ${item.value} gold`);
  const next = placeItem(ctx.registry, bag, item);
  if (!next) return fail(ERR.bagFull, "there is no room in the bag");
  world.update(hero, Wallet, { gold: wallet.gold - item.value });
  world.update(hero, Inventory, { items: next.items });
  addRunStat(world, "goldSpent", item.value);
  noteFound(world, item);
  const stocks = vendors!.stocks.map((s, i) =>
    i === stockIdx ? { ...s, items: s.items.filter((_, j) => j !== o.index) } : s,
  );
  world.setResource(RES.vendors, { stocks });
  emit(ctx, { type: "classic.vendor.bought", npc: npc.id, name: item.name, price: item.value });
  return OK;
}

/** Sells a bag item to the junk buyer (buyPct of its value). */
export function execSell(world: World, ctx: SimContext, npcEntity: Entity, uid: number): OpResult {
  const town = townOnly(world);
  if (town) return town;
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  const hero = h.hero;
  const npc = npcInReach(world, ctx, hero, npcEntity);
  if (!("proto" in npc)) return npc;
  if (npc.proto.buyPct <= 0) return fail(ERR.badTarget, "this npc does not buy items");
  const bag = world.get(hero, Inventory);
  const wallet = world.get(hero, Wallet);
  if (!bag || !wallet) return fail(ERR.noHero, "the hero has no inventory yet");
  const removed = removeItem(bag, uid);
  if (!removed) return fail(ERR.unknownId, `item ${uid} is not in the bag`);
  const price = sellPrice(removed.item, npc.proto.buyPct);
  world.update(hero, Inventory, { items: removed.bag.items });
  world.update(hero, Wallet, { gold: wallet.gold + price });
  emit(ctx, { type: "classic.vendor.sold", npc: npc.id, name: removed.item.name, price });
  return OK;
}
