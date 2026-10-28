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
  packs: [22, 30],
  progress: { normal: 1, minion: 1, champion: 4, unique: 10, boss: 0, summon: 0 },
  // About two thirds of a level (measured: 174-199 points per level at levels 1-30, see tests/rift.content.test.ts).
  goal: 120,
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
