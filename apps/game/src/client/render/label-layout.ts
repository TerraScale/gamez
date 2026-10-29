/**
 * Screen-space label layout (no Pixi, unit-tested directly): a cheap
 * de-overlap pass for every world label (the hero's nameplate, monster and NPC
 * names, station signs, loot) and a clamp that keeps labels inside the view
 * minus the HUD insets. Boxes are reused by the caller; nothing here allocates.
 *
 * Coordinates are world-local iso px (the zoomed view scales every label the
 * same way, so overlaps do not depend on the zoom).
 */

export interface LabelBox {
  /** Stable id (tie-break of the sort). */
  id: string;
  /** Horizontal centre and bottom edge before the shift. */
  x: number;
  bottom: number;
  w: number;
  h: number;
  /** Higher keeps its place (labelRank). */
  rank: number;
  /** Output: vertical shift (<= 0, upwards) chosen by deoverlapLabels. */
  dy: number;
  /**
   * Duplicate group ("" or omitted = none). A box near an already placed,
   * visible box of the same group (same monster name, a pack standing
   * together) is hidden instead of being stacked above it.
   */
  group?: string;
  /** Output: hidden as a duplicate by deoverlapLabels. */
  hidden?: boolean;
}

/** Rank bands of labelRank: units over NPCs over station signs over loot. */
export const LABEL_RANK = { unit: 400, npc: 300, prop: 200, loot: 0, projectile: 0 } as const;

/**
 * De-overlap rank of a world label. The hero's own nameplate is +Infinity
 * (always placed first, never moved); then units, NPCs, station signs and loot,
 * each band ordered by its labelPriority (elite monsters, loot rarity).
 */
export function labelRank(
  kind: keyof typeof LABEL_RANK,
  isSelf: boolean,
  priority: number,
): number {
  if (isSelf) return Number.POSITIVE_INFINITY;
  return LABEL_RANK[kind] + priority;
}

/** A label is pushed up by its height at most this many times. */
export const LABEL_MAX_STEPS = 16;
/** Gap kept between stacked labels (px). */
const GAP = 1;

/** Sort order: rank descending, then id ascending (stable for equal ranks). */
export function compareLabels(a: LabelBox, b: LabelBox): number {
  if (a.rank !== b.rank) return b.rank > a.rank ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Two boxes of one group closer than this many box heights (bottom to bottom) count as duplicates. */
export const DUPLICATE_LINES = 2;

function duplicateOf(a: LabelBox, b: LabelBox): boolean {
  if (Math.abs(a.bottom - (b.bottom + b.dy)) >= a.h * DUPLICATE_LINES) return false;
  return Math.abs(a.x - b.x) * 2 < a.w + b.w;
}

function overlaps(a: LabelBox, b: LabelBox, ady: number): boolean {
  const aTop = a.bottom + ady - a.h;
  const aBottom = a.bottom + ady;
  const bTop = b.bottom + b.dy - b.h;
  const bBottom = b.bottom + b.dy;
  if (aBottom <= bTop || bBottom <= aTop) return false;
  return Math.abs(a.x - b.x) * 2 < a.w + b.w;
}

/**
 * Sorts `boxes[0..n)` in place (rank desc, then id) and sets each box's `dy`
 * and `hidden`: a box near a placed box of the same non-empty group is hidden
 * (dy 0); every other label keeps its place unless it intersects one already
 * placed, in which case it moves up by its own height (plus a 1 px gap), up to
 * LABEL_MAX_STEPS times. Hidden boxes are no obstacle. O(n^2) in the worst
 * case; on-screen label counts are small. The sort is an insertion sort, so
 * it never allocates and is linear on last frame's (nearly sorted) order.
 */
export function deoverlapLabels(boxes: LabelBox[], n: number): void {
  const count = Math.min(n, boxes.length);
  sortRange(boxes, count);
  for (let i = 0; i < count; i++) {
    const box = boxes[i]!;
    box.hidden = false;
    const group = box.group;
    if (group) {
      let dup = false;
      for (let j = 0; j < i; j++) {
        const other = boxes[j]!;
        if (!other.hidden && other.group === group && duplicateOf(box, other)) {
          dup = true;
          break;
        }
      }
      if (dup) {
        box.hidden = true;
        box.dy = 0;
        continue;
      }
    }
    let dy = 0;
    for (let step = 0; step < LABEL_MAX_STEPS; step++) {
      let hit = false;
      for (let j = 0; j < i; j++) {
        const other = boxes[j]!;
        if (!other.hidden && overlaps(box, other, dy)) {
          hit = true;
          break;
        }
      }
      if (!hit) break;
      dy -= box.h + GAP;
    }
    box.dy = dy;
  }
}

/** Insertion sort of the first n entries (no allocation, n is small). */
function sortRange(boxes: LabelBox[], n: number): void {
  for (let i = 1; i < n; i++) {
    const v = boxes[i]!;
    let j = i - 1;
    while (j >= 0 && compareLabels(boxes[j]!, v) > 0) {
      boxes[j + 1] = boxes[j]!;
      j--;
    }
    boxes[j + 1] = v;
  }
}

/**
 * Offset that keeps the interval [centre - size/2, centre + size/2] inside
 * [lo + pad, hi - pad]. When the interval is larger than the room, it is
 * centred in it. 0 when it already fits.
 */
export function clampOffset(
  centre: number,
  size: number,
  lo: number,
  hi: number,
  pad: number,
): number {
  const min = lo + pad + size / 2;
  const max = hi - pad - size / 2;
  if (min > max) return (lo + hi) / 2 - centre;
  if (centre < min) return min - centre;
  if (centre > max) return max - centre;
  return 0;
}

/** A rect in world-local px (same shape as chunks.ts ViewRect). */
export interface LabelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** HUD chrome insets in screen (CSS) px, per edge. */
export interface LabelInsetsPx {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Writes `outer` shrunk by `insets` (screen px, divided by the zoom) into
 * `out` (reused, no allocation). An inset larger than the view leaves at
 * least a zero-size rect at the view centre line.
 */
export function insetRect(
  outer: LabelRect,
  insets: LabelInsetsPx,
  zoom: number,
  out: LabelRect,
): LabelRect {
  const k = zoom > 0 ? 1 / zoom : 1;
  let x0 = outer.x0 + Math.max(0, insets.left) * k;
  let x1 = outer.x1 - Math.max(0, insets.right) * k;
  let y0 = outer.y0 + Math.max(0, insets.top) * k;
  let y1 = outer.y1 - Math.max(0, insets.bottom) * k;
  if (x0 > x1) x0 = x1 = (x0 + x1) / 2;
  if (y0 > y1) y0 = y1 = (y0 + y1) / 2;
  out.x0 = x0;
  out.x1 = x1;
  out.y0 = y0;
  out.y1 = y1;
  return out;
}

/**
 * True when a label's anchor (the entity's feet at x, y) lies under HUD
 * chrome: outside `inner` on an edge that has an inset (inner differs from
 * outer there). Such labels are hidden instead of being clamped, which would
 * print them far from their entity. Edges without an inset keep the plain
 * view clamp (labels of units just off screen stay at the edge).
 */
export function underChrome(x: number, y: number, outer: LabelRect, inner: LabelRect): boolean {
  if (inner.y0 > outer.y0 && y < inner.y0) return true;
  if (inner.y1 < outer.y1 && y > inner.y1) return true;
  if (inner.x0 > outer.x0 && x < inner.x0) return true;
  if (inner.x1 < outer.x1 && x > inner.x1) return true;
  return false;
}

/**
 * True when a label at its natural place (centre x, from `top` to `bottom`,
 * `w` wide) lies entirely outside the view `rect`: its entity is off screen
 * and the label would only show because the view clamp pulled it in, stacked
 * at the edge far from anything (QA: off-screen party members' names piled at
 * the bottom-right corner). Such labels are hidden; partly visible ones are
 * still clamped.
 */
export function labelOffView(
  x: number,
  w: number,
  top: number,
  bottom: number,
  rect: LabelRect,
): boolean {
  return x + w / 2 < rect.x0 || x - w / 2 > rect.x1 || bottom < rect.y0 || top > rect.y1;
}

/**
 * Approximate rendered width (px) of a one-line label in the UI sans font plus
 * a 3 px stroke: about 0.6 em per character (wide fallbacks such as DejaVu
 * Sans included) plus a few px of air. Used for layout only, so text is never
 * measured on the hot path.
 */
export function estimateLabelWidth(text: string, fontPx: number): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length * fontPx * 0.6 + 6);
}
