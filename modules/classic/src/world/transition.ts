/**
 * Area transitions (classic.world.transition, pre -1100; design §9.3). Drains
 * Bus.transitions in order. Each request switches the current area, leaves
 * the old one (hero summons, projectiles, ground effects), enters a new
 * dungeon level when its depth differs from DungeonState.live (destroying the
 * old live level, resetting exploration, queuing population and the level's
 * Interactables), unlocks waypoints, places the hero and emits
 * classic.area.changed.
 *
 * Party (docs/design/party.md §2.3 I2, §6.6): every transition moves EVERY
 * member. The acting leader (party/shared.ts actingLeaderOf; the controlled
 * hero when everyone is down) lands on the arrival point exactly like the
 * solo hero; followers land on their formation spots around it (./party.ts),
 * each on a free walkable tile. Downed members come along and stay down.
 * Leaving an area destroys the summons of every member.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, pushSpawn, type SpawnRequest, type TransitionRequest } from "../bus.ts";
import {
  AreaTag,
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
import { actingLeaderOf, partyMembers, partyScaleOf, partySize } from "../party/shared.ts";
import { areaOf, currentDepth, dungeonOf, gameOf } from "../resources.ts";
import { findFreeNear } from "./common.ts";
import { freshExploreArea, exploreStateOf } from "./explore.ts";
import { getMap, type ClassicMap } from "./maps.ts";
import { planPopulation } from "./populate.ts";
import { formationSpots, occupiedExcept, unitFacing } from "./party.ts";
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
  // Every member travels (solo: [hero]); the acting leader takes the arrival point.
  const members = partyMembers(world);
  const leader = members.length > 0 ? actingLeaderOf(world) : 0;
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

  if (target !== from) leaveArea(world, members, from);

  const oldLive = dungeon.live;
  if (target >= 1 && target !== dungeon.live) enterLevel(world, ctx, map, target, members, oldLive);
  // A rift cannot be re-entered (wave A): going to town discards its level at once.
  if (target === 0 && isRiftDepth(oldLive)) dropLiveLevel(world, members);
  // Rift levels never count as the main dungeon: no deepest, no waypoints.
  if (target >= 1 && !isRiftDepth(target)) {
    dungeon.deepest = Math.max(dungeon.deepest, target);
    if (isWaypointDepth(target) && !dungeon.waypoints.includes(target)) {
      dungeon.waypoints = [...dungeon.waypoints, target].sort((a, b) => a - b);
      emit(ctx, { type: "classic.waypoint.unlocked", depth: target });
    }
  }

  if (leader !== 0) placeParty(world, ctx, map, target, req.via, leader, members, portal);

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

/** Clears what cannot follow the party out of the area: member summons, projectiles, ground effects. */
function leaveArea(world: World, members: readonly Entity[], from: number): void {
  if (members.length > 0) {
    for (const e of world.query(Summoned)) {
      if (world.exists(e) && members.includes(world.read(e, Summoned).owner)) world.destroy(e);
    }
    dropSpawns(world, (r: SpawnRequest) => r.owner !== 0 && members.includes(r.owner));
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
  members: readonly Entity[],
  oldLive: number,
): void {
  const dungeon = dungeonOf(world);
  if (oldLive > 0) {
    if (!isRiftDepth(oldLive)) recordBossWound(world, oldLive);
    destroyLevelEntities(world, members, oldLive);
  }
  dungeon.live = depth;

  const explore = exploreStateOf(world);
  explore.areas = [...explore.areas.filter((a) => a.depth === 0), freshExploreArea(map, false)];

  // Party of 2+: denser packs (docs/design/party.md §8); solo keeps the plain plan.
  const density = partySize(world) > 1 ? partyScaleOf(world, ctx.registry).densityPct : 100;
  const plan = planPopulation(ctx, ctx.registry, map, depth, gameOf(world), density);
  for (const req of plan) pushSpawn(world, req);
  dungeon.liveSpawned = plan.length;
  dungeon.liveKilled = 0;
  dungeon.liveBossAlive = plan.some((r) => r.rarity === "boss");

  if (map.stairsUp) spawnInteractableAt(world, "stairsUp", depth - 1, map.stairsUp, depth);
  if (map.stairsDown) spawnInteractableAt(world, "stairsDown", depth + 1, map.stairsDown, depth);
  if (map.waypoint) spawnInteractableAt(world, "waypoint", depth, map.waypoint, depth);
}

/** Destroys every entity of `depth` except the party members and drops its queued spawns. */
function destroyLevelEntities(world: World, members: readonly Entity[], depth: number): void {
  for (const e of world.query(AreaTag)) {
    if (members.includes(e)) continue;
    if (world.exists(e) && world.read(e, AreaTag).depth === depth) world.destroy(e);
  }
  dropSpawns(world, (r) => r.depth === depth);
}

/** Discards the live level entirely (its entities, exploration and bookkeeping): live = 0. */
function dropLiveLevel(world: World, members: readonly Entity[]): void {
  const dungeon = dungeonOf(world);
  if (dungeon.live <= 0) return;
  destroyLevelEntities(world, members, dungeon.live);
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

/**
 * Places the whole party: the leader on a free walkable tile next to the
 * arrival feature (the solo rule), every other member (slot order) on its
 * formation spot around the leader. Movement, intents and casts reset.
 */
function placeParty(
  world: World,
  ctx: SimContext,
  map: ClassicMap,
  depth: number,
  via: TransitionRequest["via"],
  leader: Entity,
  members: readonly Entity[],
  portal: { depth: number; x: number; y: number } | null,
): void {
  // Members are being moved: their old tiles do not block anyone.
  const occupied = occupiedExcept(world, map, depth, members);
  const tile = arrivalTile(map, via, depth, portal, occupied);
  placeUnit(world, ctx, leader, tile, depth);
  const followers = members.filter((m) => m !== leader);
  if (followers.length === 0) return;
  const spots = formationSpots(
    world,
    ctx.registry,
    map,
    tile,
    unitFacing(world, leader),
    followers,
    occupied,
  );
  followers.forEach((f, i) => placeUnit(world, ctx, f, spots[i] ?? tile, depth));
}

/** Puts a hero at the centre of `tile` in area `depth` and resets its movement, intent and casts. */
function placeUnit(
  world: World,
  ctx: SimContext,
  hero: Entity,
  tile: TilePos,
  depth: number,
): void {
  world.add(hero, Pos, { x: tileCenter(tile.x), y: tileCenter(tile.y) });
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
  map: ClassicMap,
  via: TransitionRequest["via"],
  depth: number,
  portal: { depth: number; x: number; y: number } | null,
  occupied: ReadonlySet<number>,
): TilePos {
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
