/**
 * The in-sim message bus (CONTRACT, implemented): typed queues in the
 * resource "classic.bus" that decouple modules. Producers push, the owning
 * consumer drains. All queues are plain JSON and normally empty between
 * ticks, so snapshots stay small.
 *
 * | queue       | producers                                  | consumer (drains)                         | lifetime                 |
 * | ----------- | ------------------------------------------ | ----------------------------------------- | ------------------------ |
 * | hits        | combat (casts, projectiles, effects, dots), monsters (on-death bursts) | combat.resolveHits (update 700) | hits pushed after 700 resolve next tick (core.cleanup carries them once) |
 * | deaths      | combat.resolveHits                         | read by progression, items, monsters, world, auto in post | cleared by core.cleanup (post 1000) |
 * | spawns      | world (population), combat (summon skills), monsters (summoner, boss minions) | monsters.spawn (pre -1050) | until drained |
 * | transitions | world command ops, progression (respawn, newHero) | world.transition (pre -1100)        | until drained            |
 * | commands    | auto, core.intent, any system              | items/world/progression command systems (update 50-52) | leftovers carried one tick, then dropped by core.cleanup |
 */
import type { Entity, World } from "@gamez/kernel";
import type { HeroCommand } from "./actions.ts";
import { RES } from "./resources.ts";
import type { Damage, MonsterRarity, Team } from "./types.ts";

export interface StatusApply {
  id: string;
  chancePct: number;
  duration: number;
  power: number;
}

export interface HitRequest {
  source: Entity;
  target: Entity;
  /** Skill id that produced the hit ("" for thorns etc.). */
  skill: string;
  /** Pre-roll damage per element (after the caster's bonuses, before the target's defences). */
  damage: Damage;
  /** Attack roll (to-hit vs armor) and block apply. */
  canMiss: boolean;
  /** Crit already rolled by the caster (x CombatStats.critMult applied by resolve). */
  crit: boolean;
  /** Damage-over-time tick: no crit, no miss, no lifesteal, no on-hit statuses. */
  dot: boolean;
  statuses: StatusApply[];
  /** Push the target away from the source by this many sub (0 = none). */
  knockback: number;
}

export interface DeathRecord {
  entity: Entity;
  killer: Entity;
  /** Team of the killer's side that gets credit ("hero" includes hero summons). */
  creditTeam: Team;
  team: Team;
  isHero: boolean;
  x: number;
  y: number;
  depth: number;
  /** Monster fields ("" / 0 for the hero). */
  monster: string;
  rarity: MonsterRarity | "hero";
  level: number;
  xp: number;
  pack: number;
}

export interface SpawnRequest {
  monster: string;
  /** Sub units. */
  x: number;
  y: number;
  depth: number;
  level: number;
  rarity: MonsterRarity;
  mods: string[];
  pack: number;
  /** Display name override ("" = derive from proto and mods). */
  name: string;
  /** Hero-team summon owner (0 = none, monster team). Summons of monsters set owner too but keep team "monster". */
  owner: Entity;
  team: Team;
  /** Absolute tick it expires (0 = never). */
  until: number;
  /** Starts awake (summons, boss minions). */
  awake: boolean;
}

export type TransitionVia =
  | "new"
  | "stairsDown"
  | "stairsUp"
  | "waypoint"
  | "townPortal"
  | "portal"
  | "respawn"
  /** wave A: town -> a rift level (`to` = rules.riftDepth(level, run)), pushed by classic.rift. */
  | "rift"
  /** wave A: rift level -> town (completed, abandoned), pushed by classic.rift. */
  | "riftExit";

export interface TransitionRequest {
  to: number;
  via: TransitionVia;
}

export interface Bus {
  hits: HitRequest[];
  deaths: DeathRecord[];
  spawns: SpawnRequest[];
  transitions: TransitionRequest[];
  commands: HeroCommand[];
}

export function emptyBus(): Bus {
  return { hits: [], deaths: [], spawns: [], transitions: [], commands: [] };
}

/** The live bus (creates it if missing, so tests with a partial module set still work). */
export function busOf(world: World): Bus {
  let b = world.getResource<Bus>(RES.bus);
  if (b === undefined) {
    world.setResource(RES.bus, emptyBus());
    b = world.getResource<Bus>(RES.bus)!;
  }
  return b;
}

export function pushHit(world: World, hit: HitRequest): void {
  busOf(world).hits.push(hit);
}

export function pushSpawn(world: World, req: SpawnRequest): void {
  busOf(world).spawns.push(req);
}

export function pushTransition(world: World, req: TransitionRequest): void {
  busOf(world).transitions.push(req);
}

export function pushCommand(world: World, cmd: HeroCommand): void {
  busOf(world).commands.push(cmd);
}

/**
 * Removes and returns the queued commands whose op is in `ops`, keeping the
 * others in order. Owner command systems call this once per tick.
 */
export function takeCommands<O extends HeroCommand["op"]>(
  world: World,
  ops: readonly O[],
): Extract<HeroCommand, { op: O }>[] {
  const bus = busOf(world);
  const mine: Extract<HeroCommand, { op: O }>[] = [];
  const rest: HeroCommand[] = [];
  for (const c of bus.commands) {
    if ((ops as readonly string[]).includes(c.op)) mine.push(c as Extract<HeroCommand, { op: O }>);
    else rest.push(c);
  }
  bus.commands = rest;
  return mine;
}

/** Zero damage packet. */
export function noDamage(): Damage {
  return { phys: 0, fire: 0, cold: 0, lightning: 0, poison: 0 };
}

export function totalDamage(d: Damage): number {
  return d.phys + d.fire + d.cold + d.lightning + d.poison;
}
