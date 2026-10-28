/**
 * Unique items (design §11.2): a fixed base, an ilvl at or above the base's,
 * and rolled mods within the given ranges. Flavour text is original.
 */
import type { UniqueProto } from "../types.ts";

export const UNIQUES: Record<string, UniqueProto> = {
  "classic.unique.ember_oath": {
    name: "Ember Oath",
    base: "classic.item.broadsword",
    ilvl: 6,
    mods: [
      { stat: "dmgPct", min: 30, max: 50 },
      { stat: "fireDmg", min: 3, max: 8 },
    ],
    weight: 4,
    flavor: "Sworn over a fire that never went out. The blade still remembers the oath.",
  },
  "classic.unique.warden_mantle": {
    name: "Warden's Mantle",
    base: "classic.item.chain_mail",
    ilvl: 12,
    mods: [
      { stat: "armorPct", min: 20, max: 40 },
      { stat: "life", min: 20, max: 40 },
    ],
    weight: 3,
    flavor: "Worn by a gatekeeper who never once opened the gate.",
  },
  "classic.unique.hawk_treads": {
    name: "Hawk's Treads",
    base: "classic.item.war_boots",
    ilvl: 14,
    mods: [
      { stat: "moveSpeed", min: 15, max: 25 },
      { stat: "dex", min: 8, max: 14 },
    ],
    weight: 4,
    flavor: "They never seem to touch the ground the way ordinary boots do.",
  },
  "classic.unique.drowned_choir_hook": {
    name: "Hook of the Drowned Choir",
    base: "classic.item.war_axe",
    ilvl: 10,
    mods: [
      { stat: "lifeSteal", min: 3, max: 6 },
      { stat: "critPct", min: 5, max: 8 },
    ],
    weight: 3,
    flavor: "Hums a hymn for the lost, and drinks a little of the living to keep singing.",
  },
  "classic.unique.cinder_crown": {
    name: "Cinder Crown",
    base: "classic.item.great_helm",
    ilvl: 14,
    mods: [
      { stat: "resFire", min: 30, max: 40 },
      { stat: "castSpeed", min: 10, max: 15 },
      { stat: "mag", min: 5, max: 10 },
    ],
    weight: 3,
    flavor: "The last crown of a court that burned itself down for warmth.",
  },
  "classic.unique.frostbitten_gauntlets": {
    name: "Frostbitten Gauntlets",
    base: "classic.item.mail_gauntlets",
    ilvl: 10,
    mods: [
      { stat: "coldDmg", min: 4, max: 8 },
      { stat: "resCold", min: 25, max: 35 },
    ],
    weight: 3,
    flavor: "Cold to the touch, even in the hottest forge.",
  },
  "classic.unique.shardwake_staff": {
    name: "Shardwake Staff",
    base: "classic.item.runed_staff",
    ilvl: 14,
    mods: [
      { stat: "mag", min: 10, max: 20 },
      { stat: "spellPct", min: 25, max: 40 },
      { stat: "manaPct", min: 20, max: 30 },
    ],
    weight: 2,
    flavor: "Each shard wakes a little more of the sleeping mage inside.",
  },
  "classic.unique.the_long_quiet": {
    name: "The Long Quiet",
    base: "classic.item.long_bow",
    ilvl: 12,
    mods: [
      { stat: "dmgPct", min: 40, max: 60 },
      { stat: "critPct", min: 6, max: 10 },
    ],
    weight: 2,
    flavor: "Nothing is heard when it is drawn, and nothing answers when it sings.",
  },
  "classic.unique.oath_of_the_ninth": {
    name: "Oath of the Ninth",
    base: "classic.item.jade_amulet",
    ilvl: 15,
    mods: [
      { stat: "allSkills", min: 1, max: 2 },
      { stat: "allAttrs", min: 2, max: 4 },
    ],
    weight: 1,
    flavor: "The ninth flame gave this to the first one who did not run.",
  },
  "classic.unique.quiet_tides": {
    name: "Ring of Quiet Tides",
    base: "classic.item.jade_ring",
    ilvl: 12,
    mods: [
      { stat: "manaRegenPct", min: 30, max: 50 },
      { stat: "lifeRegen", min: 10, max: 20 },
    ],
    weight: 3,
    flavor: "The sea goes still around the wearer, and so does the pain.",
  },
  "classic.unique.ashen_plate": {
    name: "Ashen Plate",
    base: "classic.item.plate_armor",
    ilvl: 20,
    mods: [
      { stat: "armorPct", min: 40, max: 60 },
      { stat: "resAll", min: 10, max: 15 },
    ],
    weight: 2,
    flavor: "Still warm from the pyre it was taken from.",
  },
  "classic.unique.wardens_last_word": {
    name: "Warden's Last Word",
    base: "classic.item.mace",
    ilvl: 4,
    mods: [
      { stat: "dmgPct", min: 25, max: 40 },
      { stat: "str", min: 4, max: 8 },
      { stat: "lifeOnKill", min: 3, max: 6 },
    ],
    weight: 3,
    flavor: "A warden's final argument, which nobody has ever won against.",
  },
  "classic.unique.tempest_caller": {
    name: "Tempest Caller",
    base: "classic.item.tempest_wand",
    ilvl: 20,
    mods: [
      { stat: "lightningDmg", min: 8, max: 14 },
      { stat: "spellPct", min: 20, max: 35 },
      { stat: "castSpeed", min: 10, max: 15 },
    ],
    weight: 2,
    flavor: "Whoever calls the storm must give up a little of the sky.",
  },
  "classic.unique.bulwark_of_ashes": {
    name: "Bulwark of Ashes",
    base: "classic.item.tower_shield",
    ilvl: 18,
    mods: [
      { stat: "blockPct", min: 15, max: 20 },
      { stat: "thorns", min: 6, max: 12 },
      { stat: "resFire", min: 20, max: 30 },
    ],
    weight: 2,
    flavor: "Every blow it takes leaves a scorch mark on whoever swung.",
  },
  "classic.unique.quarry_tooth": {
    name: "Quarry Tooth",
    base: "classic.item.greataxe",
    ilvl: 22,
    mods: [
      { stat: "dmgPct", min: 50, max: 80 },
      { stat: "life", min: 20, max: 40 },
    ],
    weight: 2,
    flavor: "Cut from the jaw of a stone beast that tried to eat the mountain.",
  },
};
