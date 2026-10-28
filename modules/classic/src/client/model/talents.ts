/**
 * Wave A HUD section: the talent tree of the hero's class (TalentsView, panel
 * "talents" and the Talents tab of "skills"). OWNER: T-talents. Pure: reads the
 * world and the registry, and uses the same learn checks as the actions
 * (talents/ops.ts learnCheck), so learnable and locked match what the sim allows.
 */
import { Dead, Hero, Level, Talents, Wallet } from "../../components.ts";
import { currentDepth } from "../../resources.ts";
import { talentResetCost } from "../../rules.ts";
import {
  learnCheck,
  lockCheck,
  rankOf,
  treeOfClass,
  type TalentsState,
} from "../../talents/ops.ts";
import {
  ECONOMY_ID,
  KIND,
  type EconomyProto,
  type SkillModField,
  type SkillModifier,
  type StatId,
  type StatMod,
  type TalentNodeProto,
} from "../../types.ts";
import type { TalentNodeView, TalentsView } from "../contract.ts";
import type { ModelContext } from "./context.ts";

interface Unit {
  label: string;
  /** Percent points ("%") or flat. */
  pct: boolean;
}

const STAT_TEXT: Partial<Record<StatId, Unit>> = {
  life: { label: "maximum life", pct: false },
  lifePct: { label: "maximum life", pct: true },
  armor: { label: "armor", pct: false },
  armorPct: { label: "armor", pct: true },
  blockPct: { label: "block chance", pct: true },
  resAll: { label: "all resistances", pct: true },
  dmgPct: { label: "weapon damage", pct: true },
  spellPct: { label: "spell damage", pct: true },
  toHitPct: { label: "accuracy", pct: true },
  fireDmg: { label: "fire damage to attacks", pct: false },
  coldDmg: { label: "cold damage to attacks", pct: false },
  lightningDmg: { label: "lightning damage to attacks", pct: false },
  poisonDmg: { label: "poison damage to attacks", pct: false },
  attackSpeed: { label: "attack speed", pct: true },
  castSpeed: { label: "cast speed", pct: true },
  moveSpeed: { label: "movement speed", pct: true },
  critPct: { label: "critical hit chance", pct: true },
  critDmgPct: { label: "critical damage", pct: true },
  lifeSteal: { label: "life steal", pct: true },
  potionPct: { label: "potion effect", pct: true },
  magicFind: { label: "magic find", pct: true },
  manaRegenPct: { label: "mana regeneration", pct: true },
};

const FIELD_TEXT: Record<SkillModField, Unit> = {
  damagePct: { label: "damage", pct: true },
  manaCostPct: { label: "mana cost", pct: true },
  cooldownPct: { label: "cooldown", pct: true },
  speedPct: { label: "speed", pct: true },
  radiusPct: { label: "radius", pct: true },
  extraProjectiles: { label: "projectiles", pct: false },
  extraPierce: { label: "pierce", pct: false },
  extraBounces: { label: "bounces", pct: false },
  durationPct: { label: "duration", pct: true },
  extraSummons: { label: "summons", pct: false },
};

const TAG_TEXT: Record<string, string> = {
  aoe: "Area",
  control: "Control",
  dot: "Damage over time",
  ranged: "Ranged",
  melee: "Melee",
  mobility: "Mobility",
  heal: "Healing",
  buff: "Buff",
  summon: "Summon",
  single: "Single-target",
  basic: "Basic",
};

function signed(v: number, pct: boolean): string {
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}${Math.abs(v)}${pct ? "%" : ""}`;
}

/** "all skills", "Area skills", or the name of one skill. */
function selectorLabel(c: ModelContext, sel: string): string {
  if (sel === "*") return "all skills";
  if (sel.startsWith("tag:")) {
    const tag = sel.slice(4);
    return `${TAG_TEXT[tag] ?? tag} skills`;
  }
  return c.registry.get<{ name: string }>(KIND.skill, sel)?.name ?? sel;
}

/** Effects of `node` at `rank` ranks, joined with " · " ("+8 maximum life · +5% block chance"). */
export function effectText(c: ModelContext, node: TalentNodeProto, rank: number): string {
  const parts: string[] = [];
  for (const m of node.perRank.stats as StatMod[]) {
    const u = STAT_TEXT[m.stat] ?? { label: m.stat, pct: false };
    parts.push(`${signed(m.value * rank, u.pct)} ${u.label}`);
  }
  for (const m of node.perRank.skills as SkillModifier[]) {
    const u = FIELD_TEXT[m.field];
    parts.push(`${signed(m.value * rank, u.pct)} ${u.label} · ${selectorLabel(c, m.skill)}`);
  }
  return parts.join(" · ");
}

/** The node text with "{v}" replaced by the total of the first effect (at least one rank). */
export function describeNode(node: TalentNodeProto, rank: number): string {
  const first = node.perRank.stats[0]?.value ?? node.perRank.skills[0]?.value ?? 0;
  return node.description.split("{v}").join(String(Math.abs(first * Math.max(1, rank))));
}

/** "Current: ..." (learned ranks) and "Next: ..." (the next rank), cumulative totals. */
export function nodeLines(c: ModelContext, node: TalentNodeProto, rank: number): string[] {
  if (node.perRank.stats.length === 0 && node.perRank.skills.length === 0) return [];
  const out: string[] = [];
  if (rank > 0) out.push(`Current: ${effectText(c, node, rank)}`);
  if (rank < node.maxRank) out.push(`Next: ${effectText(c, node, rank + 1)}`);
  return out;
}

/** The hero class tree with ranks, learnability and reset price; null without a hero or a tree. */
export function buildTalentsView(c: ModelContext): TalentsView | null {
  const { world, registry: reg, hero } = c;
  if (hero === 0 || !world.exists(hero)) return null;
  const heroData = world.get(hero, Hero);
  if (!heroData) return null;
  const entry = treeOfClass(reg, heroData.classId);
  if (!entry) return null;
  const t = world.get(hero, Talents) as TalentsState | undefined;
  const level = world.get(hero, Level)?.level ?? 1;

  const nodes: TalentNodeView[] = [];
  for (const id of entry.tree.nodes) {
    const node = reg.get<TalentNodeProto>(KIND.talent, id);
    if (!node) continue;
    const rank = rankOf(t, id);
    const check = learnCheck(world, reg, hero, id);
    // Locked = tier or requirement rule, whatever the points (contract: TalentNodeView.locked).
    const lock = lockCheck(reg, t, node, entry.tree);
    nodes.push({
      id,
      name: node.name,
      description: describeNode(node, rank),
      icon: node.icon,
      tier: node.tier,
      col: node.col,
      rank,
      maxRank: node.maxRank,
      learnable: check.ok,
      locked: rank < node.maxRank && !lock.ok,
      requires: node.requires,
      lines: nodeLines(c, node, rank),
    });
  }

  const econ = reg.get<EconomyProto>(KIND.economy, ECONOMY_ID);
  const resetCost = econ ? talentResetCost(econ, level) : 0;
  const gold = world.get(hero, Wallet)?.gold ?? 0;
  const spent = t?.spent ?? 0;
  const canReset =
    !world.has(hero, Dead) && currentDepth(world) === 0 && spent > 0 && gold >= resetCost;
  return {
    tree: entry.id,
    name: entry.tree.name,
    branches: [...entry.tree.branches],
    tierPoints: entry.tree.tierPoints,
    points: t?.points ?? 0,
    spent,
    nodes,
    resetCost,
    canReset,
  };
}

/** Shared by the panel: plain text of the points header. */
export function talentsSummary(view: TalentsView): string {
  return `${view.points} to spend · ${view.spent} spent`;
}
