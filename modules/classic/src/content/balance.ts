/**
 * The single balance prototype (id BALANCE_ID). Every tunable number of the
 * mode lives here. Drop chances follow design §11.3; level size and packs
 * follow the phase 2a plan (128x128 levels, up to 300 monsters per level).
 */
import { tiles } from "../fixed.ts";
import { BALANCE_ID, type BalanceProto } from "../types.ts";

export const BALANCE: BalanceProto = {
  maxLevel: 60,
  statPointsPerLevel: 5,
  skillPointsPerLevel: 1,
  xpA: 30,
  xpB: 40,
  xpGrace: 5,
  xpPenaltyPct: 15,
  xpMinPct: 5,
  deathGoldLossPct: 10,
  deathXpLossPct: 5,
  respawnDelay: 60,
  corpseTicks: 40,
  potionCooldown: 20,
  beltSlots: 4,
  beltStack: 5,
  invCols: 10,
  invRows: 4,
  stashSize: 50,
  tpScrollPrice: 50,
  maxTpScrolls: 10,
  levelWidth: 128,
  levelHeight: 128,
  rooms: [18, 26],
  roomSize: [6, 16],
  packs: [28, 40],
  maxMonstersPerLevel: 300,
  championPackChancePct: 15,
  uniquePacksPerLevel: [1, 2],
  packRampDepth: 3,
  sleepRange: tiles(20),
  lightRadius: 8,
  rarityWeights: { normal: 600, magic: 300, rare: 90, set: 8, unique: 10 },
  drops: {
    normal: { item: 12, items: [1, 1], gold: 45, potion: 12 },
    champion: { item: 40, items: [1, 2], gold: 60, potion: 25 },
    unique: { item: 100, items: [2, 3], gold: 100, potion: 50 },
    boss: { item: 100, items: [4, 6], gold: 100, potion: 100 },
    minion: { item: 8, items: [1, 1], gold: 40, potion: 8 },
    summon: { item: 0, items: [0, 0], gold: 0, potion: 0 },
  },
  goldPerLevel: [4, 10],
  vendorItems: 8,
  offlineCapMs: 8 * 3600 * 1000,
  offlineEfficiencyPct: 35,
  // ---- wave A (docs/design/wave-A.md)
  talentPointsPerLevel: 1,
  stashTabs: 4,
  gemDrops: { normal: 2, champion: 10, unique: 30, boss: 100, minion: 2, summon: 0 },
  socketedDropPct: 8,
};

export const BALANCES: Record<string, BalanceProto> = { [BALANCE_ID]: BALANCE };
