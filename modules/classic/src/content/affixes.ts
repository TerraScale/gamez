/**
 * Affix tiers (design §11.2). Each row is one tier: `classic.affix.<stat>.<tier>`.
 * Prefixes and suffixes share the tier numbering per stat; `group` is the
 * stat, so an item never gets two tiers of the same stat. Rolls are uniform
 * between min and max; `ilvl` gates the tier.
 */
import type { AffixProto, ItemCategory, StatId } from "../types.ts";

const DEFENCE: ItemCategory[] = ["armor", "helm", "gloves", "boots", "shield"];
const JEWELLERY: ItemCategory[] = ["ring", "amulet"];
const GEAR: ItemCategory[] = [
  "weapon",
  "shield",
  "helm",
  "armor",
  "gloves",
  "boots",
  "ring",
  "amulet",
];
const WEAPON: ItemCategory[] = ["weapon"];
const ELEMENTAL_RES: ItemCategory[] = [
  "helm",
  "armor",
  "gloves",
  "boots",
  "shield",
  "ring",
  "amulet",
];

type Row = [
  stat: StatId,
  tier: number,
  name: string,
  kind: "prefix" | "suffix",
  min: number,
  max: number,
  ilvl: number,
  categories: ItemCategory[],
  weight: number,
];

const ROWS: Row[] = [
  // Life, mana and attributes
  ["life", 1, "Sturdy", "prefix", 5, 10, 1, [...DEFENCE, ...JEWELLERY], 10],
  ["life", 2, "Robust", "prefix", 12, 20, 12, [...DEFENCE, ...JEWELLERY], 6],
  ["life", 3, "Stout", "prefix", 22, 34, 24, [...DEFENCE, ...JEWELLERY], 4],
  ["lifePct", 1, "Hardy", "prefix", 5, 10, 12, ["helm", "armor", "shield", "ring", "amulet"], 8],
  [
    "lifePct",
    2,
    "Stalwart",
    "prefix",
    11,
    18,
    24,
    ["helm", "armor", "shield", "ring", "amulet"],
    4,
  ],
  ["mana", 1, "Arcane", "prefix", 5, 10, 3, [...GEAR], 10],
  ["mana", 2, "Mystic", "prefix", 12, 20, 14, [...GEAR], 6],
  ["mana", 3, "Eldritch", "prefix", 22, 34, 26, [...GEAR], 4],
  ["manaPct", 1, "Azure", "prefix", 8, 15, 16, ["helm", "armor", "ring", "amulet"], 6],
  ["str", 1, "Brawny", "prefix", 2, 5, 1, [...GEAR], 10],
  ["str", 2, "Herculean", "prefix", 6, 10, 16, [...GEAR], 5],
  ["dex", 1, "of the Hawk", "suffix", 2, 5, 1, [...GEAR], 10],
  ["dex", 2, "of the Falcon", "suffix", 6, 10, 16, [...GEAR], 5],
  ["mag", 1, "Scholarly", "prefix", 2, 5, 1, [...GEAR], 10],
  ["mag", 2, "Sorcerous", "prefix", 6, 10, 16, [...GEAR], 5],
  ["vit", 1, "of the Ox", "suffix", 2, 5, 1, [...GEAR], 10],
  ["vit", 2, "of the Bull", "suffix", 6, 10, 16, [...GEAR], 5],
  ["allAttrs", 1, "of Mastery", "suffix", 2, 4, 20, [...JEWELLERY], 2],
  ["allSkills", 1, "Sage's", "prefix", 1, 2, 22, ["amulet"], 1],
  // Defence
  ["armor", 1, "Plated", "prefix", 3, 8, 1, [...DEFENCE], 10],
  ["armor", 2, "Reinforced", "prefix", 8, 15, 8, [...DEFENCE], 6],
  ["armor", 3, "Bulwark", "prefix", 16, 28, 20, [...DEFENCE], 4],
  [
    "armorPct",
    1,
    "Fortified",
    "prefix",
    10,
    20,
    10,
    ["armor", "helm", "shield", "gloves", "boots"],
    6,
  ],
  [
    "armorPct",
    2,
    "Adamant",
    "prefix",
    21,
    35,
    24,
    ["armor", "helm", "shield", "gloves", "boots"],
    3,
  ],
  ["blockPct", 1, "of Bracing", "suffix", 4, 8, 4, ["shield"], 8],
  ["blockPct", 2, "of the Wall", "suffix", 9, 15, 16, ["shield"], 4],
  ["thorns", 1, "Spiked", "prefix", 3, 6, 8, ["armor", "shield"], 5],
  ["resAll", 1, "of Ward", "suffix", 8, 12, 24, ["helm", "armor", "shield", "amulet"], 2],
  ["lifeRegen", 1, "of Vitality", "suffix", 5, 10, 10, ["armor", "ring", "amulet"], 5],
  // Weapon damage
  ["dmgPct", 1, "Savage", "prefix", 10, 20, 1, [...WEAPON], 10],
  ["dmgPct", 2, "Brutal", "prefix", 21, 35, 12, [...WEAPON], 6],
  ["dmgPct", 3, "Merciless", "prefix", 36, 50, 24, [...WEAPON], 3],
  ["dmgMin", 1, "Honed", "prefix", 1, 3, 3, [...WEAPON], 8],
  ["dmgMin", 2, "Tempered", "prefix", 3, 6, 16, [...WEAPON], 4],
  ["dmgMax", 1, "Edged", "prefix", 2, 5, 3, [...WEAPON], 8],
  ["dmgMax", 2, "Razored", "prefix", 5, 10, 16, [...WEAPON], 4],
  ["toHitPct", 1, "Precise", "prefix", 10, 25, 5, [...WEAPON], 6],
  ["critPct", 1, "Deadly", "prefix", 3, 6, 10, ["weapon", "ring", "amulet"], 6],
  ["critPct", 2, "Lethal", "prefix", 7, 10, 22, ["weapon", "ring", "amulet"], 3],
  ["critDmgPct", 1, "of Slaying", "suffix", 10, 20, 14, ["weapon", "amulet"], 5],
  ["attackSpeed", 1, "of Haste", "suffix", 5, 10, 4, [...WEAPON], 8],
  ["attackSpeed", 2, "of Swiftness", "suffix", 11, 20, 16, [...WEAPON], 4],
  // Elemental damage
  ["fireDmg", 1, "Fiery", "prefix", 2, 5, 6, [...WEAPON], 7],
  ["fireDmg", 2, "Blazing", "prefix", 6, 12, 18, [...WEAPON], 4],
  ["coldDmg", 1, "Frosted", "prefix", 2, 5, 6, [...WEAPON], 7],
  ["coldDmg", 2, "Glacial", "prefix", 6, 12, 18, [...WEAPON], 4],
  ["lightningDmg", 1, "Sparking", "prefix", 2, 5, 8, [...WEAPON], 7],
  ["lightningDmg", 2, "Thunderous", "prefix", 6, 12, 20, [...WEAPON], 4],
  ["poisonDmg", 1, "Venomous", "prefix", 2, 5, 10, [...WEAPON], 7],
  ["poisonDmg", 2, "Toxic", "prefix", 6, 12, 22, [...WEAPON], 4],
  // Spells, speed and mobility
  ["castSpeed", 1, "of Quickening", "suffix", 5, 10, 4, ["weapon", "helm", "ring", "amulet"], 8],
  ["castSpeed", 2, "of Rapidity", "suffix", 11, 18, 16, ["weapon", "helm", "ring", "amulet"], 4],
  ["moveSpeed", 1, "of the Hare", "suffix", 5, 10, 6, ["boots", "ring", "amulet"], 8],
  ["moveSpeed", 2, "of the Gazelle", "suffix", 11, 18, 18, ["boots", "ring", "amulet"], 4],
  ["magicFind", 1, "of the Magpie", "suffix", 10, 20, 8, ["helm", "ring", "amulet"], 6],
  ["goldFind", 1, "of the Miser", "suffix", 10, 20, 8, ["helm", "ring", "amulet"], 6],
  ["lightRadius", 1, "of the Lantern", "suffix", 1, 2, 3, ["helm", "ring", "amulet"], 6],
  ["potionPct", 1, "of Apothecary", "suffix", 10, 25, 10, ["helm", "ring", "amulet"], 5],
  ["manaRegenPct", 1, "of Renewal", "suffix", 10, 25, 12, ["ring", "amulet"], 5],
  // Resistances
  ["resFire", 1, "of Embers", "suffix", 8, 15, 5, ELEMENTAL_RES, 8],
  ["resFire", 2, "of the Furnace", "suffix", 16, 25, 20, ELEMENTAL_RES, 4],
  ["resCold", 1, "of Frost", "suffix", 8, 15, 5, ELEMENTAL_RES, 8],
  ["resCold", 2, "of the Glacier", "suffix", 16, 25, 20, ELEMENTAL_RES, 4],
  ["resLightning", 1, "of Thunder", "suffix", 8, 15, 5, ELEMENTAL_RES, 8],
  ["resLightning", 2, "of the Storm", "suffix", 16, 25, 20, ELEMENTAL_RES, 4],
  ["resPoison", 1, "of Clean Air", "suffix", 8, 15, 5, ELEMENTAL_RES, 8],
  ["resPoison", 2, "of the Mire", "suffix", 16, 25, 20, ELEMENTAL_RES, 4],
  // Sustain
  ["lifeSteal", 1, "of Leeching", "suffix", 2, 4, 18, [...WEAPON], 4],
  ["manaSteal", 1, "of Siphoning", "suffix", 2, 4, 14, [...WEAPON], 4],
  ["lifeOnKill", 1, "of the Reaper", "suffix", 2, 5, 12, ["weapon", "ring", "amulet"], 4],
  ["manaOnKill", 1, "of the Wisp", "suffix", 1, 3, 12, ["weapon", "ring", "amulet"], 4],
];

function build(): Record<string, AffixProto> {
  const out: Record<string, AffixProto> = {};
  for (const [stat, tier, name, kind, min, max, ilvl, categories, weight] of ROWS) {
    out[`classic.affix.${stat}.${tier}`] = {
      name,
      kind,
      group: stat,
      stat,
      min,
      max,
      ilvl,
      categories: [...categories],
      weight,
    };
  }
  return out;
}

export const AFFIXES: Record<string, AffixProto> = build();
