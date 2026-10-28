/**
 * duel.team: the player's roster. Three random starters on setup; the team
 * holds up to six creatures and anything captured past that goes to the box.
 * duel.heal restores the team between battles.
 */
import { ActionError, defineModule, type Entity, type SimContext, type World } from "@gamez/kernel";
import { newMon, restore } from "./combat.ts";
import {
  BATTLE,
  Mon,
  STARTER_COUNT,
  STARTER_LEVEL,
  type BattleState,
  type CreatureDef,
} from "./schema.ts";

/** Player team members (team = true), ordered by slot. */
export function teamOf(world: World): Entity[] {
  return world
    .query(Mon)
    .filter((e) => {
      const m = world.read(e, Mon);
      return m.owner === "player" && m.team;
    })
    .sort((a, b) => world.read(a, Mon).slot - world.read(b, Mon).slot);
}

/** Team members with HP left, ordered by slot. */
export function aliveTeam(world: World): Entity[] {
  return teamOf(world).filter((e) => world.read(e, Mon).hp > 0);
}

export function boxCount(world: World): number {
  return world.query(Mon).filter((e) => {
    const m = world.read(e, Mon);
    return m.owner === "player" && !m.team;
  }).length;
}

/** The team member in `slot`, if any. */
export function teamSlot(world: World, slot: number): Entity | undefined {
  return teamOf(world).find((e) => world.read(e, Mon).slot === slot);
}

export default defineModule({
  id: "duel.team",
  version: "1.0.0",
  deps: ["duel.creatures"],
  setup(world, ctx: SimContext) {
    const ids = ctx.registry.all<CreatureDef>("duel.creature").map(([id]) => id);
    const picks = ctx.rng.shuffle(ids).slice(0, STARTER_COUNT);
    picks.forEach((id, slot) => newMon(world, ctx, id, STARTER_LEVEL, "player", true, slot));
  },
  actions: [
    {
      name: "duel.heal",
      parse() {
        return null;
      },
      apply(world, _payload, ctx) {
        const battle = world.getResource<BattleState>(BATTLE);
        if (battle && battle.phase !== "ended") {
          throw new ActionError("battle_active", "heal between battles only");
        }
        const members = teamOf(world);
        for (const e of members) restore(world, ctx, e);
        ctx.emit({ type: "duel.healed", count: members.length });
      },
    },
  ],
});
