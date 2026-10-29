/**
 * Read-model rows of a verified classic instance (wave-B.md §4). OWNER:
 * T-leaderboards. The row shapes are fixed (projections.ts and migration 0002
 * map them).
 *
 * Pure and deterministic; never throws on partial/old worlds (no hero yet,
 * missing wave A resources): returns [] or defaults instead.
 */
import type { Entity, FrozenRegistry, InstanceReport, World } from "@gamez/kernel";
import { Hero, Level, PartyMember } from "../components.ts";
import { founderOf, partyMembers } from "../party/shared.ts";
import {
  RES,
  type DungeonState,
  type RiftRecord,
  type RiftState,
  type RunStats,
} from "../resources.ts";

/**
 * { table: "classic_hero", key } once per party member (docs/design/party.md
 * §7.4): key "hero" for the founder (existing rows keep it) and
 * `hero:<PartyMember.uid>` for the others. Solo: the single "hero" row.
 */
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

/** The row key of a member: "hero" for the founder, else `hero:<uid>` (slot when it has no PartyMember). */
export function heroKey(
  founder: Entity,
  e: Entity,
  member: { readonly uid: number } | undefined,
  slot: number,
): string {
  if (e === founder) return "hero";
  return member ? `hero:${int(member.uid)}` : `hero:s${int(slot)}`;
}

/**
 * One hero row per party member plus one rift row per RiftState.history
 * record (newest first). RiftState.best is also emitted when it has scrolled
 * out of the history, so the rift board keeps a best run that is older than
 * the last 10 runs. Kills and deaths come from PartyMember when present, else
 * RunStats (solo); depth, rifts and play time are party-wide.
 */
export function classicReports(world: World, _registry: FrozenRegistry): InstanceReport[] {
  const members = partyMembers(world);
  if (members.length === 0) return [];
  const founder = founderOf(world);
  const dungeon = world.getResource<DungeonState>(RES.dungeon);
  const stats = world.getResource<RunStats>(RES.stats);
  const rift = world.getResource<RiftState>(RES.rift);

  const best = rift?.best ?? null;
  const bestCompleted = best !== null && best.completed === true;

  const out: InstanceReport[] = [];
  members.forEach((e, slot) => {
    const heroComp = world.get(e, Hero);
    const levelComp = world.get(e, Level);
    const member = world.get(e, PartyMember);
    const data: ClassicHeroReport = {
      heroName: text(heroComp?.name),
      classId: text(heroComp?.classId),
      level: int(levelComp?.level),
      xp: int(levelComp?.xp),
      deepestDepth: int(dungeon?.deepest),
      riftBestLevel: bestCompleted ? int(best.level) : 0,
      riftBestScore: bestCompleted ? int(best.score) : 0,
      playTicks: int(stats?.ticksPlayed),
      kills: int(member ? member.kills : stats?.kills),
      deaths: int(member ? member.deaths : stats?.deaths),
    };
    out.push({
      table: REPORT_TABLES.hero,
      key: heroKey(founder, e, member, slot),
      data: { ...data },
    });
  });

  const history = rift?.history ?? [];
  const seen = new Set<number>();
  for (const r of history) {
    seen.add(int(r.run));
    out.push(riftRow(r));
  }
  if (best !== null && !seen.has(int(best.run))) out.push(riftRow(best));
  return out;
}
