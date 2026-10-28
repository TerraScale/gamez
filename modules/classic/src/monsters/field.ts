/**
 * Hero distance field (owner: T4 monster builder). A BFS over the walkable
 * tiles of the current map from the hero's tile, limited to FIELD_RADIUS
 * steps. Monsters inside the field step to the neighbour with the lowest
 * distance, so they walk around walls without a per-monster A* search.
 *
 * The field is a pure function of (map, source tile). It is memoised outside
 * the world (WeakMap keyed by the map object), so it is safe to share between
 * sims and never appears in snapshots. Maps are never mutated after use.
 */
import type { TilePos } from "../fixed.ts";
import { walkableAt, type ClassicMap } from "../world/maps.ts";

/** Field radius in tile steps. */
export const FIELD_RADIUS = 24;
/** Fields kept per map (oldest evicted first). */
const FIELDS_PER_MAP = 16;

export interface DistanceField {
  readonly width: number;
  /** Tile index of the source (the hero's tile). */
  readonly source: number;
  /** Tile index -> steps from the source. Only tiles within FIELD_RADIUS are present. */
  readonly dist: ReadonlyMap<number, number>;
}

const memo = new WeakMap<ClassicMap, Map<number, DistanceField>>();

/** The field from tile (tx, ty) on `map` (memoised). */
export function heroField(map: ClassicMap, tx: number, ty: number): DistanceField {
  const key = ty * map.width + tx;
  let per = memo.get(map);
  if (per === undefined) {
    per = new Map();
    memo.set(map, per);
  }
  const hit = per.get(key);
  if (hit !== undefined) return hit;
  const field = computeField(map, tx, ty);
  per.set(key, field);
  if (per.size > FIELDS_PER_MAP) {
    const oldest = per.keys().next().value;
    if (oldest !== undefined) per.delete(oldest);
  }
  return field;
}

function computeField(map: ClassicMap, sx: number, sy: number): DistanceField {
  const w = map.width;
  const dist = new Map<number, number>();
  const source = sy * w + sx;
  dist.set(source, 0);
  let frontier: number[] = [source];
  for (let d = 1; d <= FIELD_RADIUS && frontier.length > 0; d++) {
    const next: number[] = [];
    for (const idx of frontier) {
      const x = idx % w;
      const y = (idx - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!walkableAt(map, nx, ny)) continue;
          // No corner cutting: a diagonal step needs both orthogonal neighbours walkable.
          if (dx !== 0 && dy !== 0 && (!walkableAt(map, x + dx, y) || !walkableAt(map, x, y + dy)))
            continue;
          const ni = ny * w + nx;
          if (dist.has(ni)) continue;
          dist.set(ni, d);
          next.push(ni);
        }
      }
    }
    frontier = next;
  }
  return { width: w, source, dist };
}

/** Steps from the field source to tile (tx, ty), or undefined when outside the field. */
export function fieldDistance(field: DistanceField, tx: number, ty: number): number | undefined {
  return field.dist.get(ty * field.width + tx);
}

/**
 * The neighbour tile one step closer to the source (8 directions, no corner
 * cutting, ties by scan order). Null when the tile is the source, outside the
 * field or has no closer neighbour.
 */
export function nextStep(
  map: ClassicMap,
  field: DistanceField,
  tx: number,
  ty: number,
): TilePos | null {
  const here = fieldDistance(field, tx, ty);
  if (here === undefined || here === 0) return null;
  let best: TilePos | null = null;
  let bestD = here;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = tx + dx;
      const ny = ty + dy;
      if (!walkableAt(map, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!walkableAt(map, tx + dx, ty) || !walkableAt(map, tx, ty + dy)))
        continue;
      const d = field.dist.get(ny * field.width + nx);
      if (d !== undefined && d < bestD) {
        bestD = d;
        best = { x: nx, y: ny };
      }
    }
  }
  return best;
}
