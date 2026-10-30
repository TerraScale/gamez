/**
 * Boss quests under Auto (quest fix round 1 of the QA workflow), on the real
 * classic content with every module (plus classic.debug for the grants); the
 * harness is tests/support/boss-quests.ts (bossFight with the quest log of
 * the quest's level, runBossQuest).
 *
 * - Tunnel Mother (Skarn, depth 8, reqLevel 14) had no Auto-kill test: a
 *   hero at the quest level of each class kills her and turns the quest in.
 *   Measured (seeds 1-3, ticks to the kill, with Call the Brood in her
 *   rotation): warrior 2 846-3 889, rogue 1 522-3 704, sorcerer 1 131-1 265;
 *   no death.
 * - Two levels over the quest level (the top of the quest's band) every
 *   class still kills Skarn, Vessa and the Hollow King. Measured (seed 1):
 *   Skarn 2 199 / 1 639 / 1 052, Vessa 2 506 / 1 131 / 1 460, the Hollow
 *   King 3 484 / 1 316 / 1 239 (warrior / rogue / sorcerer).
 *
 * The 12 000-tick budget is the target of the fix; the slowest run is about
 * a third of it.
 */
import { describe, it } from "vite-plus/test";
import { expectBossQuest, HOLLOW_KING, SKARN, VESSA } from "./support/boss-quests.ts";

const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer"] as const;

describe("Tunnel Mother: a quest-level Auto hero kills Skarn and turns the quest in", () => {
  for (const cls of CLASSES) {
    it(`${cls} (level ${SKARN.level}) at depth 8, seeds 1-3`, () => {
      for (const seed of [1, 2, 3]) expectBossQuest(cls, SKARN, SKARN.level, seed);
    }, 300_000);
  }
});

describe("two levels over the quest level: every boss quest still completes", () => {
  for (const b of [SKARN, VESSA, HOLLOW_KING]) {
    for (const cls of CLASSES) {
      it(`${cls} (level ${b.level + 2}) kills ${b.name} and turns the quest in`, () => {
        expectBossQuest(cls, b, b.level + 2, 1);
      }, 120_000);
    }
  }
});
