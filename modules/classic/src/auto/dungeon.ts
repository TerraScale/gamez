/**
 * Exploration and descending (§15.2 steps 10 and 11): bounded BFS to the
 * nearest frontier (explored walkable tile next to an unexplored walkable
 * tile) skipping ignored tiles, and the descend / under-levelled farming
 * rules. The BFS allocates its scratch arrays per call (no module state).
 */
import { defineComponent, type Entity } from "@gamez/kernel";
import type { HeroCommand } from "../actions.ts";
import { AreaTag, Dead, Faction, Level, Life, Monster, Pos, Summoned } from "../components.ts";
import type { TilePos } from "../fixed.ts";
import { liveMonsterCount } from "../progression/quests.ts";
import {
  exploreAreaOf,
  exploredPct,
  isExplored,
  RES,
  type DungeonState,
  type ExploreArea,
  type QuestState,
} from "../resources.ts";
import { isBossDepth, isRiftDepth, MAIN_DUNGEON_DEPTH, monsterLevel } from "../rules.ts";
import { KIND, type QuestProto } from "../types.ts";
import { walkableAt, type ClassicMap } from "../world/maps.ts";
import {
  bfs,
  bfsBest,
  BFS_MAX_NODES,
  distanceField,
  freshMove,
  LEG_TILES,
  onRecentMove,
  tileDist,
  walkTo,
  type BfsOutcome,
} from "./route.ts";
import { leaveForRift, riftDungeonStep } from "./riftLoop.ts";
import {
  addIgnore,
  currentIntent,
  effectiveLevel,
  emitFor,
  inReach,
  isIgnored,
  moveTo,
  nearestInteractable,
  pushCmd,
  setIntent,
  setPlan,
  stopIntent,
  TRAVEL_RETRY_TICKS,
  type AutoCtx,
} from "./util.ts";

function unexploredWalkable(map: ClassicMap, ea: ExploreArea, x: number, y: number): boolean {
  return walkableAt(map, x, y) && !isExplored(ea, x, y);
}

export function isFrontier(map: ClassicMap, ea: ExploreArea, x: number, y: number): boolean {
  if (!walkableAt(map, x, y) || !isExplored(ea, x, y)) return false;
  return (
    unexploredWalkable(map, ea, x + 1, y) ||
    unexploredWalkable(map, ea, x - 1, y) ||
    unexploredWalkable(map, ea, x, y + 1) ||
    unexploredWalkable(map, ea, x, y - 1)
  );
}

/**
 * Nearest frontier by BFS steps from (sx, sy), skipping `ignore`, preferring
 * one at least 3 steps away (a closer one is the fallback). `complete` tells
 * whether a null hit means "no reachable frontier".
 *
 * With a `toward` tile (the stairs down) every frontier also costs
 * `biasPct` % of its walking distance to that tile, so exploration grows
 * toward the stairs and the hero is near them once explorePct is reached
 * (QA major #1: the stairs used to be ~100 tiles away in the farthest room).
 */
export function findFrontier(
  map: ClassicMap,
  ea: ExploreArea,
  sx: number,
  sy: number,
  ignore: readonly TilePos[],
  maxNodes = BFS_MAX_NODES,
  toward: TilePos | null = null,
  biasPct = 0,
): BfsOutcome {
  if (toward === null || biasPct <= 0) {
    return bfs(
      map,
      sx,
      sy,
      (x, y, d) => {
        if (!isFrontier(map, ea, x, y)) return 0;
        for (const t of ignore) if (t.x === x && t.y === y) return 0;
        return d >= 3 ? 2 : 1;
      },
      maxNodes,
    );
  }
  // Walking distance to the goal (not straight-line: levels are mazes of rooms).
  const field = distanceField(map, toward.x, toward.y);
  const w = map.width;
  return bfsBest(
    map,
    sx,
    sy,
    (x, y, d) => {
      if (!isFrontier(map, ea, x, y)) return -1;
      for (const t of ignore) if (t.x === x && t.y === y) return -1;
      const near = d < 3 ? NEAR_FRONTIER_PENALTY : 0;
      const togo = field[y * w + x]!;
      return d + near + Math.floor(((togo < 0 ? FAR_STEPS : togo) * biasPct) / 100);
    },
    maxNodes,
  );
}

/** Walking distance assumed for a frontier the goal cannot be reached from. */
const FAR_STEPS = 512;
/** Extra cost (steps) of a frontier closer than 3 steps (it is revealed on the way anyway). */
const NEAR_FRONTIER_PENALTY = 6;
/**
 * Stairs bias of the frontier choice (% of the frontier's distance to the
 * stairs added to its BFS steps) while exploring a level the hero will
 * leave by the stairs down.
 */
export const STAIRS_BIAS_PCT = 300;

/** The tile exploration grows toward: the stairs down of a main dungeon level the hero may descend from. */
function exploreGoal(c: AutoCtx): TilePos | null {
  if (!c.cfg.autoDescend) return null;
  return c.map.stairsDown;
}

/**
 * Step 11: keep walking to a still-valid frontier or search a new one (the
 * hero walks there leg by leg). Returns "moving", or "none" when no
 * reachable frontier exists ("unknown" when exploration data is missing or
 * the search was cut short).
 */
export function exploreStep(c: AutoCtx): "moving" | "none" | "unknown" {
  const ea = exploreAreaOf(c.world, c.depth);
  if (!ea || ea.width !== c.map.width) return "unknown";
  const st = c.st;
  if (
    st.plan === "explore" &&
    st.frontierX >= 0 &&
    !isIgnored(st, st.frontierX, st.frontierY) &&
    tileDist(st.frontierX, st.frontierY, c.tx, c.ty) > 2 &&
    isFrontier(c.map, ea, st.frontierX, st.frontierY) &&
    onRecentMove(c)
  ) {
    return "moving";
  }
  const res = findFrontier(
    c.map,
    ea,
    c.tx,
    c.ty,
    st.ignore,
    BFS_MAX_NODES,
    exploreGoal(c),
    STAIRS_BIAS_PCT,
  );
  if (!res.hit) {
    st.frontierX = -1;
    st.frontierY = -1;
    return res.complete ? "none" : "unknown";
  }
  st.frontierX = res.hit.x;
  st.frontierY = res.hit.y;
  st.focus = 0;
  setPlan(c, "explore", `${res.hit.x},${res.hit.y}`);
  freshMove(c, res.hit.next.x, res.hit.next.y);
  return "moving";
}

/**
 * Pushes a travel command (portal, stairs, waypoint) on arrival (the hero is
 * still walking there) or when the controller is due (tick >= thinkAt at
 * the start of the tick). Sending stops the intent and waits
 * TRAVEL_RETRY_TICKS before another one may be sent.
 */
export function travel(c: AutoCtx, cmd: HeroCommand): boolean {
  // Still walking (no command sent since the last one stopped the intent), or due again.
  const walking = currentIntent(c)?.kind !== "idle";
  if (!c.due && !walking) return false;
  pushCmd(c, cmd);
  stopIntent(c);
  c.st.thinkAt = c.tick + TRAVEL_RETRY_TICKS;
  c.due = false;
  return true;
}

/** Walks to the stairs of `kind` and takes them. False when this level has none. */
export function goStairs(c: AutoCtx, kind: "stairsDown" | "stairsUp"): boolean {
  const e: Entity = nearestInteractable(c, kind);
  const note = kind === "stairsDown" ? "stairs down" : "stairs up";
  if (e === 0) {
    const t = kind === "stairsDown" ? c.map.stairsDown : c.map.stairsUp;
    if (!t) return false;
    setPlan(c, "descend", note);
    walkTo(c, t.x, t.y, () => moveTo(c, t.x, t.y), c.st.plan === "descend");
    return true;
  }
  const same = c.st.focus === e && c.st.plan === "descend";
  c.st.focus = e;
  setPlan(c, "descend", note);
  if (inReach(c, e)) {
    travel(c, { op: "stairs", target: e });
    return true;
  }
  const p = c.world.read(e, Pos);
  walkTo(c, p.x >> 8, p.y >> 8, () => setIntent(c, { kind: "interact", target: e }), same);
  return true;
}

/** The live boss of the current area (awake or asleep), or 0. */
export function liveBoss(c: AutoCtx): Entity {
  for (const e of c.world.query(Monster, Pos, AreaTag)) {
    if (c.world.read(e, AreaTag).depth !== c.depth || c.world.has(e, Dead)) continue;
    if (c.world.read(e, Monster).rarity === "boss") return e;
  }
  return 0;
}

/** The hero is strong enough to take on the boss of `depth`: level >= monster level + 2. */
export function bossReady(level: number, depth: number): boolean {
  return level >= monsterLevel(depth) + BOSS_READY_LEVELS;
}
/** See bossReady. */
export const BOSS_READY_LEVELS = 2;

/** Walks to the live boss (it wakes when the hero comes close). False when there is none or it is given up. */
function huntBoss(c: AutoCtx): boolean {
  const boss = liveBoss(c);
  if (boss === 0) return false;
  const p = c.world.read(boss, Pos);
  const bx = p.x >> 8;
  const by = p.y >> 8;
  if (isIgnored(c.st, bx, by)) return false;
  const same = c.st.plan === "explore" && c.st.frontierX === bx && c.st.frontierY === by;
  c.st.frontierX = bx;
  c.st.frontierY = by;
  c.st.focus = boss;
  setPlan(c, "explore", "boss");
  walkTo(c, bx, by, () => moveTo(c, bx, by), same);
  return true;
}

/**
 * Steps 10-11 in a dungeon: explore until explorePct (or no reachable
 * frontier); on a boss depth hunt the boss once ready (level >= monster
 * level + 2); then descend when allowed, or farm a fresh population when
 * under-levelled, at maxDepth or not ready for the boss. During a watchdog
 * stall the hero heads straight for the stairs (a fresh level).
 */
export function dungeonStep(c: AutoCtx): boolean {
  // Inside a rift: its own loop (riftLoop.ts).
  if (isRiftDepth(c.depth)) return riftDungeonStep(c);
  const ea = exploreAreaOf(c.world, c.depth);
  // Just arrived: nothing revealed yet, so no frontier exists. Wait for the first reveal.
  if (ea !== undefined && ea.revealed === 0) return false;
  let explored: "moving" | "none" | "unknown" | null = null;
  const explore = (): "moving" | "none" | "unknown" => (explored ??= exploreStep(c));
  const stall = c.st.stallUntil > c.tick;

  const level = effectiveLevel(c.world.get(c.hero, Level)?.level ?? 1, c.st);
  const dungeon = c.world.getResource<DungeonState>(RES.dungeon);
  const bossAlive =
    isBossDepth(c.depth) &&
    dungeon !== undefined &&
    dungeon.liveBossAlive &&
    !dungeon.bossesKilled.includes(c.depth);
  // The main dungeon ends at MAIN_DUNGEON_DEPTH (no stairs down there).
  const depthOk =
    c.depth < MAIN_DUNGEON_DEPTH && (c.cfg.maxDepth === 0 || c.depth < c.cfg.maxDepth);
  const levelOk = level >= monsterLevel(c.depth + 1) - 2;
  // A living boss gates the way down until the hero is ready for it (or far past it), and
  // the hero only walks down to a boss depth it is ready for (no stairs ping-pong).
  const bossOk = !bossAlive || bossReady(level, c.depth + 1);
  const nextBoss =
    isBossDepth(c.depth + 1) &&
    !(dungeon?.bossesKilled.includes(c.depth + 1) ?? false) &&
    !bossReady(level, c.depth + 1);
  const canDescend = c.cfg.autoDescend && depthOk && levelOk && bossOk && !nextBoss;
  // A level above the deepest one (after a death, a waypoint, farming) is only walked
  // through when the hero may go on down: no second explorePct on the way back.
  const passing = canDescend && dungeon !== undefined && dungeon.deepest > c.depth;

  // Quest objective (clearLevel): go down to its depth, then hunt every living monster there.
  if (!stall) {
    const goal = clearObjective(c);
    if (goal > 0 && c.depth < goal && goStairs(c, "stairsDown")) return true;
    if (goal > 0 && c.depth === goal && liveMonsterCount(c.world, goal) > 0 && clearStep(c, goal))
      return true;
  }

  let finished = stall || passing || (ea !== undefined && exploredPct(ea) >= c.cfg.explorePct);
  if (!finished) {
    const r = explore();
    if (r === "moving") return true;
    if (r === "unknown") return false;
    finished = true;
  }
  if (!c.cfg.autoDescend && !stall) return explore() === "moving";

  if (bossAlive && bossReady(level, c.depth) && !stall && huntBoss(c)) return true;
  // The main dungeon is done (wave A): off to town for a rift run.
  if (!bossAlive && leaveForRift(c)) return true;
  if (canDescend && goStairs(c, "stairsDown")) return true;
  // Under-levelled (or at maxDepth, or not ready for the boss): go up for a fresh population.
  if (c.depth >= 2 && goStairs(c, "stairsUp")) return true;
  if (stall && depthOk && goStairs(c, "stairsDown")) return true;
  return explore() === "moving";
}

// ---------------------------------------------------------------------------
// Quest objective: clear a level (clearLevel quests)
// ---------------------------------------------------------------------------

/**
 * Quest objective memory (owner: classic.auto, on the hero, created lazily):
 * a clearLevel objective given up at `depth` (every remaining monster
 * unreachable) is not taken up again before tick `until`.
 */
export const AutoObjective = defineComponent<{ depth: number; until: number }>(
  "classic.autoObjective",
);
/** A given-up clear objective waits this long (5 min) before Auto tries again. */
export const OBJECTIVE_COOLDOWN_TICKS = 6000;
/** Monsters of the objective depth may be this many levels above the (effective) hero level. */
export const OBJECTIVE_LEVEL_MARGIN = 2;

/**
 * Depth of the clearLevel quest Auto works on now, or 0: an active, not done
 * clearLevel quest whose depth was reached before (<= deepest), within
 * maxDepth, with monsters at most OBJECTIVE_LEVEL_MARGIN levels above the
 * effective hero level, not blocked by the death rules (first return after
 * a death: not below the death depth; repeated deaths: strictly above it),
 * not given up recently. Never with autoDescend off, during a watchdog stall
 * or inside a rift. Several candidates: the shallowest (ties: quest id).
 */
export function clearObjective(c: AutoCtx): number {
  if (!c.cfg.autoDescend || c.st.stallUntil > c.tick || isRiftDepth(c.depth)) return 0;
  const qs = c.world.getResource<QuestState>(RES.quests);
  const dungeon = c.world.getResource<DungeonState>(RES.dungeon);
  if (!qs || !dungeon || qs.active.length === 0) return 0;
  const level = effectiveLevel(c.world.get(c.hero, Level)?.level ?? 1, c.st);
  const given = c.world.get(c.hero, AutoObjective);
  let best = 0;
  for (const q of qs.active) {
    if (q.done) continue;
    const qp = c.reg.get<QuestProto>(KIND.quest, q.id);
    if (!qp || qp.kind !== "clearLevel") continue;
    const d = qp.count;
    if (d < 1 || d > dungeon.deepest || d > MAIN_DUNGEON_DEPTH) continue;
    if (c.cfg.maxDepth > 0 && d > c.cfg.maxDepth) continue;
    if (monsterLevel(d) > level + OBJECTIVE_LEVEL_MARGIN) continue;
    if (c.st.deathDepth > 0) {
      const limit = c.st.caution >= 2 ? c.st.deathDepth - 1 : c.st.deathDepth;
      if (d > Math.max(1, limit)) continue;
    }
    if (given && given.depth === d && given.until > c.tick) continue;
    if (best === 0 || d < best) best = d;
  }
  return best;
}

/** Gives the clear objective at `depth` up for OBJECTIVE_COOLDOWN_TICKS. */
function giveUpObjective(c: AutoCtx, depth: number): void {
  const v = { depth, until: c.tick + OBJECTIVE_COOLDOWN_TICKS };
  if (c.world.has(c.hero, AutoObjective)) c.world.update(c.hero, AutoObjective, v);
  else c.world.add(c.hero, AutoObjective, v);
  emitFor(c, {
    type: "classic.auto.notice",
    code: "objective_unreachable",
    message: "Auto: the last monsters of this level are out of reach, trying again later",
  });
}

/** True for a living hostile monster of `depth` (the ones a clearLevel quest counts). */
function isClearTarget(c: AutoCtx, e: Entity, depth: number): boolean {
  if (c.world.read(e, Faction).team !== "monster") return false;
  if (c.world.read(e, AreaTag).depth !== depth) return false;
  if (c.world.has(e, Dead) || c.world.has(e, Summoned)) return false;
  return c.world.read(e, Life).hp > 0;
}

/**
 * The nearest living monster of `depth` by walking distance (BFS; a tile
 * next to the monster counts, ties: BFS order, then the lower entity id),
 * skipping ignored tiles. When the BFS was cut short: the nearest one in a
 * straight line (ties: lower id). "unreachable" when none can be reached.
 */
function clearTarget(
  c: AutoCtx,
  depth: number,
): { e: Entity; x: number; y: number; steps: number; next: TilePos } | "unreachable" {
  const w = c.map.width;
  const h = c.map.height;
  // Tile index (the monster's tile and its 8 neighbours) -> the lowest-id monster there.
  const near = new Map<number, Entity>();
  let line: Entity = 0;
  let lineD = Number.MAX_SAFE_INTEGER;
  for (const e of c.world.query(Monster, Faction, AreaTag, Life, Pos)) {
    if (!isClearTarget(c, e, depth)) continue;
    const p = c.world.read(e, Pos);
    const tx = p.x >> 8;
    const ty = p.y >> 8;
    if (isIgnored(c.st, tx, ty)) continue;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = tx + dx;
        const y = ty + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const k = y * w + x;
        if (dx === 0 && dy === 0) near.set(k, e);
        else if (!near.has(k)) near.set(k, e);
      }
    const ddx = p.x - c.hx;
    const ddy = p.y - c.hy;
    const d = ddx * ddx + ddy * ddy;
    if (d < lineD) {
      lineD = d;
      line = e;
    }
  }
  if (line === 0) return "unreachable";
  const r = bfs(c.map, c.tx, c.ty, (x, y) => (near.has(y * w + x) ? 2 : 0));
  const pick = r.hit ? near.get(r.hit.y * w + r.hit.x)! : r.complete ? 0 : line;
  if (pick === 0) return "unreachable";
  const p = c.world.read(pick, Pos);
  const x = p.x >> 8;
  const y = p.y >> 8;
  if (r.hit) return { e: pick, x, y, steps: r.hit.steps, next: r.hit.next };
  return { e: pick, x, y, steps: tileDist(x, y, c.tx, c.ty), next: { x, y } };
}

/**
 * The clear objective on its depth: walk to the nearest living monster (the
 * fight step takes over once it is close). Stuck walks give the monster's
 * tile up like a frontier (giveUpFrontier). False when every remaining
 * monster is out of reach: the objective is given up for a while.
 */
function clearStep(c: AutoCtx, depth: number): boolean {
  const t = clearTarget(c, depth);
  if (t === "unreachable") {
    giveUpObjective(c, depth);
    return false;
  }
  const st = c.st;
  const same = st.plan === "explore" && st.frontierX === t.x && st.frontierY === t.y;
  st.frontierX = t.x;
  st.frontierY = t.y;
  st.focus = t.e;
  setPlan(c, "explore", "clear level");
  if (t.steps <= LEG_TILES || tileDist(t.x, t.y, c.tx, c.ty) <= LEG_TILES) moveTo(c, t.x, t.y);
  else if (!(same && onRecentMove(c))) freshMove(c, t.next.x, t.next.y);
  return true;
}

/** Stuck handling for exploration targets. */
export function giveUpFrontier(c: AutoCtx): void {
  addIgnore(c.st, c.st.frontierX, c.st.frontierY);
  c.st.frontierX = -1;
  c.st.frontierY = -1;
}
