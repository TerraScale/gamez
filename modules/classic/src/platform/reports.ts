/**
 * Read-model rows of a verified classic instance (wave-B.md §4). OWNER:
 * T-leaderboards. The row shapes are fixed (projections.ts and migration 0002
 * map them).
 *
 * Pure and deterministic; never throws on partial/old worlds (no hero yet,
 * missing wave A resources): returns [] or defaults instead.
 */
import type { FrozenRegistry, InstanceReport, World } from "@gamez/kernel";
import { Hero, Level } from "../components.ts";
import {
  heroOf,
  RES,
  type DungeonState,
  type RiftRecord,
  type RiftState,
  type RunStats,
} from "../resources.ts";

/** { table: "classic_hero", key: "hero" } once the hero exists. */
export interface ClassicHeroReport {
  heroName: string;
  classId: string;
  level: number;
  xp: number;
  /** Deepest dungeon depth reached (DungeonState / waypoints / RunStats). */
  deepestDepth: number;
  /** RiftState.best (completed runs only); 0 when none. */
  riftBestLevel: number;
  riftBestScore: number;
  /** Sim ticks played (sim tick of the world is fine). */
  playTicks: number;
  kills: number;
  deaths: number;
}

/** { table: "leaderboard_rift", key: `run:${record.run}` } for each RiftState.history record. */
export interface ClassicRiftReport {
  heroName: string;
  classId: string;
  heroLevel: number;
  riftLevel: number;
  score: number;
  ticks: number;
  deaths: number;
  completed: boolean;
  run: number;
  endTick: number;
}

export const REPORT_TABLES = { hero: "classic_hero", rift: "leaderboard_rift" } as const;

/** Non-negative integer from an arbitrary value (0 for anything else). */
function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Rift row key: the record's own worldSeed keeps a new hero's runs from
 * overwriting an old hero's (run ids restart per world).
 */
export function riftKey(worldSeed: number, run: number): string {
  return `run:${int(worldSeed)}:${int(run)}`;
}

function riftRow(r: RiftRecord): InstanceReport {
  const data: ClassicRiftReport = {
    heroName: text(r.heroName),
    classId: text(r.classId),
    heroLevel: int(r.heroLevel),
    riftLevel: int(r.level),
    score: int(r.score),
    ticks: int(r.ticks),
    deaths: int(r.deaths),
    completed: r.completed === true,
    run: int(r.run),
    endTick: int(r.endTick),
  };
  return { table: REPORT_TABLES.rift, key: riftKey(r.worldSeed, r.run), data: { ...data } };
}

/**
 * Hero row plus one rift row per RiftState.history record (newest first).
 * RiftState.best is also emitted when it has scrolled out of the history, so
 * the rift board keeps a best run that is older than the last 10 runs.
 */
export function classicReports(world: World, _registry: FrozenRegistry): InstanceReport[] {
  const hero = heroOf(world);
  if (hero === 0) return [];
  const heroComp = world.get(hero, Hero);
  const levelComp = world.get(hero, Level);
  const dungeon = world.getResource<DungeonState>(RES.dungeon);
  const stats = world.getResource<RunStats>(RES.stats);
  const rift = world.getResource<RiftState>(RES.rift);

  const best = rift?.best ?? null;
  const bestCompleted = best !== null && best.completed === true;

  const heroData: ClassicHeroReport = {
    heroName: text(heroComp?.name),
    classId: text(heroComp?.classId),
    level: int(levelComp?.level),
    xp: int(levelComp?.xp),
    deepestDepth: int(dungeon?.deepest),
    riftBestLevel: bestCompleted ? int(best.level) : 0,
    riftBestScore: bestCompleted ? int(best.score) : 0,
    playTicks: int(stats?.ticksPlayed),
    kills: int(stats?.kills),
    deaths: int(stats?.deaths),
  };

  const out: InstanceReport[] = [{ table: REPORT_TABLES.hero, key: "hero", data: { ...heroData } }];

  const history = rift?.history ?? [];
  const seen = new Set<number>();
  for (const r of history) {
    seen.add(int(r.run));
    out.push(riftRow(r));
  }
  if (best !== null && !seen.has(int(best.run))) out.push(riftRow(best));
  return out;
}
