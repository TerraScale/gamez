/** Arena mode spec (see index.ts). OWNER: T-arena-sim. */
import { defineMode, type ModeSpec, type ModuleSpec } from "@gamez/kernel";
import { arenaCore } from "./core.ts";
import { ARENA_HZ, ARENA_MAX_TICKS } from "./constants.ts";

export { ARENA_HZ, ARENA_MAX_TICKS };

export const modules: ModuleSpec[] = [arenaCore];

export const mode: ModeSpec = defineMode({
  id: "arena",
  name: "Arena",
  description: "Async PvP: your hero's ghost against other players' ghosts.",
  world: null,
  modules: ["arena.*"],
  tick: { kind: "fixed", hz: ARENA_HZ },
});
