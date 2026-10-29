/**
 * classic.crafting actions and command system (OWNER: T-items). parse()
 * validates the payload shape; apply() notes the manual command (auto pause)
 * and runs the shared execX op (ops.ts), throwing ActionError on failure so
 * the kernel rolls everything back. The command system (update 54) drains
 * the crafting ops of Bus.commands and emits classic.command.failed.
 */
import {
  ActionError,
  type ActionDef,
  type Entity,
  type SimContext,
  type SystemDef,
  type World,
} from "@gamez/kernel";
import {
  ACTION,
  ERR,
  fail,
  type ActionPayloads,
  type HeroCommand,
  type OpResult,
} from "../actions.ts";
import { busOf, takeCommands } from "../bus.ts";
import { noteManual } from "../control.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { commandActor } from "../items/common.ts";
import { heroOf } from "../resources.ts";
import {
  execAddSocket,
  execCombineGems,
  execRepair,
  execReroll,
  execSocketGem,
  execUnsocket,
  execUpgrade,
} from "./ops.ts";

const MAX_ID = 2_147_483_647;

export const CRAFTING_OPS = [
  "repair",
  "upgrade",
  "reroll",
  "addSocket",
  "socketGem",
  "unsocket",
  "combineGems",
] as const;

/** Runs one crafting command for the hero it names (HeroCommand.hero, else the controlled hero). */
export function runCraftingCommand(world: World, ctx: SimContext, c: HeroCommand): OpResult {
  const hero = commandActor(world, c);
  if (typeof hero !== "number") return hero;
  switch (c.op) {
    case "repair":
      return execRepair(world, ctx, hero, c.npc, c.uid);
    case "upgrade":
      return execUpgrade(world, ctx, hero, c.npc, c.uid);
    case "reroll":
      return execReroll(world, ctx, hero, c.npc, c.uid);
    case "addSocket":
      return execAddSocket(world, ctx, hero, c.npc, c.uid);
    case "socketGem":
      return execSocketGem(world, ctx, hero, c.npc, c.uid, c.gem);
    case "unsocket":
      return execUnsocket(world, ctx, hero, c.npc, c.uid);
    case "combineGems":
      return execCombineGems(world, ctx, hero, c.npc, c.base);
    default:
      return fail(ERR.badPayload, "not a crafting command");
  }
}

export const craftingCommandsSystem: SystemDef = {
  ...SYSTEM.craftingCommands,
  run(world, ctx) {
    if (busOf(world).commands.length === 0) return;
    for (const c of takeCommands(world, CRAFTING_OPS)) {
      const r = runCraftingCommand(world, ctx, c);
      if (!r.ok) {
        emit(ctx, {
          type: "classic.command.failed",
          op: c.op,
          code: r.code,
          message: r.message,
          ...(c.hero !== undefined ? { hero: c.hero } : {}),
        });
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function obj(payload: unknown, what: string): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ActionError(ERR.badPayload, `${what}: expected an object`);
  }
  return payload as Record<string, unknown>;
}

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new ActionError(ERR.badPayload, `${field} must be an integer ${min}..${max}`);
  }
  return v;
}

/** Hero exists and `npc` is an existing entity id. */
function npcAndHero(world: World, p: Record<string, unknown>): Entity {
  if (heroOf(world) === 0) throw new ActionError(ERR.noHero, "there is no hero yet");
  const npc = int(p.npc, "npc", 1, MAX_ID);
  if (!world.exists(npc)) throw new ActionError(ERR.badTarget, "npc is not an entity");
  return npc;
}

function commit(world: World, ctx: SimContext, r: OpResult): void {
  noteManual(world, ctx);
  if (!r.ok) throw new ActionError(r.code, r.message);
}

type UidPayload = { npc: Entity; uid: number };

/** An action of shape {npc, uid} (uid 1.., or 0.. when `allowZero`). */
function uidAction(
  name: string,
  allowZero: boolean,
  exec: (world: World, ctx: SimContext, hero: Entity, npc: Entity, uid: number) => OpResult,
): ActionDef<UidPayload> {
  return {
    name,
    parse(world, payload) {
      const p = obj(payload, name);
      const npc = npcAndHero(world, p);
      return { npc, uid: int(p.uid, "uid", allowZero ? 0 : 1, MAX_ID) };
    },
    apply(world, p, ctx) {
      commit(world, ctx, exec(world, ctx, heroOf(world), p.npc, p.uid));
    },
  };
}

export const repairAction = uidAction(ACTION.repair, true, execRepair);
export const upgradeItemAction = uidAction(ACTION.upgradeItem, false, execUpgrade);
export const rerollItemAction = uidAction(ACTION.rerollItem, false, execReroll);
export const addSocketAction = uidAction(ACTION.addSocket, false, execAddSocket);
export const unsocketGemsAction = uidAction(ACTION.unsocketGems, false, execUnsocket);

export const socketGemAction: ActionDef<ActionPayloads["classic.socketGem"]> = {
  name: ACTION.socketGem,
  parse(world, payload) {
    const p = obj(payload, "socketGem");
    const npc = npcAndHero(world, p);
    return { npc, uid: int(p.uid, "uid", 1, MAX_ID), gem: int(p.gem, "gem", 1, MAX_ID) };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execSocketGem(world, ctx, heroOf(world), p.npc, p.uid, p.gem));
  },
};

export const combineGemsAction: ActionDef<ActionPayloads["classic.combineGems"]> = {
  name: ACTION.combineGems,
  parse(world, payload) {
    const p = obj(payload, "combineGems");
    const npc = npcAndHero(world, p);
    if (typeof p.base !== "string" || p.base.length === 0 || p.base.length > 64) {
      throw new ActionError(ERR.badPayload, "base must be a gem base id");
    }
    return { npc, base: p.base };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execCombineGems(world, ctx, heroOf(world), p.npc, p.base));
  },
};

export const craftingActions: ActionDef<any>[] = [
  repairAction,
  upgradeItemAction,
  rerollItemAction,
  addSocketAction,
  socketGemAction,
  unsocketGemsAction,
  combineGemsAction,
];
