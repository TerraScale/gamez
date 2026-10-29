/**
 * Monster death systems (owner: T4 monster builder).
 *
 * - classic.monsters.onDeath (update 750): every monster death runs the
 *   on-death skills of its prototype and mods (Emberbound novas, exploder
 *   bursts). Each skill rolls its damage once and pushes one HitRequest per
 *   hero-team unit within the skill radius of the death point. A monster
 *   killed by its own on-death skill (killer === itself, the exploder burst)
 *   does not fire it again (design §20).
 * - classic.monsters.corpses (post 200): monsters are destroyed corpseTicks
 *   after Dead.at; summons are destroyed at `until`, or when their owner is
 *   dead, gone or in another area.
 */
import type { SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, type DeathRecord, type HitRequest } from "../bus.ts";
import { AreaTag, CombatStats, Dead, Faction, Monster, Summoned } from "../components.ts";
import { emit } from "../events.ts";
import { tiles } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth } from "../resources.ts";
import { rollSkillDamage } from "../rules.ts";
import { gridOf } from "../spatial.ts";
import {
  BALANCE_ID,
  type BalanceProto,
  KIND,
  type MonsterModProto,
  type MonsterProto,
  type SkillProto,
} from "../types.ts";
import { forgetAggro, skillOf } from "./util.ts";

/** On-death skill ids of a monster: its prototype first, then its mods in order. */
function deathSkills(world: World, ctx: SimContext, e: number): string[] {
  const mon = world.get(e, Monster);
  if (mon === undefined) return [];
  const out: string[] = [];
  const proto = ctx.registry.get<MonsterProto>(KIND.monster, mon.proto);
  if (proto?.onDeathSkill !== undefined) out.push(proto.onDeathSkill);
  for (const id of mon.mods) {
    const mod = ctx.registry.get<MonsterModProto>(KIND.monsterMod, id);
    if (mod?.onDeathSkill !== undefined) out.push(mod.onDeathSkill);
  }
  return out;
}

function fireDeathSkill(world: World, ctx: SimContext, rec: DeathRecord, id: string): void {
  const sk: Readonly<SkillProto> | undefined = skillOf(ctx, id);
  const stats = world.get(rec.entity, CombatStats);
  if (sk === undefined || stats === undefined) return;
  const damage = rollSkillDamage(sk, 1, stats, null, ctx.rng);
  const radius = sk.radius ?? tiles(2);
  const status = sk.status;
  for (const victim of gridOf(world).query(rec.x, rec.y, radius)) {
    if (world.get(victim, Faction)?.team !== "hero" || world.has(victim, Dead)) continue;
    const hit: HitRequest = {
      source: rec.entity,
      target: victim,
      skill: id,
      damage: { ...damage },
      canMiss: false,
      crit: false,
      dot: false,
      statuses:
        status === undefined
          ? []
          : [
              {
                id: status.id,
                chancePct: status.chancePct,
                duration: status.duration,
                power: status.power,
              },
            ],
      knockback: 0,
    };
    busOf(world).hits.push(hit);
  }
  emit(ctx, { type: "classic.effect", effect: sk.effect, x: rec.x, y: rec.y, radius, points: [] });
}

export const monstersOnDeathSystem: SystemDef = {
  ...SYSTEM.monstersOnDeath,
  run(world, ctx) {
    const deaths = busOf(world).deaths;
    if (deaths.length === 0) return;
    for (const rec of deaths) {
      if (rec.team !== "monster" || rec.isHero) continue;
      // A monster that killed itself already fired its burst (exploder).
      if (rec.killer === rec.entity) continue;
      for (const id of deathSkills(world, ctx, rec.entity)) fireDeathSkill(world, ctx, rec, id);
    }
  },
};

export const monstersCorpsesSystem: SystemDef = {
  ...SYSTEM.monstersCorpses,
  run(world, ctx) {
    const depth = currentDepth(world);
    const corpseTicks = ctx.registry.get<BalanceProto>(KIND.balance, BALANCE_ID)?.corpseTicks ?? 40;
    const grid = gridOf(world);
    for (const e of world.query(Monster, Dead)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      if (ctx.tick - world.read(e, Dead).at < corpseTicks) continue;
      grid.remove(e);
      world.destroy(e);
      forgetAggro(world, e);
    }
    for (const e of world.query(Summoned)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      if (shouldExpire(world, e, ctx.tick, depth)) {
        grid.remove(e);
        world.destroy(e);
        forgetAggro(world, e);
      }
    }
  },
};

/** A summon expires at `until`, or when its owner is dead, gone or in another area. */
function shouldExpire(world: World, e: number, tick: number, depth: number): boolean {
  const s = world.read(e, Summoned);
  if (s.until > 0 && tick >= s.until) return true;
  if (s.owner === 0) return false;
  if (!world.exists(s.owner) || world.has(s.owner, Dead)) return true;
  return world.get(s.owner, AreaTag)?.depth !== depth;
}
