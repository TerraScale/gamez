/**
 * Small component helpers shared by the progression systems and ops.
 * Writes go through the world API so transactions journal them.
 */
import type { ComponentType, Entity, World } from "@gamez/kernel";

/** Shallow-merges `value` into the component, adding it when missing. */
export function put<T extends object>(
  world: World,
  e: Entity,
  c: ComponentType<T>,
  value: T,
): void {
  if (world.has(e, c)) world.update(e, c, value);
  else world.add(e, c, value);
}

/** Replaces the whole component value (for unions and lists where stale fields must go). */
export function replace<T>(world: World, e: Entity, c: ComponentType<T>, value: T): void {
  if (world.has(e, c)) world.remove(e, c);
  world.add(e, c, value);
}

/** Plain-string ordering (never localeCompare). */
export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
