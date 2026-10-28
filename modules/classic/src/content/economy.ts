/**
 * Gold sinks (wave A, docs/design/wave-A.md §Economy): the single
 * EconomyProto. OWNER: T-auto (tunes prices against the hoarding target);
 * read by classic.crafting, classic.items (gambling), classic.talents,
 * the HUD and the auto controller through the rules.ts price helpers.
 */
import { ECONOMY_ID, type EconomyProto } from "../types.ts";

export const ECONOMY: EconomyProto = {
  repair: { fullPct: 25, everyKills: 8, deathLossPct: 10 },
  upgrade: {
    maxLevel: 5,
    costPct: [40, 70, 110, 160, 240],
    chancePct: [100, 85, 70, 55, 40],
  },
  reroll: { basePct: 60 },
  sockets: {
    addCost: [150, 600, 2000],
    unsocketCost: 250,
    combineCost: [50, 150, 450, 1300],
  },
  gamble: {
    base: {
      weapon: 220,
      shield: 180,
      helm: 160,
      armor: 240,
      gloves: 140,
      boots: 140,
      ring: 300,
      amulet: 380,
    },
    perLevelPct: 12,
    weights: { normal: 0, magic: 700, rare: 250, set: 30, unique: 20 },
  },
  talentResetPerLevel: 60,
};

export const ECONOMIES: Record<string, EconomyProto> = { [ECONOMY_ID]: ECONOMY };
