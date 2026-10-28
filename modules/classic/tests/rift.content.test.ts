/**
 * The real rift content (wave A, T-rift): every level must hold enough
 * progress points to reach RiftProto.goal, or a run could never finish.
 * Measured on the classic content, the same way a run enters the level.
 */
import {
  createSim,
  defineMode,
  loadMode,
  type Entity,
  type LoadedMode,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { modules as classicModules } from "../src/index.ts";
import { ACTION } from "../src/actions.ts";
import { AreaTag, Interactable, Monster, Pos, Wallet } from "../src/components.ts";
import { RES, type DungeonState } from "../src/resources.ts";
import { riftDepth } from "../src/rules.ts";
import { KIND, RIFT_ID, type RiftProto } from "../src/types.ts";
import { getMap } from "../src/world/maps.ts";
import { ensureResources, spawnTestHero } from "./support/harness.ts";

const IDS = [
  "classic.core",
  "classic.world",
  "classic.rift",
  "classic.monsters",
  "classic.combat",
  "classic.progression",
  "classic.content",
];

let loaded: LoadedMode | null = null;

function realLoaded(): LoadedMode {
  if (loaded) return loaded;
  loaded = loadMode(
    defineMode({
      id: "classic",
      name: "Classic",
      description: "real content",
      world: null,
      modules: IDS,
      tick: { kind: "fixed", hz: 20 },
    }),
    classicModules,
  );
  return loaded;
}

/** Enters rift `level` (unlocked, obelisk in reach) and returns the sim at the rift depth. */
function enter(level: number): { sim: Sim; depth: number } {
  const sim = createSim(realLoaded(), { seed: 9 });
  ensureResources(sim.world);
  const spawn = getMap(sim.world, sim.loaded.registry, 0).spawn;
  const hero = spawnTestHero(sim.world, {
    x: spawn.x,
    y: spawn.y,
    depth: 0,
    gold: 10_000_000,
    classId: "classic.warrior",
  });
  (sim.world.getResource<DungeonState>(RES.dungeon) as DungeonState).bossesKilled = [16];
  sim.step(1);
  let obelisk: Entity = 0;
  for (const e of sim.world.query(Interactable, Pos, AreaTag)) {
    if (sim.world.read(e, Interactable).kind === "riftObelisk") obelisk = e;
  }
  const p = sim.world.read(obelisk, Pos);
  sim.world.update(hero, Pos, { x: p.x, y: p.y });
  sim.world.update(hero, Wallet, { gold: 10_000_000 });
  // Open levels 1..level in order, each one completed by a direct record of the state.
  const state = sim.world.getResource<{ maxCompleted: number }>(RES.rift) as
    | { maxCompleted: number }
    | undefined;
  if (state) state.maxCompleted = level - 1;
  const r = sim.dispatch(ACTION.openRift, { target: obelisk, level }, null);
  if (!r.ok) throw new Error(`openRift failed: ${r.error?.code}`);
  sim.step(1);
  return { sim, depth: riftDepth(level, 1) };
}

describe("real rift content", () => {
  const rift = (realLoaded().registry.get(KIND.rift, RIFT_ID) ?? null) as RiftProto | null;

  it("is registered", () => {
    expect(rift).not.toBeNull();
  });

  for (const level of [1, 10, 30]) {
    it(`level ${level} holds enough progress points for the goal`, () => {
      const { sim, depth } = enter(level);
      const points = rift!.progress;
      let total = 0;
      let monsters = 0;
      for (const e of sim.world.query(Monster, AreaTag)) {
        if (sim.world.read(e, AreaTag).depth !== depth) continue;
        monsters++;
        total += points[sim.world.read(e, Monster).rarity] ?? 0;
      }
      // A player explores and clears most of a level, so the goal must sit well below the total.
      expect(total).toBeGreaterThanOrEqual(rift!.goal);
      expect(monsters).toBeGreaterThan(50);
    });
  }
});
