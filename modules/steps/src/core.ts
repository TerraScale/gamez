/**
 * steps.core: prototypes (heroes, monsters, floor config), the run resource,
 * and the two basic actions every floor needs: stepping and waiting.
 */
import { ActionError, defineModule, type ActionDef } from "@gamez/kernel";
import { isWalkable } from "@gamez/world";
import {
  assertRunning,
  floorOf,
  heroEntity,
  isStep,
  occupantAt,
  Position,
  RUN_KEY,
  type FloorConfig,
  type HeroProto,
  type MonsterProto,
  type RunState,
} from "./components.ts";

export interface MoveInput {
  dx: number;
  dy: number;
}

const move: ActionDef<MoveInput> = {
  name: "steps.move",
  parse(world, payload) {
    assertRunning(world);
    const p = payload as { dx?: unknown; dy?: unknown } | null;
    if (typeof p !== "object" || p === null) {
      throw new ActionError("bad_payload", "steps.move needs {dx, dy}");
    }
    if (!isStep(p.dx) || !isStep(p.dy)) {
      throw new ActionError("out_of_range", "dx and dy must each be -1, 0 or 1");
    }
    if (p.dx === 0 && p.dy === 0) throw new ActionError("no_move", "dx and dy cannot both be 0");
    return { dx: p.dx, dy: p.dy };
  },
  apply(world, { dx, dy }, ctx) {
    const pos = world.read(heroEntity(world), Position);
    const floor = floorOf(world);
    const x = pos.x + dx;
    const y = pos.y + dy;
    if (!isWalkable(floor, x, y)) throw new ActionError("blocked", "a wall blocks the way");
    // No cutting corners: a diagonal step needs both orthogonal neighbours open (as findPath does).
    if (
      dx !== 0 &&
      dy !== 0 &&
      (!isWalkable(floor, pos.x + dx, pos.y) || !isWalkable(floor, pos.x, pos.y + dy))
    ) {
      throw new ActionError("corner", "cannot cut the corner of a wall");
    }
    if (occupantAt(world, x, y) !== undefined) {
      throw new ActionError("occupied", "something is standing there");
    }
    pos.x = x;
    pos.y = y;
    ctx.emit({ type: "steps.moved", x, y });
  },
};

const wait: ActionDef<null> = {
  name: "steps.wait",
  parse(world) {
    assertRunning(world);
    return null;
  },
  apply() {
    // Nothing to do: the world advances through the systems after this action.
  },
};

export const stepsCore = defineModule({
  id: "steps.core",
  version: "1.0.0",
  data(reg) {
    reg.define<HeroProto>("steps.hero", "steps.hero", { name: "Wanderer", hp: 12, dmg: 3 });
    reg.define<MonsterProto>("steps.monster", "steps.gloomcap", {
      name: "Gloomcap",
      hp: 4,
      dmg: 1,
    });
    reg.define<MonsterProto>("steps.monster", "steps.cinderpup", {
      name: "Cinderpup",
      hp: 6,
      dmg: 2,
    });
    reg.define<MonsterProto>("steps.monster", "steps.lanternmoth", {
      name: "Lanternmoth",
      hp: 9,
      dmg: 3,
    });
    reg.define<FloorConfig>("steps.floorConfig", "steps.floor", {
      width: 24,
      height: 24,
      rooms: 7,
      roomAttempts: 80,
      minRoom: 3,
      maxRoom: 6,
      roomGap: 2,
      monstersBase: 3,
      monstersPerDepth: 1,
      maxMonsters: 10,
      spawnClearance: 4,
      aggroRange: 8,
    });
  },
  setup(world) {
    const run: RunState = { depth: 1, kills: 0, over: false };
    world.setResource(RUN_KEY, run);
  },
  actions: [move, wait],
});
