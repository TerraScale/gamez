/**
 * Initial world of classic.world (setup): the town is the current area, the
 * dungeon bookkeeping starts empty, the town is fully explored, and the town
 * has its NPCs (one entity per NpcProto standing tile) and Interactables
 * (waypoint, stash, dungeon entrance).
 */
import type { SimContext, World } from "@gamez/kernel";
import { AreaTag, Body, Npc, Pos } from "../components.ts";
import { tileCenter } from "../fixed.ts";
import { RES, type AreaState, type DungeonState, type ExploreState } from "../resources.ts";
import { freshExploreArea } from "./explore.ts";
import { getMap } from "./maps.ts";
import { ensureObelisk } from "./riftObelisk.ts";
import { spawnInteractableAt } from "./transition.ts";

/** NPC body radius, sub units. */
const NPC_RADIUS = 80;

export function setupWorld(world: World, ctx: SimContext): void {
  const town = getMap(world, ctx.registry, 0);

  const area: AreaState = { depth: 0, theme: town.theme, enteredAt: 0 };
  world.setResource(RES.area, area);

  const dungeon: DungeonState = {
    deepest: 0,
    waypoints: [0],
    live: 0,
    portal: null,
    bossesKilled: [],
    liveSpawned: 0,
    liveKilled: 0,
    liveBossAlive: false,
    bossWound: null,
  };
  world.setResource(RES.dungeon, dungeon);

  const explore: ExploreState = { areas: [freshExploreArea(town, true)] };
  world.setResource(RES.explore, explore);

  for (const spot of town.npcSpots) {
    const e = world.create();
    world.add(e, Npc, { proto: spot.npc });
    world.add(e, Pos, { x: tileCenter(spot.x), y: tileCenter(spot.y) });
    world.add(e, AreaTag, { depth: 0 });
    world.add(e, Body, { radius: NPC_RADIUS, solid: true });
  }

  if (town.waypoint) spawnInteractableAt(world, "waypoint", 0, town.waypoint, 0);
  if (town.stash) spawnInteractableAt(world, "stash", 0, town.stash, 0);
  if (town.stairsDown) spawnInteractableAt(world, "stairsDown", 1, town.stairsDown, 0);
  ensureObelisk(world, town);
}
