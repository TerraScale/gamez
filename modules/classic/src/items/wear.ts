/**
 * classic.items.wear (post 110, OWNER: T-items, wave-A.md §5.3): durability
 * from Bus.deaths.
 *
 * - Every EconomyProto.repair.everyKills hero-credited kills: the weapon and
 *   one ctx.rng-picked worn armor piece (shield / helm / armor / gloves /
 *   boots) lose 1 durability.
 * - A hero death: every equipped item loses deathLossPct % of its max (min 1).
 * - classic.item.worn once at <= 10 % (per uid until repaired),
 *   classic.item.broken at 0. Broken items keep their slot; rules.addItemStats
 *   and progression.stats ignore them.
 *
 * Items without `dur` count as full and get one the first time they wear.
 * State: resource WEAR_RES (kill counter + warned uids), created lazily.
 * Early-outs: no deaths, no economy, no hero.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, type DeathRecord } from "../bus.ts";
import { Equipment } from "../components.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { heroOf } from "../resources.ts";
import { maxDurabilityOf } from "../rules.ts";
import { EQUIP_SLOTS, type EquipSlot, type ItemInstance } from "../types.ts";
import { baseOf, economyOf } from "./common.ts";
import { emitSetChanges, setSnapshot } from "./sets.ts";

/** Items-owned resource: kills toward the next wear step and uids already warned as worn. */
export const WEAR_RES = "classic.items.wear";

export interface WearState {
  /** Hero-credited kills since the last wear step (0..everyKills-1). */
  kills: number;
  /** Uids that got classic.item.worn and were not repaired since (ascending). */
  warned: number[];
}

export function wearOf(world: World): WearState {
  const cur = world.getResource<WearState>(WEAR_RES);
  if (cur) return cur;
  world.setResource<WearState>(WEAR_RES, { kills: 0, warned: [] });
  return world.getResource<WearState>(WEAR_RES)!;
}

/** Forgets the worn warning of repaired items (no-op when nothing was warned). */
export function clearWarned(world: World, uids: readonly number[]): void {
  const w = world.getResource<WearState>(WEAR_RES);
  if (!w || w.warned.length === 0) return;
  if (!uids.some((u) => w.warned.includes(u))) return;
  w.warned = w.warned.filter((u) => !uids.includes(u));
}

/** Slots whose items count as worn armor for the kill wear step. */
const ARMOR_CATEGORIES = new Set(["shield", "helm", "armor", "gloves", "boots"]);

/** Same predicate as loot: monster deaths credited to the hero. */
function isHeroKill(d: DeathRecord): boolean {
  return d.creditTeam === "hero" && !d.isHero && d.rarity !== "hero" && d.rarity !== "summon";
}

interface Loss {
  slot: EquipSlot;
  amount: number;
}

/**
 * Applies durability losses to equipped items (initialising a missing dur
 * first) and emits worn / broken events and set threshold changes.
 */
export function applyWear(world: World, ctx: SimContext, hero: Entity, losses: Loss[]): void {
  if (losses.length === 0) return;
  const eq = world.get(hero, Equipment);
  if (!eq) return;
  const reg = ctx.registry;
  const sets = setSnapshot(world, reg, hero);
  const patch: Partial<Record<EquipSlot, ItemInstance | null>> = {};
  const events: { kind: "worn" | "broken"; item: ItemInstance; slot: EquipSlot }[] = [];
  const state = wearOf(world);
  for (const { slot, amount } of losses) {
    const item = patch[slot] ?? eq[slot];
    if (!item || amount <= 0) continue;
    const base = baseOf(reg, item.base);
    if (!base) continue;
    const max = item.dur?.max ?? maxDurabilityOf(base);
    if (max <= 0) continue;
    const cur = item.dur?.cur ?? max;
    if (cur <= 0) continue;
    const next = Math.max(0, cur - amount);
    patch[slot] = { ...item, dur: { cur: next, max } };
    if (next === 0) {
      events.push({ kind: "broken", item, slot });
    } else if (next * 10 <= max && !state.warned.includes(item.uid)) {
      events.push({ kind: "worn", item, slot });
    }
  }
  if (Object.keys(patch).length === 0) return;
  world.update(hero, Equipment, patch);
  for (const ev of events) {
    if (ev.kind === "worn") state.warned = [...state.warned, ev.item.uid].sort((a, b) => a - b);
    emit(ctx, {
      type: ev.kind === "worn" ? "classic.item.worn" : "classic.item.broken",
      uid: ev.item.uid,
      slot: ev.slot,
      name: ev.item.name,
    });
  }
  emitSetChanges(world, ctx, hero, sets);
}

/** Equipped slots whose item can still lose durability (max > 0, not broken). */
function wearable(world: World, ctx: SimContext, hero: Entity, armorOnly: boolean): EquipSlot[] {
  const eq = world.get(hero, Equipment);
  if (!eq) return [];
  const out: EquipSlot[] = [];
  for (const slot of EQUIP_SLOTS) {
    const item = eq[slot];
    if (!item) continue;
    const base = baseOf(ctx.registry, item.base);
    if (!base) continue;
    if (armorOnly && !ARMOR_CATEGORIES.has(base.category)) continue;
    const max = item.dur?.max ?? maxDurabilityOf(base);
    if (max <= 0 || (item.dur?.cur ?? max) <= 0) continue;
    out.push(slot);
  }
  return out;
}

export const wearSystem: SystemDef = {
  ...SYSTEM.itemsWear,
  run(world, ctx) {
    const bus = busOf(world);
    if (bus.deaths.length === 0) return;
    const econ = economyOf(ctx.registry);
    if (!econ) return;
    const hero = heroOf(world);
    if (hero === 0 || !world.has(hero, Equipment)) return;

    let kills = 0;
    let heroDied = false;
    for (const d of bus.deaths) {
      if (d.isHero && d.entity === hero) heroDied = true;
      else if (isHeroKill(d)) kills++;
    }

    const every = Math.max(1, Math.floor(econ.repair.everyKills));
    if (kills > 0) {
      const state = wearOf(world);
      let total = state.kills + kills;
      while (total >= every) {
        total -= every;
        const losses: Loss[] = [];
        const eq = world.read(hero, Equipment);
        if (eq.weapon && wearable(world, ctx, hero, false).includes("weapon")) {
          losses.push({ slot: "weapon", amount: 1 });
        }
        const armor = wearable(world, ctx, hero, true);
        if (armor.length > 0) {
          losses.push({ slot: armor.length === 1 ? armor[0]! : ctx.rng.pick(armor), amount: 1 });
        }
        applyWear(world, ctx, hero, losses);
      }
      wearOf(world).kills = total;
    }

    if (heroDied) {
      const eq = world.read(hero, Equipment);
      const losses: Loss[] = [];
      for (const slot of wearable(world, ctx, hero, false)) {
        const item = eq[slot]!;
        const base = baseOf(ctx.registry, item.base)!;
        const max = item.dur?.max ?? maxDurabilityOf(base);
        losses.push({
          slot,
          amount: Math.max(1, Math.floor((max * econ.repair.deathLossPct) / 100)),
        });
      }
      applyWear(world, ctx, hero, losses);
    }
  },
};
