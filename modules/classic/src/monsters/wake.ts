/**
 * classic.monsters.wake (pre -100, owner: T4 monster builder). Sleep and wake
 * by distance to the hero, staggered: monster e is checked when
 * (e + tick) % 10 === 0. A monster in state "chase" also wakes its sleeping
 * pack mates (same non-zero pack, within 12 tiles) on every tick.
 *
 * Party (docs/design/party.md §7.1): "the hero" is any STANDING member, so a
 * monster sleeps only when it is far from every standing member.
 */
import type { SimContext, SystemDef, World } from "@gamez/kernel";
import { Ai, AreaTag, Dead, Monster, Mover, Pos } from "../components.ts";
import { tiles, within } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { partyMembers } from "../party/shared.ts";
import { currentDepth } from "../resources.ts";
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
    // Standing members' positions (solo: the hero unless dead).
    const xs: number[] = [];
    const ys: number[] = [];
    for (const m of partyMembers(world)) {
      if (world.has(m, Dead)) continue;
      const mp = world.peek(m, Pos);
      if (mp === undefined) continue;
      xs.push(mp.x);
      ys.push(mp.y);
    }
    const sleepRange = sleepRangeOf(ctx);
    // Packs that currently have a sleeping member (only those can need waking).
    const sleepingPacks = new Set<number>();
    for (const e of monsters) {
      if (world.peek(e, AreaTag)!.depth !== depth) continue;
      if (world.peek(e, Ai)!.state !== "sleep") continue;
      const pack = world.peek(e, Monster)!.pack;
      if (pack !== 0) sleepingPacks.add(pack);
    }
    for (const e of monsters) {
      if (world.peek(e, AreaTag)!.depth !== depth) continue;
      const ai = world.peek(e, Ai)!;
      if (ai.state === "chase" && sleepingPacks.has(world.peek(e, Monster)!.pack)) {
        wakePack(world, e);
      }
      if ((e + ctx.tick) % WAKE_EVERY !== 0 || xs.length === 0) continue;
      const p = world.peek(e, Pos)!;
      let far = true;
      for (let i = 0; i < xs.length && far; i++) {
        if (within(p.x, p.y, xs[i]!, ys[i]!, sleepRange)) far = false;
      }
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
