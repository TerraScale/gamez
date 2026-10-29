/**
 * Unit helpers shared by classic.core and classic.combat (T3-owned, pure):
 * area membership, status queries (stun / slow / buff mods), busy checks and
 * body-vs-wall collision. Everything reads the world and the registry only.
 */
import type { Entity, FrozenRegistry, World } from "@gamez/kernel";
import { AreaTag, Casting, Dash, Dead, Statuses, type StatusInstance } from "../components.ts";
import { KIND, type StatId, type StatusKind, type StatusProto } from "../types.ts";
import { walkableSub, type ClassicMap } from "../world/maps.ts";

/** True when `e` lives in area `depth`. */
export function inArea(world: World, e: Entity, depth: number): boolean {
  const a = world.peek(e, AreaTag);
  return a !== undefined && a.depth === depth;
}

/** StatusProto of a status id (undefined when unknown). */
export function statusProto(
  registry: FrozenRegistry,
  id: string,
): Readonly<StatusProto> | undefined {
  return registry.get<StatusProto>(KIND.status, id);
}

/** Active (until > tick) statuses of `e`, or an empty list. */
function activeList(world: World, e: Entity): readonly StatusInstance[] {
  return world.peek(e, Statuses)?.list ?? [];
}

/** Highest power among active statuses of `kind` (0 when none). */
export function statusPower(
  world: World,
  registry: FrozenRegistry,
  e: Entity,
  kind: StatusKind,
  tick: number,
): number {
  const list = activeList(world, e);
  if (list.length === 0) return 0;
  let best = 0;
  for (const s of list) {
    if (s.until <= tick) continue;
    if (statusProto(registry, s.id)?.kind !== kind) continue;
    if (s.power > best) best = s.power;
  }
  return best;
}

export function isStunned(
  world: World,
  registry: FrozenRegistry,
  e: Entity,
  tick: number,
): boolean {
  const list = activeList(world, e);
  if (list.length === 0) return false;
  for (const s of list) {
    if (s.until > tick && statusProto(registry, s.id)?.kind === "stun") return true;
  }
  return false;
}

/** Strongest active slow in percent, clamped to 0..90. */
export function slowPct(world: World, registry: FrozenRegistry, e: Entity, tick: number): number {
  return Math.max(0, Math.min(90, statusPower(world, registry, e, "slow", tick)));
}

/** Sum of a stat over active buff statuses (StatusProto.mods x power). */
export function buffStat(
  world: World,
  registry: FrozenRegistry,
  e: Entity,
  stat: StatId,
  tick: number,
): number {
  const list = activeList(world, e);
  if (list.length === 0) return 0;
  let total = 0;
  for (const s of list) {
    if (s.until <= tick) continue;
    const proto = statusProto(registry, s.id);
    if (proto?.kind !== "buff" || !proto.mods) continue;
    for (const m of proto.mods) if (m.stat === stat) total += m.perPower * s.power;
  }
  return total;
}

/** Casting, dashing, dead or stunned units do not start anything new. */
export function isBusy(world: World, registry: FrozenRegistry, e: Entity, tick: number): boolean {
  return (
    world.has(e, Casting) ||
    world.has(e, Dash) ||
    world.has(e, Dead) ||
    isStunned(world, registry, e, tick)
  );
}

/**
 * True when a body of radius `r` centred at (x, y) fits: its four corner
 * points (+- 70 % of the radius) are all on walkable tiles.
 */
export function canStand(map: ClassicMap, x: number, y: number, r: number): boolean {
  const k = Math.floor((r * 7) / 10);
  if (k <= 0) return walkableSub(map, x, y);
  return (
    walkableSub(map, x - k, y - k) &&
    walkableSub(map, x + k, y - k) &&
    walkableSub(map, x - k, y + k) &&
    walkableSub(map, x + k, y + k)
  );
}
