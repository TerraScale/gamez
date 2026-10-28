/**
 * classic.monsters.wake (pre -100, owner: T4 monster builder). Sleep and wake
 * by distance to the hero, staggered: monster e is checked when
 * (e + tick) % 10 === 0. A monster in state "chase" also wakes its sleeping
 * pack mates (same non-zero pack, within 12 tiles) on every tick.
 */
import type { SimContext, SystemDef, World } from "@gamez/kernel";
import { Ai, AreaTag, Dead, Monster, Mover, Pos } from "../components.ts";
import { tiles, within } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth, heroOf } from "../resources.ts";
import { gridOf } from "../spatial.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../types.ts";

/** Monsters are checked every this many ticks, staggered by entity id. */
export const WAKE_EVERY = 10;
/** Pack mates of a chasing monster wake within this distance. */
export const PACK_WAKE_RANGE = tiles(12);

export const monstersWakeSystem: SystemDef = {
  ...SYSTEM.monstersWake,
  run(world, ctx) {
    const monsters = world.query(Monster);
    if (monsters.length === 0) return;
    const depth = currentDepth(world);
    const hero = heroOf(world);
    const heroPos = hero !== 0 && !world.has(hero, Dead) ? world.get(hero, Pos) : undefined;
    const sleepRange = sleepRangeOf(ctx);
    // Packs that currently have a sleeping member (only those can need waking).
    const sleepingPacks = new Set<number>();
    for (const e of monsters) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      if (world.read(e, Ai).state !== "sleep") continue;
      const pack = world.read(e, Monster).pack;
      if (pack !== 0) sleepingPacks.add(pack);
    }
    for (const e of monsters) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const ai = world.read(e, Ai);
      if (ai.state === "chase" && sleepingPacks.has(world.read(e, Monster).pack)) {
        wakePack(world, e);
      }
      if ((e + ctx.tick) % WAKE_EVERY !== 0 || heroPos === undefined) continue;
      const p = world.read(e, Pos);
      const far = !within(p.x, p.y, heroPos.x, heroPos.y, sleepRange);
      if (far) {
        if (ai.state !== "sleep") sleep(world, e);
      } else if (ai.state === "sleep") {
        world.update(e, Ai, { state: "idle" });
      }
    }
  },
};

function sleepRangeOf(ctx: SimContext): number {
  return ctx.registry.get<BalanceProto>(KIND.balance, BALANCE_ID)?.sleepRange ?? tiles(20);
}

function sleep(world: World, e: number): void {
  world.update(e, Ai, { state: "sleep", target: 0 });
  const m = world.read(e, Mover);
  if (m.goalX >= 0 || m.path.length > 0) {
    world.update(e, Mover, { goalX: -1, goalY: -1, path: [], moving: false });
  }
}

/** Wakes the sleeping pack mates of a chasing monster. */
function wakePack(world: World, e: number): void {
  const pack = world.read(e, Monster).pack;
  if (pack === 0) return;
  const p = world.read(e, Pos);
  for (const other of gridOf(world).query(p.x, p.y, PACK_WAKE_RANGE)) {
    if (other === e) continue;
    const m = world.get(other, Monster);
    if (m === undefined || m.pack !== pack) continue;
    if (world.read(other, Ai).state === "sleep") world.update(other, Ai, { state: "idle" });
  }
}
