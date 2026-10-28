/**
 * Arena state shapes and build clamping (OWNER: T-arena-sim). Pure data:
 * everything here is plain JSON so it can live in components and snapshots.
 */
import type { ArenaSkillKind, ArenaWinner } from "@gamez/protocol";
import { ARENA_MAX_SKILLS } from "./constants.ts";

export const ARENA_SKILL_KINDS: readonly ArenaSkillKind[] = [
  "strike",
  "projectile",
  "nova",
  "heal",
  "shield",
];

/** Component of a fighter entity (name is namespaced, see AGENTS.md §7). */
export const FIGHTER_COMPONENT = "arena.fighter";
/** Resource: the two fighter entities of the running match. */
export const MATCH_RESOURCE = "arena.match";
/** Resource: the outcome, set once the fight ends. */
export const RESULT_RESOURCE = "arena.result";

/** One skill of a clamped build (ranges already applied). */
export interface SkillInit {
  id: string;
  name: string;
  kind: ArenaSkillKind;
  /** Percent of weapon damage (damage kinds), heal % or shield % of max hp. */
  power: number;
  /** Cooldown in arena ticks. */
  cooldown: number;
  /** Reach in tiles (0 for self-cast kinds). */
  range: number;
}

/** A build after clamping: every number is inside its ArenaBuild range. */
export interface ClampedBuild {
  name: string;
  classId: string;
  maxHp: number;
  dmgMin: number;
  dmgMax: number;
  attackRate: number;
  armor: number;
  resist: number;
  critPct: number;
  moveSpeed: number;
  skills: SkillInit[];
}

export interface SkillState extends SkillInit {
  /** Tick from which the skill can be used again. */
  readyAt: number;
}

export interface FighterState {
  side: "attacker" | "defender";
  /** Position in tenths of a tile (0..200). */
  x: number;
  hp: number;
  maxHp: number;
  shield: number;
  dmgMin: number;
  dmgMax: number;
  armor: number;
  resist: number;
  critPct: number;
  /** Tenths of a tile per tick (= tiles per second at 10 Hz). */
  moveSpeed: number;
  /** Ticks between basic attacks: round(100 / attackRate). */
  interval: number;
  /** Tick from which a basic attack is allowed. */
  nextBasic: number;
  skills: SkillState[];
}

export interface MatchRefs {
  attacker: number;
  defender: number;
}

export interface ArenaResult {
  winner: ArenaWinner;
  ticks: number;
}

/** Integer in [lo, hi]; anything that is not a finite number becomes lo. */
export function clampInt(v: unknown, lo: number, hi: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : lo;
  return Math.min(hi, Math.max(lo, n));
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** Reach in tiles per skill kind (wave-C.md §6.2). */
export function rangeRange(kind: ArenaSkillKind): [number, number] {
  switch (kind) {
    case "strike":
      return [1, 2];
    case "projectile":
    case "nova":
      return [2, 8];
    default:
      return [0, 0];
  }
}

function clampSkill(v: unknown): SkillInit | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  const kind = ARENA_SKILL_KINDS.find((k) => k === s.kind);
  if (!kind) return null;
  const [lo, hi] = rangeRange(kind);
  return {
    id: text(s.id, 80),
    name: text(s.name, 40),
    kind,
    power: clampInt(s.power, 1, 1000),
    cooldown: clampInt(s.cooldown, 1, 400),
    range: clampInt(s.range, lo, hi),
  };
}

/**
 * Clamps an untrusted ArenaBuild-shaped value into its ranges. Returns null
 * only when the value is not an object; absurd numbers are clamped, and
 * skills with an unknown kind are dropped.
 */
export function clampBuild(v: unknown): ClampedBuild | null {
  if (typeof v !== "object" || v === null) return null;
  const b = v as Record<string, unknown>;
  const dmgMin = clampInt(b.dmgMin, 1, 10_000);
  const rawSkills = Array.isArray(b.skills) ? b.skills.slice(0, ARENA_MAX_SKILLS) : [];
  const skills: SkillInit[] = [];
  for (const raw of rawSkills) {
    const s = clampSkill(raw);
    if (s) skills.push(s);
  }
  return {
    name: text(b.name, 40),
    classId: text(b.classId, 80),
    maxHp: clampInt(b.maxHp, 1, 1_000_000),
    dmgMin,
    dmgMax: clampInt(b.dmgMax, dmgMin, 10_000),
    attackRate: clampInt(b.attackRate, 1, 100),
    armor: clampInt(b.armor, 0, 100_000),
    resist: clampInt(b.resist, 0, 75),
    critPct: clampInt(b.critPct, 0, 75),
    moveSpeed: clampInt(b.moveSpeed, 1, 8),
    skills,
  };
}
