/**
 * Shared combat helpers (T3-owned, pure functions over world + registry):
 * skill lookup and ranks, cooldowns, teams, target validity, area queries,
 * damage packets and HitRequest construction. Data-driven from SkillProto, so
 * heroes and monsters go through the same code.
 */
import type { Entity, FrozenRegistry, Rng, SimContext, World } from "@gamez/kernel";
import type { HitRequest, StatusApply } from "../bus.ts";
import { skillModsOf } from "../bonus.ts";
import {
  Ai,
  Body,
  BonusStats,
  CombatStats,
  Dead,
  Faction,
  HeroStats,
  Life,
  Monster,
  Pos,
  SkillBook,
  Summoned,
  type CombatStatsValue,
} from "../components.ts";
import { pct } from "../fixed.ts";
import { heroOf, partyStateOf } from "../resources.ts";
import { effectiveRank, rollSkillDamage, type SkillModTotals } from "../rules.ts";
import type { SpatialGrid } from "../spatial.ts";
import {
  ELEMENTS,
  KIND,
  type Damage,
  type MonsterModProto,
  type SkillProto,
  type Team,
} from "../types.ts";
import { buffStat, inArea } from "../core/units.ts";

/** Largest body radius the area queries account for (sub). */
export const MAX_BODY_RADIUS = 192;
/** Extra reach tolerance for melee hits at fire time (0.5 tile). */
export const MELEE_SLACK = 128;
/** Ranged basic attack projectile (design §20). */
export const BASIC_PROJECTILE_SPEED = 80;
export const BASIC_PROJECTILE_RADIUS = 64;
/** Dash arrival hits push the target back one tile. */
export const DASH_KNOCKBACK = 256;

export function skillOf(registry: FrozenRegistry, id: string): Readonly<SkillProto> | undefined {
  return registry.get<SkillProto>(KIND.skill, id);
}

/** A melee skill with range 0 is the weapon (basic) attack. */
export function isBasic(skill: Readonly<SkillProto>): boolean {
  return skill.shape === "melee" && skill.range === 0;
}

/** SkillBook rank of a skill (0 = unknown). */
export function baseRank(world: World, e: Entity, skill: string): number {
  return world.peek(e, SkillBook)?.ranks.find((r) => r.skill === skill)?.rank ?? 0;
}

/** Rank used for numbers: SkillBook rank + HeroStats.allSkills (rules.effectiveRank). */
export function rankFor(world: World, e: Entity, proto: Readonly<SkillProto>, id: string): number {
  const r = baseRank(world, e, id);
  return effectiveRank(proto, r, world.peek(e, HeroStats)?.allSkills ?? 0);
}

export function cooldownReadyAt(world: World, e: Entity, skill: string): number {
  return world.peek(e, SkillBook)?.cooldowns.find((c) => c.skill === skill)?.readyAt ?? 0;
}

/** Sets a cooldown (list kept sorted by skill id; expired entries dropped). */
export function setCooldown(
  world: World,
  e: Entity,
  skill: string,
  readyAt: number,
  tick: number,
): void {
  const book = world.get(e, SkillBook);
  if (!book) return;
  const list = book.cooldowns.filter((c) => c.skill !== skill && c.readyAt > tick);
  list.push({ skill, readyAt });
  list.sort((a, b) => (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0));
  book.cooldowns = list;
}

export function teamOf(world: World, e: Entity): Team | null {
  return world.peek(e, Faction)?.team ?? null;
}

/** A unit that can be hit: exists, has Life + Pos + Faction, alive, in area `depth`. */
export function isLiveUnit(world: World, e: Entity, depth: number): boolean {
  return (
    e !== 0 &&
    world.exists(e) &&
    world.has(e, Life) &&
    world.has(e, Pos) &&
    world.has(e, Faction) &&
    !world.has(e, Dead) &&
    inArea(world, e, depth)
  );
}

export function isEnemyOf(world: World, e: Entity, team: Team, depth: number): boolean {
  return isLiveUnit(world, e, depth) && world.peek(e, Faction)!.team !== team;
}

export function bodyRadius(world: World, e: Entity): number {
  return world.peek(e, Body)?.radius ?? 0;
}

/**
 * Live enemies of `team` whose body overlaps the circle (x, y, r), sorted by
 * entity id (grid order). Pass `exclude` to skip already-hit units.
 */
export function enemiesInRadius(
  world: World,
  grid: SpatialGrid,
  x: number,
  y: number,
  r: number,
  team: Team,
  depth: number,
  exclude: readonly Entity[] = [],
): Entity[] {
  const out: Entity[] = [];
  for (const e of grid.query(x, y, r + MAX_BODY_RADIUS)) {
    if (exclude.includes(e) || !isEnemyOf(world, e, team, depth)) continue;
    const p = world.peek(e, Pos)!;
    const reach = r + bodyRadius(world, e);
    const dx = p.x - x;
    const dy = p.y - y;
    if (dx * dx + dy * dy <= reach * reach) out.push(e);
  }
  return out;
}

/** Live allies of `team` (including `self`) within r of (x, y), sorted by id. */
export function alliesInRadius(
  world: World,
  grid: SpatialGrid,
  x: number,
  y: number,
  r: number,
  team: Team,
  depth: number,
): Entity[] {
  const out: Entity[] = [];
  for (const e of grid.query(x, y, r + MAX_BODY_RADIUS)) {
    if (!isLiveUnit(world, e, depth) || world.read(e, Faction).team !== team) continue;
    const p = world.read(e, Pos);
    const reach = r + bodyRadius(world, e);
    if ((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) <= reach * reach) out.push(e);
  }
  return out;
}

/**
 * The hero or one of the hero's summons. Party (docs/design/party.md §7.1):
 * any party member or a summon owned by any member. Solo (no party
 * resource): exactly the single-hero rule.
 */
export function isHeroSide(world: World, e: Entity): boolean {
  if (e === 0) return false;
  const party = partyStateOf(world);
  if (party === null) {
    const hero = heroOf(world);
    if (hero === 0) return false;
    if (e === hero) return true;
    return world.exists(e) && world.get(e, Summoned)?.owner === hero;
  }
  if (!world.exists(e)) return false;
  const members = party.members;
  if (members.includes(e)) return true;
  const owner = world.get(e, Summoned)?.owner ?? 0;
  return owner !== 0 && members.includes(owner) && world.exists(owner);
}

/** Party size when it is above one (a real party), else 0: gates every party-only rule. */
export function bigPartySize(world: World): number {
  const party = partyStateOf(world);
  if (party === null || party.members.length < 2) return 0;
  let n = 0;
  for (const m of party.members) if (m !== 0 && world.exists(m)) n++;
  return n > 1 ? n : 0;
}

/** Integer roll in percent: true with probability p/100. */
export function rollPct(rng: Rng, p: number): boolean {
  if (p <= 0) return false;
  if (p >= 100) return true;
  return rng.int(0, 99) < p;
}

export function rollCrit(rng: Rng, stats: CombatStatsValue | undefined): boolean {
  return stats !== undefined && rollPct(rng, stats.critPct);
}

export function scaleDamage(d: Damage, percent: number): Damage {
  const out = { ...d };
  for (const e of ELEMENTS) out[e] = pct(d[e], percent);
  return out;
}

/**
 * Skill modifier totals of a cast (bonus.ts skillModsOf), or null when the
 * caster has no BonusStats (monsters, summons, heroes without talents): the
 * cheap path every monster cast takes.
 */
export function castMods(
  world: World,
  registry: FrozenRegistry,
  caster: Entity,
  skillId: string,
): SkillModTotals | null {
  if (caster === 0 || !world.exists(caster) || !world.has(caster, BonusStats)) return null;
  return skillModsOf(world, registry, caster, skillId);
}

/** `v` grown by `percent` % (skill modifier fields; the result is never negative). */
export function grow(v: number, percent: number): number {
  return percent === 0 ? v : Math.max(0, pct(v, 100 + percent));
}

/**
 * Element conversion for monster skills (wave A, local rule of
 * classic.combat): a `users: "monster"` skill with weaponPct > 0 and a
 * `damage` block whose min and max are both 0 deals its whole packet as
 * `damage.element` instead of the monster's attack element (boss_meteor is
 * fire and boss_frost_nova cold on any boss). Other skills are unchanged.
 */
export function convertsElement(skill: Readonly<SkillProto>): boolean {
  const d = skill.damage;
  return (
    skill.users === "monster" &&
    skill.weaponPct > 0 &&
    d !== null &&
    d.min === 0 &&
    d.max === 0 &&
    d.minPerRank === 0 &&
    d.maxPerRank === 0
  );
}

/**
 * One pre-defence damage packet of a skill for a caster:
 * rules.rollSkillDamage with the hero's attributes (monsters: none), plus
 * buff dmgPct for non-heroes (hero buffs are already in CombatStats), then
 * the cast's skill modifier `damagePct` (heroes; 0 = none) and the monster
 * element conversion (convertsElement).
 */
export function rollDamage(
  world: World,
  ctx: SimContext,
  caster: Entity,
  skill: Readonly<SkillProto>,
  rank: number,
  damagePct = 0,
): Damage {
  const stats = world.peek(caster, CombatStats);
  if (!stats) return { phys: 0, fire: 0, cold: 0, lightning: 0, poison: 0 };
  const sheet = world.peek(caster, HeroStats);
  let d = rollSkillDamage(skill as SkillProto, rank, stats, sheet ? sheet.attrs : null, ctx.rng);
  if (!sheet) {
    const buff = buffStat(world, ctx.registry, caster, "dmgPct", ctx.tick);
    if (buff !== 0) d = scaleDamage(d, Math.max(0, 100 + buff));
    if (convertsElement(skill)) {
      let total = 0;
      for (const e of ELEMENTS) total += d[e];
      d = { phys: 0, fire: 0, cold: 0, lightning: 0, poison: 0 };
      d[skill.damage!.element] = total;
    }
  }
  if (damagePct !== 0) d = scaleDamage(d, Math.max(0, 100 + damagePct));
  return d;
}

/**
 * Statuses a skill applies on hit (rank-scaled; durations grown by the
 * cast's skill modifier `durationPct`), plus monster mod on-hit statuses.
 */
export function hitStatuses(
  world: World,
  registry: FrozenRegistry,
  caster: Entity,
  skill: Readonly<SkillProto> | undefined,
  rank: number,
  durationPct = 0,
): StatusApply[] {
  const out: StatusApply[] = [];
  const s = skill?.status;
  if (s) {
    out.push({
      id: s.id,
      chancePct: s.chancePct,
      duration: grow(s.duration, durationPct),
      power: s.power + s.powerPerRank * Math.max(0, rank - 1),
    });
  }
  const mods = world.exists(caster) ? (world.peek(caster, Monster)?.mods ?? []) : [];
  for (const id of mods) {
    const m = registry.get<MonsterModProto>(KIND.monsterMod, id);
    if (m?.onHitStatus) out.push({ ...m.onHitStatus });
  }
  return out;
}

/** durationPct of `owner`'s modifiers for `skillId` (0 without BonusStats); for delayed hits. */
export function durationPctOf(
  world: World,
  registry: FrozenRegistry,
  owner: Entity,
  skillId: string,
): number {
  return castMods(world, registry, owner, skillId)?.durationPct ?? 0;
}

export function makeHit(
  source: Entity,
  target: Entity,
  skill: string,
  damage: Damage,
  o: { canMiss: boolean; crit: boolean; statuses: StatusApply[]; knockback?: number },
): HitRequest {
  return {
    source,
    target,
    skill,
    damage,
    canMiss: o.canMiss,
    crit: o.crit,
    dot: false,
    statuses: o.statuses,
    knockback: o.knockback ?? 0,
  };
}

/** Extra projectiles from monster mods (volley). */
export function extraProjectiles(world: World, registry: FrozenRegistry, caster: Entity): number {
  let n = 0;
  for (const id of world.get(caster, Monster)?.mods ?? []) {
    n += registry.get<MonsterModProto>(KIND.monsterMod, id)?.extraProjectiles ?? 0;
  }
  return n;
}

/** A hit or a hostile status wakes sleeping/idle monsters and turns them on the source. */
export function wake(world: World, target: Entity, source: Entity): void {
  const ai = world.get(target, Ai);
  if (!ai || (ai.state !== "sleep" && ai.state !== "idle")) return;
  ai.state = "chase";
  if (source !== 0 && source !== target && world.exists(source)) ai.target = source;
}
