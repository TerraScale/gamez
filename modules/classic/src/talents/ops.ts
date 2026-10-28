/**
 * Talent rules and operations (classic.talents, wave A §3). OWNER: T-talents.
 * The `execX` functions are shared by the actions, the command system and
 * the Auto/Idle allocation (points.ts). Every check runs before the first
 * write, so a failed op leaves the world untouched. Talents live in the hero's
 * Talents component (created lazily) and feed BonusStats["classic.talents"].
 */
import type { Entity, FrozenRegistry, SimContext, World } from "@gamez/kernel";
import { ERR, fail, OK, type OpResult } from "../actions.ts";
import { setBonusSource } from "../bonus.ts";
import { Dead, Hero, Level, Talents, Wallet } from "../components.ts";
import { emit } from "../events.ts";
import { MODULE } from "../ids.ts";
import { applyHeroStats } from "../progression/stats.ts";
import { currentDepth, heroOf, RES, type RunStats } from "../resources.ts";
import { talentResetCost } from "../rules.ts";
import {
  ECONOMY_ID,
  KIND,
  type EconomyProto,
  type SkillModifier,
  type StatId,
  type StatMod,
  type TalentNodeProto,
  type TalentTreeProto,
} from "../types.ts";

/** BonusStats source of the talents (the module id). */
export const TALENT_SOURCE = MODULE.talents;

/** Shape of the Talents component (see components.ts). */
export interface TalentsState {
  points: number;
  spent: number;
  ranks: { node: string; rank: number }[];
  levelSeen: number;
}

export interface TreeEntry {
  id: string;
  tree: TalentTreeProto;
}

function isResult(v: Entity | OpResult): v is OpResult {
  return typeof v !== "number";
}

/** The hero, or a failed OpResult when there is none (or it is dead, unless `alive` is false). */
function liveHero(world: World, alive = true): Entity | OpResult {
  const hero = heroOf(world);
  if (hero === 0) return fail(ERR.noHero, "there is no hero");
  if (alive && world.has(hero, Dead)) return fail(ERR.dead, "the hero is dead");
  return hero;
}

/** The talent tree of a class (the tree whose classId matches), or undefined. */
export function treeOfClass(reg: FrozenRegistry, classId: string): TreeEntry | undefined {
  for (const [id, tree] of reg.all<TalentTreeProto>(KIND.talentTree)) {
    if (tree.classId === classId) return { id, tree };
  }
  return undefined;
}

/** Rank of a node in a Talents value (0 when not learned or no component). */
export function rankOf(t: TalentsState | undefined, node: string): number {
  if (!t) return 0;
  for (const r of t.ranks) if (r.node === node) return r.rank;
  return 0;
}

/** Points spent on the nodes of one tree. */
export function spentInTree(reg: FrozenRegistry, t: TalentsState, treeId: string): number {
  let n = 0;
  for (const r of t.ranks) {
    const node = reg.get<TalentNodeProto>(KIND.talent, r.node);
    if (node?.tree === treeId) n += r.rank;
  }
  return n;
}

/** Why `nodeId` cannot get one more rank now, as an OpResult (ok when it can). */
export function learnCheck(
  world: World,
  reg: FrozenRegistry,
  hero: Entity,
  nodeId: string,
): OpResult {
  const node = reg.get<TalentNodeProto>(KIND.talent, nodeId);
  if (!node) return fail(ERR.unknownId, `unknown talent "${nodeId}"`);
  const heroData = world.get(hero, Hero);
  const tree = reg.get<TalentTreeProto>(KIND.talentTree, node.tree);
  if (!heroData || !tree || tree.classId !== heroData.classId) {
    return fail(ERR.wrongClass, "that talent is not in this class's tree");
  }
  const t = world.get(hero, Talents);
  if (!t || t.points < 1) return fail(ERR.noPoints, "no talent points left");
  if (rankOf(t, nodeId) >= node.maxRank) return fail(ERR.maxRank, "already at max rank");
  return lockCheck(reg, t, node, tree);
}

/**
 * The tier and requirement rules alone (ERR.talentLocked when they fail),
 * whatever the points: tier x tierPoints spent in the tree, and `requires`
 * at rank >= 1. Shared by learnCheck and the HUD's `locked` flag.
 */
export function lockCheck(
  reg: FrozenRegistry,
  t: TalentsState | undefined,
  node: TalentNodeProto,
  tree: TalentTreeProto,
): OpResult {
  const need = node.tier * tree.tierPoints;
  if ((t ? spentInTree(reg, t, node.tree) : 0) < need) {
    return fail(ERR.talentLocked, `needs ${need} points spent in this tree`);
  }
  if (node.requires !== null && rankOf(t, node.requires) < 1) {
    return fail(ERR.talentLocked, "needs the talent it requires");
  }
  return OK;
}

/** Creates the Talents component of the hero when missing (old saves: levelSeen 1 grants every level since 2). */
export function ensureTalents(world: World, hero: Entity): void {
  if (!world.has(hero, Talents)) {
    world.add(hero, Talents, { points: 0, spent: 0, ranks: [], levelSeen: 1 });
  }
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sums of the perRank effects of every learned node, times its rank: stat
 * mods per stat and skill modifiers per (skill, field), both sorted.
 */
export function talentBonus(
  reg: FrozenRegistry,
  ranks: readonly { node: string; rank: number }[],
): { mods: StatMod[]; skills: SkillModifier[] } {
  const stats = new Map<StatId, number>();
  const skills = new Map<string, SkillModifier>();
  for (const r of ranks) {
    const node = reg.get<TalentNodeProto>(KIND.talent, r.node);
    if (!node) continue;
    for (const m of node.perRank.stats) {
      stats.set(m.stat, (stats.get(m.stat) ?? 0) + m.value * r.rank);
    }
    for (const m of node.perRank.skills) {
      const key = `${m.skill}|${m.field}`;
      const cur = skills.get(key);
      skills.set(key, {
        skill: m.skill,
        field: m.field,
        value: (cur?.value ?? 0) + m.value * r.rank,
      });
    }
  }
  const mods: StatMod[] = [...stats.entries()]
    .sort((a, b) => byKey(a[0], b[0]))
    .map(([stat, value]) => ({ stat, value }));
  const sk: SkillModifier[] = [...skills.entries()]
    .sort((a, b) => byKey(a[0], b[0]))
    .map(([, m]) => m);
  return { mods, skills: sk };
}

/** Writes the hero's BonusStats entry for the talents (only when it changed). */
export function syncTalentBonus(world: World, reg: FrozenRegistry, hero: Entity): void {
  const t = world.get(hero, Talents);
  const b = talentBonus(reg, t?.ranks ?? []);
  setBonusSource(world, hero, TALENT_SOURCE, b.mods, b.skills);
}

/** Spends one point on `nodeId`: one more rank, stats refreshed at once. */
export function execLearnTalent(world: World, ctx: SimContext, nodeId: string): OpResult {
  const hero = liveHero(world);
  if (isResult(hero)) return hero;
  const check = learnCheck(world, ctx.registry, hero, nodeId);
  if (!check.ok) return check;
  const t = world.read(hero, Talents);
  const rank = rankOf(t, nodeId) + 1;
  const ranks = t.ranks.filter((r) => r.node !== nodeId);
  ranks.push({ node: nodeId, rank });
  ranks.sort((a, b) => byKey(a.node, b.node));
  world.update(hero, Talents, { points: t.points - 1, spent: t.spent + 1, ranks });
  syncTalentBonus(world, ctx.registry, hero);
  applyHeroStats(world, ctx.registry, hero, ctx.tick);
  emit(ctx, { type: "classic.talent.learned", node: nodeId, rank });
  return OK;
}

/**
 * Town only: refunds every spent point for rules.talentResetCost gold (a gold
 * sink, counted in RunStats.goldSpent). Without EconomyProto the reset is free.
 */
export function execResetTalents(world: World, ctx: SimContext): OpResult {
  const hero = liveHero(world);
  if (isResult(hero)) return hero;
  if (currentDepth(world) !== 0) return fail(ERR.notInTown, "talents can only be reset in town");
  const t = world.get(hero, Talents);
  if (!t || t.spent <= 0) return fail(ERR.empty, "no talent points spent");
  const level = world.get(hero, Level)?.level ?? 1;
  const econ = ctx.registry.get<EconomyProto>(KIND.economy, ECONOMY_ID);
  const cost = econ ? talentResetCost(econ, level) : 0;
  const wallet = world.get(hero, Wallet);
  if (cost > 0 && (!wallet || wallet.gold < cost)) {
    return fail(ERR.noGold, `a talent reset costs ${cost} gold`);
  }
  // world.update mutates the stored component in place: read what the event needs first.
  const refunded = t.spent;
  world.update(hero, Talents, { points: t.points + refunded, spent: 0, ranks: [] });
  if (cost > 0 && wallet) {
    world.update(hero, Wallet, { gold: wallet.gold - cost });
    const stats = world.getResource<RunStats>(RES.stats);
    if (stats) stats.goldSpent = (stats.goldSpent ?? 0) + cost;
  }
  syncTalentBonus(world, ctx.registry, hero);
  applyHeroStats(world, ctx.registry, hero, ctx.tick);
  emit(ctx, { type: "classic.talents.reset", refunded, cost });
  return OK;
}
