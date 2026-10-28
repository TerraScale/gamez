/**
 * duel.ai: the wild creature's brain. Before each player command it plans the
 * wild move with ctx.rng, drawn from the moves that still have PP. The battle
 * then spends the plan on the wild turn.
 */
import { defineModule } from "@gamez/kernel";
import { pickUsableMove } from "./combat.ts";
import { BATTLE, Mon, type BattleState } from "./schema.ts";

export default defineModule({
  id: "duel.ai",
  version: "1.0.0",
  deps: ["duel.creatures", "duel.battle"],
  systems: [
    {
      id: "duel.ai.plan",
      stage: "pre",
      run(world, ctx) {
        const b = world.getResource<BattleState>(BATTLE);
        if (!b || b.phase !== "choose" || b.wildPlanned || b.wildMon === null) return;
        if (world.read(b.wildMon, Mon).hp <= 0) return;
        b.wildMove = pickUsableMove(world, ctx, b.wildMon);
        b.wildPlanned = true;
      },
    },
  ],
});
