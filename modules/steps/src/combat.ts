/**
 * steps.combat: bump-to-attack (a wrap on steps.move, so moving into a monster
 * strikes it) and the death rules that run after every action's systems.
 */
import { defineModule } from "@gamez/kernel";
import {
  Actor,
  Health,
  heroEntity,
  type MonsterProto,
  occupantAt,
  Player,
  Position,
  RUN_KEY,
  runOf,
  strike,
} from "./components.ts";
import type { MoveInput } from "./core.ts";

export const stepsCombat = defineModule({
  id: "steps.combat",
  version: "1.0.0",
  deps: ["steps.core"],
  overrides: [
    {
      kind: "action",
      target: "steps.move",
      op: "wrap",
      with(world, payload, ctx, next) {
        const { dx, dy } = payload as MoveInput;
        const hero = heroEntity(world);
        const from = world.read(hero, Position);
        const target = occupantAt(world, from.x + dx, from.y + dy);
        if (target === undefined || !world.has(target, Actor)) {
          next(payload);
          return;
        }
        strike(world, ctx, hero, target);
      },
    },
  ],
  systems: [
    {
      id: "steps.combat.deaths",
      stage: "post",
      run(world, ctx) {
        const run = runOf(world);
        for (const e of world.query(Health, Actor)) {
          if (world.read(e, Health).hp > 0) continue;
          if (world.has(e, Player)) {
            if (!run.over) {
              run.over = true;
              ctx.emit({ type: "steps.hero_died", depth: run.depth, kills: run.kills });
            }
            continue;
          }
          const proto = world.read(e, Actor).proto;
          const stats = ctx.registry.require<MonsterProto>("steps.monster", proto);
          world.destroy(e);
          run.kills++;
          ctx.emit({ type: "steps.slain", entity: e, proto, name: stats.name, depth: run.depth });
        }
        world.setResource(RUN_KEY, run);
      },
    },
  ],
});
