/**
 * Shared progression operations (`execX`, docs/design/classic.md §6, §16).
 * Each returns an OpResult: the actions throw ActionError when !ok, and the
 * command system (commands.ts) emits classic.command.failed. Every check runs
 * before the first write, so a failed op leaves the world untouched.
 *
 * Party (docs/design/party.md §4.3, §7.2): every op takes the acting hero
 * (actions: the controlled hero; commands: the hero the command names).
 * Respawn revives every downed member; the healer heals every member;
 * quest XP goes to every standing member.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { pushCommand, pushTransition } from "../bus.ts";
import { ERR, fail, INTERACT_RANGE, OK, type OpResult } from "../actions.ts";
import {
  Attributes,
  Dead,
  Hero,
  Intent,
  Level,
  Life,
  Npc,
  Pos,
  SkillBar,
  SkillBook,
  Statuses,
} from "../components.ts";
import { emit } from "../events.ts";
import { within } from "../fixed.ts";
import { heroTag } from "../items/common.ts";
import { partyMembers, partyOf } from "../party/shared.ts";
import { currentDepth, heroOf, questsOf, RES } from "../resources.ts";
import {
  ATTRS,
  BALANCE_ID,
  KIND,
  type Attr,
  type BalanceProto,
  type ClassProto,
  type NpcProto,
  type QuestProto,
  type SkillProto,
} from "../types.ts";
import { addXp, healFull } from "./level.ts";
import { settleAcceptedClear } from "./quests.ts";
import { applyHeroStats } from "./stats.ts";
import { byString, replace } from "./util.ts";

/** Bar slots (hotkeys 1-6). */
export const BAR_SLOTS = 6;

/** `hero`, or a failed OpResult when there is none (or it is dead, unless `alive` is false). */
function liveHero(world: World, hero: Entity, alive = true): Entity | OpResult {
  if (hero === 0 || !world.exists(hero)) return fail(ERR.noHero, "there is no hero");
  if (alive && world.has(hero, Dead)) return fail(ERR.dead, "the hero is dead");
  return hero;
}

function isResult(v: Entity | OpResult): v is OpResult {
  return typeof v !== "number";
}

function rankOf(world: World, hero: Entity, skill: string): number {
  return world.read(hero, SkillBook).ranks.find((r) => r.skill === skill)?.rank ?? 0;
}

/** `hero` spends `points` stat points on one attribute. */
export function execAllocate(
  world: World,
  ctx: SimContext,
  heroIn: Entity,
  attr: Attr,
  points: number,
): OpResult {
  const hero = liveHero(world, heroIn);
  if (isResult(hero)) return hero;
  if (!ATTRS.includes(attr)) return fail(ERR.badPayload, `unknown attribute "${attr}"`);
  if (!Number.isInteger(points) || points < 1) {
    return fail(ERR.badPayload, "points must be a positive integer");
  }
  const lvl = world.read(hero, Level);
  if (points > lvl.statPoints) {
    return fail(ERR.noPoints, `only ${lvl.statPoints} stat points left`);
  }
  const attrs = world.read(hero, Attributes);
  world.update(hero, Attributes, { [attr]: attrs[attr] + points } as Partial<typeof attrs>);
  world.update(hero, Level, { statPoints: lvl.statPoints - points });
  applyHeroStats(world, ctx.registry, hero, ctx.tick);
  emit(ctx, { type: "classic.statAllocated", attr, points, ...heroTag(world, hero) });
  return OK;
}

/** `hero` learns a new skill (rank 1) or ranks one up: class skill, level, maxRank, one skill point. */
export function execLearn(world: World, ctx: SimContext, heroIn: Entity, skill: string): OpResult {
  const hero = liveHero(world, heroIn);
  if (isResult(hero)) return hero;
  const sp = ctx.registry.get<SkillProto>(KIND.skill, skill);
  if (!sp) return fail(ERR.unknownId, `unknown skill "${skill}"`);
  const classId = world.read(hero, Hero).classId;
  const cls = ctx.registry.require<ClassProto>(KIND.class, classId);
  if (sp.users !== "hero" || !cls.skills.includes(skill)) {
    return fail(ERR.notKnown, `"${skill}" is not a skill of this class`);
  }
  const lvl = world.read(hero, Level);
  if (sp.reqLevel > lvl.level) return fail(ERR.levelTooLow, `needs level ${sp.reqLevel}`);
  const cur = rankOf(world, hero, skill);
  if (cur >= sp.maxRank) return fail(ERR.maxRank, `"${skill}" is already at max rank`);
  if (lvl.skillPoints < 1) return fail(ERR.noPoints, "no skill points left");

  const book = world.read(hero, SkillBook);
  const ranks = book.ranks.filter((r) => r.skill !== skill);
  ranks.push({ skill, rank: cur + 1 });
  ranks.sort((a, b) => byString(a.skill, b.skill));
  world.update(hero, SkillBook, { ranks });
  world.update(hero, Level, { skillPoints: lvl.skillPoints - 1 });
  if (cur === 0) {
    const bar = world.read(hero, SkillBar);
    const empty = bar.slots.indexOf(null);
    if (empty >= 0) {
      const slots = [...bar.slots];
      slots[empty] = skill;
      world.update(hero, SkillBar, { slots });
    }
  }
  emit(ctx, { type: "classic.skillLearned", skill, rank: cur + 1, ...heroTag(world, hero) });
  return OK;
}

/** Puts a learned skill (rank >= 1) or nothing (null) into bar slot 0..5 of `hero`. */
export function execSetBar(
  world: World,
  ctx: SimContext,
  heroIn: Entity,
  slot: number,
  skill: string | null,
): OpResult {
  const hero = liveHero(world, heroIn);
  if (isResult(hero)) return hero;
  if (!Number.isInteger(slot) || slot < 0 || slot >= BAR_SLOTS) {
    return fail(ERR.badPayload, `slot must be 0..${BAR_SLOTS - 1}`);
  }
  if (skill !== null) {
    if (!ctx.registry.has(KIND.skill, skill))
      return fail(ERR.unknownId, `unknown skill "${skill}"`);
    if (rankOf(world, hero, skill) < 1) return fail(ERR.notKnown, `"${skill}" is not learned`);
  }
  const bar = world.read(hero, SkillBar);
  const slots = [...bar.slots];
  slots[slot] = skill;
  world.update(hero, SkillBar, { slots });
  return OK;
}

/** Clears death state on a downed hero: no Dead, full life and mana, no statuses, idle intent. */
function reviveHero(world: World, ctx: SimContext, hero: Entity): void {
  world.remove(hero, Dead);
  healFull(world, hero);
  if (world.has(hero, Statuses)) world.update(hero, Statuses, { list: [] });
  const cur = world.get(hero, Intent);
  replace(world, hero, Intent, { kind: "idle", source: cur?.source ?? "manual", at: ctx.tick });
}

/**
 * Respawn after `respawnDelay` of the controlled hero's death: full life and
 * mana, statuses cleared, transition to town. Party: whoever asks (`hero`,
 * the controlled hero or a follower's command), it needs the CONTROLLED hero
 * down; it revives EVERY downed member (slot order), emits hero.respawned for
 * each (+ classic.party.revived {via: "respawn"} in a party of two or more)
 * and queues one town transition that moves the whole party.
 */
export function execRespawn(world: World, ctx: SimContext, heroIn: Entity): OpResult {
  const actor = liveHero(world, heroIn, false);
  if (isResult(actor)) return actor;
  const party = partyOf(world) !== null;
  const hero = party ? heroOf(world) : actor;
  const dead = hero === 0 ? undefined : world.get(hero, Dead);
  if (!dead) return fail(ERR.notDead, "the hero is alive");
  const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
  const readyAt = dead.at + bal.respawnDelay;
  if (ctx.tick < readyAt) return fail(ERR.cooldown, `respawn in ${readyAt - ctx.tick} ticks`);
  if (!party) {
    reviveHero(world, ctx, hero);
    pushTransition(world, { to: 0, via: "respawn" });
    emit(ctx, { type: "classic.hero.respawned" });
    return OK;
  }
  const members = partyMembers(world);
  const downed = members.filter((e) => world.has(e, Dead));
  if (!downed.includes(hero)) downed.unshift(hero);
  for (const e of downed) reviveHero(world, ctx, e);
  pushTransition(world, { to: 0, via: "respawn" });
  for (const e of downed) {
    emit(ctx, { type: "classic.hero.respawned", hero: e });
    if (members.length > 1) {
      emit(ctx, { type: "classic.party.revived", hero: e, by: 0, via: "respawn" });
    }
  }
  return OK;
}

/** Healer in reach of `hero`, in town: full life and mana for every standing member. */
export function execHeal(world: World, ctx: SimContext, heroIn: Entity, npc: Entity): OpResult {
  const hero = liveHero(world, heroIn);
  if (isResult(hero)) return hero;
  if (currentDepth(world) !== 0) return fail(ERR.notInTown, "healing is only in town");
  const proto = world.has(npc, Npc)
    ? ctx.registry.get<NpcProto>(KIND.npc, world.read(npc, Npc).proto)
    : undefined;
  if (!proto || proto.role !== "healer") return fail(ERR.badTarget, "no healer there");
  const np = world.get(npc, Pos);
  if (!np) return fail(ERR.badTarget, "the healer is not in the world");
  const hp = world.read(hero, Pos);
  if (!within(hp.x, hp.y, np.x, np.y, INTERACT_RANGE)) return fail(ERR.tooFar, "too far away");
  if (partyOf(world) === null) {
    const life = world.read(hero, Life);
    const healed = life.max - life.hp;
    healFull(world, hero);
    emit(ctx, { type: "classic.heal", target: hero, amount: healed, x: hp.x, y: hp.y });
    return OK;
  }
  for (const e of partyMembers(world)) {
    if (world.has(e, Dead) || !world.has(e, Life)) continue;
    const life = world.read(e, Life);
    const healed = life.max - life.hp;
    healFull(world, e);
    const p = world.get(e, Pos) ?? hp;
    emit(ctx, { type: "classic.heal", target: e, amount: healed, x: p.x, y: p.y, hero: e });
  }
  return OK;
}

/**
 * Quest givers must be within INTERACT_RANGE: when the town has an NPC of
 * the quest's giver prototype, one of them must be in reach (content
 * without a giver entity, as in unit tests, is not range-checked).
 */
function giverInReach(world: World, hero: Entity, giver: string): OpResult | null {
  const hp = world.get(hero, Pos);
  let exists = false;
  for (const e of world.query(Npc, Pos)) {
    if (world.read(e, Npc).proto !== giver) continue;
    exists = true;
    const np = world.read(e, Pos);
    if (hp && within(hp.x, hp.y, np.x, np.y, INTERACT_RANGE)) return null;
  }
  return exists ? fail(ERR.tooFar, "too far from the quest giver") : null;
}

/** `hero` accepts a (party-wide) quest in town when its level, the chain and the quest state allow it. */
export function execAcceptQuest(
  world: World,
  ctx: SimContext,
  heroIn: Entity,
  quest: string,
): OpResult {
  const hero = liveHero(world, heroIn);
  if (isResult(hero)) return hero;
  const qp = ctx.registry.get<QuestProto>(KIND.quest, quest);
  if (!qp) return fail(ERR.unknownId, `unknown quest "${quest}"`);
  if (currentDepth(world) !== 0) return fail(ERR.notInTown, "quests are taken in town");
  const far = giverInReach(world, hero, qp.giver);
  if (far) return far;
  if (world.read(hero, Level).level < qp.reqLevel) {
    return fail(ERR.levelTooLow, `needs level ${qp.reqLevel}`);
  }
  const qs = questsOf(world);
  if (qs.completed.includes(quest) || qs.active.some((q) => q.id === quest)) {
    return fail(ERR.questState, "quest already taken or completed");
  }
  if (qp.after !== "" && !qs.completed.includes(qp.after)) {
    return fail(ERR.questState, `finish "${qp.after}" first`);
  }
  const active = [...qs.active, { id: quest, progress: 0, done: false }];
  active.sort((a, b) => byString(a.id, b.id));
  world.setResource(RES.quests, { active, completed: qs.completed });
  emit(ctx, { type: "classic.quest.accepted", quest });
  // A clearLevel quest accepted on an already empty live level completes at once.
  settleAcceptedClear(world, ctx, quest);
  return OK;
}

/**
 * `hero` turns in a finished quest in town: removes it from active, records
 * it as completed, queues the gold (purse) and item grants (`hero`'s bag) and
 * adds the XP (party: to every standing member).
 */
export function execCompleteQuest(
  world: World,
  ctx: SimContext,
  heroIn: Entity,
  quest: string,
): OpResult {
  const hero = liveHero(world, heroIn);
  if (isResult(hero)) return hero;
  const qp = ctx.registry.get<QuestProto>(KIND.quest, quest);
  if (!qp) return fail(ERR.unknownId, `unknown quest "${quest}"`);
  if (currentDepth(world) !== 0) return fail(ERR.notInTown, "quests are turned in town");
  const far = giverInReach(world, hero, qp.giver);
  if (far) return far;
  const qs = questsOf(world);
  const entry = qs.active.find((q) => q.id === quest);
  if (!entry || !entry.done) return fail(ERR.questState, "quest is not finished");

  const active = qs.active.filter((q) => q.id !== quest);
  const completed = [...qs.completed, quest].sort(byString);
  world.setResource(RES.quests, { active, completed });
  // Commands for a follower name it; the controlled hero's stay unchanged (§4.2).
  const who = hero !== heroOf(world) ? { hero } : {};
  if (qp.reward.gold > 0) {
    pushCommand(world, { op: "grantGold", amount: qp.reward.gold, reason: "quest", ...who });
  }
  if (qp.reward.item !== null) {
    pushCommand(world, {
      op: "grantItems",
      count: 1,
      ilvl: world.read(hero, Level).level,
      minRarity: qp.reward.item,
      toStash: false,
      reason: "quest",
      ...who,
    });
  }
  if (partyOf(world) === null) {
    addXp(world, ctx, hero, qp.reward.xp, "quest");
  } else {
    for (const e of partyMembers(world)) {
      if (!world.has(e, Dead)) addXp(world, ctx, e, qp.reward.xp, "quest");
    }
  }
  emit(ctx, { type: "classic.quest.completed", quest, gold: qp.reward.gold, xp: qp.reward.xp });
  return OK;
}

/** Adds XP from an outside source (amount >= 0) to `hero`. */
export function execGrantXp(
  world: World,
  ctx: SimContext,
  heroIn: Entity,
  amount: number,
  reason: string,
): OpResult {
  const hero = liveHero(world, heroIn, false);
  if (isResult(hero)) return hero;
  if (!Number.isInteger(amount) || amount < 0) {
    return fail(ERR.badPayload, "amount must be a non-negative integer");
  }
  addXp(world, ctx, hero, amount, reason);
  return OK;
}
