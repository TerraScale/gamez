/**
 * Control-mode helpers shared by every module's manual actions (CONTRACT,
 * implemented). The ControlState resource is owned by classic.auto; these
 * helpers are safe when it is missing (tests without classic.auto).
 */
import type { SimContext, World } from "@gamez/kernel";
import { MANUAL_OVERRIDE_TICKS } from "./actions.ts";
import { RES, type ControlMode, type ControlState } from "./resources.ts";

export function controlMode(world: World): ControlMode {
  return world.getResource<ControlState>(RES.control)?.mode ?? "manual";
}

/** True when the auto controller should drive the hero this tick. */
export function autoActive(world: World, tick: number): boolean {
  const c = world.getResource<ControlState>(RES.control);
  if (!c || c.mode === "manual") return false;
  return tick >= c.overrideUntil;
}

/**
 * Call from every manual action that commands the hero (move, skill, pickup,
 * interact, potion...). In auto/idle it pauses the controller for
 * MANUAL_OVERRIDE_TICKS so the player's command is not overwritten.
 */
export function noteManual(world: World, ctx: SimContext): void {
  const c = world.getResource<ControlState>(RES.control);
  if (!c || c.mode === "manual") return;
  c.overrideUntil = ctx.tick + MANUAL_OVERRIDE_TICKS;
}
