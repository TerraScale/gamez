/**
 * Champion and unique monster modifiers (design §8.2). Rolled per pack
 * (champion packs: one mod, two from depth 9; unique leaders: two, three
 * from depth 9). Percent fields are integer percent points.
 */
import type { MonsterModProto } from "../types.ts";

const BASE: MonsterModProto = {
  name: "",
  lifePct: 0,
  dmgPct: 0,
  speedPct: 0,
  armorPct: 0,
  lifeStealPct: 0,
  blinkEvery: 0,
  extraProjectiles: 0,
  resistAll: 0,
  tint: 0xffffff,
  minDepth: 1,
};

export const MONSTER_MODS: Record<string, MonsterModProto> = {
  "classic.mod.mighty": { ...BASE, name: "Mighty", dmgPct: 100, tint: 0xff4444, minDepth: 1 },
  "classic.mod.swift": { ...BASE, name: "Swift", speedPct: 50, tint: 0x66ffcc, minDepth: 1 },
  "classic.mod.stoneskin": {
    ...BASE,
    name: "Stoneskin",
    lifePct: 50,
    armorPct: 100,
    tint: 0xaaaaaa,
    minDepth: 1,
  },
  "classic.mod.emberbound": {
    ...BASE,
    name: "Emberbound",
    addElement: { element: "fire", pct: 50 },
    onDeathSkill: "classic.mskill.ember_burst",
    tint: 0xff6a2a,
    minDepth: 2,
  },
  "classic.mod.rimebound": {
    ...BASE,
    name: "Rimebound",
    addElement: { element: "cold", pct: 40 },
    onHitStatus: { id: "classic.status.chill", chancePct: 100, duration: 60, power: 40 },
    tint: 0x9fe8ff,
    minDepth: 2,
  },
  "classic.mod.stormbound": {
    ...BASE,
    name: "Stormbound",
    addElement: { element: "lightning", pct: 50 },
    tint: 0xffff66,
    minDepth: 3,
  },
  "classic.mod.blinking": {
    ...BASE,
    name: "Blinking",
    blinkEvery: 100,
    tint: 0x9966ff,
    minDepth: 4,
  },
  "classic.mod.leeching": {
    ...BASE,
    name: "Leeching",
    lifeStealPct: 20,
    tint: 0xcc2244,
    minDepth: 3,
  },
  "classic.mod.volley": {
    ...BASE,
    name: "Volleying",
    extraProjectiles: 2,
    tint: 0xffaa33,
    minDepth: 3,
  },
};
