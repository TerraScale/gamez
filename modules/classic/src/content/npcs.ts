/**
 * Town NPCs (design §9.1). Appearance follows the role ("unit.npc.<role>").
 * The smith restocks from the dungeon; the alchemist sells every potion base
 * and town portal scrolls; the junk buyer is the only lowball sink.
 */
import type { NpcProto } from "../types.ts";
import { UNKNOWN_ART } from "./monsters.ts";

const POTION_IDS: string[] = [
  "classic.item.potion_life_1",
  "classic.item.potion_life_2",
  "classic.item.potion_life_3",
  "classic.item.potion_life_4",
  "classic.item.potion_mana_1",
  "classic.item.potion_mana_2",
  "classic.item.potion_mana_3",
  "classic.item.potion_rejuv",
];

export const NPCS: Record<string, NpcProto> = {
  "classic.npc.maren": {
    name: "Sister Maren",
    title: "Healer",
    role: "healer",
    appearance: "unit.npc.healer",
    fallbackAppearance: UNKNOWN_ART,
    tint: 0xf5f0ff,
    buyPct: 0,
    greeting: "Rest, traveller. The light will mend what the dark has done.",
  },
  "classic.npc.brannoc": {
    name: "Brannoc",
    title: "Smith",
    role: "smith",
    appearance: "unit.npc.smith",
    fallbackAppearance: UNKNOWN_ART,
    tint: 0xc0a080,
    sells: {
      // 12 items incl. jewelry and rares (vendor.ts): the smith is the main late gold sink.
      categories: ["weapon", "shield", "helm", "armor", "gloves", "boots", "ring", "amulet"],
      count: 12,
      potions: [],
      tpScroll: false,
    },
    buyPct: 0,
    greeting: "Good steel at a fair price. Bring me what you find down there.",
  },
  "classic.npc.ysolde": {
    name: "Ysolde",
    title: "Alchemist",
    role: "alchemist",
    appearance: "unit.npc.alchemist",
    fallbackAppearance: UNKNOWN_ART,
    tint: 0x9fe0a0,
    sells: {
      categories: [],
      count: 0,
      potions: POTION_IDS,
      tpScroll: true,
    },
    buyPct: 0,
    greeting: "Mind the colours, they bite. What do you need brewed?",
  },
  "classic.npc.old_pell": {
    name: "Old Pell",
    title: "Rag Buyer",
    role: "junk",
    appearance: "unit.npc.junk",
    fallbackAppearance: UNKNOWN_ART,
    tint: 0xb8a890,
    buyPct: 10,
    greeting: "Anything you don't need, I'll take off your hands. Cheap, mind.",
  },
  "classic.npc.captain_hale": {
    name: "Captain Hale",
    title: "Watch Captain",
    role: "quest",
    appearance: "unit.npc.quest",
    fallbackAppearance: UNKNOWN_ART,
    tint: 0xe0c060,
    buyPct: 0,
    greeting: "The town needs someone brave, and you look like you have been looking for work.",
  },
};
