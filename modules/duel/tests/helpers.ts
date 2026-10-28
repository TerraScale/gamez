/** Shared helpers for the duel sim tests: a seeded sim and a simple scripted player. */
import { createSim, loadMode, type DispatchResult, type Sim } from "@gamez/kernel";
import { mode, modules } from "../src/index.ts";
import { BATTLE, Mon, type BattleState, type CreatureDef, type MonState } from "../src/schema.ts";

export function newSim(seed: number): Sim {
  return createSim(loadMode(mode, modules), { seed });
}

export function battleOf(sim: Sim): BattleState {
  const b = sim.world.getResource<BattleState>(BATTLE);
  if (!b) throw new Error("no battle state");
  return b;
}

export function monOf(sim: Sim, entity: number | null): MonState {
  if (entity === null) throw new Error("no entity");
  return sim.world.read(entity, Mon);
}

/** Team members (owner player, in the team) ordered by slot. */
export function teamMons(sim: Sim): { entity: number; mon: MonState }[] {
  return sim.world
    .query(Mon)
    .map((entity) => ({ entity, mon: sim.world.read(entity, Mon) }))
    .filter((x) => x.mon.owner === "player" && x.mon.team)
    .sort((a, b) => a.mon.slot - b.mon.slot);
}

/** The next command a simple player would send: switch when forced, else the first move with PP. */
export function nextCommand(sim: Sim): [string, unknown] {
  const b = battleOf(sim);
  if (b.phase === "switch") {
    const next = teamMons(sim).find((t) => t.mon.hp > 0 && t.entity !== b.playerMon);
    if (!next) throw new Error("no creature left to send out");
    return ["duel.switch", { slot: next.mon.slot }];
  }
  if (b.phase === "ended") return ["duel.nextBattle", null];
  const lead = monOf(sim, b.playerMon);
  const species = sim.loaded.registry.require<CreatureDef>("duel.creature", lead.species);
  const idx = lead.pp.findIndex((pp) => pp > 0);
  return idx < 0 ? ["duel.capture", null] : ["duel.useMove", { moveId: species.moves[idx] }];
}

/** Runs `plan` commands until `done` holds or `cap` commands were sent. */
export function playUntil(sim: Sim, done: (sim: Sim) => boolean, cap = 80): DispatchResult[] {
  const results: DispatchResult[] = [];
  for (let i = 0; i < cap && !done(sim); i++) {
    const [name, payload] = nextCommand(sim);
    results.push(sim.dispatch(name, payload, "player-1"));
  }
  return results;
}

/** Captures until the battle ends (switching in when forced). Deterministic for a given seed. */
export function captureUntilEnded(sim: Sim, cap = 80): DispatchResult[] {
  const results: DispatchResult[] = [];
  for (let i = 0; i < cap && battleOf(sim).phase !== "ended"; i++) {
    const b = battleOf(sim);
    const cmd: [string, unknown] = b.phase === "switch" ? nextCommand(sim) : ["duel.capture", null];
    results.push(sim.dispatch(cmd[0], cmd[1], "player-1"));
  }
  return results;
}
