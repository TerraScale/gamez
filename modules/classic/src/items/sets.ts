/**
 * Set bonus thresholds (OWNER: T-items, wave-A.md §5.1). The stat bonuses
 * themselves are computed by rules.setBonusMods (progression.stats); this
 * file only tells the player when a threshold is crossed: callers take a
 * setSnapshot() of the equipment before a change and pass it to
 * emitSetChanges() afterwards (equip, unequip, an item breaking, repair).
 */
import type { Entity, FrozenRegistry, SimContext, World } from "@gamez/kernel";
import { Equipment } from "../components.ts";
import { emit } from "../events.ts";
import { partyOf } from "../party/shared.ts";
import { setPieceCounts } from "../rules.ts";
import { EQUIP_SLOTS, KIND, type ItemInstance, type SetProto } from "../types.ts";

export type SetCounts = { set: string; pieces: number }[];

/** Equipped items in slot order (empty without Equipment). */
export function equippedItems(world: World, hero: Entity): (ItemInstance | null)[] {
  const eq = world.get(hero, Equipment);
  return eq ? EQUIP_SLOTS.map((s) => eq[s]) : [];
}

/** Distinct equipped (unbroken) pieces per set, sorted by set id. */
export function setSnapshot(world: World, reg: FrozenRegistry, hero: Entity): SetCounts {
  return setPieceCounts(reg, equippedItems(world, hero));
}

/** Number of bonuses of `set` active with `pieces` pieces. */
export function activeBonuses(reg: FrozenRegistry, set: string, pieces: number): number {
  const proto = reg.get<SetProto>(KIND.set, set);
  let n = 0;
  for (const b of proto?.bonuses ?? []) if (pieces >= b.count) n++;
  return n;
}

/** Emits classic.set.bonus for every set whose active bonus count changed since `before`. */
export function emitSetChanges(
  world: World,
  ctx: SimContext,
  hero: Entity,
  before: SetCounts,
): void {
  const reg = ctx.registry;
  const after = setSnapshot(world, reg, hero);
  const ids = [...new Set([...before.map((c) => c.set), ...after.map((c) => c.set)])].sort();
  for (const set of ids) {
    const was = before.find((c) => c.set === set)?.pieces ?? 0;
    const now = after.find((c) => c.set === set)?.pieces ?? 0;
    if (was === now) continue;
    const activeBefore = activeBonuses(reg, set, was);
    const active = activeBonuses(reg, set, now);
    if (activeBefore === active) continue;
    const proto = reg.get<SetProto>(KIND.set, set);
    emit(ctx, {
      type: "classic.set.bonus",
      set,
      name: proto?.name ?? set,
      pieces: now,
      active,
      ...(partyOf(world) !== null ? { hero } : {}),
    });
  }
}
