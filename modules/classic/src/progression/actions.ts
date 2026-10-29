/**
 * Player actions of classic.progression (docs/design/classic.md §3.7). parse()
 * is strict: unknown fields, wrong types and unknown ids throw ActionError.
 * Manual actions call noteManual() so auto/idle yields to the player. Shared
 * logic lives in hero.ts and ops.ts; apply() throws when an op fails. Every
 * action acts for the CONTROLLED hero (heroOf; docs/design/party.md §4.1).
 */
import { ActionError, type ActionDef, type SimContext, type World } from "@gamez/kernel";
import { ACTION, ERR, type OpResult } from "../actions.ts";
import { noteManual } from "../control.ts";
import { type GameState, heroOf, RES } from "../resources.ts";
import { ATTRS, type Attr, KIND } from "../types.ts";
import { cleanHeroName, execNewHero } from "./hero.ts";
import {
  BAR_SLOTS,
  execAcceptQuest,
  execAllocate,
  execCompleteQuest,
  execLearn,
  execRespawn,
  execSetBar,
} from "./ops.ts";

/** Payload must be a plain object with only the listed keys. */
function fields(payload: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ActionError(ERR.badPayload, "expected an object");
  }
  for (const k of Object.keys(payload)) {
    if (!keys.includes(k)) throw new ActionError(ERR.badPayload, `unexpected field "${k}"`);
  }
  return payload as Record<string, unknown>;
}

function unwrap(r: OpResult): void {
  if (!r.ok) throw new ActionError(r.code, r.message);
}

function stringField(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string") throw new ActionError(ERR.badPayload, `"${key}" must be a string`);
  return v;
}

const newHero: ActionDef<{ classId: string; name: string }> = {
  name: ACTION.newHero,
  parse(world, payload, ctx) {
    const game = world.getResource<GameState>(RES.game);
    if (!game || game.phase !== "choose")
      throw new ActionError(ERR.heroExists, "a hero already exists");
    const p = fields(payload, ["classId", "name"]);
    const classId = stringField(p, "classId");
    if (!ctx.registry.has(KIND.class, classId)) {
      throw new ActionError(ERR.unknownId, `unknown class "${classId}"`);
    }
    const name = cleanHeroName(stringField(p, "name"));
    if (name === null) {
      throw new ActionError(ERR.badPayload, "name must be 1-16 letters, digits, spaces, _ or -");
    }
    return { classId, name };
  },
  apply(world, p, ctx) {
    unwrap(execNewHero(world, ctx, p.classId, p.name));
  },
};

const allocateStat: ActionDef<{ attr: Attr; points: number }> = {
  name: ACTION.allocateStat,
  parse(_world, payload) {
    const p = fields(payload, ["attr", "points"]);
    const attr = p.attr;
    if (typeof attr !== "string" || !(ATTRS as readonly string[]).includes(attr)) {
      throw new ActionError(ERR.badPayload, "attr must be str, dex, mag or vit");
    }
    if (typeof p.points !== "number" || !Number.isInteger(p.points) || p.points < 1) {
      throw new ActionError(ERR.badPayload, "points must be a positive integer");
    }
    return { attr: attr as Attr, points: p.points };
  },
  apply(world: World, p, ctx: SimContext) {
    noteManual(world, ctx);
    unwrap(execAllocate(world, ctx, heroOf(world), p.attr, p.points));
  },
};

const learnSkill: ActionDef<{ skill: string }> = {
  name: ACTION.learnSkill,
  parse(world, payload, ctx) {
    const skill = stringField(fields(payload, ["skill"]), "skill");
    if (!ctx.registry.has(KIND.skill, skill)) {
      throw new ActionError(ERR.unknownId, `unknown skill "${skill}"`);
    }
    return { skill };
  },
  apply(world, p, ctx) {
    noteManual(world, ctx);
    unwrap(execLearn(world, ctx, heroOf(world), p.skill));
  },
};

const setSkillBar: ActionDef<{ slot: number; skill: string | null }> = {
  name: ACTION.setSkillBar,
  parse(_world, payload, ctx) {
    const p = fields(payload, ["slot", "skill"]);
    if (
      typeof p.slot !== "number" ||
      !Number.isInteger(p.slot) ||
      p.slot < 0 ||
      p.slot >= BAR_SLOTS
    ) {
      throw new ActionError(ERR.badPayload, `slot must be 0..${BAR_SLOTS - 1}`);
    }
    if (p.skill === null) return { slot: p.slot, skill: null };
    const skill = stringField(p, "skill");
    if (!ctx.registry.has(KIND.skill, skill)) {
      throw new ActionError(ERR.unknownId, `unknown skill "${skill}"`);
    }
    return { slot: p.slot, skill };
  },
  apply(world, p, ctx) {
    noteManual(world, ctx);
    unwrap(execSetBar(world, ctx, heroOf(world), p.slot, p.skill));
  },
};

const respawn: ActionDef<Record<string, never>> = {
  name: ACTION.respawn,
  parse(_world, payload) {
    if (payload === undefined) return {};
    fields(payload, []);
    return {};
  },
  apply(world, _p, ctx) {
    noteManual(world, ctx);
    unwrap(execRespawn(world, ctx, heroOf(world)));
  },
};

const acceptQuest: ActionDef<{ quest: string }> = {
  name: ACTION.acceptQuest,
  parse(_world, payload, ctx) {
    const quest = stringField(fields(payload, ["quest"]), "quest");
    if (!ctx.registry.has(KIND.quest, quest)) {
      throw new ActionError(ERR.unknownId, `unknown quest "${quest}"`);
    }
    return { quest };
  },
  apply(world, p, ctx) {
    noteManual(world, ctx);
    unwrap(execAcceptQuest(world, ctx, heroOf(world), p.quest));
  },
};

const completeQuest: ActionDef<{ quest: string }> = {
  name: ACTION.completeQuest,
  parse(_world, payload, ctx) {
    const quest = stringField(fields(payload, ["quest"]), "quest");
    if (!ctx.registry.has(KIND.quest, quest)) {
      throw new ActionError(ERR.unknownId, `unknown quest "${quest}"`);
    }
    return { quest };
  },
  apply(world, p, ctx) {
    noteManual(world, ctx);
    unwrap(execCompleteQuest(world, ctx, heroOf(world), p.quest));
  },
};

export const progressionActions: ActionDef<any>[] = [
  newHero,
  allocateStat,
  learnSkill,
  setSkillBar,
  respawn,
  acceptQuest,
  completeQuest,
];
