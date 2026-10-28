/**
 * UI slot registry (plan §8): modules plug React components into named slots
 * such as `hud.left` or `panel.character`, and can replace a component that
 * another module put there. Pure TypeScript; React is only a type import here.
 */
import type { ComponentType } from "react";

/** A component registered in a slot. Slot props are passed through as-is. */
// Slots take any props (each slot's caller decides), so the registry stores them loosely typed.
// oxlint-disable-next-line typescript/no-explicit-any
export type SlotComponent = ComponentType<any>;

export interface SlotEntry {
  /** Unique within its slot. */
  id: string;
  /** The module that registered the entry (for diagnostics and unloading). */
  moduleId: string;
  component: SlotComponent;
  /** Lower renders first. Defaults to 0. Ties break on `id`. */
  order?: number;
}

export interface SlotRegistry {
  /** Adds an entry. Throws when `id` is already used in `slot`. */
  register(slot: string, entry: SlotEntry): void;
  /** Swaps the component of an existing entry, keeping its id, module and order. Throws when `id` is unknown. */
  replace(slot: string, id: string, component: SlotComponent): void;
  /** Removes an entry. Does nothing when it is not there. */
  remove(slot: string, id: string): void;
  /**
   * Entries of `slot`, sorted by `order` then `id`. The same array instance is
   * returned until the slot changes, so it is safe to use as a store snapshot.
   */
  list(slot: string): readonly SlotEntry[];
  /** Calls `listener` after any change to any slot. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

const EMPTY: readonly SlotEntry[] = Object.freeze([]);

function byOrderThenId(a: SlotEntry, b: SlotEntry): number {
  const oa = a.order ?? 0;
  const ob = b.order ?? 0;
  if (oa !== ob) return oa - ob;
  // Code-unit comparison, not localeCompare: the order must not depend on the browser locale.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function createSlotRegistry(): SlotRegistry {
  const slots = new Map<string, SlotEntry[]>();
  const snapshots = new Map<string, readonly SlotEntry[]>();
  const listeners = new Set<() => void>();

  function changed(slot: string): void {
    snapshots.delete(slot);
    for (const listener of listeners) listener();
  }

  function entriesOf(slot: string): SlotEntry[] {
    let entries = slots.get(slot);
    if (!entries) {
      entries = [];
      slots.set(slot, entries);
    }
    return entries;
  }

  return {
    register(slot, entry) {
      const entries = entriesOf(slot);
      if (entries.some((e) => e.id === entry.id)) {
        throw new Error(`slot "${slot}" already has an entry "${entry.id}"`);
      }
      entries.push({ ...entry });
      entries.sort(byOrderThenId);
      changed(slot);
    },

    replace(slot, id, component) {
      const entry = slots.get(slot)?.find((e) => e.id === id);
      if (!entry) throw new Error(`slot "${slot}" has no entry "${id}" to replace`);
      entry.component = component;
      changed(slot);
    },

    remove(slot, id) {
      const entries = slots.get(slot);
      if (!entries) return;
      const at = entries.findIndex((e) => e.id === id);
      if (at < 0) return;
      entries.splice(at, 1);
      changed(slot);
    },

    list(slot) {
      const cached = snapshots.get(slot);
      if (cached) return cached;
      const entries = slots.get(slot);
      const snapshot = entries && entries.length > 0 ? Object.freeze([...entries]) : EMPTY;
      snapshots.set(slot, snapshot);
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
