/**
 * Module "classic.progression" — OWNER: progression builder (T6).
 * docs/design/classic.md §4 (hero creation), §6 (classes, stats, XP, death),
 * §16 (quests), §20 (wallet rule).
 *
 * - setup: QuestState and RunStats.
 * - classic.progression.stats (pre -500): hero CombatStats/HeroStats and the
 *   Life/Mana maxima from class, level, attributes, equipment and buffs.
 * - classic.progression.commands (update 52): allocate, learn, setBar,
 *   respawn, heal, acceptQuest, completeQuest, grantXp.
 * - classic.progression.kills (post 0): XP, level ups, life/mana on kill,
 *   run stats, quest progress.
 * - classic.progression.regen (post 300): hero life and mana regen.
 * - classic.progression.heroDeath (post 600): the death penalty, once.
 * - Actions: classic.newHero, allocateStat, learnSkill, setSkillBar,
 *   respawn, acceptQuest, completeQuest.
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { RES, type QuestState, type RunStats } from "../resources.ts";
import { progressionActions } from "./actions.ts";
import { progressionCommands } from "./commands.ts";
import { progressionHeroDeath } from "./death.ts";
import { progressionKills } from "./kills.ts";
import { progressionRegen } from "./regen.ts";
import { progressionStats } from "./stats.ts";

export { computeHeroStats, type HeroStatsInput, type HeroStatsResult } from "./stats.ts";
export { cleanHeroName } from "./hero.ts";
export { addXp } from "./level.ts";

export const classicProgression = defineModule({
  id: MODULE.progression,
  version: "0.3.1",
  deps: [MODULE.core],
  optionalDeps: [MODULE.content, MODULE.items],
  setup(world) {
    const quests: QuestState = { active: [], completed: [] };
    const stats: RunStats = {
      kills: 0,
      championKills: 0,
      uniqueKills: 0,
      bossKills: 0,
      deaths: 0,
      goldEarned: 0,
      itemsFound: 0,
      potionsUsed: 0,
      ticksPlayed: 0,
      offlineMs: 0,
    };
    world.setResource(RES.quests, quests);
    world.setResource(RES.stats, stats);
  },
  systems: [
    progressionStats,
    progressionCommands,
    progressionKills,
    progressionRegen,
    progressionHeroDeath,
  ],
  actions: progressionActions,
});
