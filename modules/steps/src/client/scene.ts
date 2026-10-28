/**
 * Pure read model for the steps client: turns a world into the board the
 * renderer and HUD draw, plus the key and facing tables. No DOM or Pixi here.
 */
import type { FrozenRegistry, GameEvent, World } from "@gamez/kernel";
import type { Facing, RenderEntity } from "@gamez/ui-host";
import {
  Actor,
  FLOOR_KEY,
  type FloorState,
  Health,
  type HeroProto,
  type MonsterProto,
  Player,
  Position,
  type Pos,
  RUN_KEY,
  type RunState,
} from "../components.ts";

export interface BoardUnit {
  id: number;
  proto: string;
  name: string;
  pos: Pos;
  hp: number;
  max: number;
  hero: boolean;
}

export interface Board {
  floor: FloorState;
  run: RunState;
  units: BoardUnit[];
  hero: BoardUnit | null;
}

/** The board for a world snapshot, or null while the instance has no floor yet. */
export function readBoard(world: World, registry: FrozenRegistry): Board | null {
  const floor = world.getResource<FloorState>(FLOOR_KEY);
  const run = world.getResource<RunState>(RUN_KEY);
  if (floor === undefined || run === undefined) return null;
  const units: BoardUnit[] = [];
  for (const e of world.query(Actor, Position, Health)) {
    const actor = world.read(e, Actor);
    const pos = world.read(e, Position);
    const hp = world.read(e, Health);
    const hero = world.has(e, Player);
    const name = hero
      ? registry.require<HeroProto>("steps.hero", actor.proto).name
      : (registry.get<MonsterProto>("steps.monster", actor.proto)?.name ?? actor.proto);
    units.push({ id: e, proto: actor.proto, name, pos: { ...pos }, hp: hp.hp, max: hp.max, hero });
  }
  const hero = units.find((u) => u.hero) ?? null;
  return { floor, run, units, hero };
}

/** Whether the hero stands on the stairs. */
export function onStairs(board: Board): boolean {
  const hero = board.hero;
  return (
    hero !== null && hero.pos.x === board.floor.stairs.x && hero.pos.y === board.floor.stairs.y
  );
}

const FACINGS = new Map<string, Facing>([
  ["0,-1", "n"],
  ["1,-1", "ne"],
  ["1,0", "e"],
  ["1,1", "se"],
  ["0,1", "s"],
  ["-1,1", "sw"],
  ["-1,0", "w"],
  ["-1,-1", "nw"],
]);

/** The iso facing for a grid step, or null for no movement. */
export function facingFor(dx: number, dy: number): Facing | null {
  return FACINGS.get(`${Math.sign(dx)},${Math.sign(dy)}`) ?? null;
}

/** Render entities for a board. Monsters face the hero; the hero faces `heroFacing`. */
export function renderEntities(board: Board, heroFacing: Facing): RenderEntity[] {
  return board.units.map((u) => {
    const hero = board.hero?.pos ?? u.pos;
    const facing = u.hero ? heroFacing : (facingFor(hero.x - u.pos.x, hero.y - u.pos.y) ?? "s");
    return {
      id: `steps-${u.id}`,
      name: u.name,
      appearance: u.hero ? "unit.hero" : `unit.monster.${u.proto.slice("steps.".length)}`,
      x: u.pos.x,
      y: u.pos.y,
      facing,
      moving: false,
      isSelf: u.hero,
    };
  });
}

/** One line for the event log, or null for events that are not worth a line. */
export function describeEvent(ev: GameEvent, registry: FrozenRegistry): string | null {
  const name = (proto: unknown): string => {
    if (typeof proto !== "string") return "something";
    if (proto === "steps.hero") return "you";
    return registry.get<MonsterProto>("steps.monster", proto)?.name ?? proto;
  };
  switch (ev.type) {
    case "steps.attacked": {
      const by = name(ev.by);
      const victim = ev.heroHit ? "you" : name(ev.victim);
      return `${by} hits ${victim} for ${String(ev.dmg)} (${String(ev.hp)} left)`;
    }
    case "steps.slain":
      return `${name(ev.proto)} is slain`;
    case "steps.descended":
      return `You descend to depth ${String(ev.depth)}`;
    case "steps.hero_died":
      return `You fall on depth ${String(ev.depth)} after ${String(ev.kills)} kills. The run is over.`;
    default:
      return null;
  }
}

/** Key to intent: arrows and WASD for orthogonal steps, QEZC for diagonals, "." to wait, ">" to descend. */
export type Intent =
  | { kind: "move"; dx: number; dy: number }
  | { kind: "wait" }
  | { kind: "descend" };

const KEYS = new Map<string, Intent>([
  ["ArrowUp", { kind: "move", dx: 0, dy: -1 }],
  ["w", { kind: "move", dx: 0, dy: -1 }],
  ["W", { kind: "move", dx: 0, dy: -1 }],
  ["ArrowDown", { kind: "move", dx: 0, dy: 1 }],
  ["s", { kind: "move", dx: 0, dy: 1 }],
  ["S", { kind: "move", dx: 0, dy: 1 }],
  ["ArrowLeft", { kind: "move", dx: -1, dy: 0 }],
  ["a", { kind: "move", dx: -1, dy: 0 }],
  ["A", { kind: "move", dx: -1, dy: 0 }],
  ["ArrowRight", { kind: "move", dx: 1, dy: 0 }],
  ["d", { kind: "move", dx: 1, dy: 0 }],
  ["D", { kind: "move", dx: 1, dy: 0 }],
  ["q", { kind: "move", dx: -1, dy: -1 }],
  ["Q", { kind: "move", dx: -1, dy: -1 }],
  ["e", { kind: "move", dx: 1, dy: -1 }],
  ["E", { kind: "move", dx: 1, dy: -1 }],
  ["z", { kind: "move", dx: -1, dy: 1 }],
  ["Z", { kind: "move", dx: -1, dy: 1 }],
  ["c", { kind: "move", dx: 1, dy: 1 }],
  ["C", { kind: "move", dx: 1, dy: 1 }],
  [".", { kind: "wait" }],
  [" ", { kind: "wait" }],
  [">", { kind: "descend" }],
  ["Enter", { kind: "descend" }],
]);

export function intentForKey(key: string): Intent | null {
  return KEYS.get(key) ?? null;
}
