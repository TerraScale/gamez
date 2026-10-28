/**
 * classic.progression.commands (update 52): drains the progression ops of the
 * bus queue and runs them through the shared execX functions. Failures emit
 * classic.command.failed (docs/design/classic.md §3.3).
 */
import type { SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, takeCommands } from "../bus.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import type { HeroCommand } from "../actions.ts";
import type { OpResult } from "../actions.ts";
import {
  execAcceptQuest,
  execAllocate,
  execCompleteQuest,
  execGrantXp,
  execHeal,
  execLearn,
  execRespawn,
  execSetBar,
} from "./ops.ts";

const OPS = [
  "allocate",
  "learn",
  "setBar",
  "respawn",
  "heal",
  "acceptQuest",
  "completeQuest",
  "grantXp",
] as const;

function runCommand(world: World, ctx: SimContext, c: HeroCommand): OpResult {
  switch (c.op) {
    case "allocate":
      return execAllocate(world, ctx, c.attr, c.points);
    case "learn":
      return execLearn(world, ctx, c.skill);
    case "setBar":
      return execSetBar(world, ctx, c.slot, c.skill);
    case "respawn":
      return execRespawn(world, ctx);
    case "heal":
      return execHeal(world, ctx, c.npc);
    case "acceptQuest":
      return execAcceptQuest(world, ctx, c.quest);
    case "completeQuest":
      return execCompleteQuest(world, ctx, c.quest);
    case "grantXp":
      return execGrantXp(world, ctx, c.amount, c.reason);
    default:
      return { ok: false, code: "unhandled", message: "not a progression op" };
  }
}

export const progressionCommands: SystemDef = {
  ...SYSTEM.progressionCommands,
  run(world, ctx) {
    if (busOf(world).commands.length === 0) return;
    for (const c of takeCommands(world, OPS)) {
      const r = runCommand(world, ctx, c);
      if (!r.ok) {
        emit(ctx, { type: "classic.command.failed", op: c.op, code: r.code, message: r.message });
      }
    }
  },
};
