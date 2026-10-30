/**
 * classic.talents.points (pre 12, SYSTEM.talentsPoints): grants talent points
 * for new hero levels (Talents.levelSeen), and in Auto/Idle (mode !== manual
 * with config.autoAllocate) spends every point on the first learnable entry of
 * TalentTreeProto.autoOrder. Stats are refreshed by the learn ops themselves.
 *
 * Party (docs/design/party.md §6.8): runs for every member in slot order.
 * Followers are always driven by the party AI, so they ALWAYS spend their
 * points (whatever the control mode or autoAllocate); the controlled hero
 * keeps the solo rule. A recruit created at level L (spawnHeroEntity +
 * addXp) has no Talents yet: the lazy levelSeen 1 grants it every level since 2.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { REPLAN_TICKS } from "../auto/util.ts";
import { Dead, Hero, Level, Talents } from "../components.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { heroTag } from "../items/common.ts";
import { partyMembers } from "../party/shared.ts";
import { heroOf, RES, type ControlState } from "../resources.ts";
import { talentPointsPerLevel } from "../rules.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../types.ts";
import { execLearnTalent, learnCheck, treeOfClass } from "./ops.ts";

/** Grants the points of levels `hero` reached since Talents.levelSeen. Returns the points gained. */
function grantPoints(world: World, ctx: SimContext, hero: Entity): number {
  const lvl = world.peek(hero, Level);
  if (!lvl) return 0;
  const before = world.peek(hero, Talents);
  const seen = before?.levelSeen ?? 1;
  if (lvl.level <= seen) return 0;
  const bal = ctx.registry.get<BalanceProto>(KIND.balance, BALANCE_ID);
  const gained = (lvl.level - seen) * (bal ? talentPointsPerLevel(bal) : 1);
  // world.update mutates in place: the total is taken before the write.
  const total = (before?.points ?? 0) + gained;
  if (before) {
    world.update(hero, Talents, { points: total, levelSeen: lvl.level });
  } else {
    world.add(hero, Talents, { points: gained, spent: 0, ranks: [], levelSeen: lvl.level });
  }
  emit(ctx, { type: "classic.talent.points", points: total, gained, ...heroTag(world, hero) });
  return gained;
}

/** Spends every point of `hero` on the first learnable autoOrder entries. */
function autoSpend(world: World, ctx: SimContext, hero: Entity): void {
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
    if (!execLearnTalent(world, ctx, hero, next).ok) break;
  }
}

export const talentsPointsSystem: SystemDef = {
  ...SYSTEM.talentsPoints,
  run(world, ctx) {
    const controlled = heroOf(world);
    for (const hero of partyMembers(world)) {
      if (!world.has(hero, Level)) continue;
      const gained = grantPoints(world, ctx, hero);

      // Spend at once when granted, and retry every REPLAN_TICKS.
      const t = world.get(hero, Talents);
      if (!t || t.points <= 0 || world.has(hero, Dead)) continue;
      if (gained === 0 && ctx.tick % REPLAN_TICKS !== 0) continue;
      if (hero === controlled) {
        // The controlled hero: Auto/Idle with autoAllocate only (the solo rule).
        const control = world.getResource<ControlState>(RES.control);
        if (!control || control.mode === "manual" || !control.config.autoAllocate) continue;
      }
      autoSpend(world, ctx, hero);
    }
  },
};
