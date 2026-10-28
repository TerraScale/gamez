/**
 * Store hooks of the HUD. Widgets read game state only through
 * useSelect(store, selector): useSyncExternalStore with a memo that keeps the
 * previous value while it is shallow-equal, so unchanged slices never re-render.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Store } from "../contract.ts";

/** Object.is for primitives; one level of key-by-key Object.is for objects and arrays. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Memoised selector over snapshots. Returns the previous selection when the
 * snapshot is the same object, or when the new selection is equal to it.
 */
export function createSelectMemo<T, S>(
  isEqual: (a: S, b: S) => boolean = shallowEqual,
): (snapshot: T, select: (t: T) => S) => S {
  let initialised = false;
  let lastSnapshot: T | undefined;
  let lastValue: S | undefined;
  return (snapshot, select) => {
    if (initialised && snapshot === lastSnapshot) return lastValue as S;
    const next = select(snapshot);
    lastSnapshot = snapshot;
    if (initialised && isEqual(lastValue as S, next)) return lastValue as S;
    initialised = true;
    lastValue = next;
    return next;
  };
}

/** Subscribes to the smallest slice of a store that a widget needs. */
export function useSelect<T, S>(
  store: Store<T>,
  select: (t: T) => S,
  isEqual: (a: S, b: S) => boolean = shallowEqual,
): S {
  const selectRef = useRef(select);
  selectRef.current = select;
  const memo = useMemo(() => createSelectMemo<T, S>(isEqual), [isEqual]);
  const getSnapshot = useCallback(
    () => memo(store.getSnapshot(), selectRef.current),
    [store, memo],
  );
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** performance.now() where available (the clock toasts and errors use). */
export function clockNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * True while clockNow() < until. Schedules one re-render at the expiry so an
 * expired toast or error disappears without another store update.
 */
export function useVisibleUntil(until: number | null | undefined): boolean {
  const [, bump] = useState(0);
  const visible = until !== null && until !== undefined && clockNow() < until;
  useEffect(() => {
    if (until === null || until === undefined) return;
    const wait = until - clockNow();
    if (wait <= 0) return;
    const id = setTimeout(() => bump((n) => n + 1), wait + 20);
    return () => clearTimeout(id);
  }, [until]);
  return visible;
}
