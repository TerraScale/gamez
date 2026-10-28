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
  type EconomyProto,
  type Element,
  type ItemBaseProto,
  type ItemCategory,
  type ItemInstance,
  type ItemRarity,
  type MonsterModProto,
  type MonsterProto,
  type MonsterRarity,
  type RiftProto,
  type SetItemProto,
  type SetProto,
  type SkillModField,
  type SkillModifier,
  type SkillProto,
  type StatId,
  type StatMod,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Depth structure
// ---------------------------------------------------------------------------

/**
 * Last depth of the main dungeon (wave A): depth 16 (the Hollow King) has no
 * stairs down; after his death the Rift opens (RiftProto.unlockBossDepth).
 */
export const MAIN_DUNGEON_DEPTH = 16;

/**
 * Rift levels live at synthetic depths (wave A): riftDepth(level, run) =
 * RIFT_DEPTH_BASE + level x 1000 + run % 1000, so every run gets a fresh map
 * (maps derive from (worldSeed, depth)) and the level is recoverable from
 * the depth. Rift depths are never boss or waypoint depths.
 */
export const RIFT_DEPTH_BASE = 100_000;
export const RIFT_MAX_LEVEL = 99;
/**
 * Monster level of rift level L = RIFT_MONSTER_LEVEL_BASE + RIFT_LEVEL_STEP x L.
 * Rift level 1 (20) sits a little below depth 16 (23), so the hero who just
 * killed the depth-16 boss can clear it; the ladder passes depth 16 at level 3.
 */
export const RIFT_MONSTER_LEVEL_BASE = 18;
export const RIFT_LEVEL_STEP = 2;

export function isRiftDepth(depth: number): boolean {
  return depth >= RIFT_DEPTH_BASE;
}
export function riftDepth(level: number, run: number): number {
  return RIFT_DEPTH_BASE + level * 1000 + (((run % 1000) + 1000) % 1000);
}
/** Rift level of a rift depth (0 for normal depths). */
export function riftLevelOf(depth: number): number {
  return isRiftDepth(depth) ? Math.floor((depth - RIFT_DEPTH_BASE) / 1000) : 0;
}

/** Dungeon tier 0..3 of a depth (1-4 -> 0, 5-8 -> 1, ...), cycling after 16. Rift depths: 3. */
export function tierOf(depth: number): number {
  if (isRiftDepth(depth)) return 3;
  return Math.floor((Math.max(1, depth) - 1) / 4) % 4;
}
/** Boss on every 4th level (never in a rift). */
export function isBossDepth(depth: number): boolean {
  return depth > 0 && depth % 4 === 0 && !isRiftDepth(depth);
}
/**
 * Waypoints on every odd depth (1, 3, 5, ...) and the town, so a death or a
 * town trip without a scroll never costs more than two levels of walking.
 * Never in a rift.
 */
export function isWaypointDepth(depth: number): boolean {
  return depth === 0 || (depth % 2 === 1 && !isRiftDepth(depth));
}
/** Monster level of a dungeon depth: 1, 2, 4, 5, 7, 8, 10, ...; rift level L: 18 + 2L. */
export function monsterLevel(depth: number): number {
  if (isRiftDepth(depth)) return RIFT_MONSTER_LEVEL_BASE + RIFT_LEVEL_STEP * riftLevelOf(depth);
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

// ---------------------------------------------------------------------------
// Skill modifiers (wave A: talents). Totals per field for one skill.
// ---------------------------------------------------------------------------

export type SkillModTotals = Record<SkillModField, number>;

export function emptySkillMods(): SkillModTotals {
  return {
    damagePct: 0,
    manaCostPct: 0,
    cooldownPct: 0,
    speedPct: 0,
    radiusPct: 0,
    extraProjectiles: 0,
    extraPierce: 0,
    extraBounces: 0,
    durationPct: 0,
    extraSummons: 0,
  };
}

/** True when `mod.skill` selects the skill (exact id, "*", or "tag:<tag>"). */
export function skillModMatches(mod: SkillModifier, skillId: string, skill: SkillProto): boolean {
  if (mod.skill === "*") return skill.users === "hero";
  if (mod.skill.startsWith("tag:")) return (skill.ai.tags as string[]).includes(mod.skill.slice(4));
  return mod.skill === skillId;
}

/** Sums the modifiers of `mods` that select the skill (into a fresh totals object). */
export function sumSkillMods(
  mods: readonly SkillModifier[],
  skillId: string,
  skill: SkillProto,
): SkillModTotals {
  const t = emptySkillMods();
  for (const m of mods) if (skillModMatches(m, skillId, skill)) t[m.field] += m.value;
  return t;
}

/** Mana cost with skill modifiers (manaCostPct, floor 0). */
export function effectiveManaCost(skill: SkillProto, rank: number, mods: SkillModTotals): number {
  return Math.max(0, pct(skillManaCost(skill, rank), 100 + mods.manaCostPct));
}

/** Cooldown ticks with skill modifiers (cooldownPct, floor 0). */
export function effectiveCooldown(skill: SkillProto, mods: SkillModTotals): number {
  return Math.max(0, pct(skill.cooldown, 100 + mods.cooldownPct));
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
  set: 12,
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

/**
 * Adds base implicits, rolled mods, smith upgrades (upgradeMods), socketed
 * gems (gemMods) of `items` and the set bonuses of the whole list
 * (setBonusMods) into `into` (returns it). Broken items (isBroken) add nothing.
 */
export function addItemStats(
  registry: FrozenRegistry,
  items: readonly (ItemInstance | null)[],
  into: StatTotals = {},
): StatTotals {
  const add = (m: StatMod): void => {
    into[m.stat] = (into[m.stat] ?? 0) + m.value;
  };
  for (const it of items) {
    if (!it || isBroken(it)) continue;
    const base = registry.get<ItemBaseProto>(KIND.itemBase, it.base);
    for (const m of base?.implicit ?? []) add(m);
    for (const m of it.mods) add(m);
    if (base && (it.upgrade ?? 0) > 0) for (const m of upgradeMods(base, it.upgrade ?? 0)) add(m);
    if (base && it.sockets) for (const m of gemMods(registry, base, it.sockets)) add(m);
  }
  for (const m of setBonusMods(registry, items)) add(m);
  return into;
}

export function stat(t: StatTotals, id: StatId): number {
  return t[id] ?? 0;
}

/** Ordering used by loot filters and the controller: normal < magic < rare < set < unique. */
export function rarityRank(r: ItemRarity): number {
  return r === "normal" ? 0 : r === "magic" ? 1 : r === "rare" ? 2 : r === "set" ? 3 : 4;
}

// ---------------------------------------------------------------------------
// Wave A itemization: durability, upgrades, sockets, sets (docs/design/wave-A.md)
// ---------------------------------------------------------------------------

/** Default max durability by category (0 = indestructible). ItemBaseProto.durability overrides. */
export const DURABILITY_BY_CATEGORY: Record<ItemCategory, number> = {
  weapon: 60,
  shield: 60,
  armor: 70,
  helm: 50,
  gloves: 40,
  boots: 40,
  ring: 0,
  amulet: 0,
  potion: 0,
  gem: 0,
};

export function maxDurabilityOf(base: ItemBaseProto): number {
  return base.durability ?? DURABILITY_BY_CATEGORY[base.category];
}

/** True when the item has durability and it reached 0. */
export function isBroken(item: ItemInstance): boolean {
  return item.dur !== undefined && item.dur.cur <= 0;
}

/** Default max sockets by category (ItemBaseProto.maxSockets overrides); two-handed weapons 3. */
export function maxSocketsOf(base: ItemBaseProto): number {
  if (base.maxSockets !== undefined) return base.maxSockets;
  switch (base.category) {
    case "weapon":
      return base.twoHanded ? 3 : 2;
    case "armor":
      return 3;
    case "shield":
    case "helm":
      return 2;
    case "gloves":
    case "boots":
    case "ring":
    case "amulet":
      return 1;
    default:
      return 0;
  }
}

/** Which gem table applies to a host item ("weapon" | "armor" | "jewelry"), null = not socketable. */
export function socketGroup(base: ItemBaseProto): "weapon" | "armor" | "jewelry" | null {
  switch (base.category) {
    case "weapon":
      return "weapon";
    case "shield":
    case "helm":
    case "armor":
    case "gloves":
    case "boots":
      return "armor";
    case "ring":
    case "amulet":
      return "jewelry";
    default:
      return null;
  }
}

/** Mods of the gems socketed into an item of `base` (empty sockets and unknown gems add nothing). */
export function gemMods(
  registry: FrozenRegistry,
  base: ItemBaseProto,
  sockets: readonly (string | null)[],
): StatMod[] {
  const group = socketGroup(base);
  if (!group) return [];
  const out: StatMod[] = [];
  for (const g of sockets) {
    if (!g) continue;
    const gem = registry.get<ItemBaseProto>(KIND.itemBase, g)?.gem;
    if (gem) out.push(...gem[group]);
  }
  return out;
}

/** Per upgrade level: weapons +6 % damage, armor pieces +12 % of base armor (min 1), jewelry +1 all attributes. */
export const UPGRADE_DMG_PCT = 6;
export const UPGRADE_ARMOR_PCT = 12;

/** Bonus of a smith upgrade level (0 = none). */
export function upgradeMods(base: ItemBaseProto, level: number): StatMod[] {
  if (level <= 0) return [];
  switch (socketGroup(base)) {
    case "weapon":
      return [{ stat: "dmgPct", value: UPGRADE_DMG_PCT * level }];
    case "armor":
      return [
        {
          stat: "armor",
          value: Math.max(level, Math.ceil(((base.armor ?? 0) * UPGRADE_ARMOR_PCT * level) / 100)),
        },
      ];
    case "jewelry":
      return [{ stat: "allAttrs", value: level }];
    default:
      return [];
  }
}

/** Number of DIFFERENT pieces per set id among `items` (sorted by set id). */
export function setPieceCounts(
  registry: FrozenRegistry,
  items: readonly (ItemInstance | null)[],
): { set: string; pieces: number }[] {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!it || !it.set || isBroken(it) || seen.has(it.set)) continue;
    seen.add(it.set);
    const piece = registry.get<SetItemProto>(KIND.setItem, it.set);
    if (!piece) continue;
    counts.set(piece.set, (counts.get(piece.set) ?? 0) + 1);
  }
  return [...counts.keys()].sort().map((set) => ({ set, pieces: counts.get(set)! }));
}

/** Set bonus mods of the equipped `items` (every bonus whose count is reached). */
export function setBonusMods(
  registry: FrozenRegistry,
  items: readonly (ItemInstance | null)[],
): StatMod[] {
  const out: StatMod[] = [];
  for (const { set, pieces } of setPieceCounts(registry, items)) {
    const proto = registry.get<SetProto>(KIND.set, set);
    for (const b of proto?.bonuses ?? []) if (pieces >= b.count) out.push(...b.mods);
  }
  return out;
}

// ---- prices (EconomyProto); shared by crafting, items, talents, rift, HUD and Auto ----

/** Gold to fully repair `item` (0 when nothing to repair or indestructible). */
export function repairCost(econ: EconomyProto, item: ItemInstance): number {
  const d = item.dur;
  if (!d || d.max <= 0 || d.cur >= d.max) return 0;
  return Math.max(
    1,
    Math.ceil((item.value * econ.repair.fullPct * (d.max - d.cur)) / (100 * d.max)),
  );
}

/** Gold for upgrading `item` one level, or null at max level. */
export function upgradeCost(econ: EconomyProto, item: ItemInstance): number | null {
  const lvl = item.upgrade ?? 0;
  if (lvl >= econ.upgrade.maxLevel) return null;
  return Math.max(1, pct(item.value, econ.upgrade.costPct[lvl] ?? 100));
}

/** Gold for rerolling `item`, or null when it cannot be rerolled (only magic and rare). */
export function rerollCost(econ: EconomyProto, item: ItemInstance): number | null {
  if (item.rarity !== "magic" && item.rarity !== "rare") return null;
  return Math.max(1, pct(item.value, econ.reroll.basePct) * (1 + (item.rerolls ?? 0)));
}

/** Gold for adding the next socket, or null when the base allows no more. */
export function socketCost(
  econ: EconomyProto,
  base: ItemBaseProto,
  item: ItemInstance,
): number | null {
  const n = item.sockets?.length ?? 0;
  if (n >= maxSocketsOf(base)) return null;
  return econ.sockets.addCost[n] ?? null;
}

/** Gambler price of `category` for a hero of `heroLevel`, or null when not offered. */
export function gamblePrice(
  econ: EconomyProto,
  category: ItemCategory,
  heroLevel: number,
): number | null {
  const b = econ.gamble.base[category];
  if (b === undefined) return null;
  return Math.max(1, pct(b, 100 + econ.gamble.perLevelPct * Math.max(1, heroLevel)));
}

export function talentResetCost(econ: EconomyProto, heroLevel: number): number {
  return econ.talentResetPerLevel * Math.max(1, heroLevel);
}

export function riftFee(rift: RiftProto, level: number): number {
  return rift.feeBase + rift.feePerLevel * level;
}

/**
 * Leaderboard score of a completed rift run: level x 1000 plus the whole
 * seconds left of the time limit (0 when over time). Failed runs score 0.
 */
export function riftScore(
  level: number,
  ticks: number,
  timeLimit: number,
  completed: boolean,
): number {
  if (!completed) return 0;
  return level * 1000 + Math.max(0, Math.floor((timeLimit - ticks) / 20));
}

// ---- balance defaults for the optional wave A BalanceProto fields ----

export function talentPointsPerLevel(bal: BalanceProto): number {
  return bal.talentPointsPerLevel ?? 1;
}
export function stashTabCount(bal: BalanceProto): number {
  return Math.max(1, bal.stashTabs ?? 1);
}
/** Total stash capacity over all tabs. */
export function stashCapacity(bal: BalanceProto): number {
  return bal.stashSize * stashTabCount(bal);
}
