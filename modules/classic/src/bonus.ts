/**
 * BonusStats helpers (CONTRACT, implemented; wave A). The BonusStats
 * component holds extra hero stat mods and skill modifiers per source module
 * (talents today). Writers replace only their own entry with setBonusSource;
 * classic.progression.stats adds bonusMods() to the hero's stat totals and
 * classic.combat reads skillModsOf() when a hero casts.
 */
import type { Entity, FrozenRegistry, World } from "@gamez/kernel";
import { BonusStats, type BonusSource } from "./components.ts";
import { emptySkillMods, sumSkillMods, type SkillModTotals } from "./rules.ts";
import { KIND, type SkillModifier, type SkillProto, type StatMod } from "./types.ts";

/**
 * Replaces the entry of `source` on `entity` (creates the component when
 * missing; an entry with no mods and no skills is removed). Entries stay
 * sorted by source. Writes only when something changed.
 */
export function setBonusSource(
  world: World,
  entity: Entity,
  source: string,
  mods: readonly StatMod[],
  skills: readonly SkillModifier[],
): void {
  const cur = world.get(entity, BonusStats);
  const list: BonusSource[] = cur ? cur.sources.filter((s) => s.source !== source) : [];
  if (mods.length > 0 || skills.length > 0) {
    list.push({
      source,
      mods: mods.map((m) => ({ stat: m.stat, value: m.value })),
      skills: skills.map((m) => ({ skill: m.skill, field: m.field, value: m.value })),
    });
  }
  list.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  if (cur && JSON.stringify(cur.sources) === JSON.stringify(list)) return;
  if (!cur && list.length === 0) return;
  if (cur) world.update(entity, BonusStats, { sources: list });
  else world.add(entity, BonusStats, { sources: list });
}

/** Every stat mod of every source (source order). Empty without the component. */
export function bonusMods(world: World, entity: Entity): StatMod[] {
  const b = world.get(entity, BonusStats);
  if (!b) return [];
  const out: StatMod[] = [];
  for (const s of b.sources) out.push(...s.mods);
  return out;
}

/** Every skill modifier of every source (source order). */
export function bonusSkillMods(world: World, entity: Entity): SkillModifier[] {
  const b = world.get(entity, BonusStats);
  if (!b) return [];
  const out: SkillModifier[] = [];
  for (const s of b.sources) out.push(...s.skills);
  return out;
}

/**
 * Totals of the skill modifiers that apply to `skillId` for `entity`
 * (all zero for units without BonusStats, e.g. monsters).
 */
export function skillModsOf(
  world: World,
  registry: FrozenRegistry,
  entity: Entity,
  skillId: string,
): SkillModTotals {
  const b = world.get(entity, BonusStats);
  if (!b || b.sources.length === 0) return emptySkillMods();
  const skill = registry.get<SkillProto>(KIND.skill, skillId);
  if (!skill) return emptySkillMods();
  return sumSkillMods(bonusSkillMods(world, entity), skillId, skill);
}
