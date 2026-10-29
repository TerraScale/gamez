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
  const cur = world.peek(e, c);
  if (cur === undefined) world.add(e, c, value);
  // An identical merge would leave the state (and its key order) unchanged: skip the
  // write and its rollback copy (the stats system re-derives every hero every tick).
  else if (!mergeIsNoop(cur as Record<string, unknown>, value as Record<string, unknown>)) {
    world.update(e, c, value);
  }
}

/** True when update(patch) would leave `cur` exactly as it is (values and key order). */
function mergeIsNoop(
  cur: Readonly<Record<string, unknown>>,
  patch: Record<string, unknown>,
): boolean {
  for (const k in patch) {
    const v = patch[k];
    if (v === undefined) {
      if (k in cur) return false;
    } else if (!(k in cur) || !jsonEqual(cur[k], v)) return false;
  }
  return true;
}

/** Plain JSON equality, including object key order (it changes hashes). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i]!;
    if (k !== kb[i]) return false;
    const vb = (b as Record<string, unknown>)[k];
    // A nested undefined is dropped by the clone, so it never equals a stored value.
    if (vb === undefined || !jsonEqual((a as Record<string, unknown>)[k], vb)) return false;
  }
  return true;
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
