import { DEFAULT_ISO, screenToTile, type IsoMetrics } from "@gamez/world";

/** Ground and object chunks are CHUNK_TILES x CHUNK_TILES tiles. */
export const CHUNK_TILES = 16;

/** The visible part of the world layer, in world-local iso px (before zoom). */
export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Fractional tile bounds (index space, tile i spans [i, i + 1]). */
export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Inclusive chunk index range. Empty when cx0 > cx1 or cy0 > cy1. */
export interface ChunkRange {
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
}

export const EMPTY_CHUNK_RANGE: ChunkRange = { cx0: 0, cy0: 0, cx1: -1, cy1: -1 };

/**
 * The world-local rectangle a viewport of `viewW` x `viewH` CSS px shows when
 * the camera centre is (camX, camY) and the world layer is scaled by `zoom`.
 */
export function viewRect(
  camX: number,
  camY: number,
  viewW: number,
  viewH: number,
  zoom: number,
): ViewRect {
  const hw = viewW / (2 * zoom);
  const hh = viewH / (2 * zoom);
  return { x0: camX - hw, y0: camY - hh, x1: camX + hw, y1: camY + hh };
}

/**
 * Tile bounds covered by a world-local iso rectangle. Tile coordinates are
 * linear in screen space, so the extremes sit at the four corners.
 */
export function visibleTileRect(r: ViewRect, m: IsoMetrics = DEFAULT_ISO): TileRect {
  const corners = [
    screenToTile(r.x0, r.y0, m),
    screenToTile(r.x1, r.y0, m),
    screenToTile(r.x1, r.y1, m),
    screenToTile(r.x0, r.y1, m),
  ];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of corners) {
    if (c.x < x0) x0 = c.x;
    if (c.x > x1) x1 = c.x;
    if (c.y < y0) y0 = c.y;
    if (c.y > y1) y1 = c.y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Chunk indices touched by a tile rectangle, grown by `margin` chunks and
 * clamped to the map. Returns EMPTY_CHUNK_RANGE for an empty map.
 */
export function chunkRange(
  tiles: TileRect,
  mapWidth: number,
  mapHeight: number,
  margin: number,
  chunk: number = CHUNK_TILES,
): ChunkRange {
  const cols = Math.ceil(mapWidth / chunk);
  const rows = Math.ceil(mapHeight / chunk);
  if (cols <= 0 || rows <= 0) return EMPTY_CHUNK_RANGE;
  const cx0 = Math.max(0, Math.floor(tiles.x0 / chunk) - margin);
  const cy0 = Math.max(0, Math.floor(tiles.y0 / chunk) - margin);
  const cx1 = Math.min(cols - 1, Math.floor(tiles.x1 / chunk) + margin);
  const cy1 = Math.min(rows - 1, Math.floor(tiles.y1 / chunk) + margin);
  if (cx0 > cx1 || cy0 > cy1) return EMPTY_CHUNK_RANGE;
  return { cx0, cy0, cx1, cy1 };
}

export function chunkInRange(range: ChunkRange, cx: number, cy: number): boolean {
  return cx >= range.cx0 && cx <= range.cx1 && cy >= range.cy0 && cy <= range.cy1;
}

export function chunkCount(range: ChunkRange): number {
  if (range.cx0 > range.cx1 || range.cy0 > range.cy1) return 0;
  return (range.cx1 - range.cx0 + 1) * (range.cy1 - range.cy0 + 1);
}

/** Chunk index (cy * cols + cx) used as a Map key. */
export function chunkKey(cx: number, cy: number, cols: number): number {
  return cy * cols + cx;
}

/** Whether a world-local iso point lies inside the view rectangle, grown by `pad` px. */
export function inViewRect(sx: number, sy: number, r: ViewRect, pad: number): boolean {
  return sx >= r.x0 - pad && sx <= r.x1 + pad && sy >= r.y0 - pad && sy <= r.y1 + pad;
}
