/**
 * "do.active" points (docs/design/admin-dashboard.md §2.7, §3): one point per
 * Durable Object per DO_ACTIVE_EVERY_MS slot, so the count reads as "DO-slots"
 * (DO instances active per 10-minute slot). The dedupe is per isolate and
 * bounded: a DO active in two isolates writes once per isolate per slot,
 * which the dashboard accepts as an upper bound.
 */
import { DO_ACTIVE_EVERY_MS } from "./schema.ts";
import type { Analytics } from "./types.ts";

/** Most DO keys remembered per isolate; the oldest is forgotten first. */
export const DO_ACTIVE_MAX_KEYS = 2000;

/** AE index limit (96 bytes; ids are ASCII). */
const INDEX_MAX = 96;

const lastWritten = new Map<string, number>();

/**
 * Writes "do.active" for `className:id` unless this isolate already wrote one
 * for it within DO_ACTIVE_EVERY_MS. Returns true when a point was written.
 * Never throws.
 */
export function markDoActive(
  analytics: Analytics,
  className: string,
  id: string,
  now: number,
): boolean {
  try {
    const key = `${className}:${id}`;
    const last = lastWritten.get(key);
    if (last !== undefined && now >= last && now - last < DO_ACTIVE_EVERY_MS) return false;
    lastWritten.delete(key);
    lastWritten.set(key, now);
    while (lastWritten.size > DO_ACTIVE_MAX_KEYS) {
      const oldest = lastWritten.keys().next().value;
      if (oldest === undefined) break;
      lastWritten.delete(oldest);
    }
    analytics.write("do.active", { class: className }, {}, id.slice(0, INDEX_MAX));
    return true;
  } catch {
    return false;
  }
}
