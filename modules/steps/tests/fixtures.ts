/** Shared helpers for the steps tests: the loaded mode, sims, and a scripted player. */
import { createSim, loadMode, type DispatchResult, type GameEvent, type Sim } from "@gamez/kernel";
import { findPath } from "@gamez/world";
import { chebyshev } from "../src/components.ts";
import {
  Actor,
  floorOf,
  heroEntity,
  Health,
  type FloorState,
  Position,
  type Pos,
  runOf,
} from "../src/components.ts";
import { mode, modules } from "../src/index.ts";

export const loaded = loadMode(mode, modules);

export function newSim(seed: number): Sim {
  return createSim(loaded, { seed });
}

export function heroPos(sim: Sim): Pos {
  return { ...sim.world.read(heroEntity(sim.world), Position) };
}

export function heroHealth(sim: Sim): { hp: number; max: number } {
  return { ...sim.world.read(heroEntity(sim.world), Health) };
}

export function floorOfSim(sim: Sim): FloorState {
  return floorOf(sim.world);
}

export function isOver(sim: Sim): boolean {
  return runOf(sim.world).over;
}

/** Monsters as {x, y, proto} in entity order. */
export function monsters(sim: Sim): { entity: number; pos: Pos; proto: string }[] {
  const out: { entity: number; pos: Pos; proto: string }[] = [];
  for (const e of sim.world.query(Actor, Position)) {
    const actor = sim.world.read(e, Actor);
    if (actor.kind !== "steps.monster") continue;
    out.push({ entity: e, pos: { ...sim.world.read(e, Position) }, proto: actor.proto });
  }
  return out;
}

export function act(sim: Sim, name: string, payload: unknown = {}): DispatchResult {
  return sim.dispatch(name, payload, "tester");
}

/**
 * A scripted player: strikes an adjacent monster when there is one, otherwise
 * walks the shortest path to the stairs (moving into a monster on the path is
 * an attack), then descends. Returns true when it reached the next depth.
 */
export function descendScripted(sim: Sim, events: GameEvent[], maxActions = 600): boolean {
  for (let i = 0; i < maxActions; i++) {
    if (isOver(sim)) return false;
    const floor = floorOfSim(sim);
    const hero = heroPos(sim);
    if (hero.x === floor.stairs.x && hero.y === floor.stairs.y) {
      const res = act(sim, "steps.descend");
      events.push(...res.events);
      return res.ok;
    }
    const foe = monsters(sim).find((m) => chebyshev(m.pos, hero) === 1);
    const next = foe?.pos ?? findPath(floor, hero, floor.stairs)?.[0];
    const res = next
      ? act(sim, "steps.move", { dx: next.x - hero.x, dy: next.y - hero.y })
      : act(sim, "steps.wait");
    if (!res.ok) throw new Error(`scripted player rejected: ${res.error?.code ?? "?"}`);
    events.push(...res.events);
  }
  return false;
}
