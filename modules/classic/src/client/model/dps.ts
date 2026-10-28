/**
 * Wave A HUD section: damage per second of the hero's bar skills, effective life and the stat
 * sources (docs/design/wave-A.md §10.3). Pure: reads the world and the registry, never writes.
 *
 * The numbers are expectations for one target and one hit per cast:
 * - average hit: rules.rollSkillDamage at the midpoint of every roll (its rng = null path),
 *   x the skill modifier damagePct, then crit: chance x critMult (combat rolls crit per hit);
 * - casts per second: 20 / the cast ticks of combat (combat/orders castTiming, with the skill
 *   modifier speedPct added to the speed stat the skill scales with), capped by the effective
 *   cooldown (combat starts the cooldown when the cast starts, so the cycle is the larger of both);
 * - effective life: lifeMax against a physical hit of a level-matched monster (physReduction of
 *   the hero's armor), then block (capped like combat, BLOCK_CAP).
 */
import type { FrozenRegistry } from "@gamez/kernel";
import {
  BonusStats,
  CombatStats,
  Equipment,
  HeroStats,
  SkillBar,
  SkillBook,
  type CombatStatsValue,
} from "../../components.ts";
import { castTiming } from "../../combat/orders.ts";
import { BLOCK_CAP } from "../../combat/resolve.ts";
import { bonusSkillMods, skillModsOf } from "../../bonus.ts";
import { pct } from "../../fixed.ts";
import {
  addItemStats,
  effectiveCooldown,
  effectiveManaCost,
  effectiveRank,
  physReduction,
  rollSkillDamage,
  setBonusMods,
  setPieceCounts,
  type StatTotals,
} from "../../rules.ts";
import {
  EQUIP_SLOTS,
  KIND,
  type AttrBlock,
  type Damage,
  type ItemInstance,
  type SetProto,
  type SkillModifier,
  type SkillProto,
  type StatMod,
} from "../../types.ts";
import type { DpsSkillView, DpsView } from "../contract.ts";
import type { ModelContext } from "./context.ts";
import { statText } from "../describe.ts";
import { fmtSigned } from "../hud/format.ts";

const TICKS_PER_SECOND = 20;
const SOURCE_NAMES = ["Items", "Sets", "Talents", "Buffs"] as const;

/** Expected damage of one hit: the midpoint roll, the skill's damage modifier and the crit chance. */
export function expectedHit(
  skill: SkillProto,
  rank: number,
  stats: CombatStatsValue,
  attrs: AttrBlock,
  damagePct: number,
): number {
  const roll: Damage = rollSkillDamage(skill, rank, stats, attrs, null);
  let base = 0;
  for (const e of ["phys", "fire", "cold", "lightning", "poison"] as const) {
    base += pct(roll[e], Math.max(0, 100 + damagePct));
  }
  const crit = Math.min(100, Math.max(0, stats.critPct)) / 100;
  const mult = stats.critMult / 100;
  return Math.round(base * (1 + crit * (mult - 1)));
}

/** Effective life against a physical hit of a level-matched monster (armor, then block). */
export function effectiveLifeOf(
  lifeMax: number,
  armor: number,
  level: number,
  blockPct: number,
): number {
  const reduction = physReduction(armor, Math.max(1, level));
  const afterArmor = Math.floor((lifeMax * 100) / Math.max(1, 100 - reduction));
  const block = Math.min(BLOCK_CAP, Math.max(0, blockPct));
  return Math.floor((afterArmor * 100) / (100 - block));
}

/** Text of one skill modifier for the sources list ("Cleave: +10% damage"). */
function skillModText(registry: FrozenRegistry, mod: SkillModifier): string {
  const who =
    mod.skill === "*"
      ? "All skills"
      : mod.skill.startsWith("tag:")
        ? `${mod.skill.slice(4)} skills`
        : (registry.get<SkillProto>(KIND.skill, mod.skill)?.name ?? mod.skill);
  const v = fmtSigned(mod.value);
  const what = (() => {
    switch (mod.field) {
      case "damagePct":
        return `${v}% damage`;
      case "manaCostPct":
        return `${v}% mana cost`;
      case "cooldownPct":
        return `${v}% cooldown`;
      case "speedPct":
        return `${v}% speed`;
      case "radiusPct":
        return `${v}% radius`;
      case "durationPct":
        return `${v}% duration`;
      case "extraProjectiles":
        return `${v} projectiles`;
      case "extraPierce":
        return `${v} pierce`;
      case "extraBounces":
        return `${v} bounces`;
      case "extraSummons":
        return `${v} summons`;
    }
  })();
  return `${who}: ${what}`;
}

function statLines(mods: readonly StatMod[]): string[] {
  return mods.map((m) => statText(m.stat, m.value));
}

/** Items: every equipped item's stats without the set bonuses (those are listed under Sets). */
function itemLines(registry: FrozenRegistry, items: ItemInstance[]): string[] {
  const all: StatTotals = addItemStats(registry, items);
  for (const m of setBonusMods(registry, items)) all[m.stat] = (all[m.stat] ?? 0) - m.value;
  const out: string[] = [];
  for (const key of Object.keys(all).sort()) {
    const v = all[key as keyof StatTotals] ?? 0;
    if (v !== 0) out.push(statText(key as StatMod["stat"], v));
  }
  return out;
}

/** Sets: one line per equipped set, then the bonuses it reaches. */
function setLines(registry: FrozenRegistry, items: ItemInstance[]): string[] {
  const out: string[] = [];
  for (const { set, pieces } of setPieceCounts(registry, items)) {
    const proto = registry.get<SetProto>(KIND.set, set);
    const name = proto?.name ?? set;
    out.push(`${name}: ${pieces} ${pieces === 1 ? "piece" : "pieces"}`);
    for (const b of proto?.bonuses ?? []) {
      if (pieces >= b.count) out.push(`${name} ${b.count}: ${statLines(b.mods).join(", ")}`);
    }
  }
  return out;
}

/**
 * Damage per second of the bar skills, effective life and the stat sources; null without a hero
 * with combat stats.
 */
export function buildDpsView(c: ModelContext): DpsView | null {
  const { world, registry, hero, heroView } = c;
  if (hero === 0 || !heroView) return null;
  const stats = world.get(hero, CombatStats);
  const sheet = world.get(hero, HeroStats);
  if (!stats || !sheet) return null;
  const bar = world.get(hero, SkillBar);
  const book = world.get(hero, SkillBook);

  const skills: DpsSkillView[] = [];
  for (const id of bar?.slots ?? []) {
    if (id === null) continue;
    const skill = registry.get<SkillProto>(KIND.skill, id);
    const bookRank = book?.ranks.find((r) => r.skill === id)?.rank ?? 0;
    if (!skill || bookRank <= 0) continue;
    const rank = effectiveRank(skill, bookRank, sheet.allSkills);
    const mods = skillModsOf(world, registry, hero, id);
    const speed = {
      attackTicks: stats.attackTicks,
      attackSpeed: stats.attackSpeed + (skill.speedStat === "attack" ? mods.speedPct : 0),
      castSpeed: stats.castSpeed + (skill.speedStat === "cast" ? mods.speedPct : 0),
    };
    const [castTicks] = castTiming(skill, speed, 0);
    const cooldown = effectiveCooldown(skill, mods);
    const cycle = Math.max(1, castTicks, cooldown);
    const perSecond = TICKS_PER_SECOND / cycle;
    const avgHit = expectedHit(skill, rank, stats, sheet.attrs, mods.damagePct);
    const manaCost = effectiveManaCost(skill, rank, mods);
    skills.push({
      skill: id,
      name: skill.name,
      avgHit,
      perSecond: Math.round(perSecond * 100) / 100,
      dps: Math.round(avgHit * perSecond),
      manaPerSecond: Math.round(manaCost * perSecond * 10) / 10,
    });
  }
  const best = skills.reduce((m, s) => Math.max(m, s.dps), 0);

  const items: ItemInstance[] = [];
  const equipment = world.get(hero, Equipment);
  for (const slot of EQUIP_SLOTS) {
    const it = equipment?.[slot];
    if (it) items.push(it);
  }
  const talentSources = world.get(hero, BonusStats)?.sources ?? [];
  const talentLines: string[] = [];
  for (const s of talentSources) talentLines.push(...statLines(s.mods));
  for (const m of bonusSkillMods(world, hero)) talentLines.push(skillModText(registry, m));
  const buffLines = heroView.statuses
    .filter((s) => s.kind === "buff")
    .map((s) => `${s.name} (${s.secondsLeft}s)`);
  const perSource: string[][] = [
    itemLines(registry, items),
    setLines(registry, items),
    talentLines,
    buffLines,
  ];

  return {
    skills,
    best,
    effectiveLife: effectiveLifeOf(heroView.lifeMax, stats.armor, heroView.level, stats.blockPct),
    sources: SOURCE_NAMES.map((source, i) => ({ source, lines: perSource[i] ?? [] })),
  };
}
