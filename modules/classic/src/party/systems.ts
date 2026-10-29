/**
 * classic.party systems — OWNER: T-party-module (docs/design/party.md §7.3).
 *   SYSTEM.partyCommands (update 56): drains the `revive` and `give` HeroCommands.
 *   SYSTEM.partyRevive   (post 610): Reviving channels, town revive, downed / wiped events (revive.ts).
 *   SYSTEM.partyControl  (post 620): control auto-switch on death (control.ts).
 * Every system returns at once when the party has fewer than two members
 * (a solo world never changes).
 */
import type { SystemDef } from "@gamez/kernel";
import { busOf, takeCommands } from "../bus.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { partyControl } from "./control.ts";
import { execGive } from "./ops.ts";
import { execRevive, partyRevive } from "./revive.ts";
import { commandHero, partySize } from "./shared.ts";
import { ERR } from "../actions.ts";

const OPS = ["revive", "give"] as const;

const partyCommands: SystemDef = {
  ...SYSTEM.partyCommands,
  run(world, ctx) {
    if (busOf(world).commands.length === 0) return;
    if (partySize(world) < 2) return;
    for (const c of takeCommands(world, OPS)) {
      const actor = commandHero(world, c);
      const r =
        actor === 0
          ? { ok: false as const, code: ERR.notMember, message: "not a party member" }
          : c.op === "revive"
            ? execRevive(world, ctx, actor, c.target)
            : execGive(world, ctx, actor, c.uid, c.to);
      if (!r.ok) {
        emit(ctx, { type: "classic.command.failed", op: c.op, code: r.code, message: r.message });
      }
    }
  },
};

export const partySystems: SystemDef[] = [partyCommands, partyRevive, partyControl];
