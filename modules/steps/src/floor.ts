/**
 * steps.floor: procedural floors (rooms joined by corridors, stairs in the
 * last room), the hero's arrival, monster population and the descend action.
 */
import { ActionError, defineModule, type SimContext, type World } from "@gamez/kernel";
import {
  assertRunning,
  Actor,
  chebyshev,
  FLOOR_KEY,
  floorOf,
  heroEntity,
  Health,
  PROP_STAIRS,
  PROP_TREE,
  Player,
  Position,
  runOf,
  RUN_KEY,
  TILE_GRASS,
  TILE_STONE,
  type FloorConfig,
  type FloorState,
  type HeroProto,
  type MonsterProto,
  type Pos,
} from "./components.ts";

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

function center(r: Room): Pos {
  return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
}

/** True when two rooms come closer than `gap` empty tiles. */
function tooClose(a: Room, b: Room, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
  );
}

/**
 * Builds a floor from ctx.rng: walls everywhere, rooms carved as stone,
 * consecutive rooms joined by L-shaped grass corridors. The spawn sits in the
 * first room and the stairs in the last.
 */
export function generateFloor(ctx: SimContext, depth: number): FloorState {
  const cfg = ctx.registry.require<FloorConfig>("steps.floorConfig", "steps.floor");
  const { width, height } = cfg;
  const ground: string[] = Array.from({ length: width * height }, () => TILE_GRASS);
  const objects: (string | null)[] = Array.from<string | null>({ length: width * height }).fill(
    PROP_TREE,
  );
  const walkable: number[] = Array.from({ length: width * height }, () => 0);
  const index = (x: number, y: number): number => y * width + x;

  // Carves an open tile; corridors never overwrite room floors.
  const open = (x: number, y: number, tile: string): void => {
    const i = index(x, y);
    if (walkable[i] === 1) return;
    ground[i] = tile;
    objects[i] = null;
    walkable[i] = 1;
  };

  const rooms: Room[] = [];
  for (let attempt = 0; attempt < cfg.roomAttempts && rooms.length < cfg.rooms; attempt++) {
    const w = ctx.rng.int(cfg.minRoom, cfg.maxRoom);
    const h = ctx.rng.int(cfg.minRoom, cfg.maxRoom);
    const room: Room = {
      x: ctx.rng.int(1, width - w - 1),
      y: ctx.rng.int(1, height - h - 1),
      w,
      h,
    };
    if (rooms.some((other) => tooClose(room, other, cfg.roomGap))) continue;
    rooms.push(room);
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) open(x, y, TILE_STONE);
    }
  }
  if (rooms.length < 2) throw new Error("steps: floor generation produced fewer than 2 rooms");

  for (let i = 1; i < rooms.length; i++) {
    const a = center(rooms[i - 1] as Room);
    const b = center(rooms[i] as Room);
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) open(x, a.y, TILE_GRASS);
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) open(b.x, y, TILE_GRASS);
  }

  const spawn = center(rooms[0] as Room);
  const stairs = center(rooms[rooms.length - 1] as Room);
  objects[index(stairs.x, stairs.y)] = PROP_STAIRS;

  return {
    id: `steps.floor.${depth}`,
    width,
    height,
    ground,
    objects,
    walkable,
    spawn,
    depth,
    stairs,
  };
}

/** Spawns monsters on open tiles away from the spawn. Prototypes are picked with ctx.rng in id order. */
export function populateMonsters(world: World, ctx: SimContext, floor: FloorState): void {
  const cfg = ctx.registry.require<FloorConfig>("steps.floorConfig", "steps.floor");
  const ids = ctx.registry.all<MonsterProto>("steps.monster").map(([id]) => id);
  const candidates: Pos[] = [];
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      const i = y * floor.width + x;
      if (floor.walkable[i] !== 1 || floor.objects[i] !== null) continue;
      if (chebyshev({ x, y }, floor.spawn) < cfg.spawnClearance) continue;
      candidates.push({ x, y });
    }
  }
  const count = Math.min(cfg.maxMonsters, cfg.monstersBase + cfg.monstersPerDepth * floor.depth);
  for (const spot of ctx.rng.shuffle(candidates).slice(0, count)) {
    const id = ctx.rng.pick(ids);
    const proto = ctx.registry.require<MonsterProto>("steps.monster", id);
    const e = world.create();
    world.add(e, Position, { x: spot.x, y: spot.y });
    world.add(e, Health, { hp: proto.hp, max: proto.hp });
    world.add(e, Actor, { kind: "steps.monster", proto: id });
  }
}

export const stepsFloor = defineModule({
  id: "steps.floor",
  version: "1.0.0",
  deps: ["steps.core"],
  setup(world, ctx) {
    const floor = generateFloor(ctx, 1);
    world.setResource(FLOOR_KEY, floor);
    const hero = ctx.registry.require<HeroProto>("steps.hero", "steps.hero");
    const e = world.create();
    world.add(e, Player, {});
    world.add(e, Position, { x: floor.spawn.x, y: floor.spawn.y });
    world.add(e, Health, { hp: hero.hp, max: hero.hp });
    world.add(e, Actor, { kind: "steps.hero", proto: "steps.hero" });
    populateMonsters(world, ctx, floor);
  },
  actions: [
    {
      name: "steps.descend",
      parse(world) {
        assertRunning(world);
        return null;
      },
      apply(world, _payload, ctx) {
        const floor = floorOf(world);
        const pos = world.read(heroEntity(world), Position);
        if (pos.x !== floor.stairs.x || pos.y !== floor.stairs.y) {
          throw new ActionError("not_on_stairs", "stand on the stairs to descend");
        }
        for (const e of world.query(Actor)) {
          if (!world.has(e, Player)) world.destroy(e);
        }
        const depth = floor.depth + 1;
        const next = generateFloor(ctx, depth);
        world.setResource(FLOOR_KEY, next);
        pos.x = next.spawn.x;
        pos.y = next.spawn.y;
        populateMonsters(world, ctx, next);
        const run = runOf(world);
        run.depth = depth;
        world.setResource(RUN_KEY, run);
        ctx.emit({ type: "steps.descended", depth });
      },
    },
  ],
});
