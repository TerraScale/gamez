/**
 * classic.combat.resolveHits (update 700), docs/design/classic.md §10.
 *
 * Drains Bus.hits in queue order. Hits whose target is gone, dead, not a
 * unit or in another area are dropped. Per hit:
 * 1. canMiss (not dots): hitChance roll -> classic.miss; then the defender's
 *    block (blockPct, max 75) -> blocked classic.miss.
 * 2. mitigate() by the defender's armor/resists vs the attacker level; crit
 *    x critMult %; total at least 1.
 * 3. Life.hp; life/mana steal for the source (not dots); thorns back to
 *    melee attackers (resolved in this same pass); status rolls; knockback
 *    (stops at walls); wake (Ai sleep/idle -> chase the source);
 *    classic.hit with the dominant element.
 * 4. hp <= 0 -> killUnit (Dead, grid removal, DeathRecord, classic.death).
 * Hits pushed while resolving (thorns) are resolved in the same pass, so
 * nothing is left for core.cleanup to drop.
 *
 * Party (docs/design/party.md §6.5, §7.1):
 * - No friendly fire: a hit from a hero-side source (any member or member
 *   summon) on another hero-team unit is dropped before any roll (target
 *   selection is already team-based; this is the backstop).
 * - Threat: in a party of 2+, a standing member that hits a monster which
 *   targets someone else turns it on the hitter (monsters/util noteThreat).
 * - classic.hit carries `hero` when the target is a follower.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, type HitRequest } from "../bus.ts";
import {
  Ai,
  CombatStats,
  Faction,
  Hero,
  Life,
  Mana,
  Monster,
  Pos,
  type CombatStatsValue,
} from "../components.ts";
import { emit } from "../events.ts";
import { isqrt, pct, scaleTo } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth, heroOf } from "../resources.ts";
import { dominantElement, hitChance, mitigate } from "../rules.ts";
import { gridOf } from "../spatial.ts";
import { ELEMENTS, type Damage, type SkillProto } from "../types.ts";
import { getAreaMap, walkableSub } from "../world/maps.ts";
import { canStand } from "../core/units.ts";
import { noteThreat } from "../monsters/util.ts";
import { isPartyHero } from "../party/shared.ts";
import {
  bigPartySize,
  bodyRadius,
  isBasic,
  isHeroSide,
  isLiveUnit,
  rollPct,
  skillOf,
  wake,
} from "./common.ts";
import { killUnit } from "./death.ts";
import { applyStatus } from "./statuses.ts";

/** Block chance cap (percent). */
export const BLOCK_CAP = 75;
/** Safety cap on hits resolved per tick (thorns chains cannot loop, this is a guard). */
const MAX_HITS_PER_TICK = 20000;

/** Final damage of a hit after defences and crit (each element; the total is at least 1). */
export function finalDamage(
  damage: Damage,
  def: CombatStatsValue | undefined,
  attackerLevel: number,
  critMult: number | null,
): Damage {
  let d = def ? mitigate(damage, def, attackerLevel) : { ...damage };
  if (critMult !== null) {
    const out = { ...d };
    for (const e of ELEMENTS) out[e] = pct(d[e], critMult);
    d = out;
  }
  return d;
}

/** Thorns only answer melee hits: melee/arc skills, except basic attacks of ranged weapons. */
export function isMeleeHit(
  skill: Readonly<SkillProto> | undefined,
  src: CombatStatsValue | undefined,
): boolean {
  if (!skill) return false;
  if (skill.shape === "arc") return true;
  if (skill.shape !== "melee") return false;
  return !(isBasic(skill) && src !== undefined && src.attackProjectile !== "");
}

export const resolveSystem: SystemDef = {
  ...SYSTEM.combatResolve,
  run(world, ctx) {
    const bus = busOf(world);
    if (bus.hits.length === 0) return;
    const depth = currentDepth(world);
    const party = bigPartySize(world) > 0;
    let budget = MAX_HITS_PER_TICK;
    while (bus.hits.length > 0 && budget > 0) {
      const batch = bus.hits;
      bus.hits = [];
      for (const h of batch) {
        if (budget-- <= 0) break;
        resolveOne(world, ctx, h, depth, party);
      }
    }
    bus.hits = [];
  },
};

function resolveOne(
  world: World,
  ctx: SimContext,
  h: HitRequest,
  depth: number,
  party: boolean,
): void {
  const t = h.target;
  if (!isLiveUnit(world, t, depth)) return;
  // No friendly fire: hero-side sources never hurt hero-team units (before any roll).
  if (h.source !== t && friendly(world, h.source, t)) return;
  // Read-only values use peek() (no rollback copy per hit).
  const tp = world.peek(t, Pos)!;
  const srcAlive = h.source !== 0 && world.exists(h.source) && isLiveUnit(world, h.source, depth);
  const src =
    h.source !== 0 && world.exists(h.source) ? world.peek(h.source, CombatStats) : undefined;
  const def = world.peek(t, CombatStats);

  // 1. to-hit and block
  if (h.canMiss && !h.dot) {
    if (src && def && !rollPct(ctx.rng, hitChance(src.toHit, src.level, def.armor, def.level))) {
      emit(ctx, {
        type: "classic.miss",
        source: h.source,
        target: t,
        blocked: false,
        x: tp.x,
        y: tp.y,
      });
      wake(world, t, h.source);
      return;
    }
    const block = Math.min(BLOCK_CAP, def?.blockPct ?? 0);
    if (block > 0 && rollPct(ctx.rng, block)) {
      emit(ctx, {
        type: "classic.miss",
        source: h.source,
        target: t,
        blocked: true,
        x: tp.x,
        y: tp.y,
      });
      wake(world, t, h.source);
      return;
    }
  }

  // 2. defences and crit
  const crit = h.crit && !h.dot;
  const d = finalDamage(h.damage, def, src?.level ?? 1, crit ? (src?.critMult ?? 150) : null);
  let amount = 0;
  for (const e of ELEMENTS) amount += d[e];
  amount = Math.max(1, amount);
  const element =
    amount > 0 && d[dominantElement(d)] > 0 ? dominantElement(d) : dominantElement(h.damage);

  // 3. apply
  const life = world.read(t, Life);
  life.hp -= amount;
  if (srcAlive && !h.dot && src) {
    if (src.lifeSteal > 0) {
      const sl = world.get(h.source, Life);
      const gain = pct(amount, src.lifeSteal);
      if (sl && gain > 0) sl.hp = Math.min(sl.max, sl.hp + gain);
    }
    if (src.manaSteal > 0) {
      const sm = world.get(h.source, Mana);
      const gain = pct(amount, src.manaSteal);
      if (sm && gain > 0) sm.mp = Math.min(sm.max, sm.mp + gain);
    }
    if (def && def.thorns > 0 && isMeleeHit(skillOf(ctx.registry, h.skill), src)) {
      busOf(world).hits.push({
        source: t,
        target: h.source,
        skill: "",
        damage: { phys: def.thorns, fire: 0, cold: 0, lightning: 0, poison: 0 },
        canMiss: false,
        crit: false,
        dot: false,
        statuses: [],
        knockback: 0,
      });
    }
  }
  const hero = heroOf(world);
  const heroHit = t === hero || world.has(t, Hero);
  emit(ctx, {
    type: "classic.hit",
    source: h.source,
    target: t,
    skill: h.skill,
    amount,
    element,
    crit,
    dot: h.dot,
    heroHit,
    byHero: isHeroSide(world, h.source),
    x: tp.x,
    y: tp.y,
    // Party: a hit on a follower names it (the controlled hero's never do: solo unchanged).
    ...(heroHit && t !== hero && party ? { hero: t } : {}),
  });

  // 4. death, else on-hit effects
  if (life.hp <= 0) {
    killUnit(world, ctx, t, h.source);
    return;
  }
  if (!h.dot) {
    for (const s of h.statuses) {
      if (rollPct(ctx.rng, s.chancePct)) {
        applyStatus(world, ctx, t, { id: s.id, duration: s.duration, power: s.power }, h.source);
      }
    }
  }
  if (h.knockback > 0 && srcAlive) knockback(world, ctx, t, h.source, h.knockback);
  wake(world, t, h.source);
  if (party && srcAlive && world.has(t, Monster) && isPartyHero(world, h.source)) {
    threat(world, ctx, t, h.source);
  }
}

/** True when `source` is hero-side and `target` is a hero-team unit (a friendly hit). */
function friendly(world: World, source: Entity, target: Entity): boolean {
  if (source === 0) return false;
  return world.get(target, Faction)?.team === "hero" && isHeroSide(world, source);
}

/**
 * Party threat: a member hitting a monster that is chasing someone else
 * turns it on the hitter, unless it switched for threat moments ago
 * (monsters/util THREAT_HOLD, so two hitters do not flip it every hit).
 */
function threat(world: World, ctx: SimContext, t: Entity, by: Entity): void {
  const ai = world.get(t, Ai);
  if (!ai || ai.target === by || ai.state === "sleep") return;
  if (world.get(t, Faction)?.team !== "monster") return;
  if (!noteThreat(world, t, ctx.tick)) return;
  world.update(t, Ai, { target: by });
}

/** Pushes `t` away from `from` by up to `dist` sub, stopping before walls. */
function knockback(world: World, ctx: SimContext, t: Entity, from: Entity, dist: number): void {
  const tp = world.read(t, Pos);
  const sp = world.read(from, Pos);
  let dx = tp.x - sp.x;
  let dy = tp.y - sp.y;
  if (dx === 0 && dy === 0) return;
  if (isqrt(dx * dx + dy * dy) === 0) return;
  const map = getAreaMap(world, ctx.registry);
  const r = bodyRadius(world, t);
  const startOk = canStand(map, tp.x, tp.y, r);
  let x = tp.x;
  let y = tp.y;
  for (let done = 32; done <= dist; done += 32) {
    [dx, dy] = scaleTo(tp.x - sp.x, tp.y - sp.y, done);
    const nx = tp.x + dx;
    const ny = tp.y + dy;
    if (!(startOk ? canStand(map, nx, ny, r) : walkableSub(map, nx, ny))) break;
    x = nx;
    y = ny;
  }
  if (x === tp.x && y === tp.y) return;
  tp.x = x;
  tp.y = y;
  gridOf(world).move(t, x, y);
}
