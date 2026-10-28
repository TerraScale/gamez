/**
 * The "Trade with <name>" bubble that a tap on a remote hero opens (wave C,
 * docs/design/wave-C.md §10.4). OWNER: T-classic-ui.
 *
 * A page-wide store (like the stash tab selection): TownPresence sets it when a
 * remote avatar is tapped, the HUD (hud/widgets/PresenceBubble.tsx) renders it.
 * Pure: no DOM, no React.
 */

export interface TradeBubble {
  /** Account of the tapped hero (from its presence entity id). */
  accountId: string;
  /** Name shown on the avatar. */
  displayName: string;
}

let current: TradeBubble | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

/** The open bubble, or null. */
export function getTradeBubble(): TradeBubble | null {
  return current;
}

/** Opens the bubble for a tapped hero (replaces an open one). */
export function showTradeBubble(b: TradeBubble): void {
  if (current && current.accountId === b.accountId && current.displayName === b.displayName) return;
  current = { accountId: b.accountId, displayName: b.displayName };
  emit();
}

/** Closes the bubble (no-op when none is open). */
export function clearTradeBubble(): void {
  if (current === null) return;
  current = null;
  emit();
}

/** Change notifications for useSyncExternalStore. Returns the unsubscribe function. */
export function subscribeTradeBubble(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * The account id of a presence entity ("<accountId>:classic-town"), derived by
 * stripping the world suffix. Ids without the suffix are returned unchanged.
 */
export function accountIdOfPresence(entityId: string, world: string): string {
  const suffix = `:${world}`;
  return entityId.endsWith(suffix) ? entityId.slice(0, -suffix.length) : entityId;
}
