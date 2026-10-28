/**
 * Town (depth 0, classic.world, design §9.1). A hand-shaped layout: grass,
 * a stone plaza with the waypoint in its centre, dirt paths to the four
 * edges, a tree border, four houses, fences, a well and a stash chest. Only
 * the house positions jitter, and that jitter (plus decoration) comes from
 * createRng(mix(worldSeed, 0)). Pure: a function of (registry, worldSeed).
 */
import { createRng, type FrozenRegistry } from "@gamez/kernel";
import { mix, type TilePos } from "../fixed.ts";
import { KIND, type NpcProto, type Rect } from "../types.ts";
import { filled, TOWN_THEME, tileKey } from "./common.ts";
import type { ClassicMap } from "./maps.ts";

export const TOWN_SIZE = 72;
const CENTRE: TilePos = { x: 36, y: 36 };
const PLAZA: Rect = { x: 30, y: 30, w: 13, h: 13 };
const SPAWN: TilePos = { x: 36, y: 46 };
const PORTAL_SPOT: TilePos = { x: 38, y: 39 };
const STASH: TilePos = { x: 41, y: 31 };
const WELL: TilePos = { x: 33, y: 33 };
const STAIRS_DOWN: TilePos = { x: 67, y: 36 };
/** Border width of the tree wall, in tiles. */
const BORDER = 2;
/** Radius of the ring of NPC standing tiles around the plaza centre. */
const NPC_RING = 4;

/** Dirt paths (x, y, w, h): north, south, west and east, two tiles wide. */
const PATHS: Rect[] = [
  { x: 35, y: BORDER, w: 2, h: 28 },
  { x: 35, y: 43, w: 2, h: 27 },
  { x: BORDER, y: 35, w: 28, h: 2 },
  { x: 43, y: 35, w: 27, h: 2 },
];

/** Houses: 3x3 blocked footprints; the base corner jitters by 0..2 tiles. */
const HOUSE_BASES: TilePos[] = [
  { x: 8, y: 8 },
  { x: 60, y: 8 },
  { x: 8, y: 58 },
  { x: 60, y: 58 },
];

export function buildTown(registry: FrozenRegistry, worldSeed: number): ClassicMap {
  const width = TOWN_SIZE;
  const height = TOWN_SIZE;
  const rng = createRng(mix(worldSeed, 0));
  const n = width * height;
  const ground: string[] = filled(n, "tile.grass");
  const objects: (string | null)[] = filled<string | null>(n, null);
  const walkable: number[] = filled(n, 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      ground[tileKey(width, x, y)] = mix(x, y) % 4 === 0 ? "tile.grass.dark" : "tile.grass";
    }
  }

  // Paths and plaza (ground only).
  for (const r of PATHS) paint(ground, width, r, "tile.dirt");
  paint(ground, width, PLAZA, "tile.stone");

  // Tree border (blocked).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x < BORDER || y < BORDER || x >= width - BORDER || y >= height - BORDER;
      if (!edge) continue;
      const i = tileKey(width, x, y);
      objects[i] = "prop.tree";
      walkable[i] = 0;
    }
  }

  // Houses (blocked footprints, the prop sprite on the middle tile).
  for (const base of HOUSE_BASES) {
    const hx = base.x + rng.int(0, 2);
    const hy = base.y + rng.int(0, 2);
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) walkable[tileKey(width, hx + dx, hy + dy)] = 0;
    }
    objects[tileKey(width, hx + 1, hy + 1)] = "prop.house";
  }

  // Fences, well and stash (blocked).
  for (let x = 20; x <= 25; x++) block(objects, walkable, width, x, 24, "prop.fence");
  for (let x = 46; x <= 51; x++) block(objects, walkable, width, x, 48, "prop.fence");
  block(objects, walkable, width, WELL.x, WELL.y, "prop.well");
  block(objects, walkable, width, STASH.x, STASH.y, "prop.stash");

  // Walkable props the player stands next to.
  objects[tileKey(width, CENTRE.x, CENTRE.y)] = "prop.waypoint";
  objects[tileKey(width, STAIRS_DOWN.x, STAIRS_DOWN.y)] = "prop.stairs.down";

  // NPC standing tiles: spread evenly around the plaza ring, in id order.
  const ring = ringTiles(CENTRE, NPC_RING);
  const npcs = registry.all<NpcProto>(KIND.npc);
  const taken = new Set<number>();
  const npcSpots: { npc: string; x: number; y: number }[] = [];
  npcs.forEach(([id], k) => {
    const first = Math.floor((k * ring.length) / Math.max(1, npcs.length));
    for (let t = 0; t < ring.length; t++) {
      const c = ring[(first + t) % ring.length] ?? CENTRE;
      const i = tileKey(width, c.x, c.y);
      if (taken.has(i) || walkable[i] !== 1) continue;
      taken.add(i);
      npcSpots.push({ npc: id, x: c.x, y: c.y });
      return;
    }
  });

  let walkableCount = 0;
  for (const w of walkable) if (w === 1) walkableCount++;

  return {
    id: "classic.d0",
    width,
    height,
    ground,
    objects,
    walkable,
    spawn: { ...SPAWN },
    depth: 0,
    theme: TOWN_THEME,
    name: "Town",
    rooms: [{ ...PLAZA }],
    stairsDown: { ...STAIRS_DOWN },
    stairsUp: null,
    waypoint: { ...CENTRE },
    npcSpots,
    portalSpot: { ...PORTAL_SPOT },
    stash: { ...STASH },
    bossSpot: null,
    walkableCount,
  };
}

function paint(ground: string[], width: number, r: Rect, id: string): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) ground[tileKey(width, x, y)] = id;
  }
}

function block(
  objects: (string | null)[],
  walkable: number[],
  width: number,
  x: number,
  y: number,
  prop: string,
): void {
  const i = tileKey(width, x, y);
  objects[i] = prop;
  walkable[i] = 0;
}

/** Square ring of tiles at Chebyshev distance r, clockwise from the top-left corner. */
function ringTiles(c: TilePos, r: number): TilePos[] {
  const out: TilePos[] = [];
  for (let x = c.x - r; x <= c.x + r; x++) out.push({ x, y: c.y - r });
  for (let y = c.y - r + 1; y <= c.y + r; y++) out.push({ x: c.x + r, y });
  for (let x = c.x + r - 1; x >= c.x - r; x--) out.push({ x, y: c.y + r });
  for (let y = c.y + r - 1; y > c.y - r; y--) out.push({ x: c.x - r, y });
  return out;
}
