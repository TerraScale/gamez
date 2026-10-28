/**
 * Module "classic.talents" (wave A, docs/design/wave-A.md §3) — OWNER: T-talents.
 *
 * - Talent points: rules.talentPointsPerLevel per level from level 2 (the
 *   Talents component is created lazily, levelSeen starts at 1).
 * - classic.talents.points (pre 12): grants the points (classic.talent.points),
 *   spends them in Auto/Idle through TalentTreeProto.autoOrder.
 * - classic.talents.commands (update 53): learnTalent / resetTalents ops.
 * - Actions: classic.learnTalent {node}, classic.resetTalents {} (town, gold).
 * - BonusStats entry "classic.talents": the summed perRank effects of every rank.
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { talentsActions } from "./actions.ts";
import { talentsCommands } from "./commands.ts";
import { talentsPointsSystem } from "./points.ts";

export {
  learnCheck,
  lockCheck,
  execLearnTalent,
  execResetTalents,
  talentBonus,
  treeOfClass,
} from "./ops.ts";

export const classicTalents = defineModule({
  id: MODULE.talents,
  version: "1.0.0",
  deps: [MODULE.core],
  optionalDeps: [MODULE.content, MODULE.progression],
  systems: [talentsPointsSystem, talentsCommands],
  actions: talentsActions,
});
