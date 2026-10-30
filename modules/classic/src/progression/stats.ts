/**
 * Hero derived stats (docs/design/classic.md §6.2). `computeHeroStats` is a
 * pure function of the registry and the hero's base data; the system
 * `classic.progression.stats` (pre -500) applies it every tick.
 */
import type { Entity, FrozenRegistry, SystemDef, World } from "@gamez/kernel";
import {
  Attributes,
  CombatStats,
  type CombatStatsValue,
  Equipment,
  Hero,
  HeroStats,
  type HeroStatsValue,
  Level,
  Life,
  Mana,
  Statuses,
} from "../components.ts";
import { pct } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { addItemStats, isBroken, type StatTotals, stat } from "../rules.ts";
import { bonusMods } from "../bonus.ts";
import { partyMembers } from "../party/shared.ts";
import {
  ATTRS,
  BALANCE_ID,
  EQUIP_SLOTS,
  KIND,
  type Attr,
  type AttrBlock,
  type BalanceProto,
  type ClassProto,
  type EquipSlot,
  type ItemBaseProto,
  type ItemInstance,
  type StatMod,
  type StatusProto,
} from "../types.ts";
import { put } from "./util.ts";

/** Everything `computeHeroStats` reads. Buffs are the active statuses only. */
export interface HeroStatsInput {
  classId: string;
  level: number;
  /** Allocated base attributes (Attributes component). */
  base: AttrBlock;
  /** Equipped items by slot; null/absent = nothing equipped. */
  equipment: Partial<Record<EquipSlot, ItemInstance | null>> | null;
  /** Active status ids with their power (statuses with `mods` add mods x power). */
  buffs: { id: string; power: number }[];
  /** Wave A: BonusStats mods (talents...). Optional: absent = none. */
  bonus?: StatMod[];
}

export interface HeroStatsResult {
  combat: CombatStatsValue;
  sheet: HeroStatsValue;
}

const FISTS_MIN = 1;
const FISTS_MAX = 3;
const DEFAULT_ATTACK_TICKS = 12;
const DEFAULT_ATTACK_RANGE = 400;

function baseOf(
  registry: FrozenRegistry,
  item: ItemInstance | null | undefined,
): ItemBaseProto | undefined {
  return item ? registry.get<ItemBaseProto>(KIND.itemBase, item.base) : undefined;
}

/** Derived hero values from base data, equipment and buffs (§6.2). Pure and integer-only. */
export function computeHeroStats(registry: FrozenRegistry, input: HeroStatsInput): HeroStatsResult {
  const cls = registry.require<ClassProto>(KIND.class, input.classId);
  const bal = registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
  const level = Math.max(1, input.level);
  // Broken items (wave A durability) count as not equipped: no stats, no base damage or armor.
  const eq: Partial<Record<EquipSlot, ItemInstance | null>> = {};
  for (const s of EQUIP_SLOTS) {
    const it = input.equipment?.[s] ?? null;
    eq[s] = it && !isBroken(it) ? it : null;
  }
  const equipped: (ItemInstance | null)[] = EQUIP_SLOTS.map((s) => eq[s] ?? null);

  // T: items (implicits + rolled mods) plus buff mods (StatusProto.mods x power) plus bonus sources.
  const T: StatTotals = addItemStats(registry, equipped);
  for (const m of input.bonus ?? []) T[m.stat] = (T[m.stat] ?? 0) + m.value;
  for (const b of input.buffs) {
    const st = registry.get<StatusProto>(KIND.status, b.id);
    for (const m of st?.mods ?? []) T[m.stat] = (T[m.stat] ?? 0) + m.perPower * b.power;
  }

  const attrs: AttrBlock = { str: 0, dex: 0, mag: 0, vit: 0 };
  for (const a of ATTRS) attrs[a] = input.base[a] + stat(T, a) + stat(T, "allAttrs");

  const weaponBase = baseOf(registry, eq.weapon);
  const shieldBase = baseOf(registry, eq.offhand);
  const hasShield = shieldBase?.category === "shield";

  let armorBase = 0;
  for (const it of equipped) armorBase += baseOf(registry, it)?.armor ?? 0;

  const primary: Attr = cls.primary;
  const dmgMult = 100 + attrs[primary] + stat(T, "dmgPct");
  const dmgMin = pct(
    (weaponBase ? (weaponBase.dmgMin ?? 0) : FISTS_MIN) + stat(T, "dmgMin"),
    dmgMult,
  );
  const dmgMax = Math.max(
    dmgMin,
    pct((weaponBase ? (weaponBase.dmgMax ?? 0) : FISTS_MAX) + stat(T, "dmgMax"), dmgMult),
  );

  const dex = attrs.dex;
  const vit = attrs.vit;
  const mag = attrs.mag;

  const lifeMax = Math.max(
    1,
    pct(
      cls.life.base + vit * cls.life.perVit + (level - 1) * cls.life.perLevel + stat(T, "life"),
      100 + stat(T, "lifePct"),
    ),
  );
  const manaMax = Math.max(
    0,
    pct(
      cls.mana.base + mag * cls.mana.perMag + (level - 1) * cls.mana.perLevel + stat(T, "mana"),
      100 + stat(T, "manaPct"),
    ),
  );
  const armor = pct(Math.floor(dex / 4) + armorBase + stat(T, "armor"), 100 + stat(T, "armorPct"));
  const toHit = pct(dex * 5 + level * 10 + stat(T, "toHit"), 100 + stat(T, "toHitPct"));

  const combat: CombatStatsValue = {
    level,
    armor,
    toHit,
    dmgMin,
    dmgMax,
    addFire: stat(T, "fireDmg"),
    addCold: stat(T, "coldDmg"),
    addLightning: stat(T, "lightningDmg"),
    addPoison: stat(T, "poisonDmg"),
    spellPct: stat(T, "spellPct"),
    critPct: 5 + Math.floor(dex / 10) + stat(T, "critPct"),
    critMult: 150 + stat(T, "critDmgPct"),
    attackSpeed: 100 + stat(T, "attackSpeed"),
    castSpeed: 100 + stat(T, "castSpeed"),
    moveSpeed: 100 + stat(T, "moveSpeed"),
    resFire: stat(T, "resFire") + stat(T, "resAll"),
    resCold: stat(T, "resCold") + stat(T, "resAll"),
    resLightning: stat(T, "resLightning") + stat(T, "resAll"),
    resPoison: stat(T, "resPoison") + stat(T, "resAll"),
    lifeSteal: stat(T, "lifeSteal"),
    manaSteal: stat(T, "manaSteal"),
    blockPct: hasShield ? (shieldBase?.block ?? 0) + stat(T, "blockPct") : 0,
    thorns: stat(T, "thorns"),
    attackTicks: weaponBase?.attackTicks ?? DEFAULT_ATTACK_TICKS,
    attackRange: weaponBase?.range ?? DEFAULT_ATTACK_RANGE,
    attackProjectile: weaponBase?.projectile ?? "",
    attackElement: "phys",
  };

  const sheet: HeroStatsValue = {
    attrs,
    lifeMax,
    manaMax,
    lifeRegen: 5 + Math.floor(vit / 5) + stat(T, "lifeRegen"),
    manaRegen: pct(Math.floor((manaMax * 10) / 40), 100 + stat(T, "manaRegenPct")),
    magicFind: stat(T, "magicFind"),
    goldFind: stat(T, "goldFind"),
    lightRadius: bal.lightRadius + stat(T, "lightRadius"),
    lifeOnKill: stat(T, "lifeOnKill"),
    manaOnKill: stat(T, "manaOnKill"),
    allSkills: stat(T, "allSkills"),
    potionPct: stat(T, "potionPct"),
    twoHanded: weaponBase?.twoHanded ?? false,
    primary,
  };
  return { combat, sheet };
}

/** Reads the hero's components into a HeroStatsInput (buffs filtered to `tick`). */
export function heroStatsInput(world: World, hero: Entity, tick: number): HeroStatsInput {
  // Read-only: peek() takes no rollback copy (the equipment is the biggest component).
  const h = world.peek(hero, Hero)!;
  const lvl = world.peek(hero, Level)!;
  const base = world.peek(hero, Attributes)!;
  const equipment = world.peek(hero, Equipment) ?? null;
  const list = world.peek(hero, Statuses)?.list ?? [];
  return {
    classId: h.classId,
    level: lvl.level,
    base: { str: base.str, dex: base.dex, mag: base.mag, vit: base.vit },
    equipment,
    buffs: list.filter((s) => s.until > tick).map((s) => ({ id: s.id, power: s.power })),
    bonus: bonusMods(world, hero),
  };
}

/**
 * Recomputes the hero's stats from its components and writes CombatStats,
 * HeroStats and the Life/Mana maxima (current values clamped to the new max;
 * raising a max does not heal). Used by the stats system and by level ups.
 */
export function applyHeroStats(
  world: World,
  registry: FrozenRegistry,
  hero: Entity,
  tick: number,
): HeroStatsResult {
  const res = computeHeroStats(registry, heroStatsInput(world, hero, tick));
  put(world, hero, CombatStats, res.combat);
  put(world, hero, HeroStats, res.sheet);
  // Written only when they change (an equal write leaves the state as it is, but costs a
  // rollback copy every tick).
  const life = world.peek(hero, Life);
  if (life !== undefined) {
    const hp = Math.min(life.hp, res.sheet.lifeMax);
    if (life.max !== res.sheet.lifeMax || life.hp !== hp)
      world.update(hero, Life, { max: res.sheet.lifeMax, hp });
  }
  const mana = world.peek(hero, Mana);
  if (mana !== undefined) {
    const mp = Math.min(mana.mp, res.sheet.manaMax);
    if (mana.max !== res.sheet.manaMax || mana.mp !== mp)
      world.update(hero, Mana, { max: res.sheet.manaMax, mp });
  }
  return res;
}

/** classic.progression.stats (pre -500): hero stats every tick, for every party member (slot order). */
export const progressionStats: SystemDef = {
  ...SYSTEM.progressionStats,
  run(world, ctx) {
    for (const hero of partyMembers(world)) applyHeroStats(world, ctx.registry, hero, ctx.tick);
  },
};
