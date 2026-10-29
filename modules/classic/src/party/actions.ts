/**
 * classic.party actions — OWNER: T-party-module (docs/design/party.md §4.1).
 *
 * Every action: parse() validates strictly (integers, member entities, clean
 * names, known config keys and types) and throws ActionError(ERR.badPayload)
 * for anything else. apply() runs the shared execX function, which calls
 * ensureParty() first (the lazy migration) and returns an OpResult. A failure
 * becomes an ActionError, so the kernel rolls the world back.
 */
import { ActionError, type ActionDef, type SimContext, type World } from "@gamez/kernel";
import { ACTION, ERR, type ActionPayloads, type OpResult } from "../actions.ts";
import { noteManual } from "../control.ts";
import { heroOf, type PartyConfig, type PartyFormation } from "../resources.ts";
import { cleanHeroName } from "../progression/hero.ts";
import { execControl } from "./control.ts";
import { execRecruit } from "./recruit.ts";
import { execBuySlot, execConfig, execDismiss, execGive, execRename, execReorder } from "./ops.ts";

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

/** An entity id from a payload: a non-negative safe integer. */
function entityOf(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new ActionError(ERR.badPayload, `${what} must be an entity id`);
  }
  return v;
}

/** A clean hero name (cleanHeroName) from a payload. */
function nameOfPayload(v: unknown): string {
  if (typeof v !== "string") throw new ActionError(ERR.badPayload, "name must be a string");
  const name = cleanHeroName(v);
  if (name === null) {
    throw new ActionError(ERR.badPayload, "name must be 1-16 letters, digits, spaces, _ or -");
  }
  return name;
}

const FORMATIONS: readonly PartyFormation[] = ["wedge", "line", "ring"];

/** Partial<PartyConfig> with strict keys and types. */
function configPatch(v: unknown): Partial<PartyConfig> {
  const p = fields(v, ["formation", "spread", "focusFire", "revive", "autoSwitch"]);
  const out: Partial<PartyConfig> = {};
  if (p.formation !== undefined) {
    if (typeof p.formation !== "string" || !FORMATIONS.includes(p.formation as PartyFormation)) {
      throw new ActionError(ERR.badPayload, "formation must be wedge, line or ring");
    }
    out.formation = p.formation as PartyFormation;
  }
  if (p.spread !== undefined) {
    if (
      typeof p.spread !== "number" ||
      !Number.isInteger(p.spread) ||
      p.spread < 1 ||
      p.spread > 4
    ) {
      throw new ActionError(ERR.badPayload, "spread must be an integer 1..4");
    }
    out.spread = p.spread;
  }
  for (const k of ["focusFire", "revive", "autoSwitch"] as const) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== "boolean") throw new ActionError(ERR.badPayload, `${k} must be a boolean`);
    out[k] = p[k] as boolean;
  }
  return out;
}

const recruit: ActionDef<ActionPayloads["classic.party.recruit"]> = {
  name: ACTION.partyRecruit,
  parse(_world: World, payload) {
    const p = fields(payload, ["classId", "name"]);
    if (typeof p.classId !== "string" || p.classId.length > 80) {
      throw new ActionError(ERR.badPayload, "classId must be a class id");
    }
    return { classId: p.classId, name: nameOfPayload(p.name) };
  },
  apply(world, p, ctx: SimContext) {
    noteManual(world, ctx);
    unwrap(execRecruit(world, ctx, { classId: p.classId, name: p.name, free: false }));
  },
};

const dismiss: ActionDef<ActionPayloads["classic.party.dismiss"]> = {
  name: ACTION.partyDismiss,
  parse(_world: World, payload) {
    return { hero: entityOf(fields(payload, ["hero"]).hero, "hero") };
  },
  apply(world, p, ctx) {
    noteManual(world, ctx);
    unwrap(execDismiss(world, ctx, p.hero));
  },
};

const rename: ActionDef<ActionPayloads["classic.party.rename"]> = {
  name: ACTION.partyRename,
  parse(_world: World, payload) {
    const p = fields(payload, ["hero", "name"]);
    return { hero: entityOf(p.hero, "hero"), name: nameOfPayload(p.name) };
  },
  apply(world, p, ctx) {
    unwrap(execRename(world, ctx, p.hero, p.name));
  },
};

const reorder: ActionDef<ActionPayloads["classic.party.reorder"]> = {
  name: ACTION.partyReorder,
  parse(_world: World, payload) {
    const p = fields(payload, ["order"]);
    if (!Array.isArray(p.order) || p.order.length < 1 || p.order.length > 4) {
      throw new ActionError(ERR.badPayload, "order must list 1..4 members");
    }
    return { order: p.order.map((e) => entityOf(e, "order entry")) };
  },
  apply(world, p, ctx) {
    unwrap(execReorder(world, ctx, p.order));
  },
};

const control: ActionDef<ActionPayloads["classic.party.control"]> = {
  name: ACTION.partyControl,
  parse(_world: World, payload) {
    return { hero: entityOf(fields(payload, ["hero"]).hero, "hero") };
  },
  apply(world, p, ctx) {
    unwrap(execControl(world, ctx, p.hero));
  },
};

const config: ActionDef<ActionPayloads["classic.party.config"]> = {
  name: ACTION.partyConfig,
  parse(_world: World, payload) {
    const p = fields(payload, ["config"]);
    return { config: configPatch(p.config) };
  },
  apply(world, p, ctx) {
    unwrap(execConfig(world, ctx, p.config));
  },
};

const buySlot: ActionDef<ActionPayloads["classic.party.buySlot"]> = {
  name: ACTION.partyBuySlot,
  parse(_world: World, payload) {
    if (payload !== undefined) fields(payload, []);
    return {};
  },
  apply(world, _p, ctx) {
    noteManual(world, ctx);
    unwrap(execBuySlot(world, ctx));
  },
};

const give: ActionDef<ActionPayloads["classic.party.give"]> = {
  name: ACTION.partyGive,
  parse(_world: World, payload) {
    const p = fields(payload, ["uid", "to"]);
    if (typeof p.uid !== "number" || !Number.isSafeInteger(p.uid) || p.uid < 0) {
      throw new ActionError(ERR.badPayload, "uid must be an item uid");
    }
    return { uid: p.uid, to: entityOf(p.to, "to") };
  },
  apply(world, p, ctx) {
    noteManual(world, ctx);
    const hero = heroOf(world);
    if (hero === 0) throw new ActionError(ERR.noHero, "there is no hero yet");
    unwrap(execGive(world, ctx, hero, p.uid, p.to));
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const partyActions: ActionDef<any>[] = [
  recruit,
  dismiss,
  rename,
  reorder,
  control,
  config,
  buySlot,
  give,
];
