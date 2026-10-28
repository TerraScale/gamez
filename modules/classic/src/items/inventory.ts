/**
 * Bag grid (OWNER: T5, design §11.4). Pure functions over a GridBag value;
 * the world is only written by the callers, after every check passed.
 * Placement is first fit scanning rows, then columns.
 */
import type { FrozenRegistry } from "@gamez/kernel";
import type { InvEntry } from "../components.ts";
import type { ItemInstance } from "../types.ts";
import { baseOf } from "./common.ts";

export interface GridBag {
  cols: number;
  rows: number;
  /** Always sorted by (y, x). */
  items: InvEntry[];
}

export function sortEntries(items: readonly InvEntry[]): InvEntry[] {
  return items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Grid footprint of an item (1x1 when its base is unknown). */
export function sizeOf(reg: FrozenRegistry, item: ItemInstance): { w: number; h: number } {
  const b = baseOf(reg, item.base);
  return b ? { w: b.size.w, h: b.size.h } : { w: 1, h: 1 };
}

/** Cell occupancy of the bag, row-major, ignoring `skipUid`. */
function occupancy(reg: FrozenRegistry, bag: GridBag, skipUid: number): boolean[] {
  const cells: boolean[] = Array.from({ length: bag.cols * bag.rows }, () => false);
  for (const en of bag.items) {
    if (en.item.uid === skipUid) continue;
    const { w, h } = sizeOf(reg, en.item);
    for (let y = en.y; y < en.y + h; y++) {
      for (let x = en.x; x < en.x + w; x++) {
        if (x >= 0 && y >= 0 && x < bag.cols && y < bag.rows) cells[y * bag.cols + x] = true;
      }
    }
  }
  return cells;
}

function rectFits(
  cells: boolean[],
  bag: GridBag,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  if (x < 0 || y < 0 || x + w > bag.cols || y + h > bag.rows) return false;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (cells[(y + dy) * bag.cols + x + dx]) return false;
    }
  }
  return true;
}

/** Top-left cell of the first free rectangle for `item` (rows first, then columns), or null. */
export function findSpace(
  reg: FrozenRegistry,
  bag: GridBag,
  item: ItemInstance,
  skipUid = -1,
): { x: number; y: number } | null {
  const { w, h } = sizeOf(reg, item);
  const cells = occupancy(reg, bag, skipUid);
  for (let y = 0; y + h <= bag.rows; y++) {
    for (let x = 0; x + w <= bag.cols; x++) {
      if (rectFits(cells, bag, x, y, w, h)) return { x, y };
    }
  }
  return null;
}

/** Whether `item` fits at (x, y) exactly (bounds and overlap), ignoring `skipUid`. */
export function fitsAt(
  reg: FrozenRegistry,
  bag: GridBag,
  item: ItemInstance,
  x: number,
  y: number,
  skipUid = -1,
): boolean {
  const { w, h } = sizeOf(reg, item);
  return rectFits(occupancy(reg, bag, skipUid), bag, x, y, w, h);
}

/** A new bag with `item` placed first-fit, or null when there is no room. Does not mutate `bag`. */
export function placeItem(reg: FrozenRegistry, bag: GridBag, item: ItemInstance): GridBag | null {
  const at = findSpace(reg, bag, item);
  if (!at) return null;
  return {
    cols: bag.cols,
    rows: bag.rows,
    items: sortEntries([...bag.items, { item, x: at.x, y: at.y }]),
  };
}

/** A new bag without the entry of `uid` (plus the removed item), or null when absent. */
export function removeItem(bag: GridBag, uid: number): { bag: GridBag; item: ItemInstance } | null {
  const entry = bag.items.find((e) => e.item.uid === uid);
  if (!entry) return null;
  return {
    bag: { cols: bag.cols, rows: bag.rows, items: bag.items.filter((e) => e !== entry) },
    item: entry.item,
  };
}
