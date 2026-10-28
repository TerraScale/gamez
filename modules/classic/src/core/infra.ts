/**
 * classic.core infrastructure (CONTRACT, implemented by the architect;
 * read-only for builders): the GameState + bus setup, the per-tick spatial
 * grid rebuild and the end-of-tick cleanup.
 */
import type { SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, emptyBus } from "../bus.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { RES, type GameState, type RunStats } from "../resources.ts";
import { gridOf } from "../spatial.ts";
import { getAreaMap } from "../world/maps.ts";

export function setupCore(world: World, ctx: SimContext): void {
  const game: GameState = {
    phase: "choose",
    worldSeed: ctx.rng.int(1, 0x7fffffff),
    nextUid: 1,
    hero: 0,
    nextPack: 1,
  };
  world.setResource(RES.game, game);
  world.setResource(RES.bus, emptyBus());
}

export const spatialSystem: SystemDef = {
  ...SYSTEM.coreSpatial,
  run(world, ctx) {
    const map = getAreaMap(world, ctx.registry);
    gridOf(world).rebuild(world, map.width, map.height, ctx.tick);
  },
};

/**
 * Leftover messages get one more tick: hits pushed after combat.resolveHits
 * (update 700, e.g. on-death bursts) resolve next tick, and commands pushed
 * after the command systems (update 50-52, e.g. core.intent arrivals at 100
 * or quest rewards at 52) run next tick. A message still queued at its
 * second cleanup is dropped (commands with classic.command.failed).
 * The carry marker is a plain JSON field on the queued message.
 */
type Carried = { carried?: 1 };

export const cleanupSystem: SystemDef = {
  ...SYSTEM.coreCleanup,
  run(world, ctx) {
    const bus = busOf(world);
    if (bus.hits.length > 0) {
      bus.hits = bus.hits
        .filter((h) => (h as Carried).carried !== 1)
        .map((h) => ({ ...h, carried: 1 }) as Carried as typeof h);
    }
    bus.deaths.length = 0;
    if (bus.commands.length > 0) {
      const keep: typeof bus.commands = [];
      for (const c of bus.commands) {
        if ((c as Carried).carried === 1) {
          emit(ctx, {
            type: "classic.command.failed",
            op: c.op,
            code: "unhandled",
            message: `no module handled command "${c.op}"`,
          });
        } else keep.push({ ...c, carried: 1 } as Carried as typeof c);
      }
      bus.commands = keep;
    }
    const stats = world.getResource<RunStats>(RES.stats);
    if (stats) stats.ticksPlayed++;
  },
};
