/**
 * Boss encounters (wave A, docs/design/wave-A.md §6.2; owner T-bosses):
 * phases and telegraph pacing for monsters with behaviour "boss".
 *
 * Phases (MonsterProto.phases, sorted by atPct descending): entered once
 * each, in order, as soon as life <= atPct % of max (several in one think
 * when a big hit skips one). Ai.count = phases done. Entering a phase emits
 * classic.boss.phase, teaches the phase `skills` (SkillBook) so they join the
 * rotation, summons minions (`summon`) and applies classic.status.enrage
 * (`enragePct` > 0; a buff read by combat for monster damage and attack/cast
 * speed; re-applying keeps the higher power). A boss respawned after its
 * level was destroyed starts at count 0 and enters its passed phases again.
 *
 * Telegraph pacing: a boss never places a telegraph while one of its own is
 * still pending (so two of them are always at least the telegraph's ticks
 * apart), and it holds still while its line telegraph (rush) is pending so
 * the dash follows the marked lane.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { pushSpawn } from "../bus.ts";
import {
  AreaTag,
  Dead,
  Faction,
  GroundEffect,
  Life,
  Monster,
  Pos,
  SkillBook,
  Summoned,
} from "../components.ts";
import { ENRAGE_STATUS } from "../content/boss.ts";
import { emit } from "../events.ts";
import { KIND, type MonsterProto, type SkillProto } from "../types.ts";
import { applyStatus } from "../combat/statuses.ts";
import { skillOf } from "./util.ts";

/** Enrage lasts for the rest of any fight (one sim hour). */
export const ENRAGE_TICKS = 20 * 60 * 60;
/** Minions called per summoning phase, and the most a boss keeps alive from phases. */
export const PHASE_SUMMONS = 3;
export const PHASE_SUMMON_MAX = 9;
/** Lifetime of phase minions (ticks). */
export const PHASE_SUMMON_TICKS = 900;

/** True for a proto that uses the wave A phase rules (has at least one phase). */
export function hasPhases(proto: Readonly<MonsterProto>): boolean {
  return proto.phases !== undefined && proto.phases.length > 0;
}

/**
 * Enters every phase whose threshold the boss's life has reached, in order.
 * Returns the new phase count (Ai.count).
 */
export function enterPhases(
  world: World,
  ctx: SimContext,
  e: Entity,
  proto: Readonly<MonsterProto>,
  count: number,
): number {
  const phases = proto.phases ?? [];
  if (count >= phases.length) return count;
  const life = world.get(e, Life);
  if (life === undefined || life.hp <= 0) return count;
  let n = count;
  while (n < phases.length && life.hp * 100 <= life.max * phases[n]!.atPct) {
    const ph = phases[n]!;
    n++;
    emit(ctx, {
      type: "classic.boss.phase",
      entity: e,
      monster: world.read(e, Monster).proto,
      phase: n,
      message: ph.message,
      enraged: ph.enragePct > 0,
    });
    if (ph.skills.length > 0) learnSkills(world, ctx, e, ph.skills);
    if (ph.summon) summonMinions(world, ctx, e, proto);
    if (ph.enragePct > 0) {
      applyStatus(
        world,
        ctx,
        e,
        { id: ENRAGE_STATUS, duration: ENRAGE_TICKS, power: ph.enragePct },
        e,
      );
    }
  }
  return n;
}

/** Skill ids a boss may rotate through now: its skills after [0] plus the skills of the phases done. */
export function rotationSkills(proto: Readonly<MonsterProto>, count: number): string[] {
  const out = proto.skills.slice(1);
  const phases = proto.phases ?? [];
  for (let i = 0; i < Math.min(count, phases.length); i++) {
    for (const id of phases[i]!.skills) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Adds the skills to the boss's SkillBook (rank like monsters.spawn: level / 3, at least 1). */
function learnSkills(world: World, ctx: SimContext, e: Entity, ids: readonly string[]): void {
  const book = world.get(e, SkillBook);
  if (book === undefined) return;
  const level = world.get(e, Monster)?.level ?? 1;
  const ranks = book.ranks.map((r) => ({ skill: r.skill, rank: r.rank }));
  let changed = false;
  for (const id of ids) {
    if (ranks.some((r) => r.skill === id)) continue;
    const sk = ctx.registry.get<SkillProto>(KIND.skill, id);
    if (sk === undefined) continue;
    ranks.push({ skill: id, rank: Math.min(sk.maxRank, Math.max(1, Math.floor(level / 3))) });
    changed = true;
  }
  if (!changed) return;
  ranks.sort((a, b) => (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0));
  world.update(e, SkillBook, { ranks });
}

/** Minion type of a boss: its `boss.minions`, else the monster of its first summon skill. */
export function minionOf(ctx: SimContext, proto: Readonly<MonsterProto>): string {
  const m = proto.boss?.minions ?? "";
  if (m !== "" && ctx.registry.has(KIND.monster, m)) return m;
  for (const id of proto.skills) {
    const sm = skillOf(ctx, id)?.summon;
    if (sm !== undefined && ctx.registry.has(KIND.monster, sm.monster)) return sm.monster;
  }
  return "";
}

function summonMinions(
  world: World,
  ctx: SimContext,
  e: Entity,
  proto: Readonly<MonsterProto>,
): void {
  const minion = minionOf(ctx, proto);
  if (minion === "") return;
  let alive = 0;
  for (const s of world.query(Summoned)) {
    if (world.read(s, Summoned).owner === e && !world.has(s, Dead)) alive++;
  }
  const n = Math.min(PHASE_SUMMONS, PHASE_SUMMON_MAX - alive);
  if (n <= 0) return;
  const mon = world.read(e, Monster);
  const p = world.read(e, Pos);
  const depth = world.read(e, AreaTag).depth;
  const team = world.read(e, Faction).team;
  // Ring of offsets around the boss; monsters.spawn snaps each to a walkable tile.
  const ring: [number, number][] = [
    [384, 0],
    [-384, 0],
    [0, 384],
    [0, -384],
    [272, 272],
    [-272, -272],
  ];
  for (let i = 0; i < n; i++) {
    const [ox, oy] = ring[i % ring.length]!;
    pushSpawn(world, {
      monster: minion,
      x: p.x + ox,
      y: p.y + oy,
      depth,
      level: mon.level,
      rarity: "summon",
      mods: [],
      pack: mon.pack,
      name: "",
      owner: e,
      team,
      until: ctx.tick + PHASE_SUMMON_TICKS,
      awake: true,
    });
  }
  emit(ctx, { type: "classic.effect", effect: "fx.raise", x: p.x, y: p.y, radius: 0, points: [] });
}

/** The boss's own pending telegraphs: whether there is any, and whether one is a line. */
export function pendingTelegraphs(world: World, e: Entity): { any: boolean; line: boolean } {
  let any = false;
  let line = false;
  for (const g of world.query(GroundEffect)) {
    const v = world.read(g, GroundEffect);
    if (v.once !== true || v.owner !== e) continue;
    any = true;
    if (v.shape === "line") line = true;
  }
  return { any, line };
}
