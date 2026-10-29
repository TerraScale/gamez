/**
 * classic.core input actions (docs/design/classic.md §5): classic.moveTo,
 * classic.useSkill, classic.stop, classic.pickup, classic.interact. Each one
 * validates strictly, writes the hero Intent with source "manual" and
 * at = ctx.tick, drops the current walk, and calls noteManual().
 *
 * Party (docs/design/party.md §4): every action acts for the CONTROLLED hero
 * (heroOf). classic.interact also accepts a downed party member (not the
 * controlled hero itself) of this area: the intent walks there and revives.
 */
import {
  ActionError,
  type ActionDef,
  type Entity,
  type SimContext,
  type World,
} from "@gamez/kernel";
import { ACTION, ERR, type ActionPayloads } from "../actions.ts";
import {
  CastOrder,
  Dead,
  Faction,
  Intent,
  Interactable,
  Life,
  Loot,
  Mover,
  Npc,
  Pos,
  SkillBook,
  type HeroIntentValue,
} from "../components.ts";
import { noteManual } from "../control.ts";
import { currentDepth, heroOf } from "../resources.ts";
import { KIND, type SkillProto } from "../types.ts";
import { getAreaMap, walkableAt } from "../world/maps.ts";
import { isDownedAlly } from "./intent.ts";
import { inArea } from "./units.ts";

function bad(message: string): never {
  throw new ActionError(ERR.badPayload, message);
}

function obj(payload: unknown, allowEmpty = false): Record<string, unknown> {
  if (allowEmpty && payload === undefined) return {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    bad("expected an object payload");
  }
  return payload as Record<string, unknown>;
}

function int(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) bad(`${name} must be an integer`);
  return v;
}

function entityArg(v: unknown, name: string): Entity {
  const e = int(v, name);
  if (e < 0) bad(`${name} must be >= 0`);
  return e;
}

/** The live hero, or throws no_hero / dead. */
export function requireLiveHero(world: World): Entity {
  const hero = heroOf(world);
  if (hero === 0 || !world.has(hero, Intent)) {
    throw new ActionError(ERR.noHero, "no hero");
  }
  if (world.has(hero, Dead)) throw new ActionError(ERR.dead, "the hero is dead");
  return hero;
}

/** Target entity that exists in the current area. */
function areaEntity(world: World, e: Entity): boolean {
  return e !== 0 && world.exists(e) && world.has(e, Pos) && inArea(world, e, currentDepth(world));
}

function writeIntent(world: World, ctx: SimContext, hero: Entity, intent: HeroIntentValue): void {
  world.add(hero, Intent, intent);
  const m = world.get(hero, Mover);
  if (m) {
    if (m.path.length > 0) m.path = [];
    m.goalX = -1;
    m.goalY = -1;
  }
  noteManual(world, ctx);
}

const moveTo: ActionDef<ActionPayloads["classic.moveTo"]> = {
  name: ACTION.moveTo,
  parse(world, payload, ctx) {
    const o = obj(payload);
    const x = int(o.x, "x");
    const y = int(o.y, "y");
    requireLiveHero(world);
    const map = getAreaMap(world, ctx.registry);
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) {
      throw new ActionError(ERR.badTarget, "tile outside the map");
    }
    if (!walkableAt(map, x, y)) throw new ActionError(ERR.blocked, "tile is not walkable");
    return { x, y };
  },
  apply(world, p, ctx) {
    const hero = requireLiveHero(world);
    writeIntent(world, ctx, hero, {
      kind: "move",
      source: "manual",
      at: ctx.tick,
      x: p.x,
      y: p.y,
    });
  },
};

const useSkill: ActionDef<ActionPayloads["classic.useSkill"]> = {
  name: ACTION.useSkill,
  parse(world, payload, ctx) {
    const o = obj(payload);
    if (typeof o.skill !== "string" || o.skill === "") bad("skill must be a skill id");
    const skillId = o.skill;
    const target = entityArg(o.target, "target");
    const x = int(o.x, "x");
    const y = int(o.y, "y");
    if (typeof o.repeat !== "boolean") bad("repeat must be a boolean");
    const repeat = o.repeat;
    const hero = requireLiveHero(world);
    const skill = ctx.registry.get<SkillProto>(KIND.skill, skillId);
    if (!skill) throw new ActionError(ERR.unknownId, `unknown skill "${skillId}"`);
    const rank = world.get(hero, SkillBook)?.ranks.find((r) => r.skill === skillId)?.rank ?? 0;
    if (rank < 1) throw new ActionError(ERR.notKnown, `skill "${skillId}" is not known`);
    if (skill.target === "enemy" && target === 0) {
      throw new ActionError(ERR.badTarget, "this skill needs an enemy target");
    }
    if (target !== 0) {
      if (
        !areaEntity(world, target) ||
        !world.has(target, Life) ||
        world.has(target, Dead) ||
        target === hero
      ) {
        throw new ActionError(ERR.badTarget, "target is not a live unit in this area");
      }
      const mine = world.get(hero, Faction)?.team ?? "hero";
      if (skill.target === "enemy" && world.get(target, Faction)?.team === mine) {
        throw new ActionError(ERR.badTarget, "target is not an enemy");
      }
    }
    if (skill.target !== "self") {
      const map = getAreaMap(world, ctx.registry);
      if (x < 0 || y < 0 || x >= map.width * 256 || y >= map.height * 256) {
        throw new ActionError(ERR.badTarget, "point outside the map");
      }
    }
    return { skill: skillId, target, x, y, repeat };
  },
  apply(world, p, ctx) {
    const hero = requireLiveHero(world);
    writeIntent(world, ctx, hero, {
      kind: "skill",
      source: "manual",
      at: ctx.tick,
      skill: p.skill,
      target: p.target,
      x: p.x,
      y: p.y,
      repeat: p.repeat,
    });
  },
};

const stopAction: ActionDef<ActionPayloads["classic.stop"]> = {
  name: ACTION.stop,
  parse(world, payload) {
    obj(payload, true);
    requireLiveHero(world);
    return {};
  },
  apply(world, _p, ctx) {
    const hero = requireLiveHero(world);
    if (world.has(hero, CastOrder)) world.remove(hero, CastOrder);
    writeIntent(world, ctx, hero, { kind: "idle", source: "manual", at: ctx.tick });
  },
};

const pickup: ActionDef<ActionPayloads["classic.pickup"]> = {
  name: ACTION.pickup,
  parse(world, payload) {
    const o = obj(payload);
    const target = entityArg(o.target, "target");
    requireLiveHero(world);
    if (!areaEntity(world, target) || !world.has(target, Loot)) {
      throw new ActionError(ERR.badTarget, "no loot there");
    }
    return { target };
  },
  apply(world, p, ctx) {
    const hero = requireLiveHero(world);
    writeIntent(world, ctx, hero, {
      kind: "pickup",
      source: "manual",
      at: ctx.tick,
      target: p.target,
    });
  },
};

const interact: ActionDef<ActionPayloads["classic.interact"]> = {
  name: ACTION.interact,
  parse(world, payload) {
    const o = obj(payload);
    const target = entityArg(o.target, "target");
    const hero = requireLiveHero(world);
    if (
      !areaEntity(world, target) ||
      !(
        world.has(target, Npc) ||
        world.has(target, Interactable) ||
        isDownedAlly(world, hero, target)
      )
    ) {
      throw new ActionError(ERR.badTarget, "nothing to interact with there");
    }
    return { target };
  },
  apply(world, p, ctx) {
    const hero = requireLiveHero(world);
    writeIntent(world, ctx, hero, {
      kind: "interact",
      source: "manual",
      at: ctx.tick,
      target: p.target,
    });
  },
};

export const coreActions: ActionDef<any>[] = [moveTo, useSkill, stopAction, pickup, interact];
