/**
 * Player actions of classic.talents (wave A §3): classic.learnTalent and
 * classic.resetTalents. parse() is strict; both call noteManual() and then
 * run the shared execX function for the CONTROLLED hero (heroOf), which
 * throws ActionError when it fails.
 */
import { ActionError, type ActionDef, type SimContext, type World } from "@gamez/kernel";
import { ACTION, ERR, type OpResult } from "../actions.ts";
import { noteManual } from "../control.ts";
import { heroOf } from "../resources.ts";
import { execLearnTalent, execResetTalents } from "./ops.ts";

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

const learnTalent: ActionDef<{ node: string }> = {
  name: ACTION.learnTalent,
  parse(_world: World, payload) {
    const p = fields(payload, ["node"]);
    if (typeof p.node !== "string")
      throw new ActionError(ERR.badPayload, '"node" must be a string');
    return { node: p.node };
  },
  apply(world, p, ctx: SimContext) {
    noteManual(world, ctx);
    unwrap(execLearnTalent(world, ctx, heroOf(world), p.node));
  },
};

const resetTalents: ActionDef<Record<string, never>> = {
  name: ACTION.resetTalents,
  parse(_world, payload) {
    if (payload === undefined) return {};
    fields(payload, []);
    return {};
  },
  apply(world, _p, ctx) {
    noteManual(world, ctx);
    unwrap(execResetTalents(world, ctx, heroOf(world)));
  },
};

export const talentsActions = [learnTalent, resetTalents];
