/**
 * Isometric (2:1 diamond) projection. Tile (0,0) sits at screen (0,0); +x goes
 * down-right, +y goes down-left. Coordinates are the tile's top-centre corner.
 */
export interface IsoMetrics {
  tileWidth: number;
  tileHeight: number;
}

export const DEFAULT_ISO: IsoMetrics = { tileWidth: 64, tileHeight: 32 };

export function tileToScreen(x: number, y: number, m: IsoMetrics = DEFAULT_ISO) {
  return { sx: ((x - y) * m.tileWidth) / 2, sy: ((x + y) * m.tileHeight) / 2 };
}

/** Inverse of tileToScreen, fractional. Floor the result to get the tile under a point. */
export function screenToTile(sx: number, sy: number, m: IsoMetrics = DEFAULT_ISO) {
  const a = sx / (m.tileWidth / 2);
  const b = sy / (m.tileHeight / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Draw order for painter's algorithm: larger is drawn later (in front). */
export function depthOf(x: number, y: number): number {
  return x + y;
}
