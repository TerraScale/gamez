/**
 * The Rift loop of the auto controller (docs/design/wave-A.md §7 and §8).
 *
 * Wanted when AutoConfig.autoRift (default true), the Rift is unlocked, the
 * main dungeon is done (deepest >= MAIN_DUNGEON_DEPTH and its boss dead)
 * and the fee of the chosen level is affordable. Then:
 *  - from depth 16 the hero goes to town (scroll, else the stairs up to the
 *    waypoint), and the town routine's return step opens a rift at the
 *    obelisk ({op:"openRift", target, level}) instead of using the portal;
 *  - in the rift: explore everything (no explorePct, no stairs), hunt the
 *    guardian once it spawned, hunt the last monsters when no frontier is
 *    left; after the run (completed or not) walk to the riftExit and take it
 *    (core.intent queues leaveRift; the op is also sent on arrival).
 *  - level: 1 at first; after a run completed within RiftProto.timeLimit the
 *    next level (<= maxCompleted + 1), after a slow or failed run one lower;
 *    never above what the hero's level can take (monster level <= level + 2).
 *  - no run at all while the hero is too weak for level 1 (riftReady), or
 *    after RIFT_FAIL_STREAK deaths in a row at level 1 until the hero gains a
 *    level: the hero farms the main dungeon instead of paying fees to die.
 * No town portal in a rift (ERR.inRift): no voluntary trips, no retreat.
 */
import type { Entity } from "@gamez/kernel";
import { AreaTag, Dead, Interactable, Monster, Pos } from "../components.ts";
import { riftOf, RES, type DungeonState, type RiftState } from "../resources.ts";
import {
  isRiftDepth,
  MAIN_DUNGEON_DEPTH,
  monsterLevel,
  riftDepth,
  riftFee,
  RIFT_MAX_LEVEL,
} from "../rules.ts";
import { KIND, RIFT_ID, type RiftProto } from "../types.ts";
import { goldOf, heroLevel } from "./econ.ts";
import { exploreStep, goStairs, travel } from "./dungeon.ts";
import { walkTo } from "./route.ts";
import {
  effectiveLevel,
  inReach,
  isIgnored,
  moveTo,
  nearestInteractable,
  purseScrolls,
  setIntent,
  setPlan,
  type AutoCtx,
} from "./util.ts";
import { approach, type StepResult } from "./visit.ts";

export function riftProto(c: AutoCtx): RiftProto | undefined {
  return c.reg.get<RiftProto>(KIND.rift, RIFT_ID);
}

/** Highest rift level the hero's (effective) level takes on: monster level <= level + 2. */
export function riftLevelCap(level: number): number {
  let l = 1;
  while (l < RIFT_MAX_LEVEL && monsterLevel(riftDepth(l + 1, 0)) <= level + RIFT_LEVEL_MARGIN) l++;
  return l;
}
/** Rift monsters may be this many levels above the hero. */
export const RIFT_LEVEL_MARGIN = 2;

/**
 * The level of the next run: 1 the first time; the next level after a run
 * completed within the time limit (up to maxCompleted + 1), one lower after
 * a slow or failed run; capped by riftLevelCap.
 */
export function chooseRiftLevel(state: RiftState, proto: RiftProto, heroLvl: number): number {
  const last = state.history[0];
  let level = 1;
  if (last) {
    if (last.completed && last.ticks <= proto.timeLimit) level = last.level + 1;
    else level = last.level - 1;
  }
  level = Math.min(level, state.maxCompleted + 1, riftLevelCap(heroLvl), RIFT_MAX_LEVEL);
  return Math.max(1, level);
}

/** Failed level-1 runs in a row that pause auto rifts until the hero levels up. */
export const RIFT_FAIL_STREAK = 2;

/**
 * True when the hero may try rifts: level 1's monsters are within
 * RIFT_LEVEL_MARGIN of `effLvl`, and the last RIFT_FAIL_STREAK runs were not
 * all level-1 failures at the hero's current level `heroLvl` or above.
 */
export function riftReady(state: RiftState, effLvl: number, heroLvl: number): boolean {
  if (monsterLevel(riftDepth(1, 0)) > effLvl + RIFT_LEVEL_MARGIN) return false;
  const recent = state.history.slice(0, RIFT_FAIL_STREAK);
  if (recent.length < RIFT_FAIL_STREAK) return true;
  const stuck = recent.every((r) => !r.completed && r.level === 1 && r.heroLevel >= heroLvl);
  return !stuck;
}

/** True when the main dungeon is finished: deepest 16 and its boss dead. */
export function mainDungeonDone(dungeon: DungeonState | undefined): boolean {
  return (
    dungeon !== undefined &&
    dungeon.deepest >= MAIN_DUNGEON_DEPTH &&
    dungeon.bossesKilled.includes(MAIN_DUNGEON_DEPTH)
  );
}

/** The rift level to open now, or 0 when no rift run is wanted (see the file comment). */
export function riftWanted(c: AutoCtx): number {
  if (!(c.cfg.autoRift ?? true)) return 0;
  const state = riftOf(c.world);
  const proto = riftProto(c);
  if (!state?.unlocked || !proto || state.active) return 0;
  if (!mainDungeonDone(c.world.getResource<DungeonState>(RES.dungeon))) return 0;
  const lvl = effectiveLevel(heroLevel(c), c.st);
  if (!riftReady(state, lvl, heroLevel(c))) return 0;
  let level = chooseRiftLevel(state, proto, lvl);
  const gold = goldOf(c);
  while (level > 1 && riftFee(proto, level) > gold) level--;
  return riftFee(proto, level) <= gold ? level : 0;
}

/** Town routine, return step: open the wanted rift at the obelisk. "skip" when none is wanted. */
export function riftTownStep(c: AutoCtx): StepResult {
  if (c.depth !== 0) return "skip";
  const level = riftWanted(c);
  if (level === 0) return "skip";
  const obelisk = nearestInteractable(c, "riftObelisk");
  if (obelisk === 0) return "skip";
  setPlan(c, "toDungeon", `rift ${level}`);
  const same = c.st.focus === obelisk;
  c.st.focus = obelisk;
  if (inReach(c, obelisk)) {
    travel(c, { op: "openRift", target: obelisk, level });
    return "wait";
  }
  approach(c, obelisk, same);
  return "walk";
}

/**
 * At the bottom of the main dungeon with a rift wanted: head for town (a
 * scroll, else the stairs up toward the waypoint). False when not applicable.
 */
export function leaveForRift(c: AutoCtx): boolean {
  if (c.depth < MAIN_DUNGEON_DEPTH || isRiftDepth(c.depth) || riftWanted(c) === 0) return false;
  if (purseScrolls(c) > 0) {
    setPlan(c, "toTown", "rift");
    travel(c, { op: "townPortal" });
    return true;
  }
  return goStairs(c, "stairsUp");
}

/** Nearest living monster of the current area (any distance), or 0. */
function nearestMonster(c: AutoCtx): Entity {
  let best = 0;
  let bestD = Number.MAX_SAFE_INTEGER;
  for (const e of c.world.query(Monster, Pos, AreaTag)) {
    if (c.world.read(e, AreaTag).depth !== c.depth || c.world.has(e, Dead)) continue;
    if (c.world.read(e, Monster).rarity === "summon") continue;
    const p = c.world.read(e, Pos);
    if (isIgnored(c.st, p.x >> 8, p.y >> 8)) continue;
    const dx = p.x - c.hx;
    const dy = p.y - c.hy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function hunt(c: AutoCtx, e: Entity, note: string): boolean {
  if (e === 0 || !c.world.has(e, Pos)) return false;
  const p = c.world.read(e, Pos);
  const tx = p.x >> 8;
  const ty = p.y >> 8;
  const same = c.st.plan === "explore" && c.st.frontierX === tx && c.st.frontierY === ty;
  c.st.frontierX = tx;
  c.st.frontierY = ty;
  c.st.focus = e;
  setPlan(c, "explore", note);
  walkTo(c, tx, ty, () => moveTo(c, tx, ty), same);
  return true;
}

/** Walks to the rift exit and takes it (or sends leaveRift when there is none). */
function exitRift(c: AutoCtx): boolean {
  const exit = nearestInteractable(c, "riftExit");
  setPlan(c, "toTown", "rift exit");
  if (exit === 0) {
    travel(c, { op: "leaveRift" });
    return true;
  }
  const same = c.st.focus === exit;
  c.st.focus = exit;
  if (inReach(c, exit)) {
    travel(c, { op: "leaveRift" });
    return true;
  }
  const p = c.world.read(exit, Pos);
  walkTo(c, p.x >> 8, p.y >> 8, () => setIntent(c, { kind: "interact", target: exit }), same);
  return true;
}

/** The dungeon routine inside a rift (replaces explore/descend). */
export function riftDungeonStep(c: AutoCtx): boolean {
  const state = riftOf(c.world);
  const run = state?.active ?? null;
  if (!run || run.depth !== c.depth) return exitRift(c);
  if (run.guardianSpawned && run.guardian !== 0 && c.world.exists(run.guardian)) {
    if (!c.world.has(run.guardian, Dead) && hunt(c, run.guardian, "guardian")) return true;
  }
  const r = exploreStep(c);
  if (r === "moving") return true;
  if (r === "unknown") return false;
  // Everything explored: hunt what is left for the progress bar.
  if (hunt(c, nearestMonster(c), "rift hunt")) return true;
  // Nothing left to kill and no guardian: give the run up.
  return exitRift(c);
}

/** True when `e` is the rift exit (arrival handling in think.arriveAt). */
export function isRiftExit(c: AutoCtx, e: Entity): boolean {
  return c.world.get(e, Interactable)?.kind === "riftExit";
}
