import type { TilePos } from "@gamez/protocol";

/**
 * A tile map shared by client (rendering) and server (walkability, paths).
 * Tiles are stored row-major: index = y * width + x.
 */
export interface TileMap {
  id: string;
  width: number;
  height: number;
  /** Ground layer: logical sprite id per tile (from the asset manifest), e.g. "tile.grass.01". */
  ground: string[];
  /** Optional object layer drawn above ground (trees, walls, props); null = empty. */
  objects: (string | null)[];
  /** 1 = walkable, 0 = blocked. */
  walkable: number[];
  /** Where new characters appear. */
  spawn: TilePos;
}

export function tileIndex(map: TileMap, x: number, y: number): number {
  return y * map.width + x;
}

export function inBounds(map: TileMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function isWalkable(map: TileMap, x: number, y: number): boolean {
  return inBounds(map, x, y) && map.walkable[tileIndex(map, x, y)] === 1;
}
