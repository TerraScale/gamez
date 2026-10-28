/**
 * Exploration and descending (§15.2 steps 10-11): bounded BFS to the
 * nearest frontier (explored walkable tile next to an unexplored walkable
 * tile) skipping ignored tiles, and the descend / under-levelled farming
 * rules. The BFS allocates its scratch arrays per call (no module state).
 */
import type { Entity } from "@gamez/kernel";
import { pushCommand } from "../bus.ts";
import { AreaTag, Dead, Level, Monster, Pos } from "../components.ts";
import type { TilePos } from "../fixed.ts";
import {
  exploreAreaOf,
  exploredPct,
  isExplored,
  RES,
  type DungeonState,
  type ExploreArea,
} from "../resources.ts";
import { isBossDepth, monsterLevel } from "../rules.ts";
import { walkableAt, type ClassicMap } from "../world/maps.ts";
import {
  bfs,
  BFS_MAX_NODES,
  freshMove,
  onRecentMove,
  tileDist,
  walkTo,
  type BfsOutcome,
} from "./route.ts";
import {
  addIgnore,
  currentIntent,
  effectiveLevel,
  inReach,
  isIgnored,
  moveTo,
  nearestInteractable,
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
 */
export function findFrontier(
  map: ClassicMap,
  ea: ExploreArea,
  sx: number,
  sy: number,
  ignore: readonly TilePos[],
  maxNodes = BFS_MAX_NODES,
): BfsOutcome {
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
  const res = findFrontier(c.map, ea, c.tx, c.ty, st.ignore);
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
export function travel(c: AutoCtx, cmd: Parameters<typeof pushCommand>[1]): boolean {
  // Still walking (no command sent since the last one stopped the intent), or due again.
  const walking = currentIntent(c)?.kind !== "idle";
  if (!c.due && !walking) return false;
  pushCommand(c.world, cmd);
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
  const ea = exploreAreaOf(c.world, c.depth);
  // Just arrived: nothing revealed yet, so no frontier exists. Wait for the first reveal.
  if (ea !== undefined && ea.revealed === 0) return false;
  let explored: "moving" | "none" | "unknown" | null = null;
  const explore = (): "moving" | "none" | "unknown" => (explored ??= exploreStep(c));
  const stall = c.st.stallUntil > c.tick;

  let finished = stall || (ea !== undefined && exploredPct(ea) >= c.cfg.explorePct);
  if (!finished) {
    const r = explore();
    if (r === "moving") return true;
    if (r === "unknown") return false;
    finished = true;
  }
  if (!c.cfg.autoDescend && !stall) return explore() === "moving";

  const level = effectiveLevel(c.world.get(c.hero, Level)?.level ?? 1, c.st);
  const dungeon = c.world.getResource<DungeonState>(RES.dungeon);
  const bossAlive =
    isBossDepth(c.depth) &&
    dungeon !== undefined &&
    dungeon.liveBossAlive &&
    !dungeon.bossesKilled.includes(c.depth);
  const ready = bossReady(level, c.depth);
  if (bossAlive && ready && !stall && huntBoss(c)) return true;

  const depthOk = c.cfg.maxDepth === 0 || c.depth < c.cfg.maxDepth;
  const levelOk = level >= monsterLevel(c.depth + 1) - 2;
  // A living boss gates the way down until the hero is ready for it (or far past it), and
  // the hero only walks down to a boss depth it is ready for (no stairs ping-pong).
  const bossOk = !bossAlive || bossReady(level, c.depth + 1);
  const nextBoss =
    isBossDepth(c.depth + 1) &&
    !(dungeon?.bossesKilled.includes(c.depth + 1) ?? false) &&
    !bossReady(level, c.depth + 1);
  if (depthOk && levelOk && bossOk && !nextBoss && goStairs(c, "stairsDown")) return true;
  // Under-levelled (or at maxDepth, or not ready for the boss): go up for a fresh population.
  if (c.depth >= 2 && goStairs(c, "stairsUp")) return true;
  if (stall && goStairs(c, "stairsDown")) return true;
  return explore() === "moving";
}

/** Stuck handling for exploration targets. */
export function giveUpFrontier(c: AutoCtx): void {
  addIgnore(c.st, c.st.frontierX, c.st.frontierY);
  c.st.frontierX = -1;
  c.st.frontierY = -1;
}
