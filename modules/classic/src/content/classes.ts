/**
 * Hero classes (design §6.1). Starter gear and potions are base ids from
 * items.ts; skill ids from skills.ts. Attribute blocks and life/mana growth
 * follow the table; autoAlloc sums to statPointsPerLevel (5).
 */
import type { ClassProto } from "../types.ts";

export const CLASSES: Record<string, ClassProto> = {
  "classic.warrior": {
    name: "Warrior",
    description:
      "A sturdy front-liner. Strength adds weapon damage, and rallying cries keep the line standing.",
    appearance: "unit.hero.warrior",
    tint: 0xd9b26f,
    base: { str: 30, dex: 20, mag: 10, vit: 25 },
    life: { base: 50, perVit: 3, perLevel: 3 },
    // Playtest: 20-odd mana at level 7 left whirl and mend unused.
    mana: { base: 10, perMag: 1, perLevel: 2 },
    primary: "str",
    autoAlloc: { str: 2, dex: 1, mag: 0, vit: 2 },
    skills: [
      "classic.skill.attack",
      "classic.skill.cleave",
      "classic.skill.rally",
      "classic.skill.mend",
      "classic.skill.whirl",
      "classic.skill.charge",
      "classic.skill.quake_stomp",
      "classic.skill.iron_skin",
      "classic.skill.sky_leap",
    ],
    startingSkills: ["classic.skill.attack", "classic.skill.cleave"],
    defaultBar: ["classic.skill.attack", "classic.skill.cleave", null, null, null, null],
    autoSkillOrder: [
      "classic.skill.cleave",
      "classic.skill.rally",
      "classic.skill.whirl",
      "classic.skill.charge",
      "classic.skill.mend",
    ],
    starterItems: ["classic.item.short_sword", "classic.item.buckler", "classic.item.leather_cap"],
    starterPotions: [{ base: "classic.item.potion_life_1", count: 4 }],
    moveSpeed: 51,
  },
  "classic.rogue": {
    name: "Rogue",
    description:
      "A quick ranged skirmisher. Dexterity adds weapon damage, and poison and sentries do the rest.",
    appearance: "unit.hero.rogue",
    tint: 0x7fbf6a,
    base: { str: 20, dex: 30, mag: 15, vit: 20 },
    life: { base: 48, perVit: 2, perLevel: 3 },
    // Playtest: the rogue was mana-starved (44 mana at level 8) and killed at half the others' rate.
    mana: { base: 20, perMag: 2, perLevel: 2 },
    primary: "dex",
    autoAlloc: { str: 1, dex: 3, mag: 0, vit: 1 },
    skills: [
      "classic.skill.attack",
      "classic.skill.multishot",
      "classic.skill.venom_shot",
      "classic.skill.mend",
      "classic.skill.spark_sentry",
      "classic.skill.tumble",
      "classic.skill.piercing_shot",
      "classic.skill.caltrops",
      "classic.skill.night_volley",
    ],
    startingSkills: ["classic.skill.attack", "classic.skill.multishot"],
    defaultBar: ["classic.skill.attack", "classic.skill.multishot", null, null, null, null],
    autoSkillOrder: [
      "classic.skill.multishot",
      "classic.skill.venom_shot",
      "classic.skill.spark_sentry",
      "classic.skill.mend",
      // Wave A: replaces tumble, which Auto never cast; the bar holds four extras.
      "classic.skill.piercing_shot",
    ],
    starterItems: ["classic.item.hunting_bow", "classic.item.padded_vest"],
    starterPotions: [
      { base: "classic.item.potion_life_1", count: 3 },
      { base: "classic.item.potion_mana_1", count: 1 },
    ],
    moveSpeed: 51,
  },
  "classic.sorcerer": {
    name: "Sorcerer",
    description:
      "A frail caster who wins from range. Magic adds spell damage, and elements do the rest.",
    appearance: "unit.hero.sorcerer",
    tint: 0x9d7bff,
    base: { str: 15, dex: 20, mag: 35, vit: 15 },
    life: { base: 30, perVit: 2, perLevel: 1 },
    mana: { base: 25, perMag: 2, perLevel: 2 },
    // Magic drives the staff's damage and the gear score, like the auto allocation.
    primary: "mag",
    autoAlloc: { str: 0, dex: 1, mag: 3, vit: 1 },
    skills: [
      "classic.skill.attack",
      "classic.skill.ember_bolt",
      "classic.skill.frost_ring",
      "classic.skill.mend",
      "classic.skill.arc_chain",
      "classic.skill.cinder_orb",
      "classic.skill.phase_step",
      "classic.skill.glacial_spike",
      "classic.skill.storm_call",
      "classic.skill.falling_star",
    ],
    startingSkills: ["classic.skill.attack", "classic.skill.ember_bolt"],
    defaultBar: ["classic.skill.attack", "classic.skill.ember_bolt", null, null, null, null],
    autoSkillOrder: [
      "classic.skill.ember_bolt",
      "classic.skill.frost_ring",
      "classic.skill.arc_chain",
      "classic.skill.cinder_orb",
      "classic.skill.phase_step",
      "classic.skill.mend",
    ],
    starterItems: ["classic.item.gnarled_staff"],
    starterPotions: [
      { base: "classic.item.potion_life_1", count: 2 },
      { base: "classic.item.potion_mana_1", count: 2 },
    ],
    moveSpeed: 51,
  },
};
