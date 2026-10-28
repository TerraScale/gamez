/**
 * Walking to a town NPC / Interactable for a routine step and acting on
 * arrival (shared by the town routine, the crafting steps and the rift).
 */
import type { Entity } from "@gamez/kernel";
import { Pos } from "../components.ts";
import { walkTo } from "./route.ts";
import { inReach, setIntent, stopIntent, type AutoCtx } from "./util.ts";

/** skip: nothing to do; walk: on the way; done: ops queued; wait: travel sent. */
export type StepResult = "skip" | "walk" | "done" | "wait";

/** Walk to `e` (interact intent, long walks in legs), or run `act` when within reach. */
export function at(c: AutoCtx, e: Entity, act: () => void): StepResult {
  const same = c.st.focus === e;
  c.st.focus = e;
  if (inReach(c, e)) {
    act();
    stopIntent(c);
    return "done";
  }
  approach(c, e, same);
  return "walk";
}

export function approach(c: AutoCtx, e: Entity, same: boolean): void {
  const p = c.world.read(e, Pos);
  walkTo(c, p.x >> 8, p.y >> 8, () => setIntent(c, { kind: "interact", target: e }), same);
}
