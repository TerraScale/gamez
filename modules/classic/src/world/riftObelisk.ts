/**
 * The town's Rift obelisk (classic.world, wave A; docs/design/wave-A.md §7).
 * Placed by setup for new games and lazily by the transition system when the
 * hero is in town and no obelisk exists (old saves). The tile is a pure
 * function of the town map: the free walkable tile nearest the waypoint, at
 * least 3 tiles away, not on a prop, an NPC spot, the portal spot, the stash
 * or the spawn.
 */
import type { World } from "@gamez/kernel";
import { AreaTag, Interactable } from "../components.ts";
import type { TilePos } from "../fixed.ts";
import { findFreeNear, tileKey } from "./common.ts";
import type { ClassicMap } from "./maps.ts";
import { spawnInteractableAt } from "./transition.ts";

/** Ring distance from the waypoint searched for the obelisk. */
const OBELISK_RADIUS = 3;

/** Deterministic obelisk tile of the town map, or null when none is free. */
export function obeliskTile(map: ClassicMap): TilePos | null {
  const occupied = new Set<number>();
  for (let i = 0; i < map.objects.length; i++) {
    if ((map.objects[i] ?? null) !== null) occupied.add(i);
  }
  for (const s of map.npcSpots) occupied.add(tileKey(map.width, s.x, s.y));
  for (const t of [map.spawn, map.portalSpot, map.stash, map.waypoint]) {
    if (t) occupied.add(tileKey(map.width, t.x, t.y));
  }
  const anchor = map.waypoint ?? map.spawn;
  return findFreeNear(map, anchor, OBELISK_RADIUS, occupied);
}

/** True when the town already has a Rift obelisk. */
export function hasObelisk(world: World): boolean {
  return world
    .query(Interactable, AreaTag)
    .some(
      (e) =>
        world.read(e, AreaTag).depth === 0 && world.read(e, Interactable).kind === "riftObelisk",
    );
}

/** Creates the obelisk in the town when it is missing. Returns true when it created one. */
export function ensureObelisk(world: World, town: ClassicMap): boolean {
  if (hasObelisk(world)) return false;
  const at = obeliskTile(town);
  if (!at) return false;
  spawnInteractableAt(world, "riftObelisk", 0, at, 0);
  return true;
}
