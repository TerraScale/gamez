/**
 * classic.combat.dashes (update 350): moves Dash holders `speed` sub per tick
 * toward (tx, ty), stopping at walls; on arrival (or timeout) the Dash ends,
 * damaging dashes hit their target (or the nearest enemy touching the
 * arrival point) with a one-tile knockback, and a classic.effect is emitted.
 * Wave A: hero dashes apply the skill modifiers damagePct and durationPct;
 * telegraphed dashes (line telegraphs, ./telegraphs.ts) already hit when the
 * line fired, so their dash deals no arrival hit.
 */
import type { SystemDef } from "@gamez/kernel";
import { pushHit } from "../bus.ts";
import { CombatStats, Dash, Dead, Mover, Pos } from "../components.ts";
import { emit } from "../events.ts";
import { facingOf, isqrt, scaleTo } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth } from "../resources.ts";
import { gridOf } from "../spatial.ts";
import { getAreaMap, walkableSub } from "../world/maps.ts";
import { canStand, inArea, isStunned } from "../core/units.ts";
import {
  bodyRadius,
  castMods,
  DASH_KNOCKBACK,
  enemiesInRadius,
  hitStatuses,
  isEnemyOf,
  makeHit,
  MELEE_SLACK,
  rollCrit,
  rollDamage,
  skillOf,
  teamOf,
} from "./common.ts";

export const dashesSystem: SystemDef = {
  ...SYSTEM.combatDashes,
  run(world, ctx) {
    const list = world.query(Dash, Pos);
    if (list.length === 0) return;
    const depth = currentDepth(world);
    const map = getAreaMap(world, ctx.registry);
    const grid = gridOf(world);
    for (const e of list) {
      if (!inArea(world, e, depth)) continue;
      if (world.has(e, Dead) || isStunned(world, ctx.registry, e, ctx.tick)) {
        world.remove(e, Dash);
        continue;
      }
      const d = world.read(e, Dash);
      const p = world.read(e, Pos);
      const r = bodyRadius(world, e);
      const startOk = canStand(map, p.x, p.y, r);
      const fits = (x: number, y: number): boolean =>
        startOk ? canStand(map, x, y, r) : walkableSub(map, x, y);
      const dx = d.tx - p.x;
      const dy = d.ty - p.y;
      const len = isqrt(dx * dx + dy * dy);
      let step = Math.min(len, d.speed);
      let arrived = len <= d.speed;
      // Back off in 32-sub steps until the body fits (a wall ends the dash).
      let [sx, sy] = step === len ? [dx, dy] : scaleTo(dx, dy, step);
      while (step > 0 && !fits(p.x + sx, p.y + sy)) {
        arrived = true;
        step = Math.max(0, step - 32);
        [sx, sy] = scaleTo(dx, dy, step);
      }
      if (sx !== 0 || sy !== 0) {
        p.x += sx;
        p.y += sy;
        grid.move(e, p.x, p.y);
      }
      const m = world.get(e, Mover);
      if (m) {
        m.moving = sx !== 0 || sy !== 0;
        if (m.moving) m.facing = facingOf(sx, sy, m.facing);
      }
      if (!arrived && ctx.tick < d.until) continue;

      world.remove(e, Dash);
      if (m) m.moving = false;
      const skill = skillOf(ctx.registry, d.skill);
      if (!skill) continue;
      const team = teamOf(world, e) ?? "monster";
      if ((skill.weaponPct > 0 || skill.damage) && !skill.telegraph) {
        let t = 0;
        if (isEnemyOf(world, d.target, team, depth)) {
          const tp = world.read(d.target, Pos);
          const reach = r + bodyRadius(world, d.target) + MELEE_SLACK;
          const ddx = tp.x - p.x;
          const ddy = tp.y - p.y;
          if (ddx * ddx + ddy * ddy <= reach * reach) t = d.target;
        }
        if (t === 0)
          t = enemiesInRadius(world, grid, p.x, p.y, r + MELEE_SLACK, team, depth)[0] ?? 0;
        if (t !== 0) {
          const mods = castMods(world, ctx.registry, e, d.skill);
          pushHit(
            world,
            makeHit(e, t, d.skill, rollDamage(world, ctx, e, skill, d.rank, mods?.damagePct ?? 0), {
              canMiss: false,
              crit: rollCrit(ctx.rng, world.get(e, CombatStats)),
              statuses: hitStatuses(world, ctx.registry, e, skill, d.rank, mods?.durationPct ?? 0),
              knockback: DASH_KNOCKBACK,
            }),
          );
        }
      }
      emit(ctx, {
        type: "classic.effect",
        effect: skill.effect,
        x: p.x,
        y: p.y,
        radius: 0,
        points: [],
      });
    }
  },
};
