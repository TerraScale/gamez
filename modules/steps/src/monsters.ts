/**
 * steps.monsters: after every action, each living monster strikes the hero
 * when adjacent, walks one step along a shortest path when the hero is within
 * aggro range, or waits.
 */
import { defineModule } from "@gamez/kernel";
import { findPath } from "@gamez/world";
import {
  Actor,
  chebyshev,
  floorOf,
  type FloorConfig,
  heroEntity,
  Health,
  Player,
  Position,
  occupantAt,
  strike,
} from "./components.ts";

export const stepsMonsters = defineModule({
  id: "steps.monsters",
  version: "1.0.0",
  deps: ["steps.core", "steps.floor"],
  systems: [
    {
      id: "steps.monsters.act",
      run(world, ctx) {
        const hero = heroEntity(world);
        const { aggroRange } = ctx.registry.require<FloorConfig>(
          "steps.floorConfig",
          "steps.floor",
        );
        const floor = floorOf(world);
        // Query order is ascending entity id, so turns resolve the same way on every machine.
        for (const e of world.query(Actor, Position, Health)) {
          if (world.has(e, Player) || world.read(e, Health).hp <= 0) continue;
          if (world.read(hero, Health).hp <= 0) return;
          const pos = world.read(e, Position);
          const heroPos = { ...world.read(hero, Position) };
          const dist = chebyshev(pos, heroPos);
          if (dist <= 1) {
            strike(world, ctx, e, hero);
            continue;
          }
          if (dist > aggroRange) continue;
          const next = findPath(floor, pos, heroPos)?.[0];
          if (next === undefined || occupantAt(world, next.x, next.y) !== undefined) continue;
          pos.x = next.x;
          pos.y = next.y;
        }
      },
    },
  ],
});
