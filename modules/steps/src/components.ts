/**
 * Components, resources and helpers shared by the steps modules. Everything
 * here is sim code: no randomness, time or I/O.
 */
import {
  ActionError,
  defineComponent,
  type Entity,
  type SimContext,
  type World,
} from "@gamez/kernel";
import type { TileMap } from "@gamez/world";

export interface Pos {
  x: number;
  y: number;
}

export const Position = defineComponent<Pos>("steps.position");
export const Health = defineComponent<{ hp: number; max: number }>("steps.health");
/** Registry kind and id of the prototype that gives this entity its stats. */
export const Actor = defineComponent<{ kind: ActorKind; proto: string }>("steps.actor");
/** Tag on the player's hero. */
export const Player = defineComponent<Record<string, never>>("steps.player");

/** Registry kinds used for actor stats. */
export type ActorKind = "steps.hero" | "steps.monster";

/** Run-wide state, resource "steps.run". */
export interface RunState {
  depth: number;
  kills: number;
  over: boolean;
}
export const RUN_KEY = "steps.run";

/** The current floor, resource "steps.floor": a TileMap plus its depth and stairs. */
export interface FloorState extends TileMap {
  depth: number;
  stairs: Pos;
}
export const FLOOR_KEY = "steps.floor";

export interface HeroProto {
  name: string;
  hp: number;
  dmg: number;
}

export interface MonsterProto {
  name: string;
  hp: number;
  dmg: number;
}

/** Registry kind "steps.floorConfig", id "steps.floor": how floors are generated and populated. */
export interface FloorConfig {
  width: number;
  height: number;
  rooms: number;
  roomAttempts: number;
  minRoom: number;
  maxRoom: number;
  /** Empty tiles kept between two rooms. */
  roomGap: number;
  monstersBase: number;
  monstersPerDepth: number;
  maxMonsters: number;
  /** No monsters within this Chebyshev distance of the spawn. */
  spawnClearance: number;
  /** Monsters within this distance (tiles) walk toward the hero. */
  aggroRange: number;
}

export const TILE_STONE = "tile.stone";
export const TILE_GRASS = "tile.grass";
export const PROP_TREE = "prop.tree";
export const PROP_STAIRS = "prop.stairs";

export function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function isStep(v: unknown): v is -1 | 0 | 1 {
  return v === -1 || v === 0 || v === 1;
}

export function heroEntity(world: World): Entity {
  const hero = world.query(Player)[0];
  if (hero === undefined) throw new Error("steps: no hero in the world");
  return hero;
}

export function runOf(world: World): RunState {
  const run = world.getResource<RunState>(RUN_KEY);
  if (run === undefined) throw new Error("steps: run state missing");
  return run;
}

export function floorOf(world: World): FloorState {
  const floor = world.getResource<FloorState>(FLOOR_KEY);
  if (floor === undefined) throw new Error("steps: floor missing");
  return floor;
}

/** Rejects every action once the hero has died. */
export function assertRunning(world: World): void {
  if (runOf(world).over)
    throw new ActionError("run_over", "the run is over: restart to play again");
}

/** The entity standing on a tile, if any (units only; walls are tiles, not entities). */
export function occupantAt(world: World, x: number, y: number): Entity | undefined {
  for (const e of world.query(Position)) {
    const p = world.read(e, Position);
    if (p.x === x && p.y === y) return e;
  }
  return undefined;
}

/** One attack: damage comes from the attacker's registry prototype. Deaths are handled after the systems. */
export function strike(world: World, ctx: SimContext, attacker: Entity, target: Entity): void {
  const by = world.read(attacker, Actor);
  const victim = world.read(target, Actor);
  const dmg = ctx.registry.require<{ dmg: number }>(by.kind, by.proto).dmg;
  const hp = world.read(target, Health);
  hp.hp = Math.max(0, hp.hp - dmg);
  ctx.emit({
    type: "steps.attacked",
    attacker,
    target,
    by: by.proto,
    victim: victim.proto,
    heroHit: world.has(target, Player),
    dmg,
    hp: hp.hp,
  });
}
