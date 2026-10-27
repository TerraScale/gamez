/**
 * Kernel sim benchmark: dispatch throughput of a small event-mode module
 * (with and without a 1k-entity world, to expose the rollback snapshot cost)
 * and step() throughput of a fixed-mode module with 1k entities.
 * Run with `pnpm --filter @gamez/bench bench:kernel`.
 */
import {
  createSim,
  defineComponent,
  defineMode,
  defineModule,
  loadMode,
  type ModuleSpec,
  type Sim,
} from "@gamez/kernel";
import { fmt, measure, printTable, writeResults, type Timing } from "./lib.ts";

const Count = defineComponent<{ n: number }>("bench.count");
const Pos = defineComponent<{ x: number; y: number }>("bench.pos");
const Vel = defineComponent<{ dx: number; dy: number }>("bench.vel");

/** Event-mode counter: one action bumps one counter, and one system runs after it. */
const counter = defineModule({
  id: "bench.counter",
  version: "1.0.0",
  setup(world) {
    const e = world.create();
    world.add(e, Count, { n: 0 });
  },
  actions: [
    {
      name: "bench.bump",
      parse(_w, payload) {
        const by = (payload as { by?: unknown }).by;
        if (typeof by !== "number") throw new TypeError("by must be a number");
        return { by };
      },
      apply(world, p: { by: number }, ctx) {
        const [e] = world.query(Count);
        world.read(e!, Count).n += p.by;
        ctx.emit({ type: "bench.bumped", by: p.by });
      },
    },
  ],
  systems: [
    {
      id: "bench.counter.tally",
      run(world) {
        for (const e of world.query(Count)) world.read(e, Count);
      },
    },
  ],
});

/** Adds 1000 idle entities, so every dispatch's rollback snapshot covers them too. */
const filler = defineModule({
  id: "bench.filler",
  version: "1.0.0",
  setup(world) {
    for (let i = 0; i < 1000; i++) {
      const e = world.create();
      world.add(e, Pos, { x: i, y: i });
    }
  },
});

/** Fixed-mode swarm: 1000 entities moved by one system at 20 Hz. */
const swarm = defineModule({
  id: "bench.swarm",
  version: "1.0.0",
  setup(world, ctx) {
    for (let i = 0; i < 1000; i++) {
      const e = world.create();
      world.add(e, Pos, { x: ctx.rng.int(0, 99), y: ctx.rng.int(0, 99) });
      world.add(e, Vel, { dx: ctx.rng.int(-1, 1), dy: ctx.rng.int(-1, 1) });
    }
  },
  systems: [
    {
      id: "bench.swarm.move",
      run(world) {
        for (const e of world.query(Pos, Vel)) {
          const p = world.read(e, Pos);
          const v = world.read(e, Vel);
          p.x += v.dx;
          p.y += v.dy;
        }
      },
    },
  ],
});

const catalog: ModuleSpec[] = [counter, filler, swarm];

const eventSmall = loadMode(
  defineMode({
    id: "bench-event-small",
    name: "Bench event (small)",
    description: "Counter only",
    world: null,
    modules: ["bench.counter"],
    tick: { kind: "event" },
  }),
  catalog,
);
const eventLarge = loadMode(
  defineMode({
    id: "bench-event-large",
    name: "Bench event (1k entities)",
    description: "Counter plus 1000 idle entities",
    world: null,
    modules: ["bench.counter", "bench.filler"],
    tick: { kind: "event" },
  }),
  catalog,
);
const fixed1k = loadMode(
  defineMode({
    id: "bench-fixed-1k",
    name: "Bench fixed (1k entities)",
    description: "1000 moving entities at 20 Hz",
    world: null,
    modules: ["bench.swarm"],
    tick: { kind: "fixed", hz: 20 },
  }),
  catalog,
);

let sink: unknown;

function dispatchRow(name: string, sim: Sim, n: number): Timing {
  return measure(
    name,
    "dispatches",
    n,
    () => {
      for (let i = 0; i < n; i++) {
        sink = sim.dispatch("bench.bump", { by: 1 }, "bench");
      }
    },
    () => undefined,
    { minIterations: 3, minTimeMs: 1500 },
  );
}

const small = createSim(eventSmall, { seed: 1 });
const large = createSim(eventLarge, { seed: 1 });
const dispatchRows = [
  dispatchRow("event mode, world of 1 entity", small, 20_000),
  dispatchRow("event mode, world of 1001 entities", large, 2_000),
];

// Sanity: every dispatch must have succeeded, or the numbers mean nothing.
const probe = small.dispatch("bench.bump", { by: 1 }, "bench");
if (!probe.ok) throw new Error(`dispatch failed: ${probe.error?.message}`);

const sim1k = createSim(fixed1k, { seed: 7 });
const stepRows = [
  measure(
    "fixed mode, 1000 entities, step(100)",
    "ticks",
    100,
    () => {
      sink = sim1k.step(100);
    },
    () => undefined,
    { minIterations: 3, minTimeMs: 1500 },
  ),
];

printTable("Kernel: event-mode dispatch", dispatchRows);
printTable("Kernel: fixed-mode step()", stepRows);
// Entity updates per second, the number a fixed-mode game cares about.
console.log(
  `\nFixed mode: ${fmt(stepRows[0]!.throughput * 1000, 0)} entity updates/s (1000 entities x ticks/s).`,
);
console.log(`Sim hash after bench (sanity): ${sim1k.hash()}`);
void sink;

writeResults("kernel", { dispatch: dispatchRows, step: stepRows });
