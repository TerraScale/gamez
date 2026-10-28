/**
 * Area transitions (classic.world.transition, pre -1100; design §9.3). Drains
 * Bus.transitions in order. Each request switches the current area, leaves
 * the old one (hero summons, projectiles, ground effects), enters a new
 * dungeon level when its depth differs from DungeonState.live (destroying the
 * old live level, resetting exploration, queuing population and the level's
 * Interactables), unlocks waypoints, places the hero and emits
 * classic.area.changed.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, pushSpawn, type SpawnRequest, type TransitionRequest } from "../bus.ts";
import {
  AreaTag,
  Body,
  CastOrder,
  Casting,
  Dash,
  Dead,
  GroundEffect,
  Interactable,
  Intent,
  Life,
  Monster,
  Mover,
  Pos,
  Projectile,
  Summoned,
  type InteractableKind,
} from "../components.ts";
import { emit } from "../events.ts";
import { tileCenter, type TilePos } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { isRiftDepth, isWaypointDepth } from "../rules.ts";
import { areaOf, currentDepth, dungeonOf, gameOf, heroOf } from "../resources.ts";
import { findFreeNear, tileKey } from "./common.ts";
import { freshExploreArea, exploreStateOf } from "./explore.ts";
import { getMap, type ClassicMap } from "./maps.ts";
import { planPopulation } from "./populate.ts";
import { ensureObelisk } from "./riftObelisk.ts";

/** Runs the queued area transitions in order. */
export function runTransitions(world: World, ctx: SimContext): void {
  const bus = busOf(world);
  if (bus.transitions.length === 0) return;
  const requests = bus.transitions.splice(0, bus.transitions.length);
  for (const req of requests) applyTransition(world, ctx, req);
}

export const transitionSystem: SystemDef = {
  ...SYSTEM.worldTransition,
  run(world, ctx) {
    runTransitions(world, ctx);
    // Old saves: the town gets its Rift obelisk the first time the hero is in town.
    if (currentDepth(world) === 0) ensureObelisk(world, getMap(world, ctx.registry, 0));
  },
};

function applyTransition(world: World, ctx: SimContext, req: TransitionRequest): void {
  const target = req.to;
  if (!Number.isInteger(target) || target < 0) return;
  const area = areaOf(world);
  const dungeon = dungeonOf(world);
  const hero = heroOf(world);
  const from = area.depth;
  // Snapshot of the portal before any closing: its position places the hero.
  const portal = dungeon.portal ? { ...dungeon.portal } : null;
  if (req.via === "portal") {
    // A portal request is only valid while the pair is open (and leads there).
    if (!portal) return;
    if (target !== 0 && target !== portal.depth) return;
  }
  // Rift transitions only enter rift depths; the rift exit only leads to town (wave A).
  if (req.via === "rift" && !isRiftDepth(target)) return;
  if (req.via === "riftExit" && target !== 0) return;
  const map = getMap(world, ctx.registry, target);

  if (target !== from) leaveArea(world, hero, from);

  const oldLive = dungeon.live;
  if (target >= 1 && target !== dungeon.live) enterLevel(world, ctx, map, target, hero, oldLive);
  // A rift cannot be re-entered (wave A): going to town discards its level at once.
  if (target === 0 && isRiftDepth(oldLive)) dropLiveLevel(world, hero);
  // Rift levels never count as the main dungeon: no deepest, no waypoints.
  if (target >= 1 && !isRiftDepth(target)) {
    dungeon.deepest = Math.max(dungeon.deepest, target);
    if (isWaypointDepth(target) && !dungeon.waypoints.includes(target)) {
      dungeon.waypoints = [...dungeon.waypoints, target].sort((a, b) => a - b);
      emit(ctx, { type: "classic.waypoint.unlocked", depth: target });
    }
  }

  if (hero !== 0) placeHero(world, ctx, map, target, req.via, hero, portal);

  // A pair closes when the hero uses it from town, or when the level it leads to is left.
  if (portal) {
    const usedFromTown = req.via === "portal" && target !== 0;
    const levelLeft = target >= 1 && portal.depth !== target;
    if (usedFromTown || levelLeft) closePortal(world);
  }

  area.depth = target;
  area.theme = map.theme;
  area.enteredAt = ctx.tick;
  emit(ctx, {
    type: "classic.area.changed",
    depth: target,
    theme: map.theme,
    via: req.via,
    name: map.name,
  });
}

/** Clears what cannot follow the hero out of the area: summons, projectiles, ground effects. */
function leaveArea(world: World, hero: Entity, from: number): void {
  if (hero !== 0) {
    for (const e of world.query(Summoned)) {
      if (world.exists(e) && world.read(e, Summoned).owner === hero) world.destroy(e);
    }
    dropSpawns(world, (r: SpawnRequest) => r.owner === hero);
  }
  for (const e of world.query(Projectile, AreaTag)) {
    if (world.exists(e) && world.read(e, AreaTag).depth === from) world.destroy(e);
  }
  for (const e of world.query(GroundEffect, AreaTag)) {
    if (world.exists(e) && world.read(e, AreaTag).depth === from) world.destroy(e);
  }
}

/**
 * Enters a dungeon level that is not the live one: destroys the old live
 * level, resets exploration, queues population and the level's Interactables.
 */
function enterLevel(
  world: World,
  ctx: SimContext,
  map: ClassicMap,
  depth: number,
  hero: Entity,
  oldLive: number,
): void {
  const dungeon = dungeonOf(world);
  if (oldLive > 0) {
    if (!isRiftDepth(oldLive)) recordBossWound(world, oldLive);
    destroyLevelEntities(world, hero, oldLive);
  }
  dungeon.live = depth;

  const explore = exploreStateOf(world);
  explore.areas = [...explore.areas.filter((a) => a.depth === 0), freshExploreArea(map, false)];

  const plan = planPopulation(ctx, ctx.registry, map, depth, gameOf(world));
  for (const req of plan) pushSpawn(world, req);
  dungeon.liveSpawned = plan.length;
  dungeon.liveKilled = 0;
  dungeon.liveBossAlive = plan.some((r) => r.rarity === "boss");

  if (map.stairsUp) spawnInteractableAt(world, "stairsUp", depth - 1, map.stairsUp, depth);
  if (map.stairsDown) spawnInteractableAt(world, "stairsDown", depth + 1, map.stairsDown, depth);
  if (map.waypoint) spawnInteractableAt(world, "waypoint", depth, map.waypoint, depth);
}

/** Destroys every entity of `depth` except the hero and drops its queued spawns. */
function destroyLevelEntities(world: World, hero: Entity, depth: number): void {
  for (const e of world.query(AreaTag)) {
    if (e !== hero && world.exists(e) && world.read(e, AreaTag).depth === depth) world.destroy(e);
  }
  dropSpawns(world, (r) => r.depth === depth);
}

/** Discards the live level entirely (its entities, exploration and bookkeeping): live = 0. */
function dropLiveLevel(world: World, hero: Entity): void {
  const dungeon = dungeonOf(world);
  if (dungeon.live <= 0) return;
  destroyLevelEntities(world, hero, dungeon.live);
  const explore = exploreStateOf(world);
  explore.areas = explore.areas.filter((a) => a.depth === 0);
  dungeon.live = 0;
  dungeon.liveSpawned = 0;
  dungeon.liveKilled = 0;
  dungeon.liveBossAlive = false;
}

/** Remembers how hurt the living boss of `depth` is before its level is destroyed. */
function recordBossWound(world: World, depth: number): void {
  const dungeon = dungeonOf(world);
  for (const e of world.query(Monster, Life, AreaTag)) {
    if (world.read(e, AreaTag).depth !== depth || world.has(e, Dead)) continue;
    if (world.read(e, Monster).rarity !== "boss") continue;
    const life = world.read(e, Life);
    const lost = Math.max(0, life.max - Math.max(0, life.hp));
    dungeon.bossWound = lost > 0 ? { depth, lost } : null;
    return;
  }
}

/** Puts the hero on a free walkable tile next to the arrival feature and resets its movement. */
function placeHero(
  world: World,
  ctx: SimContext,
  map: ClassicMap,
  depth: number,
  via: TransitionRequest["via"],
  hero: Entity,
  portal: { depth: number; x: number; y: number } | null,
): void {
  const tile = arrivalTile(world, map, depth, via, hero, portal);
  const at = tileCenter(tile.x);
  const atY = tileCenter(tile.y);
  world.add(hero, Pos, { x: at, y: atY });
  world.add(hero, AreaTag, { depth });
  if (world.has(hero, Mover)) {
    world.update(hero, Mover, { path: [], goalX: -1, goalY: -1, moving: false, blocked: 0 });
  }
  const prev = world.get(hero, Intent);
  world.add(hero, Intent, { kind: "idle", source: prev?.source ?? "manual", at: ctx.tick });
  if (world.has(hero, Casting)) world.remove(hero, Casting);
  if (world.has(hero, Dash)) world.remove(hero, Dash);
  if (world.has(hero, CastOrder)) world.remove(hero, CastOrder);
}

/** Arrival tile for a transition: the feature the hero comes through, else the map spawn. */
function arrivalTile(
  world: World,
  map: ClassicMap,
  depth: number,
  via: TransitionRequest["via"],
  hero: Entity,
  portal: { depth: number; x: number; y: number } | null,
): TilePos {
  const occupied = occupiedTiles(world, map, depth, hero);
  let anchor: TilePos | null = null;
  let minRadius = 1;
  switch (via) {
    case "new":
    case "respawn":
      anchor = map.spawn;
      minRadius = 0;
      break;
    case "stairsDown":
      // The map spawn sits next to the level's stairs up.
      anchor = map.spawn;
      minRadius = 0;
      break;
    case "stairsUp":
      anchor = map.stairsDown;
      break;
    case "rift":
    case "riftExit":
      // A rift level is entered at its first room; the town is entered at its spawn.
      anchor = map.spawn;
      minRadius = 0;
      break;
    case "waypoint":
      anchor = map.waypoint;
      break;
    case "townPortal":
      anchor = map.portalSpot;
      break;
    case "portal":
      if (depth === 0) {
        anchor = map.portalSpot;
      } else if (portal) {
        anchor = { x: portal.x >> 8, y: portal.y >> 8 };
        minRadius = 0;
      }
      break;
  }
  const found = anchor ? findFreeNear(map, anchor, minRadius, occupied) : null;
  return found ?? findFreeNear(map, map.spawn, 0, occupied) ?? map.spawn;
}

/** Tile keys of solid units of `depth` other than the hero (for placement). */
function occupiedTiles(world: World, map: ClassicMap, depth: number, hero: Entity): Set<number> {
  const keys = new Set<number>();
  for (const e of world.query(Pos, Body, AreaTag)) {
    if (e === hero || world.read(e, AreaTag).depth !== depth) continue;
    if (!world.read(e, Body).solid) continue;
    const p = world.read(e, Pos);
    keys.add(tileKey(map.width, p.x >> 8, p.y >> 8));
  }
  return keys;
}

/** Removes queued spawn requests matching `drop`, keeping the order of the rest. */
function dropSpawns(world: World, drop: (r: SpawnRequest) => boolean): void {
  const bus = busOf(world);
  const keep = bus.spawns.filter((r) => !drop(r));
  bus.spawns.length = 0;
  for (const r of keep) bus.spawns.push(r);
}

/** Closes the open town portal: removes both sides and clears the dungeon state. */
export function closePortal(world: World): void {
  for (const e of world.query(Interactable)) {
    if (world.exists(e) && world.read(e, Interactable).kind === "portal") world.destroy(e);
  }
  dungeonOf(world).portal = null;
}

/** Creates an Interactable at a tile centre. */
export function spawnInteractableAt(
  world: World,
  kind: InteractableKind,
  toDepth: number,
  at: TilePos,
  depth: number,
): Entity {
  return spawnInteractableSub(world, kind, toDepth, tileCenter(at.x), tileCenter(at.y), depth);
}

/** Creates an Interactable at a sub-unit position. */
export function spawnInteractableSub(
  world: World,
  kind: InteractableKind,
  toDepth: number,
  x: number,
  y: number,
  depth: number,
): Entity {
  const e = world.create();
  world.add(e, Interactable, { kind, toDepth });
  world.add(e, Pos, { x, y });
  world.add(e, AreaTag, { depth });
  return e;
}
