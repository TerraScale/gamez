/**
 * Travel (classic.world; design §3.3, §9.3): town portal, portal use, stairs
 * and waypoints. Each op has a shared execX() returning OpResult, used by
 * both its action (throws ActionError when it fails) and the command system
 * (emits classic.command.failed). Travel is a transition request: the hero
 * moves in the next classic.world.transition (pre, next tick).
 *
 * Party (docs/design/party.md §4.3, §6.6, §6.7):
 * - Every op acts for an explicit hero: actions pass the controlled hero
 *   (heroOf), the command system party/shared.ts commandHero(cmd) (a `hero`
 *   that is not a member fails with not_member). Reach checks (stairs,
 *   waypoint, portal) use that hero; the town portal opens where it stands
 *   and spends a scroll from the shared purse (purseOf).
 * - Any standing member may travel; the transition moves the whole party.
 * - `regroup` (the party AI's leash): places a FOLLOWER (not the acting
 *   leader) on its formation spot next to the acting leader, same area.
 */
import {
  ActionError,
  type ActionDef,
  type Entity,
  type SimContext,
  type SystemDef,
  type World,
} from "@gamez/kernel";
import {
  ACTION,
  ERR,
  fail,
  INTERACT_RANGE,
  OK,
  type HeroCommand,
  type OpResult,
} from "../actions.ts";
import { busOf, pushTransition, takeCommands } from "../bus.ts";
import {
  AreaTag,
  Dead,
  Interactable,
  type InteractableKind,
  Mover,
  Pos,
  Supplies,
} from "../components.ts";
import { noteManual } from "../control.ts";
import { emit } from "../events.ts";
import { dist2, tileCenter, within } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { isRiftDepth } from "../rules.ts";
import { actingLeaderOf, commandHero, partyMembers, purseOf } from "../party/shared.ts";
import { currentDepth, dungeonOf, heroOf } from "../resources.ts";
import { gridOf } from "../spatial.ts";
import { getAreaMap, getMap } from "./maps.ts";
import { formationSpots, occupiedExcept, unitFacing } from "./party.ts";
import { closePortal, spawnInteractableSub } from "./transition.ts";

const TOWN = 0;
const STAIRS: readonly InteractableKind[] = ["stairsDown", "stairsUp"];
const PORTALS: readonly InteractableKind[] = ["portal"];
const WAYPOINTS: readonly InteractableKind[] = ["waypoint"];

/** Common precondition: the acting hero exists and is alive. */
function checkHero(world: World, hero: Entity): OpResult {
  if (hero === 0) return fail(ERR.noHero, "there is no hero yet");
  if (world.has(hero, Dead)) return fail(ERR.dead, "the hero is dead");
  return OK;
}

/** Nearest Interactable of the given kinds in the current area within INTERACT_RANGE of the hero (0 = none). */
function nearestInReach(world: World, hero: Entity, kinds: readonly InteractableKind[]): Entity {
  const depth = currentDepth(world);
  const hp = world.read(hero, Pos);
  let best: Entity = 0;
  let bestD = Infinity;
  for (const e of world.query(Interactable, Pos, AreaTag)) {
    if (world.read(e, AreaTag).depth !== depth) continue;
    if (!kinds.includes(world.read(e, Interactable).kind)) continue;
    const p = world.read(e, Pos);
    if (!within(hp.x, hp.y, p.x, p.y, INTERACT_RANGE)) continue;
    const d = dist2(hp.x, hp.y, p.x, p.y);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** True when the current area has an Interactable of one of the kinds (in reach or not). */
function hasInArea(world: World, kinds: readonly InteractableKind[]): boolean {
  const depth = currentDepth(world);
  return world
    .query(Interactable, AreaTag)
    .some(
      (e) =>
        world.read(e, AreaTag).depth === depth && kinds.includes(world.read(e, Interactable).kind),
    );
}

/** Opens a town portal pair from the dungeon (costs one scroll). */
export function execTownPortal(world: World, ctx: SimContext, hero: Entity): OpResult {
  const ready = checkHero(world, hero);
  if (!ready.ok) return ready;
  const depth = currentDepth(world);
  if (depth === TOWN) return fail(ERR.inTown, "the town portal opens from the dungeon");
  if (isRiftDepth(depth)) return fail(ERR.inRift, "no town portal inside a rift");
  // Scrolls are part of the shared purse (solo: the hero itself).
  const purse = purseOf(world);
  const supplies = world.get(purse, Supplies);
  if (!supplies || supplies.tpScrolls < 1) return fail(ERR.noScroll, "no town portal scroll");

  closePortal(world);
  const p = world.read(hero, Pos);
  spawnInteractableSub(world, "portal", TOWN, p.x, p.y, depth);
  const town = getMap(world, ctx.registry, TOWN);
  spawnInteractableSub(
    world,
    "portal",
    depth,
    tileCenter(town.portalSpot.x),
    tileCenter(town.portalSpot.y),
    TOWN,
  );
  dungeonOf(world).portal = { depth, x: p.x, y: p.y };
  world.update(purse, Supplies, { tpScrolls: supplies.tpScrolls - 1 });
  emit(ctx, { type: "classic.portal.opened", depth });
  pushTransition(world, { to: TOWN, via: "townPortal" });
  return OK;
}

/**
 * Uses the open portal from the side the hero stands on: from town it leads
 * back to the portal's depth (and closes the pair on arrival), from the
 * dungeon it leads to town (the pair stays open).
 */
export function execUsePortal(world: World, hero: Entity): OpResult {
  const ready = checkHero(world, hero);
  if (!ready.ok) return ready;
  if (isRiftDepth(currentDepth(world))) return fail(ERR.inRift, "no portals inside a rift");
  const portal = dungeonOf(world).portal;
  if (!portal) return fail(ERR.noPortal, "no town portal is open");
  if (nearestInReach(world, hero, PORTALS) === 0) {
    return fail(ERR.tooFar, "stand next to the portal");
  }
  const depth = currentDepth(world);
  pushTransition(world, { to: depth === TOWN ? portal.depth : TOWN, via: "portal" });
  return OK;
}

/** Takes the staircase `target` (an Interactable of the current area within reach). */
export function execStairs(world: World, hero: Entity, target: Entity): OpResult {
  const ready = checkHero(world, hero);
  if (!ready.ok) return ready;
  if (
    !world.exists(target) ||
    !world.has(target, Interactable) ||
    !world.has(target, AreaTag) ||
    !world.has(target, Pos)
  ) {
    return fail(ERR.badTarget, "no such staircase");
  }
  const it = world.read(target, Interactable);
  if (!STAIRS.includes(it.kind)) return fail(ERR.badTarget, "that is not a staircase");
  if (isRiftDepth(currentDepth(world))) return fail(ERR.inRift, "no stairs inside a rift");
  if (world.read(target, AreaTag).depth !== currentDepth(world)) {
    return fail(ERR.badTarget, "that staircase is in another area");
  }
  const hp = world.read(hero, Pos);
  const tp = world.read(target, Pos);
  if (!within(hp.x, hp.y, tp.x, tp.y, INTERACT_RANGE)) return fail(ERR.tooFar, "too far away");
  pushTransition(world, {
    to: it.toDepth,
    via: it.kind === "stairsDown" ? "stairsDown" : "stairsUp",
  });
  return OK;
}

/** Travels to the unlocked waypoint of `depth`; the hero must stand at a waypoint of this area. */
export function execWaypoint(world: World, hero: Entity, depth: number): OpResult {
  const ready = checkHero(world, hero);
  if (!ready.ok) return ready;
  if (isRiftDepth(currentDepth(world))) return fail(ERR.inRift, "no waypoints inside a rift");
  if (!dungeonOf(world).waypoints.includes(depth)) {
    return fail(ERR.noWaypoint, `waypoint ${depth} is not unlocked`);
  }
  if (depth === currentDepth(world)) return fail(ERR.badTarget, "already at that waypoint's depth");
  if (nearestInReach(world, hero, WAYPOINTS) === 0) {
    return hasInArea(world, WAYPOINTS)
      ? fail(ERR.tooFar, "stand next to a waypoint")
      : fail(ERR.noWaypoint, "there is no waypoint here");
  }
  pushTransition(world, { to: depth, via: "waypoint" });
  return OK;
}

/**
 * Party leash (op `regroup`): places follower `hero` on its formation spot
 * next to the acting leader (a free walkable tile connected to the leader's,
 * else the nearest free one), same area. Resets its walk and moves it in the
 * spatial grid. Fails not_member for non-members, the controlled hero and the
 * acting leader; dead for a downed follower.
 */
export function execRegroup(world: World, ctx: SimContext, hero: Entity): OpResult {
  if (hero === 0 || hero === heroOf(world)) {
    return fail(ERR.notMember, "only a follower can regroup");
  }
  const leader = actingLeaderOf(world);
  if (hero === leader || leader === 0) return fail(ERR.notMember, "the leader cannot regroup");
  if (world.has(hero, Dead)) return fail(ERR.dead, "the hero is down");
  const depth = currentDepth(world);
  const hp = world.get(hero, Pos);
  const lp = world.get(leader, Pos);
  if (!hp || !lp || world.get(hero, AreaTag)?.depth !== depth) {
    return fail(ERR.badTarget, "not in the leader's area");
  }
  if (world.get(leader, AreaTag)?.depth !== depth) {
    return fail(ERR.badTarget, "the leader is in another area");
  }
  const map = getAreaMap(world, ctx.registry);
  const followers = partyMembers(world).filter((m) => m !== leader);
  const lt = { x: lp.x >> 8, y: lp.y >> 8 };
  // The whole formation is laid out (slot order) and this follower takes its own spot.
  const occupied = occupiedExcept(world, map, depth, [hero]);
  const spots = formationSpots(
    world,
    ctx.registry,
    map,
    lt,
    unitFacing(world, leader),
    followers,
    occupied,
  );
  const spot = spots[followers.indexOf(hero)];
  if (!spot || (spot.x === lt.x && spot.y === lt.y)) {
    return fail(ERR.blocked, "no room next to the leader");
  }
  const x = tileCenter(spot.x);
  const y = tileCenter(spot.y);
  world.update(hero, Pos, { x, y });
  if (world.has(hero, Mover)) {
    world.update(hero, Mover, { path: [], goalX: -1, goalY: -1, moving: false, blocked: 0 });
  }
  gridOf(world).move(hero, x, y);
  return OK;
}

// ---------------------------------------------------------------------------
// Command system (update 51)
// ---------------------------------------------------------------------------

const WORLD_OPS = ["townPortal", "usePortal", "stairs", "waypoint", "regroup"] as const;
type WorldCommand = Extract<HeroCommand, { op: (typeof WORLD_OPS)[number] }>;

export const worldCommandsSystem: SystemDef = {
  ...SYSTEM.worldCommands,
  run(world, ctx) {
    if (busOf(world).commands.length === 0) return;
    for (const cmd of takeCommands(world, WORLD_OPS)) {
      const r = runCommand(world, ctx, cmd);
      if (!r.ok) {
        emit(ctx, { type: "classic.command.failed", op: cmd.op, code: r.code, message: r.message });
      }
    }
  },
};

function runCommand(world: World, ctx: SimContext, cmd: WorldCommand): OpResult {
  // The acting hero: cmd.hero (a member) or the controlled hero.
  const hero = commandHero(world, cmd);
  if (cmd.hero !== undefined && hero === 0) {
    return fail(ERR.notMember, "that hero is not in the party");
  }
  switch (cmd.op) {
    case "townPortal":
      return execTownPortal(world, ctx, hero);
    case "usePortal":
      return execUsePortal(world, hero);
    case "stairs":
      return execStairs(world, hero, cmd.target);
    case "waypoint":
      return execWaypoint(world, hero, cmd.depth);
    case "regroup":
      return execRegroup(world, ctx, cmd.hero === undefined ? 0 : hero);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Accepts only an empty object (or no payload). */
function parseEmpty(payload: unknown): Record<string, never> {
  if (payload === undefined || payload === null) return {};
  if (typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length === 0) {
    return {};
  }
  throw new ActionError(ERR.badPayload, "expected an empty payload");
}

function runOrThrow(world: World, ctx: SimContext, r: OpResult): void {
  if (!r.ok) throw new ActionError(r.code, r.message);
  noteManual(world, ctx);
}

export const townPortalAction: ActionDef<Record<string, never>> = {
  name: ACTION.townPortal,
  parse: (_world, payload) => parseEmpty(payload),
  apply(world, _p, ctx) {
    runOrThrow(world, ctx, execTownPortal(world, ctx, heroOf(world)));
  },
};

export const usePortalAction: ActionDef<Record<string, never>> = {
  name: ACTION.usePortal,
  parse: (_world, payload) => parseEmpty(payload),
  apply(world, _p, ctx) {
    runOrThrow(world, ctx, execUsePortal(world, heroOf(world)));
  },
};

export const useStairsAction: ActionDef<Record<string, never>> = {
  name: ACTION.useStairs,
  parse: (_world, payload) => parseEmpty(payload),
  apply(world, _p, ctx) {
    const hero = heroOf(world);
    const ready = checkHero(world, hero);
    if (!ready.ok) throw new ActionError(ready.code, ready.message);
    const stairs = nearestInReach(world, hero, STAIRS);
    if (stairs === 0) throw new ActionError(ERR.tooFar, "no staircase within reach");
    runOrThrow(world, ctx, execStairs(world, hero, stairs));
  },
};

export const useWaypointAction: ActionDef<{ depth: number }> = {
  name: ACTION.useWaypoint,
  parse(_world, payload) {
    const depth = (payload as { depth?: unknown } | null | undefined)?.depth;
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0) {
      throw new ActionError(ERR.badPayload, "expected { depth: integer >= 0 }");
    }
    return { depth };
  },
  apply(world, p, ctx) {
    runOrThrow(world, ctx, execWaypoint(world, heroOf(world), p.depth));
  },
};
