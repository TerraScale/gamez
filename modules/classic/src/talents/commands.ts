/**
 * classic.talents.commands (update 53, SYSTEM.talentsCommands): drains the
 * learnTalent / resetTalents ops of the bus queue and runs them through the
 * shared execX functions for the hero each command names (HeroCommand.hero,
 * else the controlled hero). Failures emit classic.command.failed.
 */
import type { SystemDef } from "@gamez/kernel";
import { busOf, takeCommands } from "../bus.ts";
import type { OpResult } from "../actions.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { commandActor } from "../items/common.ts";
import { execLearnTalent, execResetTalents } from "./ops.ts";

const OPS = ["learnTalent", "resetTalents"] as const;

export const talentsCommands: SystemDef = {
  ...SYSTEM.talentsCommands,
  run(world, ctx) {
    if (busOf(world).commands.length === 0) return;
    for (const c of takeCommands(world, OPS)) {
      const hero = commandActor(world, c);
      const r: OpResult =
        typeof hero !== "number"
          ? hero
          : c.op === "learnTalent"
            ? execLearnTalent(world, ctx, hero, c.node)
            : execResetTalents(world, ctx, hero);
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
