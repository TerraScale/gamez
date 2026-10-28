/**
 * Classic hero -> ArenaBuild (wave-C.md §6.2). OWNER: T-arena-sim.
 * Pure, deterministic, never throws (returns null without a hero). Reads the
 * verified world: class, level, CombatStats/HeroStats (max hp, weapon damage,
 * attack speed, armor, resists, crit), Mover (base speed), the skill bar
 * (mapped to ArenaSkill kinds: melee/arc/dash -> "strike", projectile/chain ->
 * "projectile", nova/aoeTarget/pulse -> "nova", heals -> "heal", buffs ->
 * "shield"; at most 4, bar order), the class appearance and a gear score.
 * Every number is clamped to the ArenaBuild ranges (protocol economy.ts).
 * Returned without accountId/displayName/sourceHash (the host fills them).
 *
 * Conversions (classic runs at 20 Hz, the arena at 10 Hz, 256 sub per tile):
 *   attackRate  = attacks per 10 s = 200 x attackSpeed / (100 x weapon attackTicks)
 *   moveSpeed   = Mover.speed x CombatStats.moveSpeed % tiles per second
 *   skill cooldown = ceil(classic cooldown / 2), at least 10 arena ticks (1 s)
 *   skill range  = tiles, clamped to the kind's range (wave-C.md §6.2)
 */
import type { FrozenRegistry, World } from "@gamez/kernel";
import type { ArenaBuild, ArenaSkill, ArenaSkillKind } from "@gamez/protocol";
import { CombatStats, HeroStats, Hero, Level, Mover, SkillBar, SkillBook } from "../components.ts";
import { KIND, type ClassProto, type SkillProto } from "../types.ts";
import { heroOf } from "../resources.ts";

export type ClassicArenaBuild = Omit<ArenaBuild, "accountId" | "displayName" | "sourceHash">;

/** Basic weapon attack: not a skill in the arena (the build's damage covers it). */
const BASIC_SKILL = "classic.skill.attack";
const MAX_SKILLS = 4;
const CLASSIC_HZ = 20;
const SUB_PER_TILE = 256;
const MIN_SKILL_COOLDOWN = 10;

function clampInt(v: number, lo: number, hi: number): number {
  const n = Number.isFinite(v) ? Math.floor(v) : lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Arena skill kind of a hero skill, or null when the arena has no equivalent. */
export function arenaKindOf(p: SkillProto): ArenaSkillKind | null {
  if (p.heal) return "heal";
  if (p.buff) return "shield";
  switch (p.shape) {
    case "melee":
    case "arc":
    case "dash":
      return "strike";
    case "projectile":
    case "chain":
      return "projectile";
    case "nova":
    case "aoeTarget":
    case "pulse":
      return "nova";
    default:
      return null;
  }
}

/** Power of a skill at a rank: percent of weapon damage, heal %, or shield %. Null when it does nothing in the arena. */
function powerOf(
  p: SkillProto,
  kind: ArenaSkillKind,
  rank: number,
  avgWeapon: number,
): number | null {
  const up = rank - 1;
  if (kind === "heal") return p.heal ? p.heal.pct + p.heal.pctPerRank * up : null;
  if (kind === "shield") return p.buff ? p.buff.power + p.buff.powerPerRank * up : null;
  if (p.weaponPct > 0) return p.weaponPct + p.weaponPctPerRank * up;
  if (p.damage) {
    // Flat spell damage as a percent of the hero's average weapon damage (elements are not modelled).
    const avgFlat =
      (p.damage.min + p.damage.max) / 2 + ((p.damage.minPerRank + p.damage.maxPerRank) / 2) * up;
    return Math.round((avgFlat * 100) / Math.max(1, avgWeapon));
  }
  return null;
}

/** Reach in tiles for a kind (clamped to the kind's range). */
function rangeOf(p: SkillProto, kind: ArenaSkillKind): number {
  if (kind === "heal" || kind === "shield") return 0;
  if (kind === "strike") return clampInt(Math.round(p.range / SUB_PER_TILE), 1, 2);
  const reach = kind === "projectile" ? (p.projectile?.maxRange ?? p.range) : (p.radius ?? p.range);
  return clampInt(Math.round(reach / SUB_PER_TILE), 2, 8);
}

export function classicArenaBuild(
  world: World,
  registry: FrozenRegistry,
): ClassicArenaBuild | null {
  const hero = heroOf(world);
  if (hero === 0) return null;
  const h = world.get(hero, Hero);
  const cs = world.get(hero, CombatStats);
  const hs = world.get(hero, HeroStats);
  if (!h || !cs || !hs) return null;
  const cls = registry.get<ClassProto>(KIND.class, h.classId);
  if (!cls) return null;

  const level = clampInt(world.get(hero, Level)?.level ?? 1, 1, 1000);
  const dmgMin = clampInt(cs.dmgMin, 1, 10_000);
  const dmgMax = clampInt(Math.max(cs.dmgMin, cs.dmgMax), dmgMin, 10_000);
  const avgWeapon = (dmgMin + dmgMax) / 2;
  const maxHp = clampInt(hs.lifeMax, 1, 1_000_000);
  const baseTicks = Math.max(2, cs.attackTicks);
  // Attacks per 10 s (200 classic ticks): 200 x speed / (100 x base ticks).
  const attackRate = clampInt(Math.round((200 * cs.attackSpeed) / (100 * baseTicks)), 1, 100);
  const armor = clampInt(cs.armor, 0, 100_000);
  const resist = clampInt(
    Math.floor((cs.resFire + cs.resCold + cs.resLightning + cs.resPoison) / 4),
    0,
    75,
  );
  const critPct = clampInt(cs.critPct, 0, 75);
  const speedSub = Math.floor(
    ((world.get(hero, Mover)?.speed ?? cls.moveSpeed) * cs.moveSpeed) / 100,
  );
  const moveSpeed = clampInt(Math.round((speedSub * CLASSIC_HZ) / SUB_PER_TILE), 1, 8);

  const bar = world.get(hero, SkillBar)?.slots ?? [];
  const ranks = world.get(hero, SkillBook)?.ranks ?? [];
  const skills: ArenaSkill[] = [];
  for (const id of bar) {
    if (skills.length >= MAX_SKILLS) break;
    if (!id || id === BASIC_SKILL) continue;
    const p = registry.get<SkillProto>(KIND.skill, id);
    if (!p || p.users !== "hero") continue;
    const kind = arenaKindOf(p);
    if (!kind) continue;
    const rank = Math.max(1, ranks.find((r) => r.skill === id)?.rank ?? 1);
    const power = powerOf(p, kind, rank, avgWeapon);
    if (power === null) continue;
    skills.push({
      id,
      name: p.name.slice(0, 40),
      kind,
      power: clampInt(power, 1, 1000),
      cooldown: clampInt(Math.max(MIN_SKILL_COOLDOWN, Math.ceil(p.cooldown / 2)), 1, 400),
      range: rangeOf(p, kind),
    });
  }

  // Gear score for matchmaking display only: damage per 10 s, plus armor and a tenth of max hp.
  const power = clampInt(
    Math.floor((avgWeapon * attackRate) / 10) + armor + Math.floor(maxHp / 10),
    0,
    1_000_000,
  );

  return {
    mode: "classic",
    classId: h.classId,
    level,
    name: h.name.slice(0, 40),
    appearance: cls.appearance.startsWith("unit.hero") ? cls.appearance : "unit.hero",
    maxHp,
    dmgMin,
    dmgMax,
    attackRate,
    armor,
    resist,
    critPct,
    moveSpeed,
    skills,
    power,
  };
}
