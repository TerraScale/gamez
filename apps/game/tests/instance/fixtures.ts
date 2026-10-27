/** Inline test modes for instance tests: an event-ticked counter and a fixed-ticked clock. */
import { ActionError, defineMode, defineModule, loadMode, type ModuleSpec } from "@gamez/kernel";

export interface Counter {
  value: number;
  rolls: number[];
}

export const counterCore = defineModule({
  id: "tcount.core",
  version: "1.0.0",
  setup(world, ctx) {
    world.setResource<Counter>("tcount.counter", { value: ctx.rng.int(0, 5), rolls: [] });
  },
  actions: [
    {
      name: "tcount.add",
      parse(_w, payload) {
        const by = (payload as { by?: unknown } | null)?.by;
        if (typeof by !== "number" || !Number.isInteger(by)) {
          throw new ActionError("bad_payload", "by must be an integer");
        }
        return by;
      },
      apply(world, by: number, ctx) {
        const c = world.getResource<Counter>("tcount.counter")!;
        c.value += by;
        if (c.value > 100) throw new ActionError("too_big", "counter over 100");
        ctx.emit({ type: "tcount.added", value: c.value, actor: ctx.actor });
      },
    },
    {
      name: "tcount.roll",
      parse: () => null,
      apply(world, _p, ctx) {
        const c = world.getResource<Counter>("tcount.counter")!;
        c.rolls.push(ctx.rng.int(1, 6));
      },
    },
  ],
});

export const counterMode = defineMode({
  id: "tcount",
  name: "Counter",
  description: "instance test mode",
  world: null,
  modules: ["tcount.*"],
  tick: { kind: "event" },
  instance: { maxPlayers: 1 },
});

export const clockCore = defineModule({
  id: "tclock.core",
  version: "1.0.0",
  setup(world) {
    world.setResource("tclock.ticks", 0);
  },
  systems: [
    {
      id: "tclock.count",
      run(world) {
        world.setResource("tclock.ticks", (world.getResource<number>("tclock.ticks") ?? 0) + 1);
      },
    },
  ],
  actions: [
    {
      name: "tclock.reset",
      parse: () => null,
      apply(world) {
        world.setResource("tclock.ticks", 0);
      },
    },
  ],
});

export const clockMode = defineMode({
  id: "tclock",
  name: "Clock",
  description: "fixed instance test mode",
  world: null,
  modules: ["tclock.*"],
  tick: { kind: "fixed", hz: 20 },
  instance: { maxPlayers: 2 },
});

export const CATALOG: readonly ModuleSpec[] = [counterCore, clockCore];
export const TEST_MODES = [counterMode, clockMode] as const;

export const counterLoaded = loadMode(counterMode, CATALOG);
export const clockLoaded = loadMode(clockMode, CATALOG);

/** counterMode with a module version bump: same rules, different contentHash. */
export const counterLoadedV2 = loadMode(counterMode, [{ ...counterCore, version: "2.0.0" }]);
