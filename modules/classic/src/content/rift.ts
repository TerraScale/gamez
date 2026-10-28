/**
 * The endless Rift (wave A, docs/design/wave-A.md §Rift): the single
 * RiftProto. OWNER: T-rift. Guardian ids are defined by T-bosses in
 * monsters.ts (classic.monster.guardian_*); classic.rift must tolerate a
 * missing guardian id (fall back to the strongest regular monster as a boss).
 */
import { RIFT_ID, type RiftProto } from "../types.ts";

export const RIFT: RiftProto = {
  unlockBossDepth: 16,
  size: 80,
  rooms: [10, 14],
  roomSize: [6, 12],
  // Wave A QA: [22, 30] packs and a goal of 120 left geared level-24 heroes dying in rift level 1
  // (128+ monsters alive); fewer packs and a lower goal keep the run about two thirds of a level.
  packs: [18, 26],
  progress: { normal: 1, minion: 1, champion: 4, unique: 10, boss: 0, summon: 0 },
  goal: 100,
  timeLimit: 20 * 60 * 6,
  guardians: ["classic.monster.guardian_maw", "classic.monster.guardian_choir"],
  feeBase: 200,
  feePerLevel: 80,
  reward: { goldPerLevel: 120, items: 2, bonusEvery: 5, minRarity: "rare" },
  themes: [
    "classic.theme.crypt",
    "classic.theme.caves",
    "classic.theme.forge",
    "classic.theme.abyss",
  ],
};

export const RIFTS: Record<string, RiftProto> = { [RIFT_ID]: RIFT };
