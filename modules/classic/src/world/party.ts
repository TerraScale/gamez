/**
 * Party placement (classic.world; docs/design/party.md §6.6, §6.7). Pure
 * reads of the world plus integer tile maths, shared by the area transition
 * (every follower lands on its formation spot around the acting leader) and
 * the `regroup` leash op.
 *
 * A follower's spot is the free walkable tile CONNECTED to the leader's tile
 * (4-neighbour flood fill within a small window, so never behind a wall)
 * that is nearest to leader + formationOffsets(); ties go to flood order.
 * When the window has no free tile, the nearest free walkable tile around
 * the leader (findFreeNear ring scan) is used.
 */
import type { Entity, FrozenRegistry, World } from "@gamez/kernel";
import { AreaTag, Body, Mover, Pos } from "../components.ts";
import { clamp, type Facing, type TilePos } from "../fixed.ts";
import { roleOf } from "../party/shared.ts";
import { DEFAULT_PARTY_CONFIG, partyStateOf, type PartyConfig } from "../resources.ts";
import { formationOffsets } from "../rules.ts";
import { findFreeNear, tileKey } from "./common.ts";
import type { ClassicMap } from "./maps.ts";

/** The party's AI config (defaults without a party resource). */
export function partyConfigOf(world: World): PartyConfig {
  return partyStateOf(world)?.config ?? DEFAULT_PARTY_CONFIG;
}

/** Window (Chebyshev tiles) followers are placed within around the leader: spread x 2 + 2. */
export function placementRadius(config: PartyConfig): number {
  return clamp(Math.trunc(config.spread), 1, 4) * 2 + 2;
}

/**
 * Tile keys of the solid units of area `depth` that are not in `skip` (the
 * units being placed), for placement.
 */
export function occupiedExcept(
  world: World,
  map: ClassicMap,
  depth: number,
  skip: readonly Entity[],
): Set<number> {
  const keys = new Set<number>();
  for (const e of world.query(Pos, Body, AreaTag)) {
    if (skip.includes(e) || world.read(e, AreaTag).depth !== depth) continue;
    if (!world.read(e, Body).solid) continue;
    const p = world.read(e, Pos);
    keys.add(tileKey(map.width, p.x >> 8, p.y >> 8));
  }
  return keys;
}

/** Walkable tiles 4-connected to `from` within Chebyshev `radius`, in flood (BFS) order. */
function reachableWithin(map: ClassicMap, from: TilePos, radius: number): TilePos[] {
  const out: TilePos[] = [];
  if (!walkable(map, from.x, from.y)) return out;
  const seen = new Set<number>([tileKey(map.width, from.x, from.y)]);
  out.push({ x: from.x, y: from.y });
  for (let head = 0; head < out.length; head++) {
    const t = out[head]!;
    for (let k = 0; k < 4; k++) {
      const x = t.x + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const y = t.y + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (Math.abs(x - from.x) > radius || Math.abs(y - from.y) > radius) continue;
      if (!walkable(map, x, y)) continue;
      const key = tileKey(map.width, x, y);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x, y });
    }
  }
  return out;
}

function walkable(map: ClassicMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return map.walkable[tileKey(map.width, x, y)] === 1;
}

/**
 * Spots for `followers` (slot order) around a leader standing on `leader`
 * and facing `leaderFacing` (Mover.facing). `occupied` holds the tiles that
 * are taken (the leader's own tile is added); each chosen tile is added too,
 * so followers never share a tile. Returns one tile per follower.
 */
export function formationSpots(
  world: World,
  registry: FrozenRegistry,
  map: ClassicMap,
  leader: TilePos,
  leaderFacing: Facing,
  followers: readonly Entity[],
  occupied: Set<number>,
): TilePos[] {
  if (followers.length === 0) return [];
  const config = partyConfigOf(world);
  const roles = followers.map((f) => roleOf(world, registry, f));
  const offsets = formationOffsets(config.formation, config.spread, leaderFacing, roles);
  const window = reachableWithin(map, leader, placementRadius(config));
  occupied.add(tileKey(map.width, leader.x, leader.y));
  const out: TilePos[] = [];
  for (let i = 0; i < followers.length; i++) {
    const off = offsets[i] ?? { dx: 0, dy: 0 };
    const gx = leader.x + off.dx;
    const gy = leader.y + off.dy;
    let best: TilePos | null = null;
    let bestD = Infinity;
    for (const t of window) {
      if (occupied.has(tileKey(map.width, t.x, t.y))) continue;
      const d = (t.x - gx) * (t.x - gx) + (t.y - gy) * (t.y - gy);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    const spot = best ?? findFreeNear(map, leader, 1, occupied) ?? leader;
    occupied.add(tileKey(map.width, spot.x, spot.y));
    out.push(spot);
  }
  return out;
}

/** The facing of a unit (its Mover), "s" without one. */
export function unitFacing(world: World, e: Entity): Facing {
  return world.get(e, Mover)?.facing ?? "s";
}
