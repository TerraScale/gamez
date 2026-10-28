import type { TileMap } from "@gamez/world";

/**
 * Phase-0 town: grass with a stone plaza and a ring of blocked trees around
 * the edge. Uses only ids the art.kenney pack provides.
 */
function buildTown(): TileMap {
  const width = 48;
  const height = 48;
  const ground: string[] = [];
  const objects: (string | null)[] = [];
  const walkable: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const plaza = Math.abs(x - 24) < 6 && Math.abs(y - 24) < 6;
      ground.push(plaza ? "tile.stone" : "tile.grass");
      objects.push(edge ? "prop.tree" : null);
      walkable.push(edge ? 0 : 1);
    }
  }
  return { id: "classic.town", width, height, ground, objects, walkable, spawn: { x: 24, y: 24 } };
}

export const townMap: TileMap = buildTown();
