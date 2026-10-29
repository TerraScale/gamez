/**
 * classic.items.heroInit (pre -900, OWNER: T5, design §4 and §20): gives a new
 * hero its bag, equipment (class starter gear), belt (starter potions),
 * wallet and scrolls, then restocks the town vendors when due.
 *
 * Party (docs/design/party.md §2.3 I4): runs for every member without an
 * Inventory (slot order). Wallet and Supplies (the purse) only go to a solo
 * hero or the founder; a recruit gets its kit but no purse.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { Belt, Equipment, Hero, Inventory, Supplies, Wallet } from "../components.ts";
import { SYSTEM } from "../ids.ts";
import { founderOf, partyMembers, partyOf } from "../party/shared.ts";
import { KIND, type ClassProto } from "../types.ts";
import { balanceOf, baseOf } from "./common.ts";
import { beltAccept, type BeltSlot } from "./belt.ts";
import { emptyEquipment } from "./equip.ts";
import { placeItem, type GridBag } from "./inventory.ts";
import { rollItem } from "./generate.ts";
import { restockVendors } from "./vendor.ts";
import type { EquipSlot, ItemInstance } from "../types.ts";

export const STARTING_GOLD = 50;
export const STARTING_SCROLLS = 2;

/** Gives a hero without Inventory its starting kit (components that already exist are kept). */
export function initHeroKit(world: World, ctx: SimContext, hero: Entity): void {
  const reg = ctx.registry;
  const bal = balanceOf(reg);
  const heroProto = world.get(hero, Hero);
  const cls = heroProto ? reg.get<ClassProto>(KIND.class, heroProto.classId) : undefined;

  let bag: GridBag = { cols: bal.invCols, rows: bal.invRows, items: [] };
  if (!world.has(hero, Equipment)) {
    const eq = emptyEquipment();
    for (const id of cls?.starterItems ?? []) {
      const item: ItemInstance | null = rollItem(world, ctx, {
        ilvl: 1,
        rarity: "normal",
        magicFind: 0,
        base: id,
      });
      if (!item) continue;
      const base = baseOf(reg, id)!;
      const free = base.slots.find((s: EquipSlot) => eq[s] === null);
      if (free) {
        eq[free] = item;
      } else {
        const next = placeItem(reg, bag, item);
        if (next) bag = next;
      }
    }
    world.add(hero, Equipment, eq);
  }
  world.add(hero, Inventory, { cols: bag.cols, rows: bag.rows, items: bag.items });

  if (!world.has(hero, Belt)) {
    let slots: BeltSlot[] = Array.from({ length: bal.beltSlots }, () => ({ base: null, count: 0 }));
    for (const sp of cls?.starterPotions ?? []) {
      slots = beltAccept(slots, sp.base, sp.count, bal.beltStack).slots;
    }
    world.add(hero, Belt, { slots, readyAt: 0 });
  }
  // The purse (I4): a solo hero or the founder only.
  if (partyOf(world) !== null && hero !== founderOf(world)) return;
  if (!world.has(hero, Wallet)) world.add(hero, Wallet, { gold: STARTING_GOLD });
  if (!world.has(hero, Supplies)) world.add(hero, Supplies, { tpScrolls: STARTING_SCROLLS });
}

export const heroInitSystem: SystemDef = {
  ...SYSTEM.itemsHeroInit,
  run(world, ctx) {
    const members = partyMembers(world);
    if (members.length === 0) return;
    for (const hero of members) {
      if (!world.has(hero, Inventory)) initHeroKit(world, ctx, hero);
    }
    restockVendors(world, ctx);
  },
};
