/**
 * classic.core.intent (update 100): executes the hero Intent. docs/design/classic.md §3.3, §5.
 *
 * - move: A* (findPath, maxNodes 6000) to the target tile, nearest walkable
 *   tile within 3 tiles as a fallback; idle once arrived (or unreachable).
 * - skill: self skills and point casts (no target entity) are ordered at
 *   once; otherwise walk until the target is within range (+ its body radius)
 *   and in line of sight (direct steering with LOS, else A* re-pathed every
 *   10 ticks or when the target moved > 2 tiles from the path goal), then
 *   stop and add a CastOrder. `repeat` keeps re-issuing it until the target
 *   is Dead; otherwise the intent turns idle when the order is issued.
 * - pickup / interact: walk until within APPROACH_RANGE, then queue the
 *   owner command or emit the panel event, then idle.
 * Busy heroes (Casting, Dash, Dead, stun) do not start anything.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { findPath } from "@gamez/world";
import { APPROACH_RANGE } from "../actions.ts";
import { pushCommand } from "../bus.ts";
import {
  Body,
  CastOrder,
  CombatStats,
  Dead,
  HeroStats,
  Intent,
  Interactable,
  Loot,
  Mover,
  Npc,
  Pos,
  SkillBook,
  Mana,
  type HeroIntentValue,
  type MoverValue,
} from "../components.ts";
import { emit } from "../events.ts";
import { chebyshev, dist2, toTile, type TilePos } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth, heroOf } from "../resources.ts";
import { effectiveRank, skillManaCost } from "../rules.ts";
import { KIND, type NpcProto, type SkillProto } from "../types.ts";
import { getAreaMap, lineOfSight, walkableAt, type ClassicMap } from "../world/maps.ts";
import { inArea, isBusy } from "./units.ts";

export const PATH_MAX_NODES = 6000;
/** Re-path a chase at most this often (ticks) unless the target moved far. */
export const REPATH_TICKS = 10;
/** Re-path when the target is this many tiles away from the current path goal. */
export const REPATH_DRIFT = 2;
/** Re-path when the hero has been blocked this many ticks. */
export const BLOCKED_REPATH = 20;

type IntentOf<K extends HeroIntentValue["kind"]> = Extract<HeroIntentValue, { kind: K }>;

/**
 * A* path from `from` to `to`; when that fails, to the nearest walkable tile
 * within 3 tiles of `to` (by distance, then y, then x). [] = already there,
 * null = unreachable.
 */
export function planPath(map: ClassicMap, from: TilePos, to: TilePos): TilePos[] | null {
  const direct = walkableAt(map, to.x, to.y) ? findPath(map, from, to, PATH_MAX_NODES) : null;
  if (direct) return direct;
  const cands: { x: number; y: number; d: number }[] = [];
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = to.x + dx;
      const y = to.y + dy;
      if (walkableAt(map, x, y)) cands.push({ x, y, d: dx * dx + dy * dy });
    }
  }
  cands.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  // A few attempts only: each failed A* costs up to maxNodes.
  for (let i = 0; i < cands.length && i < 4; i++) {
    const c = cands[i]!;
    const p = findPath(map, from, c, PATH_MAX_NODES);
    if (p) return p;
  }
  return null;
}

/** Skill reach: SkillProto.range, or the basic attack reach when it is 0. */
export function skillReach(skill: Readonly<SkillProto>, attackRange: number): number {
  return skill.range > 0 ? skill.range : attackRange;
}

function stop(m: MoverValue | undefined): void {
  if (!m) return;
  if (m.path.length > 0) m.path = [];
  m.goalX = -1;
  m.goalY = -1;
}

function setIdle(world: World, hero: Entity, intent: HeroIntentValue, ctx: SimContext): void {
  world.add(hero, Intent, { kind: "idle", source: intent.source, at: ctx.tick });
  stop(world.get(hero, Mover));
}

export const intentSystem: SystemDef = {
  ...SYSTEM.coreIntent,
  run(world, ctx) {
    const hero = heroOf(world);
    if (hero === 0) return;
    const intent = world.get(hero, Intent);
    if (!intent || !world.has(hero, Pos)) return;
    if (!inArea(world, hero, currentDepth(world))) return;
    const mover = world.get(hero, Mover);
    // A freshly written intent drops whatever the previous one was walking.
    if (intent.at === ctx.tick) stop(mover);
    if (intent.kind === "idle") return;
    if (isBusy(world, ctx.registry, hero, ctx.tick)) return;
    const map = getAreaMap(world, ctx.registry);
    switch (intent.kind) {
      case "move":
        runMove(world, ctx, hero, intent, mover, map);
        break;
      case "skill":
        runSkill(world, ctx, hero, intent, mover, map);
        break;
      case "pickup":
      case "interact":
        runUse(world, ctx, hero, intent, mover, map);
        break;
    }
  },
};

function heroTile(world: World, hero: Entity): TilePos {
  const p = world.read(hero, Pos);
  return { x: toTile(p.x), y: toTile(p.y) };
}

function runMove(
  world: World,
  ctx: SimContext,
  hero: Entity,
  intent: IntentOf<"move">,
  mover: MoverValue | undefined,
  map: ClassicMap,
): void {
  if (!mover) return setIdle(world, hero, intent, ctx);
  const goal = mover.path[mover.path.length - 1];
  // Keep walking a path that ends at the target (or at its fallback tile within 3 tiles).
  if (goal && mover.blocked < BLOCKED_REPATH && chebyshev(goal, intent) <= 3) return;
  const path = planPath(map, heroTile(world, hero), { x: intent.x, y: intent.y });
  mover.blocked = 0;
  if (path === null || path.length === 0) return setIdle(world, hero, intent, ctx);
  mover.path = path;
  mover.goalX = -1;
  mover.goalY = -1;
}

/**
 * Walks toward (tx, ty): direct steering with line of sight, else an A* path
 * re-planned when empty, every REPATH_TICKS, when the target drifted more than
 * REPATH_DRIFT tiles from the path goal, or when blocked. Returns false when
 * the target is unreachable.
 */
function approach(
  world: World,
  ctx: SimContext,
  hero: Entity,
  intent: HeroIntentValue,
  mover: MoverValue,
  map: ClassicMap,
  tx: number,
  ty: number,
): boolean {
  const p = world.read(hero, Pos);
  // Direct steering with line of sight, unless a path is being followed (it was set because
  // steering got blocked, e.g. on a wall corner the thin line of sight does not see).
  if (
    mover.path.length === 0 &&
    lineOfSight(map, p.x, p.y, tx, ty) &&
    mover.blocked < BLOCKED_REPATH
  ) {
    if (mover.path.length > 0) mover.path = [];
    mover.goalX = tx;
    mover.goalY = ty;
    return true;
  }
  const target = { x: toTile(tx), y: toTile(ty) };
  const goal = mover.path[mover.path.length - 1];
  const due =
    goal === undefined ||
    mover.blocked >= BLOCKED_REPATH ||
    chebyshev(goal, target) > REPATH_DRIFT ||
    ((ctx.tick - intent.at) % REPATH_TICKS === 0 && (goal.x !== target.x || goal.y !== target.y));
  if (!due) return true;
  mover.blocked = 0;
  const path = planPath(map, { x: toTile(p.x), y: toTile(p.y) }, target);
  if (path === null) return false;
  if (path.length === 0) {
    // Same tile (or best reachable tile): finish with direct steering.
    mover.path = [];
    mover.goalX = tx;
    mover.goalY = ty;
    return true;
  }
  mover.path = path;
  mover.goalX = -1;
  mover.goalY = -1;
  return true;
}

function runSkill(
  world: World,
  ctx: SimContext,
  hero: Entity,
  intent: IntentOf<"skill">,
  mover: MoverValue | undefined,
  map: ClassicMap,
): void {
  const skill = ctx.registry.get<SkillProto>(KIND.skill, intent.skill);
  const book = world.get(hero, SkillBook);
  const known = book?.ranks.find((r) => r.skill === intent.skill);
  if (!skill || !known || known.rank < 1) return setIdle(world, hero, intent, ctx);
  const p = world.read(hero, Pos);

  if (skill.target === "self") {
    stop(mover);
    world.add(hero, CastOrder, { skill: intent.skill, target: 0, x: p.x, y: p.y });
    return setIdle(world, hero, intent, ctx);
  }

  let tx = intent.x;
  let ty = intent.y;
  let reach = -1;
  if (intent.target !== 0) {
    const t = intent.target;
    if (!world.exists(t) || world.has(t, Dead) || !inArea(world, t, currentDepth(world))) {
      return setIdle(world, hero, intent, ctx);
    }
    const tp = world.get(t, Pos);
    if (!tp) return setIdle(world, hero, intent, ctx);
    tx = tp.x;
    ty = tp.y;
    const stats = world.get(hero, CombatStats);
    reach = skillReach(skill, stats?.attackRange ?? 0) + (world.get(t, Body)?.radius ?? 0);
  } else if (skill.target === "enemy") {
    return setIdle(world, hero, intent, ctx);
  }

  const inReach =
    reach < 0 || (dist2(p.x, p.y, tx, ty) <= reach * reach && lineOfSight(map, p.x, p.y, tx, ty));
  if (!inReach) {
    if (!mover || !approach(world, ctx, hero, intent, mover, map, tx, ty)) {
      setIdle(world, hero, intent, ctx);
    }
    return;
  }

  stop(mover);
  if (intent.repeat) {
    // Wait out cooldowns instead of spamming failed orders.
    const ready = book!.cooldowns.find((c) => c.skill === intent.skill)?.readyAt ?? 0;
    if (ready > ctx.tick) return;
  }
  world.add(hero, CastOrder, { skill: intent.skill, target: intent.target, x: tx, y: ty });
  if (!intent.repeat || !affordable(world, hero, skill, known.rank)) {
    setIdle(world, hero, intent, ctx);
  }
}

/** Enough mana for one more cast (units without Mana always can). */
function affordable(
  world: World,
  hero: Entity,
  skill: Readonly<SkillProto>,
  rank: number,
): boolean {
  const mana = world.get(hero, Mana);
  if (!mana) return true;
  const all = world.get(hero, HeroStats)?.allSkills ?? 0;
  return mana.mp >= skillManaCost(skill, effectiveRank(skill, rank, all));
}

function runUse(
  world: World,
  ctx: SimContext,
  hero: Entity,
  intent: IntentOf<"pickup"> | IntentOf<"interact">,
  mover: MoverValue | undefined,
  map: ClassicMap,
): void {
  const t = intent.target;
  const valid =
    world.exists(t) &&
    inArea(world, t, currentDepth(world)) &&
    world.has(t, Pos) &&
    (intent.kind === "pickup"
      ? world.has(t, Loot)
      : world.has(t, Npc) || world.has(t, Interactable));
  if (!valid) return setIdle(world, hero, intent, ctx);
  const p = world.read(hero, Pos);
  const tp = world.read(t, Pos);
  if (dist2(p.x, p.y, tp.x, tp.y) > APPROACH_RANGE * APPROACH_RANGE) {
    if (!mover || !approach(world, ctx, hero, intent, mover, map, tp.x, tp.y)) {
      setIdle(world, hero, intent, ctx);
    }
    return;
  }
  stop(mover);
  if (intent.kind === "pickup") {
    pushCommand(world, { op: "pickup", target: t });
  } else {
    interactWith(world, ctx, t);
  }
  setIdle(world, hero, intent, ctx);
}

function interactWith(world: World, ctx: SimContext, t: Entity): void {
  const npc = world.get(t, Npc);
  if (npc) {
    const proto = ctx.registry.get<NpcProto>(KIND.npc, npc.proto);
    const role = proto?.role ?? "";
    emit(ctx, { type: "classic.npc.opened", npc: t, proto: npc.proto, role });
    if (role === "healer") pushCommand(world, { op: "heal", npc: t });
    return;
  }
  const it = world.get(t, Interactable);
  if (!it) return;
  switch (it.kind) {
    case "stairsDown":
    case "stairsUp":
      pushCommand(world, { op: "stairs", target: t });
      break;
    case "portal":
      pushCommand(world, { op: "usePortal" });
      break;
    case "waypoint":
      emit(ctx, { type: "classic.waypoint.opened" });
      break;
    case "stash":
      emit(ctx, { type: "classic.stash.opened" });
      break;
  }
}
