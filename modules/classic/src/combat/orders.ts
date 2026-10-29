/**
 * classic.combat.orders (update 250): CastOrder -> Casting
 * (docs/design/classic.md §7.3, §20). The order is always removed; failures
 * emit classic.cast.failed with an ERR code.
 *
 * Checks, in order: caster alive in the current area, not busy (Casting /
 * Dash / stun), skill known (rank >= 1), off cooldown, mana (units without
 * Mana cast for free), target valid and within range + target body radius
 * (enemy skills need a live enemy; point skills with an entity aim at it;
 * point skills without one and self skills need no range).
 * Timing: basic attacks (melee, range 0) use CombatStats.attackTicks with the
 * hit at half; other skills castTicks/hitTick. Both scale with attack or cast
 * speed, reduced by the strongest slow.
 * Wave A: hero casts read their skill modifiers (bonus.ts skillModsOf):
 * manaCostPct (rules.effectiveManaCost), cooldownPct (rules.effectiveCooldown)
 * and speedPct (added to the speed stat). Units without HeroStats (monsters,
 * summons) add their buff attackSpeed / castSpeed (enrage, rally) to the
 * speed stat: hero buffs are already in CombatStats.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { ERR } from "../actions.ts";
import {
  CastOrder,
  Casting,
  CombatStats,
  Dash,
  Dead,
  HeroStats,
  Mana,
  Mover,
  Pos,
} from "../components.ts";
import { emit } from "../events.ts";
import { facingOf } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth } from "../resources.ts";
import { effectiveCooldown, effectiveManaCost, scaledTicks, skillManaCost } from "../rules.ts";
import type { SkillProto } from "../types.ts";
import { buffStat, inArea, isStunned, slowPct } from "../core/units.ts";
import {
  baseRank,
  bodyRadius,
  castMods,
  cooldownReadyAt,
  isBasic,
  isEnemyOf,
  isLiveUnit,
  rankFor,
  setCooldown,
  skillOf,
  teamOf,
} from "./common.ts";

/** Range slack (sub) between the intent's check and the order's check. */
const RANGE_SLACK = 32;

/**
 * Cast timing in ticks for a caster: [duration, hit offset], offsets in
 * 1..duration-1. `speedBonus` (percent points) is added to the speed stat
 * (skill modifier speedPct for heroes, buff speed for monsters).
 */
export function castTiming(
  skill: Readonly<SkillProto>,
  stats: { attackTicks: number; attackSpeed: number; castSpeed: number } | undefined,
  slow: number,
  speedBonus = 0,
): [number, number] {
  const basic = isBasic(skill);
  const base = basic ? Math.max(2, stats?.attackTicks ?? skill.castTicks) : skill.castTicks;
  const hitBase = basic ? Math.floor(base / 2) : skill.hitTick;
  const speed0 =
    (skill.speedStat === "attack" ? (stats?.attackSpeed ?? 100) : (stats?.castSpeed ?? 100)) +
    speedBonus;
  const speed = Math.floor((speed0 * (100 - Math.max(0, Math.min(90, slow)))) / 100);
  const dur = scaledTicks(base, speed);
  const hit = Math.ceil((Math.max(0, hitBase) * 100) / Math.max(10, speed));
  return [dur, Math.max(1, Math.min(dur - 1, hit))];
}

function fail(ctx: SimContext, caster: Entity, skill: string, code: string): void {
  emit(ctx, { type: "classic.cast.failed", caster, skill, code });
}

export const ordersSystem: SystemDef = {
  ...SYSTEM.combatOrders,
  run(world, ctx) {
    const orders = world.query(CastOrder);
    if (orders.length === 0) return;
    const depth = currentDepth(world);
    for (const e of orders) {
      const order = world.read(e, CastOrder);
      world.remove(e, CastOrder);
      if (!inArea(world, e, depth) || !world.has(e, Pos)) continue;
      const code = tryStart(world, ctx, e, order, depth);
      if (code !== null) fail(ctx, e, order.skill, code);
    }
  },
};

function tryStart(
  world: World,
  ctx: SimContext,
  e: Entity,
  order: { skill: string; target: Entity; x: number; y: number },
  depth: number,
): string | null {
  const tick = ctx.tick;
  if (world.has(e, Dead)) return ERR.dead;
  if (world.has(e, Casting) || world.has(e, Dash) || isStunned(world, ctx.registry, e, tick)) {
    return ERR.busy;
  }
  const skill = skillOf(ctx.registry, order.skill);
  if (!skill) return ERR.unknownId;
  if (baseRank(world, e, order.skill) < 1) return ERR.notKnown;
  const rank = rankFor(world, e, skill, order.skill);
  if (cooldownReadyAt(world, e, order.skill) > tick) return ERR.cooldown;
  const mods = castMods(world, ctx.registry, e, order.skill);
  const mana = world.get(e, Mana);
  const cost = mana
    ? mods
      ? effectiveManaCost(skill as SkillProto, rank, mods)
      : skillManaCost(skill, rank)
    : 0;
  if (mana && mana.mp < cost) return ERR.noMana;

  // Read-only values use peek() (no rollback copy); Mana and Mover change below.
  const p = world.peek(e, Pos)!;
  const stats = world.peek(e, CombatStats);
  const team = teamOf(world, e) ?? "monster";
  let tx = order.x;
  let ty = order.y;
  let target: Entity = 0;
  if (skill.target === "self") {
    tx = p.x;
    ty = p.y;
  } else {
    const wantsEnemy = skill.target === "enemy";
    if (order.target !== 0) {
      const ok = wantsEnemy
        ? isEnemyOf(world, order.target, team, depth)
        : isLiveUnit(world, order.target, depth);
      if (!ok) return ERR.badTarget;
      target = order.target;
      const tp = world.peek(target, Pos)!;
      tx = tp.x;
      ty = tp.y;
      const reach =
        (skill.range > 0 ? skill.range : (stats?.attackRange ?? 0)) +
        bodyRadius(world, target) +
        RANGE_SLACK;
      const dx = tx - p.x;
      const dy = ty - p.y;
      if (dx * dx + dy * dy > reach * reach) return ERR.tooFar;
    } else if (wantsEnemy) {
      return ERR.badTarget;
    }
  }

  const speedBonus = mods
    ? mods.speedPct
    : world.has(e, HeroStats)
      ? 0
      : buffStat(
          world,
          ctx.registry,
          e,
          skill.speedStat === "attack" ? "attackSpeed" : "castSpeed",
          tick,
        );
  const [dur, hit] = castTiming(skill, stats, slowPct(world, ctx.registry, e, tick), speedBonus);
  let end = tick + dur;
  if (skill.shape === "pulse" && skill.pulse) {
    // Room for every pulse before the unit is free.
    end = Math.max(end, tick + hit + (skill.pulse.count - 1) * Math.max(1, skill.pulse.every) + 1);
  }
  if (mana && cost > 0) mana.mp -= cost;
  const cooldown = mods ? effectiveCooldown(skill as SkillProto, mods) : skill.cooldown;
  if (cooldown > 0) setCooldown(world, e, order.skill, tick + cooldown, tick);
  const m = world.peek(e, Mover);
  if (m && (tx !== p.x || ty !== p.y)) {
    const f = facingOf(tx - p.x, ty - p.y, m.facing);
    if (f !== m.facing) world.update(e, Mover, { facing: f });
  }
  world.add(e, Casting, {
    skill: order.skill,
    rank,
    target,
    x: tx,
    y: ty,
    startedAt: tick,
    hitAt: tick + hit,
    endAt: end,
    fired: false,
    pulses: 0,
  });
  emit(ctx, {
    type: "classic.cast",
    caster: e,
    skill: order.skill,
    effect: skill.effect,
    x: p.x,
    y: p.y,
    tx,
    ty,
  });
  return null;
}
