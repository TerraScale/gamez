/**
 * Wave A HUD section: the Rift (docs/design/wave-A.md §7) — OWNER: T-rift.
 * Pure: reads the world, the registry and RiftState; never throws. Without a
 * hero there is nothing to show (null); without RiftState the locked view is
 * returned, so the panel can still explain how to unlock it.
 */
import { INTERACT_RANGE } from "../../actions.ts";
import { AreaTag, Dead, Interactable, Pos, Wallet } from "../../components.ts";
import { within } from "../../fixed.ts";
import { monsterLevel, RIFT_MAX_LEVEL, riftDepth, riftFee } from "../../rules.ts";
import { riftOf } from "../../resources.ts";
import { KIND, RIFT_ID, type RiftProto } from "../../types.ts";
import type { Entity, World } from "@gamez/kernel";
import type { RiftView } from "../contract.ts";
import type { ModelContext } from "./context.ts";

/** The rift levels and the obelisk in reach; null without a hero or RiftProto. */
export function buildRiftView(c: ModelContext): RiftView | null {
  if (c.hero === 0) return null;
  const rift = c.registry.get<RiftProto>(KIND.rift, RIFT_ID);
  if (!rift) return null;
  const state = riftOf(c.world);
  const unlocked = state?.unlocked ?? false;
  const maxCompleted = state?.maxCompleted ?? 0;
  const gold = c.world.get(c.hero, Wallet)?.gold ?? 0;
  const top = Math.min(maxCompleted + 1, RIFT_MAX_LEVEL);
  const levels: RiftView["levels"] = [];
  for (let level = 1; level <= top; level++) {
    const fee = riftFee(rift, level);
    levels.push({
      level,
      fee,
      monsterLevel: monsterLevel(riftDepth(level, 1)),
      affordable: gold >= fee,
    });
  }
  const run = state?.active ?? null;
  return {
    unlocked,
    unlockText: `Defeat the Hollow King on depth ${rift.unlockBossDepth} to open the Rift.`,
    levels,
    maxCompleted,
    best: state?.best ?? null,
    history: state?.history ?? [],
    active: run
      ? {
          level: run.level,
          progressPct:
            run.goal > 0 ? Math.min(100, Math.floor((run.progress * 100) / run.goal)) : 0,
          ticksLeft: Math.max(0, rift.timeLimit - (c.tick - run.startTick)),
          guardianAlive: run.guardianSpawned && !guardianGone(c.world, run.guardian),
          done: run.guardianSpawned && guardianGone(c.world, run.guardian),
        }
      : null,
    obelisk: obeliskInReach(c.world, c.hero),
  };
}

/** True once a found guardian entity is gone or dead. */
function guardianGone(world: World, guardian: Entity): boolean {
  if (guardian === 0) return false;
  return !world.exists(guardian) || world.has(guardian, Dead);
}

/** The town's rift obelisk within interaction reach of the hero (0 = none). */
function obeliskInReach(world: World, hero: Entity): Entity {
  if (!world.has(hero, Pos)) return 0;
  const hp = world.read(hero, Pos);
  for (const e of world.query(Interactable, Pos, AreaTag)) {
    if (world.read(e, Interactable).kind !== "riftObelisk") continue;
    if (world.read(e, AreaTag).depth !== 0) continue;
    const p = world.read(e, Pos);
    if (within(hp.x, hp.y, p.x, p.y, INTERACT_RANGE)) return e;
  }
  return 0;
}
