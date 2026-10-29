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

/**
 * Height (CSS px) of the element a callback ref is attached to, kept current by
 * a ResizeObserver. Returns [ref, height]. Height is 0 until the element mounts
 * and where ResizeObserver is missing (the layout then uses its constants).
 */
export function useMeasuredHeight(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!el) {
      setHeight(0);
      return;
    }
    const report = () => setHeight(Math.ceil(el.getBoundingClientRect().height));
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, height];
}

/** Where a horizontal scroller can still scroll (px): the overflow affordance follows these. */
export interface ScrollEdges {
  /** Content is hidden to the left (scrolled past the start). */
  start: boolean;
  /** Content is hidden to the right (not yet scrolled to the end). */
  end: boolean;
}

export const NO_SCROLL_EDGES: ScrollEdges = { start: false, end: false };

/** Pure: the overflow edges of a scroller from its scroll geometry (1 px tolerance for rounding). */
export function scrollEdges(m: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): ScrollEdges {
  const overflow = m.scrollWidth - m.clientWidth;
  if (overflow <= 1) return NO_SCROLL_EDGES;
  return { start: m.scrollLeft > 1, end: m.scrollLeft < overflow - 1 };
}

function sameEdges(a: ScrollEdges, b: ScrollEdges): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * Overflow edges of a horizontal scroller, kept current on scroll and on resize of the scroller or
 * its content. Returns [callback ref, edges]; edges stay NO_SCROLL_EDGES until the element mounts.
 */
export function useScrollEdges(): [(el: HTMLElement | null) => void, ScrollEdges] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NO_SCROLL_EDGES);
  useEffect(() => {
    if (!el) {
      setEdges(NO_SCROLL_EDGES);
      return;
    }
    const report = () => {
      const next = scrollEdges({
        scrollLeft: el.scrollLeft,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      });
      setEdges((prev) => (sameEdges(prev, next) ? prev : next));
    };
    report();
    el.addEventListener("scroll", report, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(report);
      observer.observe(el);
      if (el.firstElementChild) observer.observe(el.firstElementChild);
    }
    return () => {
      el.removeEventListener("scroll", report);
      observer?.disconnect();
    };
  }, [el]);
  return [setEl, edges];
}
