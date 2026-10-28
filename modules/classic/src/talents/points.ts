/**
 * classic.talents.points (pre 12, SYSTEM.talentsPoints): grants talent points
 * for new hero levels (Talents.levelSeen), and in Auto/Idle (mode !== manual
 * with config.autoAllocate) spends every point on the first learnable entry of
 * TalentTreeProto.autoOrder. Stats are refreshed by the learn ops themselves.
 */
import type { SystemDef } from "@gamez/kernel";
import { REPLAN_TICKS } from "../auto/util.ts";
import { Dead, Hero, Level, Talents } from "../components.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { heroOf, RES, type ControlState } from "../resources.ts";
import { talentPointsPerLevel } from "../rules.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../types.ts";
import { execLearnTalent, learnCheck, treeOfClass } from "./ops.ts";

export const talentsPointsSystem: SystemDef = {
  ...SYSTEM.talentsPoints,
  run(world, ctx) {
    const hero = heroOf(world);
    if (hero === 0) return;
    const lvl = world.get(hero, Level);
    if (!lvl) return;
    const before = world.get(hero, Talents);
    const seen = before?.levelSeen ?? 1;
    let gained = 0;
    if (lvl.level > seen) {
      const bal = ctx.registry.get<BalanceProto>(KIND.balance, BALANCE_ID);
      gained = (lvl.level - seen) * (bal ? talentPointsPerLevel(bal) : 1);
      // world.update mutates in place: the total is taken before the write.
      const total = (before?.points ?? 0) + gained;
      if (before) {
        world.update(hero, Talents, { points: total, levelSeen: lvl.level });
      } else {
        world.add(hero, Talents, { points: gained, spent: 0, ranks: [], levelSeen: lvl.level });
      }
      emit(ctx, { type: "classic.talent.points", points: total, gained });
    }

    // Auto/Idle spends points at once when granted, and retries every REPLAN_TICKS.
    const t = world.get(hero, Talents);
    if (!t || t.points <= 0 || world.has(hero, Dead)) return;
    const control = world.getResource<ControlState>(RES.control);
    if (!control || control.mode === "manual" || !control.config.autoAllocate) return;
    if (gained === 0 && ctx.tick % REPLAN_TICKS !== 0) return;
    const heroData = world.get(hero, Hero);
    if (!heroData) return;
    const tree = treeOfClass(ctx.registry, heroData.classId);
    if (!tree) return;
    for (;;) {
      let next: string | null = null;
      for (const id of tree.tree.autoOrder) {
        if (learnCheck(world, ctx.registry, hero, id).ok) {
          next = id;
          break;
        }
      }
      if (next === null) break;
      if (!execLearnTalent(world, ctx, next).ok) break;
    }
  },
};
