/**
 * Rift ops (classic.rift, wave A; docs/design/wave-A.md §7). Each op has a
 * shared execX() returning OpResult, used by its action (throws ActionError)
 * and by the command system (emits classic.command.failed). Opening a rift
 * pays the fee and queues the transition; the level itself is built by
 * classic.world (rift depths) and tracked by ./track.ts.
 */
import {
  ActionError,
  type ActionDef,
  type Entity,
  type SimContext,
  type SystemDef,
  type World,
} from "@gamez/kernel";
import {
  ACTION,
  ERR,
  fail,
  INTERACT_RANGE,
  OK,
  type ActionPayloads,
  type HeroCommand,
  type OpResult,
} from "../actions.ts";
import { busOf, pushTransition, takeCommands } from "../bus.ts";
import { AreaTag, Dead, Interactable, Pos, Wallet } from "../components.ts";
import { noteManual } from "../control.ts";
import { emit } from "../events.ts";
import { within } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { isRiftDepth, RIFT_MAX_LEVEL, riftDepth, riftFee } from "../rules.ts";
import { currentDepth, heroOf, type RiftRun } from "../resources.ts";
import { RIFT_ID } from "../types.ts";
import { riftProtoOf } from "../world/riftMap.ts";
import { recordOf, pushHistory, riftStateOf, spendGold } from "./state.ts";

export const TOWN = 0;

/** Common precondition: a hero exists and is alive. */
function heroReady(world: World): OpResult {
  const hero = heroOf(world);
  if (hero === 0) return fail(ERR.noHero, "there is no hero yet");
  if (world.has(hero, Dead)) return fail(ERR.dead, "the hero is dead");
  return OK;
}

/** Opens a rift run at `level` through the obelisk `target` (town only). */
export function execOpenRift(
  world: World,
  ctx: SimContext,
  target: Entity,
  level: number,
): OpResult {
  const ready = heroReady(world);
  if (!ready.ok) return ready;
  const hero = heroOf(world);
  const depth = currentDepth(world);
  if (depth !== TOWN) {
    return fail(isRiftDepth(depth) ? ERR.inRift : ERR.notInTown, "rifts open from the town");
  }
  if (
    !world.exists(target) ||
    !world.has(target, Interactable) ||
    world.read(target, Interactable).kind !== "riftObelisk" ||
    !world.has(target, AreaTag) ||
    !world.has(target, Pos) ||
    world.read(target, AreaTag).depth !== TOWN
  ) {
    return fail(ERR.badTarget, "that is not the rift obelisk");
  }
  const hp = world.read(hero, Pos);
  const tp = world.read(target, Pos);
  if (!within(hp.x, hp.y, tp.x, tp.y, INTERACT_RANGE)) return fail(ERR.tooFar, "too far away");

  const state = riftStateOf(world);
  if (!state.unlocked) return fail(ERR.riftLocked, "the rift is still sealed");
  if (state.active) return fail(ERR.inRift, "a rift run is already open");
  if (!Number.isInteger(level) || level < 1 || level > state.maxCompleted + 1) {
    return fail(ERR.riftLevel, `rift level must be 1..${state.maxCompleted + 1}`);
  }
  if (level > RIFT_MAX_LEVEL)
    return fail(ERR.riftLevel, `rift level must be at most ${RIFT_MAX_LEVEL}`);
  const rift = riftProtoOf(ctx.registry);
  if (!rift) return fail(ERR.unknownId, `no ${RIFT_ID} content`);
  const fee = riftFee(rift, level);
  const wallet = world.get(hero, Wallet);
  if (!wallet || wallet.gold < fee) return fail(ERR.noGold, `need ${fee} gold`);

  spendGold(world, hero, fee);
  const run = state.nextRun;
  state.nextRun = run + 1;
  const depthOf = riftDepth(level, run);
  const active: RiftRun = {
    level,
    depth: depthOf,
    run,
    startTick: ctx.tick,
    progress: 0,
    goal: rift.goal,
    guardian: 0,
    guardianSpawned: false,
    deaths: 0,
    feePaid: fee,
  };
  state.active = active;
  pushTransition(world, { to: depthOf, via: "rift" });
  emit(ctx, { type: "classic.rift.opened", level, depth: depthOf, fee, run });
  return OK;
}

/**
 * Leaves the rift the hero stands in. Before the guardian dies the run fails
 * (reason "left"); after completion it only returns to town.
 */
export function execLeaveRift(world: World, ctx: SimContext): OpResult {
  const ready = heroReady(world);
  if (!ready.ok) return ready;
  if (!isRiftDepth(currentDepth(world))) return fail(ERR.notInRift, "you are not in a rift");
  const state = riftStateOf(world);
  if (state.active) failRun(world, ctx, state.active, "left");
  pushTransition(world, { to: TOWN, via: "riftExit" });
  return OK;
}

/**
 * Ends the active run without completion: a failed record (score 0) goes to
 * the history and the run is cleared. The hero walks out through the normal
 * respawn (death) or leaveRift.
 */
export function failRun(
  world: World,
  ctx: SimContext,
  run: RiftRun,
  reason: "death" | "left",
): void {
  const state = riftStateOf(world);
  const record = recordOf(world, run, ctx.tick, {
    completed: false,
    score: 0,
    reason,
    deaths: run.deaths,
  });
  pushHistory(state, record);
  state.active = null;
  emit(ctx, { type: "classic.rift.failed", record });
}

// ---------------------------------------------------------------------------
// Command system (update 55)
// ---------------------------------------------------------------------------

const RIFT_OPS = ["openRift", "leaveRift"] as const;
type RiftCommand = Extract<HeroCommand, { op: (typeof RIFT_OPS)[number] }>;

export const riftCommandsSystem: SystemDef = {
  ...SYSTEM.riftCommands,
  run(world, ctx) {
    if (busOf(world).commands.length === 0) return;
    for (const cmd of takeCommands(world, RIFT_OPS)) {
      const r = runCommand(world, ctx, cmd);
      if (!r.ok) {
        emit(ctx, { type: "classic.command.failed", op: cmd.op, code: r.code, message: r.message });
      }
    }
  },
};

function runCommand(world: World, ctx: SimContext, cmd: RiftCommand): OpResult {
  switch (cmd.op) {
    case "openRift":
      return execOpenRift(world, ctx, cmd.target, cmd.level);
    case "leaveRift":
      return execLeaveRift(world, ctx);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function parseEmpty(payload: unknown): Record<string, never> {
  if (payload === undefined || payload === null) return {};
  if (typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length === 0) {
    return {};
  }
  throw new ActionError(ERR.badPayload, "expected an empty payload");
}

export const openRiftAction: ActionDef<ActionPayloads["classic.openRift"]> = {
  name: ACTION.openRift,
  parse(_world, payload) {
    const p = payload as { target?: unknown; level?: unknown } | null | undefined;
    if (
      !p ||
      typeof p.target !== "number" ||
      !Number.isInteger(p.target) ||
      typeof p.level !== "number" ||
      !Number.isInteger(p.level)
    ) {
      throw new ActionError(ERR.badPayload, "expected { target: entity, level: integer }");
    }
    return { target: p.target, level: p.level };
  },
  apply(world, p, ctx) {
    const r = execOpenRift(world, ctx, p.target, p.level);
    if (!r.ok) throw new ActionError(r.code, r.message);
    noteManual(world, ctx);
  },
};

export const leaveRiftAction: ActionDef<Record<string, never>> = {
  name: ACTION.leaveRift,
  parse: (_world, payload) => parseEmpty(payload),
  apply(world, _p, ctx) {
    const r = execLeaveRift(world, ctx);
    if (!r.ok) throw new ActionError(r.code, r.message);
    noteManual(world, ctx);
  },
};
