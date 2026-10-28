/**
 * Item scoring for auto-equip, auto-sell and the HUD "upgrade" hint — OWNER:
 * auto builder (T7). Signature is CONTRACT (the client view imports it).
 *
 * The score is an integer "power" estimate of one item for a class whose
 * weapon damage scales with `primary`. It is comparable between items of the
 * same slot: weapons by sustained damage (average hit x attack rate x damage
 * bonuses, plus flat elemental adds), armor pieces by armor and block, and
 * every slot by its mods (attributes, life/mana, resists, speeds, utility).
 * Deterministic: only + - * / and floor.
 */
import type { FrozenRegistry } from "@gamez/kernel";
import { addItemStats, stat, type StatTotals } from "../rules.ts";
import { ATTRS, KIND, type Attr, type ItemBaseProto, type ItemInstance } from "../types.ts";

/** Reference attack duration (ticks) used to normalise weapon speed. */
const REF_TICKS = 12;
/**
 * Weight of the weapon damage estimate for weapon users (primary str/dex):
 * every attack and weapon skill scales with it (and the primary attribute
 * multiplies it again), so a few attribute points must not outweigh it.
 * Casters (primary mag) deal flat spell damage and keep weight 1.
 */
const WEAPON_WEIGHT = 3;

/** Points per unit of each attribute: the primary feeds damage, vitality life. */
function attrWeight(a: Attr, primary: Attr): number {
  if (a === primary) return 4;
  return a === "vit" ? 3 : 2;
}

function modScore(t: StatTotals, primary: Attr): number {
  let s = 0;
  const all = stat(t, "allAttrs");
  for (const a of ATTRS) s += (stat(t, a) + all) * attrWeight(a, primary);
  s += stat(t, "life") * 2 + stat(t, "lifePct") * 4 + stat(t, "lifeRegen") / 2;
  s += stat(t, "mana") + stat(t, "manaPct") * 2 + stat(t, "manaRegenPct") / 2;
  s += stat(t, "armorPct") * 2 + stat(t, "armor") * 2;
  s += stat(t, "toHit") / 4 + stat(t, "toHitPct");
  s += stat(t, "spellPct") * 2 + stat(t, "castSpeed") * 2;
  s += stat(t, "critPct") * 3 + stat(t, "critDmgPct");
  s += stat(t, "blockPct") * 2;
  s +=
    stat(t, "resFire") +
    stat(t, "resCold") +
    stat(t, "resLightning") +
    stat(t, "resPoison") +
    stat(t, "resAll") * 4;
  s += stat(t, "lifeSteal") * 4 + stat(t, "manaSteal") * 3;
  s += stat(t, "lifeOnKill") * 2 + stat(t, "manaOnKill");
  s += stat(t, "thorns") * 2;
  s += stat(t, "magicFind") / 2 + stat(t, "goldFind") / 4;
  s += stat(t, "moveSpeed") * 2 + stat(t, "lightRadius") * 3 + stat(t, "potionPct");
  s += stat(t, "allSkills") * 40;
  return s;
}

/** Sustained weapon damage estimate (x10), including flat damage mods. */
function weaponScore(base: ItemBaseProto, t: StatTotals): number {
  const lo = (base.dmgMin ?? 0) + stat(t, "dmgMin");
  const hi = (base.dmgMax ?? 0) + stat(t, "dmgMax");
  const ticks = Math.max(2, base.attackTicks ?? REF_TICKS);
  const rate = (REF_TICKS * (100 + stat(t, "attackSpeed"))) / (ticks * 100);
  const avg = ((lo + hi) / 2) * ((100 + stat(t, "dmgPct")) / 100);
  const elem =
    stat(t, "fireDmg") + stat(t, "coldDmg") + stat(t, "lightningDmg") + stat(t, "poisonDmg");
  return (avg + elem) * rate * 10;
}

/** Higher is better; comparable between items of the same slot for one class. */
export function itemScore(registry: FrozenRegistry, item: ItemInstance, primary: Attr): number {
  const base = registry.get<ItemBaseProto>(KIND.itemBase, item.base);
  if (!base || base.category === "potion") return 0;
  const t = addItemStats(registry, [item]);
  let s = modScore(t, primary);
  if (base.category === "weapon") {
    s += weaponScore(base, t) * (primary === "mag" ? 1 : WEAPON_WEIGHT);
    // Weapon-only mods that do not show in the damage estimate.
    s += stat(t, "attackSpeed");
  } else {
    // Off-weapon damage mods still add to every attack.
    s += stat(t, "dmgPct") * 2 + (stat(t, "dmgMin") + stat(t, "dmgMax")) * 3;
    s +=
      (stat(t, "fireDmg") + stat(t, "coldDmg") + stat(t, "lightningDmg") + stat(t, "poisonDmg")) *
      4;
    s += stat(t, "attackSpeed") * 2;
  }
  s += (base.armor ?? 0) * 2 + (base.block ?? 0) * 3;
  // Every equippable item beats an empty slot.
  return Math.max(1, Math.floor(s + 1));
}
