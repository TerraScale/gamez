/**
 * Equipment ops (OWNER: T5, design §11.4): equip, unequip and the
 * two-handed / ring / requirement rules; classic.set.bonus on set threshold
 * changes (wave A). Shared by the actions and the
 * command system.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { ERR, fail, OK, type OpResult } from "../actions.ts";
import { Equipment, Inventory, Level } from "../components.ts";
import { emit } from "../events.ts";
import { EQUIP_SLOTS, type EquipSlot, type ItemInstance, type ItemBaseProto } from "../types.ts";
import { baseOf, liveHero, heroAttrs } from "./common.ts";
import { placeItem, type GridBag } from "./inventory.ts";
import { emitSetChanges, setSnapshot } from "./sets.ts";

export function emptyEquipment(): Record<EquipSlot, ItemInstance | null> {
  const out = {} as Record<EquipSlot, ItemInstance | null>;
  for (const s of EQUIP_SLOTS) out[s] = null;
  return out;
}

/** Level, reqStr and reqDex of a base against the hero (null when met). */
export function requirementsFail(
  world: World,
  hero: Entity,
  base: Readonly<ItemBaseProto>,
): OpResult | null {
  const level = world.get(hero, Level)?.level ?? 1;
  const attrs = heroAttrs(world, hero);
  if (level < base.reqLevel || attrs.str < base.reqStr || attrs.dex < base.reqDex) {
    return fail(
      ERR.requirements,
      `needs level ${base.reqLevel}, ${base.reqStr} str and ${base.reqDex} dex`,
    );
  }
  return null;
}

/** Equips a bag item. Replaced items (and the offhand of a two-handed weapon) go back to the bag. */
export function execEquip(
  world: World,
  ctx: SimContext,
  uid: number,
  slot: EquipSlot | null,
): OpResult {
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  const hero = h.hero;
  const reg = ctx.registry;
  const bag = world.get(hero, Inventory);
  const eq = world.get(hero, Equipment);
  if (!bag || !eq) return fail(ERR.noHero, "the hero has no inventory yet");

  const entry = bag.items.find((e) => e.item.uid === uid);
  if (!entry) return fail(ERR.unknownId, `item ${uid} is not in the bag`);
  const item = entry.item;
  const base = baseOf(reg, item.base);
  if (!base) return fail(ERR.unknownId, `unknown base "${item.base}"`);
  if (base.slots.length === 0) return fail(ERR.badTarget, `${item.name} cannot be equipped`);

  let target: EquipSlot;
  if (slot === null) {
    // Rings: first free ring slot, else ring1. Others: first allowed slot.
    target = base.slots.find((s) => eq[s] === null) ?? base.slots[0]!;
  } else if (base.slots.includes(slot)) {
    target = slot;
  } else {
    return fail(ERR.badTarget, `${item.name} does not fit the ${slot} slot`);
  }

  const req = requirementsFail(world, hero, base);
  if (req) return req;

  const weaponBase = eq.weapon ? baseOf(reg, eq.weapon.base) : undefined;
  if (target === "offhand" && weaponBase?.twoHanded) {
    return fail(ERR.blocked, "a two-handed weapon is equipped");
  }

  const twoHanded = target === "weapon" && base.twoHanded === true;
  const displaced: { item: ItemInstance; slot: EquipSlot }[] = [];
  if (twoHanded) {
    if (eq.weapon) displaced.push({ item: eq.weapon, slot: "weapon" });
    if (eq.offhand) displaced.push({ item: eq.offhand, slot: "offhand" });
  } else {
    const old = eq[target];
    if (old) displaced.push({ item: old, slot: target });
  }

  let grid: GridBag = {
    cols: bag.cols,
    rows: bag.rows,
    items: bag.items.filter((e) => e.item.uid !== uid),
  };
  for (const d of displaced) {
    const next = placeItem(reg, grid, d.item);
    if (!next) return fail(ERR.bagFull, "there is no room in the bag for the replaced item");
    grid = next;
  }

  const sets = setSnapshot(world, reg, hero);
  const nextEq = { ...eq };
  nextEq[target] = item;
  if (twoHanded) nextEq.offhand = null;
  world.update(hero, Inventory, { items: grid.items });
  world.update(hero, Equipment, nextEq);

  for (const d of displaced)
    emit(ctx, { type: "classic.item.unequipped", uid: d.item.uid, slot: d.slot });
  emit(ctx, { type: "classic.item.equipped", uid, slot: target, name: item.name });
  emitSetChanges(world, ctx, hero, sets);
  return OK;
}

/** Moves the item of a slot into the bag. */
export function execUnequip(world: World, ctx: SimContext, slot: EquipSlot): OpResult {
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  const hero = h.hero;
  const bag = world.get(hero, Inventory);
  const eq = world.get(hero, Equipment);
  if (!bag || !eq) return fail(ERR.noHero, "the hero has no inventory yet");
  const item = eq[slot];
  if (!item) return fail(ERR.empty, `nothing is equipped in the ${slot} slot`);
  const next = placeItem(ctx.registry, bag, item);
  if (!next) return fail(ERR.bagFull, "there is no room in the bag");
  const sets = setSnapshot(world, ctx.registry, hero);
  const nextEq = { ...eq };
  nextEq[slot] = null;
  world.update(hero, Inventory, { items: next.items });
  world.update(hero, Equipment, nextEq);
  emit(ctx, { type: "classic.item.unequipped", uid: item.uid, slot });
  emitSetChanges(world, ctx, hero, sets);
  return OK;
}
