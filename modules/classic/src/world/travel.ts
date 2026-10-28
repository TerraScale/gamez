/**
 * Travel (classic.world; design §3.3, §9.3): town portal, portal use, stairs
 * and waypoints. Each op has a shared execX() returning OpResult, used by
 * both its action (throws ActionError when it fails) and the command system
 * (emits classic.command.failed). Travel is a transition request: the hero
 * moves in the next classic.world.transition (pre, next tick).
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
  Pos,
  Supplies,
} from "../components.ts";
import { noteManual } from "../control.ts";
import { emit } from "../events.ts";
import { dist2, tileCenter, within } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth, dungeonOf, heroOf } from "../resources.ts";
import { getMap } from "./maps.ts";
import { closePortal, spawnInteractableSub } from "./transition.ts";

const TOWN = 0;
const STAIRS: readonly InteractableKind[] = ["stairsDown", "stairsUp"];
const PORTALS: readonly InteractableKind[] = ["portal"];
const WAYPOINTS: readonly InteractableKind[] = ["waypoint"];

/** Common precondition: a hero exists and is alive. */
function checkHero(world: World): OpResult {
  const hero = heroOf(world);
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
export function execTownPortal(world: World, ctx: SimContext): OpResult {
  const ready = checkHero(world);
  if (!ready.ok) return ready;
  const hero = heroOf(world);
  const depth = currentDepth(world);
  if (depth === TOWN) return fail(ERR.inTown, "the town portal opens from the dungeon");
  const supplies = world.get(hero, Supplies);
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
  world.update(hero, Supplies, { tpScrolls: supplies.tpScrolls - 1 });
  emit(ctx, { type: "classic.portal.opened", depth });
  pushTransition(world, { to: TOWN, via: "townPortal" });
  return OK;
}

/**
 * Uses the open portal from the side the hero stands on: from town it leads
 * back to the portal's depth (and closes the pair on arrival), from the
 * dungeon it leads to town (the pair stays open).
 */
export function execUsePortal(world: World): OpResult {
  const ready = checkHero(world);
  if (!ready.ok) return ready;
  const hero = heroOf(world);
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
export function execStairs(world: World, target: Entity): OpResult {
  const ready = checkHero(world);
  if (!ready.ok) return ready;
  const hero = heroOf(world);
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
export function execWaypoint(world: World, depth: number): OpResult {
  const ready = checkHero(world);
  if (!ready.ok) return ready;
  const hero = heroOf(world);
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

// ---------------------------------------------------------------------------
// Command system (update 51)
// ---------------------------------------------------------------------------

const WORLD_OPS = ["townPortal", "usePortal", "stairs", "waypoint"] as const;
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
  switch (cmd.op) {
    case "townPortal":
      return execTownPortal(world, ctx);
    case "usePortal":
      return execUsePortal(world);
    case "stairs":
      return execStairs(world, cmd.target);
    case "waypoint":
      return execWaypoint(world, cmd.depth);
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
    runOrThrow(world, ctx, execTownPortal(world, ctx));
  },
};

export const usePortalAction: ActionDef<Record<string, never>> = {
  name: ACTION.usePortal,
  parse: (_world, payload) => parseEmpty(payload),
  apply(world, _p, ctx) {
    runOrThrow(world, ctx, execUsePortal(world));
  },
};

export const useStairsAction: ActionDef<Record<string, never>> = {
  name: ACTION.useStairs,
  parse: (_world, payload) => parseEmpty(payload),
  apply(world, _p, ctx) {
    const ready = checkHero(world);
    if (!ready.ok) throw new ActionError(ready.code, ready.message);
    const stairs = nearestInReach(world, heroOf(world), STAIRS);
    if (stairs === 0) throw new ActionError(ERR.tooFar, "no staircase within reach");
    runOrThrow(world, ctx, execStairs(world, stairs));
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
    runOrThrow(world, ctx, execWaypoint(world, p.depth));
  },
};
