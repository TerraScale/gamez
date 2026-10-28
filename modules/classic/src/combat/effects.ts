/**
 * classic.combat.effects (update 550): GroundEffect entities (fields, lingering
 * bursts) hit every enemy within `radius` every `every` ticks from `nextAt`
 * until `until`, then disappear. Damage is the pre-rolled packet; the
 * skill's status (if any) rides along.
 */
import type { SystemDef } from "@gamez/kernel";
import { pushHit } from "../bus.ts";
import { AreaTag, GroundEffect, Pos } from "../components.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth } from "../resources.ts";
import { gridOf } from "../spatial.ts";
import { enemiesInRadius, hitStatuses, makeHit, skillOf } from "./common.ts";

export const effectsSystem: SystemDef = {
  ...SYSTEM.combatEffects,
  run(world, ctx) {
    const list = world.query(GroundEffect, Pos, AreaTag);
    if (list.length === 0) return;
    const depth = currentDepth(world);
    const grid = gridOf(world);
    for (const e of list) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const g = world.read(e, GroundEffect);
      if (ctx.tick >= g.nextAt && g.nextAt < g.until) {
        const p = world.read(e, Pos);
        const skill = skillOf(ctx.registry, g.skill);
        const statuses = hitStatuses(world, ctx.registry, g.owner, skill, g.rank);
        for (const t of enemiesInRadius(world, grid, p.x, p.y, g.radius, g.team, depth)) {
          pushHit(
            world,
            makeHit(
              g.owner,
              t,
              g.skill,
              { ...g.damage },
              { canMiss: false, crit: false, statuses },
            ),
          );
        }
        g.nextAt += Math.max(1, g.every);
      }
      if (ctx.tick >= g.until) world.destroy(e);
    }
  },
};
