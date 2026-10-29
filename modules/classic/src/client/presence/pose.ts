/**
 * The local hero's pose as reported to the classic town presence world
 * (wave-B.md §7). OWNER: T-classic-presence.
 *
 * Pure reads of the sim, written into a reusable PoseState so the steady
 * state allocates nothing. Positions are integer tiles; the path is at most
 * MAX_PATH tiles towards the hero's current move target.
 */
import type { Entity, FrozenRegistry, World } from "@gamez/kernel";
import { MAX_COMPANIONS, type CompanionPose } from "@gamez/protocol";
import { CombatStats, Hero, Level, Mover, Pos } from "../../components.ts";
import { SUB, TICK_HZ } from "../../fixed.ts";
import { partyStateOf } from "../../resources.ts";
import { KIND, type ClassProto } from "../../types.ts";
import type { PresenceConnection } from "@gamez/ui-host";

/** Longest path reported (tiles). Keeps payloads and the server's walk maths small. */
export const MAX_PATH = 8;
/** Speed clamp in tiles per second (the server clamps to the same range). */
export const SPEED_MIN = 1;
export const SPEED_MAX = 12;
/** Companion offsets are clamped to -MAX_OFFSET..MAX_OFFSET tiles (the server clamps to the same range). */
export const MAX_OFFSET = 4;

/** Wire type of a pose update (derived, so this package need not depend on @gamez/protocol). */
export type PoseUpdate = Parameters<PresenceConnection["setPose"]>[0];

export interface PoseState {
  /** Integer tile the hero stands on. */
  x: number;
  y: number;
  /** Number of valid entries in px / py (0..MAX_PATH). */
  n: number;
  px: number[];
  py: number[];
  /** Tiles per second, one decimal, clamped to SPEED_MIN..SPEED_MAX. */
  speed: number;
  /** Class appearance, e.g. "unit.hero.warrior". */
  appearance: string;
  /** "Lv <level> <Class name>". */
  tag: string;
  /** Keys the appearance and tag were built from (rebuilt only when they change). */
  level: number;
  classId: string;
  /**
   * Party companions: the other members of the party, in partyMembers order
   * (party.md §11.3). Entries 0..cn-1 are valid; the arrays are reused.
   */
  cn: number;
  /** Class appearance of each companion. */
  cAppearance: string[];
  /** Hero name of each companion. */
  cName: string[];
  /** Integer tile offset of each companion from the controlled hero, -4..4. */
  cdx: number[];
  cdy: number[];
}

export function makePose(): PoseState {
  return {
    x: 0,
    y: 0,
    n: 0,
    px: [0, 0, 0, 0, 0, 0, 0, 0],
    py: [0, 0, 0, 0, 0, 0, 0, 0],
    speed: SPEED_MIN,
    appearance: "unit.hero",
    tag: "",
    level: -1,
    classId: "",
    cn: 0,
    cAppearance: Array.from({ length: MAX_COMPANIONS }, () => "unit.hero"),
    cName: Array.from({ length: MAX_COMPANIONS }, () => ""),
    cdx: Array.from({ length: MAX_COMPANIONS }, () => 0),
    cdy: Array.from({ length: MAX_COMPANIONS }, () => 0),
  };
}

function clampOffset(v: number): number {
  return v < -MAX_OFFSET ? -MAX_OFFSET : v > MAX_OFFSET ? MAX_OFFSET : v;
}

/**
 * Fills the companion slots from the party: every member except `hero`, in
 * partyMembers order, at most MAX_COMPANIONS, each at its integer tile offset
 * from the controlled hero's tile (`out.x`, `out.y`, already set). A member
 * without a position yet is skipped. No party (or a party of one) leaves cn at 0.
 */
function readCompanions(
  world: World,
  hero: Entity,
  registry: FrozenRegistry,
  out: PoseState,
): void {
  out.cn = 0;
  const party = partyStateOf(world);
  if (!party) return;
  for (const e of party.members) {
    if (out.cn >= MAX_COMPANIONS) break;
    if (e === 0 || e === hero || !world.exists(e)) continue;
    const pos = world.get(e, Pos);
    if (!pos) continue;
    const i = out.cn;
    const hi = world.get(e, Hero);
    const proto = registry.get<ClassProto>(KIND.class, hi?.classId ?? "");
    out.cAppearance[i] = proto?.appearance ?? "unit.hero";
    out.cName[i] = hi?.name ? hi.name : (proto?.name ?? "Hero");
    out.cdx[i] = clampOffset(Math.floor(pos.x / SUB) - out.x);
    out.cdy[i] = clampOffset(Math.floor(pos.y / SUB) - out.y);
    out.cn = i + 1;
  }
}

/**
 * Fills `out` with the hero's current pose. Reads only; never mutates the sim.
 * Returns false (and leaves `out` alone) while the hero has no position yet,
 * e.g. between a new hero and its placement in the town.
 */
export function readPose(
  world: World,
  hero: Entity,
  registry: FrozenRegistry,
  out: PoseState,
): boolean {
  const pos = world.get(hero, Pos);
  if (!pos) return false;
  out.x = Math.floor(pos.x / SUB);
  out.y = Math.floor(pos.y / SUB);

  const level = world.get(hero, Level)?.level ?? 1;
  const classId = world.get(hero, Hero)?.classId ?? "";
  if (classId !== out.classId || level !== out.level) {
    const proto = registry.get<ClassProto>(KIND.class, classId);
    out.classId = classId;
    out.level = level;
    out.appearance = proto?.appearance ?? "unit.hero";
    out.tag = `Lv ${level} ${proto?.name ?? "Hero"}`;
  }

  const mover = world.get(hero, Mover);
  let n = 0;
  let px = out.x;
  let py = out.y;
  const path = mover?.path ?? [];
  for (let i = 0; i < path.length && n < MAX_PATH; i++) {
    const p = path[i];
    if (!p || (p.x === px && p.y === py)) continue;
    out.px[n] = p.x;
    out.py[n] = p.y;
    n++;
    px = p.x;
    py = p.y;
  }
  if (n === 0 && mover && mover.goalX >= 0 && mover.goalY >= 0) {
    // Direct steering with no A* path: straight steps towards the goal tile.
    const gx = Math.floor(mover.goalX / SUB);
    const gy = Math.floor(mover.goalY / SUB);
    while (n < MAX_PATH && (px !== gx || py !== gy)) {
      px += Math.sign(gx - px);
      py += Math.sign(gy - py);
      out.px[n] = px;
      out.py[n] = py;
      n++;
    }
  }
  out.n = n;

  const pct = world.get(hero, CombatStats)?.moveSpeed ?? 100;
  const tilesPerSec = ((mover?.speed ?? 0) * pct * TICK_HZ) / 100 / SUB;
  out.speed = clampSpeed(tilesPerSec);
  readCompanions(world, hero, registry, out);
  return true;
}

export function clampSpeed(tilesPerSec: number): number {
  if (!(tilesPerSec >= SPEED_MIN)) return SPEED_MIN;
  const s = tilesPerSec > SPEED_MAX ? SPEED_MAX : tilesPerSec;
  return Math.round(s * 10) / 10;
}

export function samePose(a: PoseState, b: PoseState): boolean {
  if (a.x !== b.x || a.y !== b.y || a.n !== b.n) return false;
  if (a.speed !== b.speed || a.appearance !== b.appearance || a.tag !== b.tag) return false;
  if (a.cn !== b.cn) return false;
  for (let i = 0; i < a.n; i++) {
    if ((a.px[i] ?? 0) !== (b.px[i] ?? 0) || (a.py[i] ?? 0) !== (b.py[i] ?? 0)) return false;
  }
  for (let i = 0; i < a.cn; i++) {
    if (
      a.cAppearance[i] !== b.cAppearance[i] ||
      a.cName[i] !== b.cName[i] ||
      a.cdx[i] !== b.cdx[i] ||
      a.cdy[i] !== b.cdy[i]
    ) {
      return false;
    }
  }
  return true;
}

/** Copies `src` into `dst` (no allocation). */
export function copyPose(src: PoseState, dst: PoseState): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.n = src.n;
  dst.speed = src.speed;
  dst.appearance = src.appearance;
  dst.tag = src.tag;
  dst.level = src.level;
  dst.classId = src.classId;
  for (let i = 0; i < src.n; i++) {
    dst.px[i] = src.px[i] ?? 0;
    dst.py[i] = src.py[i] ?? 0;
  }
  dst.cn = src.cn;
  for (let i = 0; i < src.cn; i++) {
    dst.cAppearance[i] = src.cAppearance[i] ?? "unit.hero";
    dst.cName[i] = src.cName[i] ?? "";
    dst.cdx[i] = src.cdx[i] ?? 0;
    dst.cdy[i] = src.cdy[i] ?? 0;
  }
}

/**
 * Builds the wire update (allocates; called at most 4 times a second).
 * `withCompanions` decides whether the update carries a companions field: the
 * caller passes true while the party has companions to report, or when the
 * server still holds a non-empty list (the field then sends [] once, to clear
 * it). Solo traffic therefore carries no field at all.
 */
export function toPoseUpdate(s: PoseState, withCompanions: boolean): PoseUpdate {
  const path: { x: number; y: number }[] = [];
  for (let i = 0; i < s.n; i++) path.push({ x: s.px[i] ?? 0, y: s.py[i] ?? 0 });
  const update: PoseUpdate = {
    pos: { x: s.x, y: s.y },
    path,
    speed: s.speed,
    appearance: s.appearance,
    tag: s.tag,
  };
  if (withCompanions) {
    const companions: CompanionPose[] = [];
    for (let i = 0; i < s.cn; i++) {
      companions.push({
        appearance: s.cAppearance[i] ?? "unit.hero",
        name: s.cName[i] ?? "",
        dx: s.cdx[i] ?? 0,
        dy: s.cdy[i] ?? 0,
      });
    }
    update.companions = companions;
  }
  return update;
}
