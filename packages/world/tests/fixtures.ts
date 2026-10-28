import type { TileMap } from "../src/map.ts";

/** Builds a TileMap from rows where '#' is blocked and any other character is walkable. */
export function makeMap(rows: string[]): TileMap {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const walkable = rows.flatMap((row) => row.split("").map((c) => (c === "#" ? 0 : 1)));
  return {
    id: "test",
    width,
    height,
    ground: Array.from({ length: width * height }, () => "tile.grass"),
    objects: Array.from({ length: width * height }, () => null),
    walkable,
    spawn: { x: 0, y: 0 },
  };
}

/** A fully walkable width x height map. */
export function openMap(width: number, height: number): TileMap {
  return makeMap(Array.from({ length: height }, () => ".".repeat(width)));
}
