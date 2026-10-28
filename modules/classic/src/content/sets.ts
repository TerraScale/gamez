/**
 * Item sets (wave A, docs/design/wave-A.md §5.1). OWNER: T-itemcontent.
 * SetProto ids "classic.set.<name>", SetItemProto ids "classic.setItem.<name>".
 *
 * Eight sets: two themed per class (an early one around ilvl 8-15 and a late
 * one around ilvl 30-40) and two generic sets (classId null). Four pieces
 * each, in four different slots. Bonuses at 2, 3 and 4 different pieces.
 * Piece ilvl is never below its base ilvl (rules: base ilvl gates the base).
 */
import type { SetItemProto, SetProto } from "../types.ts";

export const SETS: Record<string, SetProto> = {
  // ---- warrior: early ----
  "classic.set.ashen_choir": {
    name: "Vow of the Ashen Choir",
    classId: "classic.warrior",
    pieces: [
      "classic.setItem.ashen_choir_helm",
      "classic.setItem.ashen_choir_blade",
      "classic.setItem.ashen_choir_gauntlets",
      "classic.setItem.ashen_choir_hauberk",
    ],
    bonuses: [
      { count: 2, mods: [{ stat: "critPct", value: 4 }] },
      {
        count: 3,
        mods: [
          { stat: "dmgPct", value: 15 },
          { stat: "life", value: 15 },
        ],
      },
      {
        count: 4,
        mods: [
          { stat: "dmgPct", value: 25 },
          { stat: "life", value: 30 },
          { stat: "resFire", value: 15 },
        ],
      },
    ],
  },
  // ---- warrior: late ----
  "classic.set.iron_vigil": {
    name: "Iron Vigil",
    classId: "classic.warrior",
    pieces: [
      "classic.setItem.iron_vigil_bastion",
      "classic.setItem.iron_vigil_plate",
      "classic.setItem.iron_vigil_helm",
      "classic.setItem.iron_vigil_longsword",
    ],
    bonuses: [
      {
        count: 2,
        mods: [
          { stat: "life", value: 25 },
          { stat: "armorPct", value: 10 },
        ],
      },
      {
        count: 3,
        mods: [
          { stat: "dmgPct", value: 20 },
          { stat: "resAll", value: 8 },
        ],
      },
      {
        count: 4,
        mods: [
          { stat: "armor", value: 20 },
          { stat: "life", value: 50 },
          { stat: "thorns", value: 6 },
        ],
      },
    ],
  },
  // ---- rogue: early ----
  "classic.set.quicksilver_veil": {
    name: "Quicksilver Veil",
    classId: "classic.rogue",
    pieces: [
      "classic.setItem.quicksilver_cap",
      "classic.setItem.quicksilver_dirk",
      "classic.setItem.quicksilver_greaves",
      "classic.setItem.quicksilver_band",
    ],
    bonuses: [
      {
        count: 2,
        mods: [
          { stat: "dex", value: 4 },
          { stat: "moveSpeed", value: 5 },
        ],
      },
      {
        count: 3,
        mods: [
          { stat: "critPct", value: 4 },
          { stat: "attackSpeed", value: 5 },
        ],
      },
      {
        count: 4,
        mods: [
          { stat: "critDmgPct", value: 15 },
          { stat: "dex", value: 8 },
          { stat: "moveSpeed", value: 10 },
        ],
      },
    ],
  },
  // ---- rogue: late ----
  "classic.set.hollow_wings": {
    name: "Hollow Wings",
    classId: "classic.rogue",
    pieces: [
      "classic.setItem.hollow_wings_bow",
      "classic.setItem.hollow_wings_greaves",
      "classic.setItem.hollow_wings_pendant",
      "classic.setItem.hollow_wings_ring",
    ],
    bonuses: [
      {
        count: 2,
        mods: [
          { stat: "dex", value: 8 },
          { stat: "attackSpeed", value: 5 },
        ],
      },
      {
        count: 3,
        mods: [
          { stat: "critPct", value: 6 },
          { stat: "dmgPct", value: 20 },
        ],
      },
      {
        count: 4,
        mods: [
          { stat: "critDmgPct", value: 25 },
          { stat: "moveSpeed", value: 15 },
          { stat: "dex", value: 14 },
        ],
      },
    ],
  },
  // ---- sorcerer: early ----
  "classic.set.ember_codex": {
    name: "Ember Codex",
    classId: "classic.sorcerer",
    pieces: [
      "classic.setItem.ember_codex_staff",
      "classic.setItem.ember_codex_cap",
      "classic.setItem.ember_codex_pendant",
      "classic.setItem.ember_codex_band",
    ],
    bonuses: [
      {
        count: 2,
        mods: [
          { stat: "spellPct", value: 8 },
          { stat: "mana", value: 15 },
        ],
      },
      {
        count: 3,
        mods: [
          { stat: "castSpeed", value: 8 },
          { stat: "fireDmg", value: 3 },
        ],
      },
      {
        count: 4,
        mods: [
          { stat: "spellPct", value: 15 },
          { stat: "resFire", value: 15 },
          { stat: "manaPct", value: 12 },
        ],
      },
    ],
  },
  // ---- sorcerer: late ----
  "classic.set.stormbinder": {
    name: "Stormbinder's Regalia",
    classId: "classic.sorcerer",
    pieces: [
      "classic.setItem.stormbinder_staff",
      "classic.setItem.stormbinder_vestments",
      "classic.setItem.stormbinder_circlet",
      "classic.setItem.stormbinder_pendant",
    ],
    bonuses: [
      {
        count: 2,
        mods: [
          { stat: "spellPct", value: 12 },
          { stat: "lightningDmg", value: 4 },
        ],
      },
      {
        count: 3,
        mods: [
          { stat: "castSpeed", value: 12 },
          { stat: "mana", value: 40 },
        ],
      },
      {
        count: 4,
        mods: [
          { stat: "spellPct", value: 25 },
          { stat: "resLightning", value: 20 },
          { stat: "lightningDmg", value: 8 },
        ],
      },
    ],
  },
  // ---- generic (any class) ----
  "classic.set.wayfarer": {
    name: "Wayfarer's Kit",
    classId: null,
    pieces: [
      "classic.setItem.wayfarer_aegis",
      "classic.setItem.wayfarer_boots",
      "classic.setItem.wayfarer_charm",
      "classic.setItem.wayfarer_visage",
    ],
    bonuses: [
      {
        count: 2,
        mods: [
          { stat: "vit", value: 4 },
          { stat: "life", value: 15 },
        ],
      },
      {
        count: 3,
        mods: [
          { stat: "resAll", value: 6 },
          { stat: "moveSpeed", value: 8 },
        ],
      },
      {
        count: 4,
        mods: [
          { stat: "allAttrs", value: 3 },
          { stat: "life", value: 40 },
          { stat: "resAll", value: 10 },
        ],
      },
    ],
  },
  "classic.set.sunken_crown": {
    name: "Sunken Crown",
    classId: null,
    pieces: [
      "classic.setItem.sunken_aegis",
      "classic.setItem.sunken_signet",
      "classic.setItem.sunken_medallion",
      "classic.setItem.sunken_grips",
    ],
    bonuses: [
      {
        count: 2,
        mods: [
          { stat: "resAll", value: 6 },
          { stat: "life", value: 30 },
        ],
      },
      {
        count: 3,
        mods: [
          { stat: "armorPct", value: 20 },
          { stat: "lifeRegen", value: 15 },
        ],
      },
      {
        count: 4,
        mods: [
          { stat: "resAll", value: 14 },
          { stat: "allAttrs", value: 4 },
          { stat: "life", value: 60 },
        ],
      },
    ],
  },
};

export const SET_ITEMS: Record<string, SetItemProto> = {
  // Vow of the Ashen Choir (warrior, early)
  "classic.setItem.ashen_choir_helm": {
    name: "Ashen Choir Helm",
    set: "classic.set.ashen_choir",
    base: "classic.item.iron_helm",
    ilvl: 10,
    mods: [
      { stat: "resFire", min: 8, max: 14 },
      { stat: "vit", min: 3, max: 5 },
    ],
    weight: 10,
  },
  "classic.setItem.ashen_choir_blade": {
    name: "Ashen Choir Blade",
    set: "classic.set.ashen_choir",
    base: "classic.item.war_axe",
    ilvl: 10,
    mods: [
      { stat: "dmgPct", min: 15, max: 25 },
      { stat: "fireDmg", min: 2, max: 4 },
    ],
    weight: 8,
  },
  "classic.setItem.ashen_choir_gauntlets": {
    name: "Ashen Choir Gauntlets",
    set: "classic.set.ashen_choir",
    base: "classic.item.mail_gauntlets",
    ilvl: 12,
    mods: [
      { stat: "life", min: 10, max: 16 },
      { stat: "str", min: 3, max: 5 },
    ],
    weight: 10,
  },
  "classic.setItem.ashen_choir_hauberk": {
    name: "Ashen Choir Hauberk",
    set: "classic.set.ashen_choir",
    base: "classic.item.chain_mail",
    ilvl: 14,
    mods: [
      { stat: "armor", min: 10, max: 16 },
      { stat: "life", min: 8, max: 12 },
    ],
    weight: 8,
  },
  // Iron Vigil (warrior, late)
  "classic.setItem.iron_vigil_bastion": {
    name: "Iron Vigil Bastion",
    set: "classic.set.iron_vigil",
    base: "classic.item.bastion_shield",
    ilvl: 30,
    mods: [
      { stat: "blockPct", min: 15, max: 22 },
      { stat: "armorPct", min: 25, max: 40 },
    ],
    weight: 6,
  },
  "classic.setItem.iron_vigil_plate": {
    name: "Iron Vigil Plate",
    set: "classic.set.iron_vigil",
    base: "classic.item.vigil_plate",
    ilvl: 32,
    mods: [
      { stat: "armorPct", min: 30, max: 45 },
      { stat: "resAll", min: 8, max: 12 },
    ],
    weight: 6,
  },
  "classic.setItem.iron_vigil_helm": {
    name: "Iron Vigil Helm",
    set: "classic.set.iron_vigil",
    base: "classic.item.war_helm",
    ilvl: 32,
    mods: [
      { stat: "str", min: 8, max: 12 },
      { stat: "lifePct", min: 12, max: 18 },
    ],
    weight: 6,
  },
  "classic.setItem.iron_vigil_longsword": {
    name: "Iron Vigil Longsword",
    set: "classic.set.iron_vigil",
    base: "classic.item.ember_longsword",
    ilvl: 30,
    mods: [
      { stat: "dmgPct", min: 40, max: 60 },
      { stat: "critPct", min: 4, max: 7 },
    ],
    weight: 6,
  },
  // Quicksilver Veil (rogue, early)
  "classic.setItem.quicksilver_cap": {
    name: "Quicksilver Cap",
    set: "classic.set.quicksilver_veil",
    base: "classic.item.leather_cap",
    ilvl: 8,
    mods: [
      { stat: "dex", min: 3, max: 5 },
      { stat: "magicFind", min: 6, max: 10 },
    ],
    weight: 10,
  },
  "classic.setItem.quicksilver_dirk": {
    name: "Quicksilver Dirk",
    set: "classic.set.quicksilver_veil",
    base: "classic.item.dagger",
    ilvl: 8,
    mods: [
      { stat: "dmgMin", min: 2, max: 3 },
      { stat: "critPct", min: 3, max: 5 },
    ],
    weight: 8,
  },
  "classic.setItem.quicksilver_greaves": {
    name: "Quicksilver Greaves",
    set: "classic.set.quicksilver_veil",
    base: "classic.item.greaves",
    ilvl: 10,
    mods: [
      { stat: "moveSpeed", min: 6, max: 10 },
      { stat: "armor", min: 4, max: 6 },
    ],
    weight: 10,
  },
  "classic.setItem.quicksilver_band": {
    name: "Quicksilver Band",
    set: "classic.set.quicksilver_veil",
    base: "classic.item.iron_ring",
    ilvl: 10,
    mods: [
      { stat: "goldFind", min: 10, max: 18 },
      { stat: "lifeRegen", min: 5, max: 10 },
    ],
    weight: 8,
  },
  // Hollow Wings (rogue, late)
  "classic.setItem.hollow_wings_bow": {
    name: "Hollow Wing Bow",
    set: "classic.set.hollow_wings",
    base: "classic.item.nightwing_bow",
    ilvl: 32,
    mods: [
      { stat: "dmgPct", min: 30, max: 45 },
      { stat: "critPct", min: 4, max: 6 },
    ],
    weight: 6,
  },
  "classic.setItem.hollow_wings_greaves": {
    name: "Hollow Wing Greaves",
    set: "classic.set.hollow_wings",
    base: "classic.item.stormrunner_greaves",
    ilvl: 36,
    mods: [
      { stat: "moveSpeed", min: 18, max: 24 },
      { stat: "dex", min: 8, max: 12 },
    ],
    weight: 6,
  },
  "classic.setItem.hollow_wings_pendant": {
    name: "Hollow Wing Pendant",
    set: "classic.set.hollow_wings",
    base: "classic.item.shadowglass_amulet",
    ilvl: 38,
    mods: [
      { stat: "critPct", min: 5, max: 8 },
      { stat: "lifeOnKill", min: 3, max: 5 },
    ],
    weight: 6,
  },
  "classic.setItem.hollow_wings_ring": {
    name: "Hollow Wing Ring",
    set: "classic.set.hollow_wings",
    base: "classic.item.eclipse_ring",
    ilvl: 40,
    mods: [
      { stat: "critDmgPct", min: 15, max: 25 },
      { stat: "allAttrs", min: 2, max: 3 },
    ],
    weight: 6,
  },
  // Ember Codex (sorcerer, early)
  "classic.setItem.ember_codex_staff": {
    name: "Ember Codex Staff",
    set: "classic.set.ember_codex",
    base: "classic.item.runed_staff",
    ilvl: 15,
    mods: [
      { stat: "mag", min: 3, max: 5 },
      { stat: "fireDmg", min: 3, max: 6 },
    ],
    weight: 8,
  },
  "classic.setItem.ember_codex_cap": {
    name: "Ember Codex Cap",
    set: "classic.set.ember_codex",
    base: "classic.item.leather_cap",
    ilvl: 12,
    mods: [
      { stat: "mag", min: 2, max: 4 },
      { stat: "resFire", min: 6, max: 10 },
    ],
    weight: 10,
  },
  "classic.setItem.ember_codex_pendant": {
    name: "Ember Codex Pendant",
    set: "classic.set.ember_codex",
    base: "classic.item.jade_amulet",
    ilvl: 15,
    mods: [
      { stat: "mana", min: 10, max: 16 },
      { stat: "spellPct", min: 6, max: 10 },
    ],
    weight: 8,
  },
  "classic.setItem.ember_codex_band": {
    name: "Ember Codex Band",
    set: "classic.set.ember_codex",
    base: "classic.item.jade_ring",
    ilvl: 12,
    mods: [
      { stat: "manaRegenPct", min: 15, max: 25 },
      { stat: "castSpeed", min: 5, max: 8 },
    ],
    weight: 8,
  },
  // Stormbinder's Regalia (sorcerer, late)
  "classic.setItem.stormbinder_staff": {
    name: "Stormbinder Staff",
    set: "classic.set.stormbinder",
    base: "classic.item.abyssal_staff",
    ilvl: 40,
    mods: [
      { stat: "mana", min: 25, max: 40 },
      { stat: "spellPct", min: 20, max: 30 },
    ],
    weight: 6,
  },
  "classic.setItem.stormbinder_vestments": {
    name: "Stormbinder Vestments",
    set: "classic.set.stormbinder",
    base: "classic.item.stormbinder_robe",
    ilvl: 36,
    mods: [
      { stat: "mag", min: 14, max: 20 },
      { stat: "resLightning", min: 25, max: 35 },
    ],
    weight: 6,
  },
  "classic.setItem.stormbinder_circlet": {
    name: "Stormbinder Circlet",
    set: "classic.set.stormbinder",
    base: "classic.item.circlet_of_tides",
    ilvl: 34,
    mods: [
      { stat: "castSpeed", min: 10, max: 15 },
      { stat: "manaRegenPct", min: 30, max: 45 },
    ],
    weight: 6,
  },
  "classic.setItem.stormbinder_pendant": {
    name: "Stormbinder Pendant",
    set: "classic.set.stormbinder",
    base: "classic.item.sunstone_pendant",
    ilvl: 34,
    mods: [
      { stat: "spellPct", min: 15, max: 25 },
      { stat: "lightningDmg", min: 6, max: 10 },
    ],
    weight: 6,
  },
  // Wayfarer's Kit (generic)
  "classic.setItem.wayfarer_aegis": {
    name: "Wayfarer's Aegis",
    set: "classic.set.wayfarer",
    base: "classic.item.kite_shield",
    ilvl: 16,
    mods: [
      { stat: "blockPct", min: 5, max: 9 },
      { stat: "armorPct", min: 8, max: 14 },
    ],
    weight: 8,
  },
  "classic.setItem.wayfarer_boots": {
    name: "Wayfarer's Boots",
    set: "classic.set.wayfarer",
    base: "classic.item.war_boots",
    ilvl: 16,
    mods: [
      { stat: "moveSpeed", min: 6, max: 10 },
      { stat: "life", min: 8, max: 14 },
    ],
    weight: 8,
  },
  "classic.setItem.wayfarer_charm": {
    name: "Wayfarer's Charm",
    set: "classic.set.wayfarer",
    base: "classic.item.bone_amulet",
    ilvl: 18,
    mods: [
      { stat: "mag", min: 3, max: 5 },
      { stat: "manaRegenPct", min: 10, max: 18 },
    ],
    weight: 8,
  },
  "classic.setItem.wayfarer_visage": {
    name: "Wayfarer's Visage",
    set: "classic.set.wayfarer",
    base: "classic.item.great_helm",
    ilvl: 20,
    mods: [
      { stat: "resCold", min: 10, max: 16 },
      { stat: "str", min: 4, max: 7 },
    ],
    weight: 8,
  },
  // Sunken Crown (generic, late)
  "classic.setItem.sunken_aegis": {
    name: "Sunken Aegis",
    set: "classic.set.sunken_crown",
    base: "classic.item.sunward_aegis",
    ilvl: 40,
    mods: [
      { stat: "blockPct", min: 18, max: 24 },
      { stat: "resAll", min: 8, max: 12 },
    ],
    weight: 6,
  },
  "classic.setItem.sunken_signet": {
    name: "Sunken Signet",
    set: "classic.set.sunken_crown",
    base: "classic.item.sigil_ring",
    ilvl: 40,
    mods: [
      { stat: "manaRegenPct", min: 25, max: 40 },
      { stat: "allAttrs", min: 1, max: 2 },
    ],
    weight: 6,
  },
  "classic.setItem.sunken_medallion": {
    name: "Sunken Medallion",
    set: "classic.set.sunken_crown",
    base: "classic.item.choir_medallion",
    ilvl: 44,
    mods: [
      { stat: "life", min: 35, max: 55 },
      { stat: "lifeOnKill", min: 4, max: 7 },
    ],
    weight: 6,
  },
  "classic.setItem.sunken_grips": {
    name: "Sunken Grips",
    set: "classic.set.sunken_crown",
    base: "classic.item.gauntlets_of_the_deep",
    ilvl: 40,
    mods: [
      { stat: "poisonDmg", min: 8, max: 14 },
      { stat: "resPoison", min: 20, max: 30 },
    ],
    weight: 6,
  },
};
