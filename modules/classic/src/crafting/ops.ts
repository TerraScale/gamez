/**
 * Smith services (OWNER: T-items, wave-A.md §5.2-5.4). One execX per op,
 * shared by the classic.crafting actions (ActionError on failure) and its
 * command system (classic.command.failed). Every op needs the town, `npc` =
 * an NPC whose NpcProto.crafts is set (ERR.notSmith) within INTERACT_RANGE
 * (ERR.tooFar), the item in the bag or equipped (ERR.unknownId) and enough
 * gold (ERR.noGold). Nothing is written before every check passed.
 * Equipped items edited in place keep their slot.
 *
 * RunStats: goldSpent for every paid op; itemsCrafted for a successful
 * upgrade, reroll, added socket and combined gems (resources.ts RunStats
 * doc); gemsSocketed per socketed gem. Repair adds only goldSpent.
 *
 * Party (docs/design/party.md §7.4): every op acts for an explicit hero (its
 * bag and equipment, its reach to the smith); gold comes from the purse.
 */
import type { Entity, FrozenRegistry, SimContext, World } from "@gamez/kernel";
import { ERR, fail, INTERACT_RANGE, OK, type OpResult } from "../actions.ts";
import { Equipment, Inventory, Npc, Pos, type InvEntry } from "../components.ts";
import { emit } from "../events.ts";
import { within } from "../fixed.ts";
import {
  maxDurabilityOf,
  repairCost,
  rerollCost,
  socketCost,
  socketGroup,
  upgradeCost,
} from "../rules.ts";
import {
  EQUIP_SLOTS,
  KIND,
  type EconomyProto,
  type EquipSlot,
  type ItemBaseProto,
  type ItemInstance,
  type NpcProto,
} from "../types.ts";
import {
  addRunStat,
  baseOf,
  economyOf,
  liveHero,
  townOnly,
  clearWarned,
  emitSetChanges,
  gemBaseOf,
  heroTag,
  purseWallet,
  setPurseGold,
  makeGemItem,
  rollAffixes,
  setSnapshot,
  placeItem,
  removeItem,
  type GridBag,
} from "../items/index.ts";

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

interface Smith {
  hero: Entity;
  npc: string;
  econ: Readonly<EconomyProto>;
}

/** Town, `hero` alive, a crafting NPC in its reach and the economy prototype. */
export function smithFor(
  world: World,
  ctx: SimContext,
  hero: Entity,
  npcEntity: Entity,
): Smith | OpResult {
  const town = townOnly(world);
  if (town) return town;
  const h = liveHero(world, hero);
  if (!("hero" in h)) return h;
  if (!world.exists(npcEntity) || !world.has(npcEntity, Npc) || !world.has(npcEntity, Pos)) {
    return fail(ERR.badTarget, "no such npc");
  }
  const id = world.read(npcEntity, Npc).proto;
  const proto = ctx.registry.get<NpcProto>(KIND.npc, id);
  if (!proto) return fail(ERR.unknownId, `unknown npc "${id}"`);
  if (!proto.crafts) return fail(ERR.notSmith, `${proto.name} offers no smithing`);
  const hp = world.read(hero, Pos);
  const np = world.read(npcEntity, Pos);
  if (!within(hp.x, hp.y, np.x, np.y, INTERACT_RANGE)) {
    return fail(ERR.tooFar, "too far from the smith");
  }
  const econ = economyOf(ctx.registry);
  if (!econ) return fail(ERR.notSmith, "smithing is not available");
  return { hero, npc: id, econ };
}

/** Where an item is: a bag entry or an equipment slot. */
export type ItemLoc = { at: "bag"; entry: InvEntry } | { at: "slot"; slot: EquipSlot };

export interface Located {
  item: ItemInstance;
  base: Readonly<ItemBaseProto>;
  loc: ItemLoc;
}

/** Finds `uid` in the bag or the equipment (ERR.unknownId otherwise). */
export function locate(
  world: World,
  reg: FrozenRegistry,
  hero: Entity,
  uid: number,
): Located | OpResult {
  const bag = world.get(hero, Inventory);
  const entry = bag?.items.find((e) => e.item.uid === uid);
  let item: ItemInstance | undefined;
  let loc: ItemLoc | undefined;
  if (entry) {
    item = entry.item;
    loc = { at: "bag", entry };
  } else {
    const eq = world.get(hero, Equipment);
    for (const slot of EQUIP_SLOTS) {
      const it = eq?.[slot];
      if (it && it.uid === uid) {
        item = it;
        loc = { at: "slot", slot };
        break;
      }
    }
  }
  if (!item || !loc) return fail(ERR.unknownId, `item ${uid} is not carried`);
  const base = baseOf(reg, item.base);
  if (!base) return fail(ERR.unknownId, `unknown base "${item.base}"`);
  return { item, base, loc };
}

/** Writes `item` back where it was (same bag cell or same slot). */
export function writeBack(world: World, hero: Entity, loc: ItemLoc, item: ItemInstance): void {
  if (loc.at === "slot") {
    world.update(hero, Equipment, { [loc.slot]: item });
    return;
  }
  const bag = world.read(hero, Inventory);
  world.update(hero, Inventory, {
    items: bag.items.map((e) =>
      e.item.uid === item.uid ? { item, x: loc.entry.x, y: loc.entry.y } : e,
    ),
  });
}

/** Pays `cost` gold from the party purse (checked first by the caller) and counts it as spent. */
function pay(world: World, cost: number): void {
  if (cost <= 0) return;
  const wallet = purseWallet(world)!;
  setPurseGold(world, wallet.purse, wallet.gold - cost);
  addRunStat(world, "goldSpent", cost);
}

function needGold(world: World, cost: number): OpResult | null {
  return (purseWallet(world)?.gold ?? 0) < cost ? fail(ERR.noGold, `need ${cost} gold`) : null;
}

/** Item name without a trailing smith suffix " +N". */
export function baseName(name: string): string {
  return name.replace(/ \+\d+$/, "");
}

/** Item name with the smith suffix for `level` (none at 0). */
export function upgradedName(name: string, level: number): string {
  const plain = baseName(name);
  return level > 0 ? `${plain} +${level}` : plain;
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/** Repairs one item (uid > 0) or everything worn and carried that needs it (uid 0). */
export function execRepair(
  world: World,
  ctx: SimContext,
  hero: Entity,
  npc: Entity,
  uid: number,
): OpResult {
  const s = smithFor(world, ctx, hero, npc);
  if (!("hero" in s)) return s;
  const { econ } = s;
  const reg = ctx.registry;

  const targets: { item: ItemInstance; loc: ItemLoc; cost: number }[] = [];
  if (uid === 0) {
    const eq = world.get(hero, Equipment);
    for (const slot of EQUIP_SLOTS) {
      const it = eq?.[slot];
      if (!it) continue;
      const cost = repairCost(econ, it);
      if (cost > 0) targets.push({ item: it, loc: { at: "slot", slot }, cost });
    }
    for (const entry of world.get(hero, Inventory)?.items ?? []) {
      const cost = repairCost(econ, entry.item);
      if (cost > 0) targets.push({ item: entry.item, loc: { at: "bag", entry }, cost });
    }
    if (targets.length === 0) return fail(ERR.noRepairNeeded, "nothing needs repair");
  } else {
    const f = locate(world, reg, hero, uid);
    if (!("item" in f)) return f;
    if (maxDurabilityOf(f.base) <= 0 && !f.item.dur) {
      return fail(ERR.indestructible, `${f.item.name} never wears`);
    }
    const cost = repairCost(econ, f.item);
    if (cost <= 0) return fail(ERR.noRepairNeeded, `${f.item.name} needs no repair`);
    targets.push({ item: f.item, loc: f.loc, cost });
  }

  const total = targets.reduce((n, t) => n + t.cost, 0);
  const broke = needGold(world, total);
  if (broke) return broke;

  const sets = setSnapshot(world, reg, hero);
  pay(world, total);
  for (const t of targets) {
    const max = t.item.dur!.max;
    writeBack(world, hero, t.loc, { ...t.item, dur: { cur: max, max } });
  }
  const uids = targets.map((t) => t.item.uid);
  clearWarned(world, uids);
  emit(ctx, { type: "classic.repaired", uids, cost: total, ...heroTag(world, hero) });
  emitSetChanges(world, ctx, hero, sets);
  return OK;
}

// ---------------------------------------------------------------------------
// Upgrade and reroll
// ---------------------------------------------------------------------------

/** Upgrades an item one level: costs rules.upgradeCost, succeeds with chancePct[L] (ctx.rng). */
export function execUpgrade(
  world: World,
  ctx: SimContext,
  hero: Entity,
  npc: Entity,
  uid: number,
): OpResult {
  const s = smithFor(world, ctx, hero, npc);
  if (!("hero" in s)) return s;
  const { econ } = s;
  const f = locate(world, ctx.registry, hero, uid);
  if (!("item" in f)) return f;
  if (socketGroup(f.base) === null) return fail(ERR.badTarget, `${f.item.name} cannot be upgraded`);
  const cost = upgradeCost(econ, f.item);
  if (cost === null) return fail(ERR.maxUpgrade, `${f.item.name} is fully upgraded`);
  const broke = needGold(world, cost);
  if (broke) return broke;

  const level = f.item.upgrade ?? 0;
  const chance = econ.upgrade.chancePct[level] ?? 0;
  const success = ctx.rng.int(0, 99) < chance;
  pay(world, cost);
  let item = f.item;
  if (success) {
    item = { ...f.item, upgrade: level + 1, name: upgradedName(f.item.name, level + 1) };
    writeBack(world, hero, f.loc, item);
    addRunStat(world, "itemsCrafted", 1);
  }
  emit(ctx, {
    type: "classic.upgraded",
    uid,
    name: item.name,
    level: item.upgrade ?? 0,
    success,
    cost,
    ...heroTag(world, hero),
  });
  return OK;
}

/** New affixes for the same base, rarity and ilvl (magic and rare only). */
export function execReroll(
  world: World,
  ctx: SimContext,
  hero: Entity,
  npc: Entity,
  uid: number,
): OpResult {
  const s = smithFor(world, ctx, hero, npc);
  if (!("hero" in s)) return s;
  const { econ } = s;
  const f = locate(world, ctx.registry, hero, uid);
  if (!("item" in f)) return f;
  const cost = rerollCost(econ, f.item);
  if (cost === null) return fail(ERR.notRerollable, `${f.item.name} cannot be rerolled`);
  const broke = needGold(world, cost);
  if (broke) return broke;

  const rolled = rollAffixes(ctx, f.base, f.item.rarity, f.item.ilvl);
  pay(world, cost);
  const item: ItemInstance = {
    ...f.item,
    mods: rolled.mods,
    affixes: rolled.affixes,
    name: upgradedName(rolled.name, f.item.upgrade ?? 0),
    rerolls: (f.item.rerolls ?? 0) + 1,
  };
  writeBack(world, hero, f.loc, item);
  addRunStat(world, "itemsCrafted", 1);
  emit(ctx, { type: "classic.rerolled", uid, name: item.name, cost, ...heroTag(world, hero) });
  return OK;
}

// ---------------------------------------------------------------------------
// Sockets and gems
// ---------------------------------------------------------------------------

/** Adds one empty socket (EconomyProto.sockets.addCost[n]). */
export function execAddSocket(
  world: World,
  ctx: SimContext,
  hero: Entity,
  npc: Entity,
  uid: number,
): OpResult {
  const s = smithFor(world, ctx, hero, npc);
  if (!("hero" in s)) return s;
  const { econ } = s;
  const f = locate(world, ctx.registry, hero, uid);
  if (!("item" in f)) return f;
  const cost = socketGroup(f.base) === null ? null : socketCost(econ, f.base, f.item);
  if (cost === null) return fail(ERR.maxSockets, `${f.item.name} cannot take more sockets`);
  const broke = needGold(world, cost);
  if (broke) return broke;
  pay(world, cost);
  const sockets = [...(f.item.sockets ?? []), null];
  writeBack(world, hero, f.loc, { ...f.item, sockets });
  addRunStat(world, "itemsCrafted", 1);
  emit(ctx, {
    type: "classic.socket.added",
    uid,
    sockets: sockets.length,
    cost,
    ...heroTag(world, hero),
  });
  return OK;
}

/** A gem in the bag: its entry and gem base, or the failure. */
function bagGem(
  world: World,
  reg: FrozenRegistry,
  hero: Entity,
  gemUid: number,
): { entry: InvEntry; base: Readonly<ItemBaseProto> } | OpResult {
  const entry = world.get(hero, Inventory)?.items.find((e) => e.item.uid === gemUid);
  const base = entry ? baseOf(reg, entry.item.base) : undefined;
  if (!entry || !base?.gem) return fail(ERR.notGem, `item ${gemUid} is not a gem in the bag`);
  return { entry, base };
}

/** Puts a bag gem into the first empty socket of `uid` (free). */
export function execSocketGem(
  world: World,
  ctx: SimContext,
  hero: Entity,
  npc: Entity,
  uid: number,
  gemUid: number,
): OpResult {
  const s = smithFor(world, ctx, hero, npc);
  if (!("hero" in s)) return s;
  const reg = ctx.registry;
  const f = locate(world, reg, hero, uid);
  if (!("item" in f)) return f;
  if (gemUid === uid) return fail(ERR.notGem, "an item cannot be socketed into itself");
  const g = bagGem(world, reg, hero, gemUid);
  if (!("entry" in g)) return g;
  const sockets = f.item.sockets ?? [];
  if (sockets.length === 0) return fail(ERR.noSockets, `${f.item.name} has no sockets`);
  const slot = sockets.indexOf(null);
  if (slot < 0) return fail(ERR.socketsFull, `every socket of ${f.item.name} is filled`);

  const gemId = g.entry.item.base;
  const bag = world.read(hero, Inventory);
  const removed = removeItem(bag, gemUid)!;
  world.update(hero, Inventory, { items: removed.bag.items });
  const next = sockets.slice();
  next[slot] = gemId;
  writeBack(world, hero, f.loc, { ...f.item, sockets: next });
  addRunStat(world, "gemsSocketed", 1);
  emit(ctx, { type: "classic.gem.socketed", uid, gem: gemId, slot, ...heroTag(world, hero) });
  return OK;
}

/** Removes every gem of `uid` into the bag (all or nothing, ERR.bagFull) for unsocketCost. */
export function execUnsocket(
  world: World,
  ctx: SimContext,
  hero: Entity,
  npc: Entity,
  uid: number,
): OpResult {
  const s = smithFor(world, ctx, hero, npc);
  if (!("hero" in s)) return s;
  const { econ } = s;
  const reg = ctx.registry;
  const f = locate(world, reg, hero, uid);
  if (!("item" in f)) return f;
  const sockets = f.item.sockets ?? [];
  if (sockets.length === 0) return fail(ERR.noSockets, `${f.item.name} has no sockets`);
  const gems = sockets.filter((g): g is string => g !== null);
  if (gems.length === 0) return fail(ERR.empty, `${f.item.name} has no gems`);
  for (const g of gems) {
    if (!baseOf(reg, g)) return fail(ERR.unknownId, `unknown gem "${g}"`);
  }
  const cost = econ.sockets.unsocketCost;
  const broke = needGold(world, cost);
  if (broke) return broke;

  // Fit check with placeholder uids first (the bag minus nothing: the host stays where it is).
  let grid: GridBag = world.read(hero, Inventory);
  for (const [i, g] of gems.entries()) {
    const next = placeItem(reg, grid, probeItem(g, -2 - i));
    if (!next) return fail(ERR.bagFull, "there is no room in the bag for the gems");
    grid = next;
  }

  pay(world, cost);
  writeBack(world, hero, f.loc, { ...f.item, sockets: sockets.map(() => null) });
  let bag: GridBag = world.read(hero, Inventory);
  for (const g of gems) bag = placeItem(reg, bag, makeGemItem(world, reg, g))!;
  world.update(hero, Inventory, { items: bag.items });
  emit(ctx, { type: "classic.gems.removed", uid, gems, cost, ...heroTag(world, hero) });
  return OK;
}

/** A stand-in for fit checks (negative uid; -1 is the grid's "skip nothing" marker, so use <= -2). */
function probeItem(base: string, uid = -2): ItemInstance {
  return { uid, base, rarity: "normal", ilvl: 1, name: "", mods: [], affixes: [], value: 0 };
}

/** Three bag gems of `baseId` -> one gem of the same kind, one tier higher. */
export function execCombineGems(
  world: World,
  ctx: SimContext,
  hero: Entity,
  npc: Entity,
  baseId: string,
): OpResult {
  const s = smithFor(world, ctx, hero, npc);
  if (!("hero" in s)) return s;
  const { econ } = s;
  const reg = ctx.registry;
  const base = baseOf(reg, baseId);
  if (!base?.gem) return fail(ERR.notGem, `"${baseId}" is not a gem`);
  const tier = base.gem.tier;
  const to = tier >= 5 ? undefined : gemBaseOf(reg, base.gem.kind, tier + 1);
  const cost = econ.sockets.combineCost[tier - 1];
  if (!to || cost === undefined) return fail(ERR.maxTier, `${base.name} cannot be combined`);
  const bag = world.get(hero, Inventory);
  const uids = (bag?.items ?? [])
    .filter((e) => e.item.base === baseId)
    .map((e) => e.item.uid)
    .sort((a, b) => a - b)
    .slice(0, 3);
  if (uids.length < 3) return fail(ERR.needThree, `needs three ${base.name}`);
  const broke = needGold(world, cost);
  if (broke) return broke;

  let grid: GridBag = bag!;
  for (const u of uids) grid = removeItem(grid, u)!.bag;
  if (!placeItem(reg, grid, probeItem(to))) return fail(ERR.bagFull, "there is no room in the bag");
  pay(world, cost);
  const next = placeItem(reg, grid, makeGemItem(world, reg, to))!;
  world.update(hero, Inventory, { items: next.items });
  addRunStat(world, "itemsCrafted", 1);
  emit(ctx, { type: "classic.gems.combined", from: baseId, to, cost, ...heroTag(world, hero) });
  return OK;
}
