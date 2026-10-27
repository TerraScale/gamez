/**
 * ECS benchmark: the kernel World against bitecs, miniplex and koota on the
 * same workload. Every entity has three components (Position, Velocity,
 * Health). Run with `pnpm --filter @gamez/bench bench:ecs`
 * (needs --expose-gc for the heap numbers).
 */
import { createWorld as kernelWorld, defineComponent, restoreWorld } from "@gamez/kernel";
import type { World as KernelWorld } from "@gamez/kernel";
import { addComponent, addEntity, createWorld as bitecsWorld, query as bitecsQuery } from "bitecs";
import { createWorld as kootaWorld, trait } from "koota";
import { World as MiniplexWorld } from "miniplex";
import { fmt, measure, printTable, writeResults, type Timing } from "./lib.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with node --expose-gc (see package.json bench:ecs)");

interface Adapter<S> {
  name: string;
  /** Builds a world with `n` entities, each with Position, Velocity and Health. */
  populate(n: number): S;
  /** One query + update pass over every entity that has Position and Velocity. */
  pass(state: S): void;
}

/** Deterministic initial values so every library starts from the same data. */
const initial = (i: number) => ({
  x: i % 1000,
  y: (i * 31) % 1000,
  dx: (i % 3) - 1,
  dy: ((i >> 1) % 3) - 1,
  hp: 100,
});

// ---- kernel World -----------------------------------------------------------

const KPos = defineComponent<{ x: number; y: number }>("bench.pos");
const KVel = defineComponent<{ dx: number; dy: number }>("bench.vel");
const KHp = defineComponent<{ hp: number }>("bench.hp");

const kernel: Adapter<KernelWorld> = {
  name: "kernel World (read + mutate)",
  populate(n) {
    const w = kernelWorld();
    for (let i = 0; i < n; i++) {
      const v = initial(i);
      const e = w.create();
      w.add(e, KPos, { x: v.x, y: v.y });
      w.add(e, KVel, { dx: v.dx, dy: v.dy });
      w.add(e, KHp, { hp: v.hp });
    }
    return w;
  },
  pass(w) {
    for (const e of w.query(KPos, KVel)) {
      const p = w.read(e, KPos);
      const v = w.read(e, KVel);
      p.x += v.dx;
      p.y += v.dy;
    }
  },
};

/** Same pass through world.update(), which deep-clones each patch (the safe path). */
const kernelUpdate: Adapter<KernelWorld> = {
  name: "kernel World (update(), cloning)",
  populate: (n) => kernel.populate(n),
  pass(w) {
    for (const e of w.query(KPos, KVel)) {
      const p = w.read(e, KPos);
      const v = w.read(e, KVel);
      w.update(e, KPos, { x: p.x + v.dx, y: p.y + v.dy });
    }
  },
};

// ---- bitecs (array of structs, one array per component) ---------------------

type Vec2 = { x: number; y: number };
type Vel2 = { dx: number; dy: number };
interface BitecsAos {
  world: ReturnType<typeof bitecsWorld>;
  Position: Vec2[];
  Velocity: Vel2[];
  Health: { hp: number }[];
}

const bitecsAos: Adapter<BitecsAos> = {
  name: "bitecs (AoS arrays)",
  populate(n) {
    const world = bitecsWorld();
    const Position: Vec2[] = [];
    const Velocity: Vel2[] = [];
    const Health: { hp: number }[] = [];
    for (let i = 0; i < n; i++) {
      const v = initial(i);
      const eid = addEntity(world);
      addComponent(world, eid, Position);
      addComponent(world, eid, Velocity);
      addComponent(world, eid, Health);
      Position[eid] = { x: v.x, y: v.y };
      Velocity[eid] = { dx: v.dx, dy: v.dy };
      Health[eid] = { hp: v.hp };
    }
    return { world, Position, Velocity, Health };
  },
  pass({ world, Position, Velocity }) {
    for (const eid of bitecsQuery(world, [Position, Velocity])) {
      const p = Position[eid]!;
      const v = Velocity[eid]!;
      p.x += v.dx;
      p.y += v.dy;
    }
  },
};

// ---- bitecs (structure of arrays, the idiomatic fast path) ------------------

interface BitecsSoa {
  world: ReturnType<typeof bitecsWorld>;
  Position: { x: Float64Array; y: Float64Array };
  Velocity: { dx: Float64Array; dy: Float64Array };
  Health: { hp: Float64Array };
}

const bitecsSoa: Adapter<BitecsSoa> = {
  name: "bitecs (SoA typed arrays)",
  populate(n) {
    const world = bitecsWorld();
    const cap = n + 16;
    const Position = { x: new Float64Array(cap), y: new Float64Array(cap) };
    const Velocity = { dx: new Float64Array(cap), dy: new Float64Array(cap) };
    const Health = { hp: new Float64Array(cap) };
    for (let i = 0; i < n; i++) {
      const v = initial(i);
      const eid = addEntity(world);
      addComponent(world, eid, Position);
      addComponent(world, eid, Velocity);
      addComponent(world, eid, Health);
      Position.x[eid] = v.x;
      Position.y[eid] = v.y;
      Velocity.dx[eid] = v.dx;
      Velocity.dy[eid] = v.dy;
      Health.hp[eid] = v.hp;
    }
    return { world, Position, Velocity, Health };
  },
  pass({ world, Position, Velocity }) {
    for (const eid of bitecsQuery(world, [Position, Velocity])) {
      Position.x[eid]! += Velocity.dx[eid]!;
      Position.y[eid]! += Velocity.dy[eid]!;
    }
  },
};

// ---- miniplex ---------------------------------------------------------------

type MxEntity = {
  position: Vec2;
  velocity: Vel2;
  health: { hp: number };
};

interface MiniplexState {
  world: MiniplexWorld<MxEntity>;
  moving: ReturnType<MiniplexWorld<MxEntity>["with"]>;
}

const miniplex: Adapter<MiniplexState> = {
  name: "miniplex 2",
  populate(n) {
    const world = new MiniplexWorld<MxEntity>();
    // Queries are created before the entities so the index is maintained on add.
    const moving = world.with("position", "velocity");
    for (let i = 0; i < n; i++) {
      const v = initial(i);
      world.add({
        position: { x: v.x, y: v.y },
        velocity: { dx: v.dx, dy: v.dy },
        health: { hp: v.hp },
      });
    }
    return { world, moving };
  },
  pass({ moving }) {
    for (const e of moving) {
      e.position.x += e.velocity.dx;
      e.position.y += e.velocity.dy;
    }
  },
};

// ---- koota ------------------------------------------------------------------

const KoPosition = trait({ x: 0, y: 0 });
const KoVelocity = trait({ dx: 0, dy: 0 });
const KoHealth = trait({ hp: 100 });

/** Koota allows at most 16 live worlds per process, so each populate() frees the previous one. */
let kootaCurrent: ReturnType<typeof kootaWorld> | null = null;

const koota: Adapter<ReturnType<typeof kootaWorld>> = {
  name: "koota 0.6",
  populate(n) {
    kootaCurrent?.destroy();
    const world = kootaWorld();
    kootaCurrent = world;
    for (let i = 0; i < n; i++) {
      const v = initial(i);
      world.spawn(
        [KoPosition, { x: v.x, y: v.y }],
        [KoVelocity, { dx: v.dx, dy: v.dy }],
        [KoHealth, { hp: v.hp }],
      );
    }
    return world;
  },
  pass(world) {
    world.query(KoPosition, KoVelocity).updateEach(([p, v]) => {
      p.x += v.dx;
      p.y += v.dy;
    });
  },
};

// ---- harness ----------------------------------------------------------------

const adapters: Adapter<any>[] = [kernel, kernelUpdate, bitecsAos, bitecsSoa, miniplex, koota];
const SIZES = [10_000, 50_000];
let sink: unknown;

/** Heap bytes per entity kept alive by a populated world (GC pressure proxy). */
function heapPerEntity<S>(adapter: Adapter<S>, n: number): number {
  gc!();
  const before = process.memoryUsage().heapUsed;
  const state = adapter.populate(n);
  gc!();
  const after = process.memoryUsage().heapUsed;
  sink = state;
  return (after - before) / n;
}

const createRows: Timing[] = [];
const passRows: Timing[] = [];
const heapRows: Record<string, number> = {};

for (const adapter of adapters) {
  for (const n of SIZES) {
    const row = measure(
      `${adapter.name}`,
      "entities",
      n,
      () => {
        sink = adapter.populate(n);
      },
      () => undefined,
    );
    createRows.push({ ...row, name: `${adapter.name}, create ${fmt(n, 0)}` });
    console.error(`created ${adapter.name} ${n}`);
  }
  const n = 50_000;
  const state = adapter.populate(n);
  const row = measure(
    adapter.name,
    "entities",
    n,
    () => adapter.pass(state),
    () => undefined,
  );
  passRows.push({ ...row, name: adapter.name });
  sink = state;
  heapRows[adapter.name] = heapPerEntity(adapter, n);
  console.error(`pass ${adapter.name}`);
}

// Snapshot cost of the kernel World (used by every dispatch rollback and by
// save/restore), and the restore path.
const snapWorld = kernel.populate(50_000);
const snapshotRow = measure(
  "kernel World snapshot()",
  "entities",
  50_000,
  () => {
    sink = snapWorld.snapshot();
  },
  () => undefined,
);
const snap = snapWorld.snapshot();
const restoreRow = measure(
  "kernel restoreWorld(snapshot)",
  "entities",
  50_000,
  () => {
    sink = restoreWorld(snap);
  },
  () => undefined,
);

printTable("ECS: create entities (3 components each)", createRows);
printTable("ECS: query + update pass over 50k entities", passRows);
printTable("ECS: kernel snapshot/restore over 50k entities", [snapshotRow, restoreRow]);

console.log("\n### ECS: heap retained per entity (50k, after GC)\n");
console.log("| Case | Bytes/entity |");
console.log("|---|---:|");
for (const [name, bytes] of Object.entries(heapRows)) {
  console.log(`| ${name} | ${fmt(bytes, 0)} |`);
}

void sink;
writeResults("ecs", {
  create: createRows,
  pass: passRows,
  kernelSnapshot: [snapshotRow, restoreRow],
  heapBytesPerEntity: heapRows,
});
