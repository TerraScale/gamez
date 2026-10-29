/**
 * Module "classic.content" — OWNER: content builder (T1). Data only: no
 * systems, no actions, no setup. Defines every prototype of the mode in
 * data() (docs/design/classic.md §6-§9, §11, §14, §16). Each table lives in
 * its own file; this module registers them in sorted id order per kind.
 */
import { defineModule, type Registry } from "@gamez/kernel";
import { KIND } from "../types.ts";
import { MODULE } from "../ids.ts";
import { AFFIXES } from "./affixes.ts";
import { BALANCES } from "./balance.ts";
import { CLASSES } from "./classes.ts";
import { ITEMS } from "./items.ts";
import { MONSTER_MODS } from "./mods.ts";
import { MONSTERS } from "./monsters.ts";
import { NAMES } from "./names.ts";
import { NPCS } from "./npcs.ts";
import { QUESTS } from "./quests.ts";
import { SKILLS } from "./skills.ts";
import { STATUSES } from "./statuses.ts";
import { THEMES } from "./themes.ts";
import { UNIQUES } from "./uniques.ts";
import { ACHIEVEMENTS } from "./achievements.ts";
import { BOSS_SKILLS, BOSS_STATUSES } from "./boss.ts";
import { ECONOMIES } from "./economy.ts";
import { GEMS } from "./gems.ts";
import { RIFTS } from "./rift.ts";
import { SET_ITEMS, SETS } from "./sets.ts";
import { TALENT_NODES, TALENT_TREES } from "./talents.ts";

/** Defines every prototype of one table, in sorted id order. */
function defineAll<T extends object>(reg: Registry, kind: string, table: Record<string, T>): void {
  for (const id of Object.keys(table).sort()) reg.define(kind, id, table[id]!);
}

export const classicContent = defineModule({
  id: MODULE.content,
  version: "0.4.2",
  data(reg) {
    defineAll(reg, KIND.balance, BALANCES);
    defineAll(reg, KIND.class, CLASSES);
    defineAll(reg, KIND.skill, SKILLS);
    defineAll(reg, KIND.status, STATUSES);
    defineAll(reg, KIND.monster, MONSTERS);
    defineAll(reg, KIND.monsterMod, MONSTER_MODS);
    defineAll(reg, KIND.itemBase, ITEMS);
    defineAll(reg, KIND.affix, AFFIXES);
    defineAll(reg, KIND.unique, UNIQUES);
    defineAll(reg, KIND.npc, NPCS);
    defineAll(reg, KIND.quest, QUESTS);
    defineAll(reg, KIND.theme, THEMES);
    defineAll(reg, KIND.names, NAMES);
    // ---- wave A tables (docs/design/wave-A.md). A table may share a kind with
    // another (gems are item bases, boss skills are skills); duplicate ids throw.
    defineAll(reg, KIND.skill, BOSS_SKILLS);
    defineAll(reg, KIND.status, BOSS_STATUSES);
    defineAll(reg, KIND.itemBase, GEMS);
    defineAll(reg, KIND.set, SETS);
    defineAll(reg, KIND.setItem, SET_ITEMS);
    defineAll(reg, KIND.talentTree, TALENT_TREES);
    defineAll(reg, KIND.talent, TALENT_NODES);
    defineAll(reg, KIND.economy, ECONOMIES);
    defineAll(reg, KIND.rift, RIFTS);
    defineAll(reg, KIND.achievement, ACHIEVEMENTS);
  },
});
