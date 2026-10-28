/**
 * Game formulas (CONTRACT, implemented). Pure integer functions shared by
 * every module and the client so numbers agree everywhere. Change a formula
 * here on purpose (it changes balance for every module) and bump the
 * versions of the modules that use it.
 */
import type { FrozenRegistry, Rng } from "@gamez/kernel";
import type { CombatStatsValue } from "./components.ts";
import { clamp, pct } from "./fixed.ts";
import {
  KIND,
  type AttrBlock,
  type BalanceProto,
  type Damage,
  type Element,
  type ItemBaseProto,
  type ItemInstance,
  type ItemRarity,
  type MonsterModProto,
  type MonsterProto,
  type MonsterRarity,
  type SkillProto,
  type StatId,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Depth structure
// ---------------------------------------------------------------------------

/** Dungeon tier 0..3 of a depth (1-4 -> 0, 5-8 -> 1, ...), cycling after 16. */
export function tierOf(depth: number): number {
  return Math.floor((Math.max(1, depth) - 1) / 4) % 4;
}
/** Boss on every 4th level. */
export function isBossDepth(depth: number): boolean {
  return depth > 0 && depth % 4 === 0;
}
/**
 * Waypoints on every odd depth (1, 3, 5, ...) and the town, so a death or a
 * town trip without a scroll never costs more than two levels of walking.
 */
export function isWaypointDepth(depth: number): boolean {
  return depth === 0 || depth % 2 === 1;
}
/** Monster level of a dungeon depth: 1, 2, 4, 5, 7, 8, 10, ... */
export function monsterLevel(depth: number): number {
  return 1 + Math.floor((3 * (Math.max(1, depth) - 1)) / 2);
}

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

export function xpToNext(bal: BalanceProto, level: number): number {
  return bal.xpA * level * level + bal.xpB * level;
}
/** Total XP at which `level` starts (level 1 starts at 0). */
export function xpAtLevel(bal: BalanceProto, level: number): number {
  let total = 0;
  for (let l = 1; l < level; l++) total += xpToNext(bal, l);
  return total;
}
/** Level for a total XP amount (capped at maxLevel). */
export function levelForXp(bal: BalanceProto, xp: number): number {
  let level = 1;
  let need = xpToNext(bal, 1);
  let acc = 0;
  while (level < bal.maxLevel && xp >= acc + need) {
    acc += need;
    level++;
    need = xpToNext(bal, level);
  }
  return level;
}
/** XP for killing a monster worth `xp` at `monsterLvl` (level-difference penalty applied). */
export function xpForKill(
  bal: BalanceProto,
  heroLevel: number,
  monsterLvl: number,
  xp: number,
): number {
  const diff = heroLevel - monsterLvl - bal.xpGrace;
  if (diff <= 0) return xp;
  const keep = Math.max(bal.xpMinPct, 100 - diff * bal.xpPenaltyPct);
  return Math.max(1, pct(xp, keep));
}

// ---------------------------------------------------------------------------
// Monsters
// ---------------------------------------------------------------------------

export const RARITY_SCALE: Record<MonsterRarity, { life: number; dmg: number; xp: number }> = {
  normal: { life: 100, dmg: 100, xp: 100 },
  minion: { life: 150, dmg: 110, xp: 150 },
  champion: { life: 300, dmg: 150, xp: 300 },
  unique: { life: 400, dmg: 175, xp: 500 },
  boss: { life: 100, dmg: 100, xp: 100 },
  summon: { life: 100, dmg: 100, xp: 0 },
};

export interface ScaledMonster {
  life: number;
  armor: number;
  toHit: number;
  dmgMin: number;
  dmgMax: number;
  xp: number;
  speedPct: number;
  resistAll: number;
  lifeStealPct: number;
}

/**
 * Monster stats at `level` with rarity and mods:
 * life x(100 + 25*(L-1))%, damage x(100 + 15*(L-1))%, armor +8/L, toHit +12/L, xp x(100 + 30*(L-1))%,
 * then rarity multipliers (RARITY_SCALE) and every mod's lifePct/dmgPct/armorPct/speedPct.
 */
export function scaleMonster(
  proto: MonsterProto,
  level: number,
  rarity: MonsterRarity,
  mods: readonly MonsterModProto[],
): ScaledMonster {
  const l = Math.max(1, level) - 1;
  const r = RARITY_SCALE[rarity];
  let lifeP = r.life;
  let dmgP = r.dmg;
  let armorP = 100;
  let speedP = 100;
  let resistAll = 0;
  let lifeSteal = 0;
  for (const m of mods) {
    lifeP += m.lifePct;
    dmgP += m.dmgPct;
    armorP += m.armorPct;
    speedP += m.speedPct;
    resistAll += m.resistAll;
    lifeSteal += m.lifeStealPct;
  }
  const life = Math.max(1, pct(pct(proto.life, 100 + 25 * l), lifeP));
  const dmgMin = Math.max(1, pct(pct(proto.dmgMin, 100 + 15 * l), dmgP));
  const dmgMax = Math.max(dmgMin, pct(pct(proto.dmgMax, 100 + 15 * l), dmgP));
  return {
    life,
    armor: pct(proto.armor + 8 * l, armorP),
    toHit: proto.toHit + 12 * l,
    dmgMin,
    dmgMax,
    xp: pct(pct(proto.xp, 100 + 30 * l), r.xp),
    speedPct: speedP,
    resistAll,
    lifeStealPct: lifeSteal,
  };
}

/** Boss summon thresholds (% of max life, design §8.2): one summon per threshold crossed. */
export const BOSS_SUMMON_PCTS: readonly number[] = [66, 33];

/** Number of summon thresholds a boss at `hp` of `max` is below. */
export function bossPhase(hp: number, max: number): number {
  let n = 0;
  for (const p of BOSS_SUMMON_PCTS) if (hp * 100 < max * p) n++;
  return n;
}

/** "Name, Title" for a boss, without repeating a title the content name already has. */
export function bossDisplayName(proto: MonsterProto): string {
  const title = proto.boss?.title ?? "";
  if (title === "" || proto.name.includes(title)) return proto.name;
  return `${proto.name}, ${title}`;
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/** Chance (5..95 %) that an attack hits: 200 * toHit/(toHit+armor) * aLvl/(aLvl+dLvl). */
export function hitChance(
  toHit: number,
  attackerLevel: number,
  armor: number,
  defenderLevel: number,
): number {
  const t = Math.max(1, toHit);
  const a = Math.max(0, armor);
  const al = Math.max(1, attackerLevel);
  const dl = Math.max(1, defenderLevel);
  return clamp(Math.floor((200 * t * al) / ((t + a) * (al + dl))), 5, 95);
}

/** % of physical damage removed by armor: armor / (armor + 50 + 10 * attackerLevel), max 75. */
export function physReduction(armor: number, attackerLevel: number): number {
  if (armor <= 0) return 0;
  return Math.min(75, Math.floor((armor * 100) / (armor + 50 + 10 * Math.max(1, attackerLevel))));
}

/** Capped resist (-100..75) for an element of a CombatStats block. */
export function resistOf(s: CombatStatsValue, e: Element): number {
  switch (e) {
    case "fire":
      return clamp(s.resFire, -100, 75);
    case "cold":
      return clamp(s.resCold, -100, 75);
    case "lightning":
      return clamp(s.resLightning, -100, 75);
    case "poison":
      return clamp(s.resPoison, -100, 75);
    default:
      return 0;
  }
}

/** Damage after the defender's armor and resists (crit not included). */
export function mitigate(d: Damage, def: CombatStatsValue, attackerLevel: number): Damage {
  return {
    phys: pct(d.phys, 100 - physReduction(def.armor, attackerLevel)),
    fire: pct(d.fire, 100 - resistOf(def, "fire")),
    cold: pct(d.cold, 100 - resistOf(def, "cold")),
    lightning: pct(d.lightning, 100 - resistOf(def, "lightning")),
    poison: pct(d.poison, 100 - resistOf(def, "poison")),
  };
}

/** Ticks of an action at a speed percent (100 = base); never below 2. */
export function scaledTicks(baseTicks: number, speedPct: number): number {
  return Math.max(2, Math.ceil((baseTicks * 100) / Math.max(10, speedPct)));
}

/** Effective rank including +all skills, capped at maxRank + 5. */
export function effectiveRank(skill: SkillProto, rank: number, allSkills: number): number {
  if (rank <= 0) return 0;
  return Math.min(skill.maxRank + 5, rank + allSkills);
}

export function skillManaCost(skill: SkillProto, rank: number): number {
  return skill.manaCost + skill.manaPerRank * Math.max(0, rank - 1);
}

/** Element with the largest share (ties: phys, fire, cold, lightning, poison). */
export function dominantElement(d: Damage): Element {
  let best: Element = "phys";
  let v = d.phys;
  for (const e of ["fire", "cold", "lightning", "poison"] as const) {
    if (d[e] > v) {
      v = d[e];
      best = e;
    }
  }
  return best;
}

/**
 * Rolls one hit's damage for a skill (before the target's defences):
 * - weapon part: roll dmgMin..dmgMax, x (weaponPct + weaponPctPerRank*(rank-1))%, plus the flat
 *   elemental adds (addFire...) at the same %;
 * - flat part: roll min..max (+perRank*(rank-1)), x (100 + attr[scaling] + spellPct)%.
 * `attrs` is the hero's total attributes (monsters pass null: no attribute bonus).
 * Pass rng = null for the average (auto controller estimates).
 */
export function rollSkillDamage(
  skill: SkillProto,
  rank: number,
  s: CombatStatsValue,
  attrs: AttrBlock | null,
  rng: Rng | null,
): Damage {
  const roll = (lo: number, hi: number): number =>
    rng ? rng.int(Math.min(lo, hi), Math.max(lo, hi)) : Math.floor((lo + hi) / 2);
  const r = Math.max(1, rank) - 1;
  const out: Damage = { phys: 0, fire: 0, cold: 0, lightning: 0, poison: 0 };
  const wp = skill.weaponPct > 0 ? skill.weaponPct + skill.weaponPctPerRank * r : 0;
  if (wp > 0) {
    const base = pct(roll(s.dmgMin, s.dmgMax), wp);
    out[s.attackElement] += base;
    out.fire += pct(s.addFire, wp);
    out.cold += pct(s.addCold, wp);
    out.lightning += pct(s.addLightning, wp);
    out.poison += pct(s.addPoison, wp);
  }
  if (skill.damage) {
    const d = skill.damage;
    const bonus = 100 + (skill.scaling && attrs ? attrs[skill.scaling] : 0) + s.spellPct;
    out[d.element] += pct(roll(d.min + d.minPerRank * r, d.max + d.maxPerRank * r), bonus);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const RARITY_VALUE_MULT: Record<ItemRarity, number> = {
  normal: 1,
  magic: 3,
  rare: 7,
  unique: 15,
};

/** Gold value: base.value x rarity mult x (100 + 5*ilvl)%. */
export function itemValue(base: ItemBaseProto, rarity: ItemRarity, ilvl: number): number {
  return Math.max(1, pct(base.value * RARITY_VALUE_MULT[rarity], 100 + 5 * ilvl));
}

/** The alchemist sells a potion once the hero is within 2 levels of its item level (design §9.1). */
export function potionUnlocked(base: ItemBaseProto, heroLevel: number): boolean {
  return base.ilvl <= heroLevel + 2;
}

/** What an NPC with `buyPct` pays for an item. */
export function sellPrice(item: ItemInstance, buyPct: number): number {
  return Math.max(buyPct > 0 ? 1 : 0, pct(item.value, buyPct));
}

export type StatTotals = Partial<Record<StatId, number>>;

/** Adds base implicits and rolled mods of `items` into `into` (returns it). */
export function addItemStats(
  registry: FrozenRegistry,
  items: readonly (ItemInstance | null)[],
  into: StatTotals = {},
): StatTotals {
  for (const it of items) {
    if (!it) continue;
    const base = registry.get<ItemBaseProto>(KIND.itemBase, it.base);
    for (const m of base?.implicit ?? []) into[m.stat] = (into[m.stat] ?? 0) + m.value;
    for (const m of it.mods) into[m.stat] = (into[m.stat] ?? 0) + m.value;
  }
  return into;
}

export function stat(t: StatTotals, id: StatId): number {
  return t[id] ?? 0;
}

/** Ordering used by loot filters and the controller: normal < magic < rare < unique. */
export function rarityRank(r: ItemRarity): number {
  return r === "normal" ? 0 : r === "magic" ? 1 : r === "rare" ? 2 : 3;
}
