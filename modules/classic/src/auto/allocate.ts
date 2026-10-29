/**
 * classic.auto.allocate (pre 10, §15.3): in Auto/Idle with
 * config.autoAllocate, spends stat points by ClassProto.autoAlloc weights in
 * a fixed str -> dex -> mag -> vit cycle, skill points by autoSkillOrder
 * (new skills first, then spread with an order bias), and puts newly learned
 * skills into empty bar slots. Only queues progression commands. Party
 * (docs/design/party.md §6.8): followers always spend their points.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import type { HeroCommandBody } from "../actions.ts";
import { pushCommand } from "../bus.ts";
import { Attributes, Dead, Level, SkillBar, SkillBook } from "../components.ts";
import { SYSTEM } from "../ids.ts";
import { partyMembers } from "../party/shared.ts";
import { heroOf, RES, type ControlState } from "../resources.ts";
import {
  ATTRS,
  KIND,
  type Attr,
  type AttrBlock,
  type ClassProto,
  type SkillProto,
} from "../types.ts";
import { heroClass, isParty, REPLAN_TICKS } from "./util.ts";

/**
 * The allocation cycle of a weight block: round r takes every attribute
 * (in str, dex, mag, vit order) whose weight is > r. {2,1,0,2} ->
 * [str, dex, vit, str, vit].
 */
export function allocCycle(weights: AttrBlock): Attr[] {
  const out: Attr[] = [];
  const rounds = Math.max(0, ...ATTRS.map((a) => weights[a]));
  for (let r = 0; r < rounds; r++) for (const a of ATTRS) if (weights[a] > r) out.push(a);
  return out;
}

/** Points per attribute for the next `points` points, given `spent` already allocated. */
export function statPlan(weights: AttrBlock, spent: number, points: number): AttrBlock {
  const plan: AttrBlock = { str: 0, dex: 0, mag: 0, vit: 0 };
  const cycle = allocCycle(weights);
  if (cycle.length === 0) return plan;
  for (let i = 0; i < points; i++) plan[cycle[(spent + i) % cycle.length]!]++;
  return plan;
}

/**
 * Skills to learn for `points` skill points. Learnable = an autoSkillOrder
 * entry of the class with reqLevel met and below maxRank. A learnable skill
 * at rank 0 is learned first (newly unlocked skills get a point at once);
 * otherwise the lowest 2 x rank + order index wins (ties: order), so points
 * spread over the top skills with a bias toward the front of the order.
 */
export function skillPlan(
  cls: ClassProto,
  getSkill: (id: string) => SkillProto | undefined,
  ranks: ReadonlyMap<string, number>,
  level: number,
  points: number,
): string[] {
  const order = cls.autoSkillOrder;
  if (order.length === 0) return [];
  const local = new Map(ranks);
  const out: string[] = [];
  for (let p = 0; p < points; p++) {
    let chosen: string | null = null;
    let bestScore = Number.MAX_SAFE_INTEGER;
    for (let k = 0; k < order.length; k++) {
      const id = order[k]!;
      const s = getSkill(id);
      if (!s || !cls.skills.includes(id) || s.reqLevel > level) continue;
      const rank = local.get(id) ?? 0;
      if (rank >= s.maxRank) continue;
      const score = rank === 0 ? -1 : 2 * rank + k;
      if (score < bestScore) {
        bestScore = score;
        chosen = id;
        if (rank === 0) break;
      }
    }
    if (chosen === null) break;
    local.set(chosen, (local.get(chosen) ?? 0) + 1);
    out.push(chosen);
  }
  return out;
}

/**
 * Queues the stat / skill / bar commands that spend `hero`'s unspent points.
 * `push` adds `hero` to the commands of a follower (party) and nothing for
 * the controlled hero (solo-identical commands).
 */
function allocateFor(
  world: World,
  ctx: SimContext,
  hero: Entity,
  push: (cmd: HeroCommandBody) => void,
): void {
  const lvl = world.get(hero, Level);
  const cls = heroClass(world, ctx.registry, hero);
  if (!lvl || !cls) return;

  if (lvl.statPoints > 0) {
    const attrs = world.get(hero, Attributes);
    let spent = 0;
    if (attrs) for (const a of ATTRS) spent += Math.max(0, attrs[a] - cls.base[a]);
    const plan = statPlan(cls.autoAlloc, spent, lvl.statPoints);
    for (const a of ATTRS) if (plan[a] > 0) push({ op: "allocate", attr: a, points: plan[a] });
  }

  const book = world.get(hero, SkillBook);
  if (lvl.skillPoints > 0 && book) {
    const ranks = new Map<string, number>();
    for (const r of book.ranks) ranks.set(r.skill, r.rank);
    const learn = skillPlan(
      cls,
      (id) => ctx.registry.get<SkillProto>(KIND.skill, id),
      ranks,
      lvl.level,
      lvl.skillPoints,
    );
    const slots = [...(world.get(hero, SkillBar)?.slots ?? [])];
    for (const id of learn) {
      push({ op: "learn", skill: id });
      // A skill learned for the first time goes into the first empty bar slot.
      if ((ranks.get(id) ?? 0) === 0 && !slots.includes(id)) {
        const slot = slots.indexOf(null);
        if (slot >= 0) {
          slots[slot] = id;
          push({ op: "setBar", slot, skill: id });
        }
      }
      ranks.set(id, (ranks.get(id) ?? 0) + 1);
    }
  }
}

/**
 * Party (docs/design/party.md §6.8): followers spend their points whatever
 * the control mode (they are always AI-driven); the controlled hero keeps
 * the solo rule (Auto/Idle with autoAllocate). Slot order, every
 * REPLAN_TICKS.
 */
function allocateFollowers(world: World, ctx: SimContext): void {
  const hero = heroOf(world);
  for (const e of partyMembers(world)) {
    if (e === hero || world.has(e, Dead)) continue;
    allocateFor(world, ctx, e, (cmd) => pushCommand(world, { ...cmd, hero: e }));
  }
}

export const allocateSystem: SystemDef = {
  ...SYSTEM.autoAllocate,
  run(world, ctx) {
    if (ctx.tick % REPLAN_TICKS !== 0) return;
    if (isParty(world)) allocateFollowers(world, ctx);
    const control = world.getResource<ControlState>(RES.control);
    if (!control || control.mode === "manual" || !control.config.autoAllocate) return;
    const hero = heroOf(world);
    if (hero === 0 || world.has(hero, Dead)) return;
    allocateFor(world, ctx, hero, (cmd) => pushCommand(world, cmd));
  },
};
