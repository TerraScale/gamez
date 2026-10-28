/**
 * Human-readable text for items, stats and skills (docs/design/classic.md
 * §13). Pure functions over prototypes and plain values: used by the HUD model
 * (ItemView.lines, SkillView.description) and tests. The STAT_TEXT table is
 * exhaustive over StatId, so a new stat cannot ship without a line.
 */
import type { FrozenRegistry } from "@gamez/kernel";
import { skillManaCost } from "../rules.ts";
import {
  KIND,
  type ItemBaseProto,
  type ItemInstance,
  type SkillProto,
  type StatId,
} from "../types.ts";
import { fmtDuration } from "./hud/format.ts";

type Fmt = (v: number) => string;

const signed = (v: number): string => (v > 0 ? `+${v}` : `${v}`);
const flat =
  (text: string): Fmt =>
  (v) =>
    `${signed(v)} ${text}`;
const pctOf =
  (text: string): Fmt =>
  (v) =>
    `${signed(v)}% ${text}`;

/** One line per StatId. Values are the raw integers stored in ItemInstance.mods. */
export const STAT_TEXT: Record<StatId, Fmt> = {
  str: flat("to Strength"),
  dex: flat("to Dexterity"),
  mag: flat("to Magic"),
  vit: flat("to Vitality"),
  allAttrs: flat("to All Attributes"),
  life: flat("to Life"),
  mana: flat("to Mana"),
  lifePct: pctOf("to Maximum Life"),
  manaPct: pctOf("to Maximum Mana"),
  lifeRegen: (v) => `${signed(Math.round(v) / 10)} Life per second`,
  manaRegenPct: pctOf("Mana Regeneration"),
  armor: flat("to Armor"),
  armorPct: pctOf("Armor"),
  toHit: flat("to Accuracy"),
  toHitPct: pctOf("Accuracy"),
  dmgMin: flat("to Minimum Damage"),
  dmgMax: flat("to Maximum Damage"),
  dmgPct: pctOf("Damage"),
  spellPct: pctOf("Spell Damage"),
  fireDmg: flat("Fire Damage"),
  coldDmg: flat("Cold Damage"),
  lightningDmg: flat("Lightning Damage"),
  poisonDmg: flat("Poison Damage"),
  attackSpeed: pctOf("Attack Speed"),
  castSpeed: pctOf("Cast Speed"),
  moveSpeed: pctOf("Movement Speed"),
  critPct: pctOf("Critical Hit Chance"),
  critDmgPct: pctOf("Critical Damage"),
  blockPct: pctOf("Block Chance"),
  resFire: pctOf("Fire Resistance"),
  resCold: pctOf("Cold Resistance"),
  resLightning: pctOf("Lightning Resistance"),
  resPoison: pctOf("Poison Resistance"),
  resAll: pctOf("to All Resistances"),
  lifeSteal: pctOf("Life Stolen per Hit"),
  manaSteal: pctOf("Mana Stolen per Hit"),
  lifeOnKill: flat("Life on Kill"),
  manaOnKill: flat("Mana on Kill"),
  thorns: flat("Thorns"),
  magicFind: pctOf("Magic Find"),
  goldFind: pctOf("Gold Find"),
  lightRadius: flat("Light Radius"),
  allSkills: flat("to All Skills"),
  potionPct: pctOf("Potion Effectiveness"),
};

/** Text of one stat line, e.g. statText("life", 12) = "+12 to Life". */
export function statText(stat: StatId, value: number): string {
  const fmt = STAT_TEXT[stat];
  return fmt ? fmt(value) : `${signed(value)} ${stat}`;
}

const POTION_LABEL = { life: "Life", mana: "Mana", rejuv: "Life and Mana" } as const;

/** "Restores 50 Life" / "Restores 35% Life and Mana". */
export function potionText(base: ItemBaseProto): string | null {
  const p = base.potion;
  if (!p) return null;
  const what = POTION_LABEL[p.kind];
  return p.amount > 0 ? `Restores ${p.amount} ${what}` : `Restores ${p.pct}% ${what}`;
}

/**
 * Lines of an item, base first: damage, armor, block, potion effect, base
 * implicits, rolled mods, then requirements. Unknown bases give the name only.
 */
export function itemLines(registry: FrozenRegistry, item: ItemInstance): string[] {
  const base = registry.get<ItemBaseProto>(KIND.itemBase, item.base);
  if (!base) return [item.name];
  const lines: string[] = [];
  if (base.dmgMin !== undefined && base.dmgMax !== undefined) {
    lines.push(`${base.dmgMin}-${base.dmgMax} damage`);
  }
  if (base.armor !== undefined && base.armor > 0) lines.push(`${base.armor} Armor`);
  if (base.block !== undefined && base.block > 0) lines.push(`${base.block}% Block Chance`);
  const potion = potionText(base);
  if (potion !== null) lines.push(potion);
  for (const m of base.implicit) lines.push(statText(m.stat, m.value));
  for (const m of item.mods) lines.push(statText(m.stat, m.value));
  if (base.reqLevel > 1) lines.push(`Requires level ${base.reqLevel}`);
  if (base.reqStr > 0) lines.push(`Requires ${base.reqStr} Strength`);
  if (base.reqDex > 0) lines.push(`Requires ${base.reqDex} Dexterity`);
  return lines;
}

/** Ticks (20 Hz) as a duration, the one format used everywhere ("10s", "0.3s"). */
export function ticksToSeconds(ticks: number): string {
  return fmtDuration(ticks);
}

/**
 * Detail lines of a skill at `rank`, without the description, mana and
 * cooldown (those are shown once, by the stat line). Empty for plain skills.
 */
export function skillDetailLines(skill: SkillProto, rank: number): string[] {
  const r = Math.max(1, rank);
  const lines: string[] = [];
  if (skill.range > 0) lines.push(`Range: ${(skill.range / 256).toFixed(1)} tiles`);
  if (skill.weaponPct > 0) {
    lines.push(`Weapon damage: ${skill.weaponPct + skill.weaponPctPerRank * (r - 1)}%`);
  }
  if (skill.damage) {
    const d = skill.damage;
    const lo = d.min + d.minPerRank * (r - 1);
    const hi = d.max + d.maxPerRank * (r - 1);
    lines.push(`${lo}-${hi} ${d.element} damage`);
  }
  if (skill.radius !== undefined && skill.radius > 0) {
    lines.push(`Radius: ${(skill.radius / 256).toFixed(1)} tiles`);
  }
  return lines;
}

/**
 * Tooltip lines of a skill at `rank` (the description first). `rank` 0 shows
 * the cost of the first rank.
 */
export function skillTooltip(skill: SkillProto, rank: number): string[] {
  const r = Math.max(1, rank);
  const lines: string[] = [skill.description];
  const mana = skillManaCost(skill, r);
  if (mana > 0) lines.push(`Mana: ${mana}`);
  if (skill.cooldown > 0) lines.push(`Cooldown: ${ticksToSeconds(skill.cooldown)}`);
  return [...lines, ...skillDetailLines(skill, r)];
}

/** Stats an item grants in total (implicits plus rolled mods), for comparisons. */
export function statTotals(
  item: ItemInstance,
  base: ItemBaseProto | undefined,
): Partial<Record<StatId, number>> {
  const out: Partial<Record<StatId, number>> = {};
  const add = (stat: StatId, value: number): void => {
    out[stat] = (out[stat] ?? 0) + value;
  };
  for (const m of base?.implicit ?? []) add(m.stat, m.value);
  for (const m of item.mods) add(m.stat, m.value);
  return out;
}

/**
 * Stat differences (`own` minus `equipped`) in STAT_TEXT order. Zero
 * differences are left out. Each text is the player line, e.g. "-3 to Dexterity".
 */
export function statDiffs(
  own: Partial<Record<StatId, number>>,
  equipped: Partial<Record<StatId, number>>,
): { text: string; delta: number }[] {
  const out: { text: string; delta: number }[] = [];
  for (const stat of Object.keys(STAT_TEXT) as StatId[]) {
    const delta = (own[stat] ?? 0) - (equipped[stat] ?? 0);
    if (delta !== 0) out.push({ text: statText(stat, delta), delta });
  }
  return out;
}
