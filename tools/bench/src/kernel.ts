/**
 * Kernel sim benchmark: dispatch throughput of a small event-mode module
 * (with and without a 1k-entity world, to expose the rollback cost), step()
 * throughput of a fixed-mode module with 1k entities, and the per-tick cost
 * of a classic-like 20 Hz workload (300 monsters, projectiles, loot) against
 * the same systems run with no sim around them.
 * Run with `pnpm --filter @gamez/bench bench:kernel`.
 * `BENCH_RESULTS=<name>` writes results/<name>.json instead of kernel.json.
 */
import {
  ActionError,
  createRng,
  createSim,
  createWorld,
  defineComponent,
  defineMode,
  defineModule,
  loadMode,
  stableHash,
  type GameEvent,
  type ModuleSpec,
  type Sim,
  type SimContext,
  type World,
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
      name: "bench.fail",
      parse: () => null,
      apply(world) {
        const [e] = world.query(Count);
        world.read(e!, Count).n += 1;
        throw new ActionError("bench_fail", "always rejected");
      },
    },
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

// ---- classic-like workload ---------------------------------------------------
// Shaped like modules/classic at 20 Hz: ~300 monsters, projectiles and loot on
// a 128x128 area (map kept outside the world), a hit bus and an exploration
// bitset as resources. Positions are in sub-tile units (256 per tile).

const MONSTERS = 300;
const SIZE = 128 * 256;
const CPos = defineComponent<{ x: number; y: number }>("cl.pos");
const CVel = defineComponent<{ dx: number; dy: number }>("cl.vel");
const CHp = defineComponent<{ hp: number; max: number }>("cl.hp");
const CMonster = defineComponent<{ kind: string; cd: number; aggro: boolean }>("cl.monster");
const CShot = defineComponent<{ ttl: number; dmg: number; owner: number }>("cl.shot");
const CLoot = defineComponent<{ item: string; qty: number; ttl: number }>("cl.loot");
const CHero = defineComponent<{ name: string }>("cl.hero");
interface Bus {
  hits: { target: number; dmg: number }[];
  deaths: number[];
}
interface Explore {
  revealed: number;
  bits: number[];
}

function spawnMonster(world: World, ctx: SimContext): void {
  const e = world.create();
  world.add(e, CPos, { x: ctx.rng.int(0, SIZE - 1), y: ctx.rng.int(0, SIZE - 1) });
  world.add(e, CVel, { dx: ctx.rng.int(-8, 8), dy: ctx.rng.int(-8, 8) });
  world.add(e, CHp, { hp: 20, max: 20 });
  world.add(e, CMonster, { kind: "cl.skeleton", cd: ctx.rng.int(0, 40), aggro: false });
}

const clamp = (v: number) => (v < 0 ? 0 : v >= SIZE ? SIZE - 1 : v);

const classicSystems: {
  id: string;
  stage?: "pre" | "update" | "post";
  run(w: World, ctx: SimContext): void;
}[] = [
  {
    id: "cl.ai",
    stage: "pre",
    run(world, ctx) {
      const [hero] = world.query(CHero);
      const hp = world.read(hero!, CPos);
      for (const e of world.query(CMonster, CPos)) {
        const m = world.read(e, CMonster);
        const p = world.read(e, CPos);
        m.aggro = Math.abs(p.x - hp.x) + Math.abs(p.y - hp.y) < 8 * 256;
        if (--m.cd > 0 || !ctx.rng.chance(0.05)) continue;
        m.cd = 40;
        const s = world.create();
        world.add(s, CPos, { x: p.x, y: p.y });
        world.add(s, CVel, { dx: Math.sign(hp.x - p.x) * 64, dy: Math.sign(hp.y - p.y) * 64 });
        world.add(s, CShot, { ttl: 30, dmg: 3, owner: e });
      }
    },
  },
  {
    id: "cl.move",
    run(world) {
      for (const e of world.query(CPos, CVel)) {
        const p = world.read(e, CPos);
        const v = world.read(e, CVel);
        p.x = clamp(p.x + v.dx);
        p.y = clamp(p.y + v.dy);
      }
    },
  },
  {
    id: "cl.shots",
    run(world) {
      const bus = world.getResource<Bus>("cl.bus")!;
      const [hero] = world.query(CHero);
      const hp = world.read(hero!, CPos);
      for (const e of world.query(CShot, CPos)) {
        const s = world.read(e, CShot);
        const p = world.read(e, CPos);
        if (Math.abs(p.x - hp.x) + Math.abs(p.y - hp.y) < 128) {
          bus.hits.push({ target: hero!, dmg: s.dmg });
          world.destroy(e);
        } else if (--s.ttl <= 0) world.destroy(e);
      }
    },
  },
  {
    id: "cl.combat",
    run(world, ctx) {
      // The hero hits one random monster per tick.
      const monsters = world.query(CMonster, CHp);
      const target = ctx.rng.pick(monsters);
      const hp = world.read(target, CHp);
      hp.hp -= ctx.rng.int(1, 6);
      if (hp.hp <= 0) world.getResource<Bus>("cl.bus")!.deaths.push(target);
    },
  },
  {
    id: "cl.deaths",
    stage: "post",
    run(world, ctx) {
      const bus = world.getResource<Bus>("cl.bus")!;
      for (const e of bus.deaths) {
        const p = world.read(e, CPos);
        const l = world.create();
        world.add(l, CPos, { x: p.x, y: p.y });
        world.add(l, CLoot, { item: "cl.gold", qty: ctx.rng.int(1, 50), ttl: 200 });
        world.destroy(e);
        ctx.emit({ type: "cl.died", entity: e });
        spawnMonster(world, ctx);
      }
      const [hero] = world.query(CHero);
      for (const h of bus.hits) world.read(hero!, CHp).hp -= h.dmg;
      if (world.read(hero!, CHp).hp <= 0) world.update(hero!, CHp, { hp: 100 });
      world.setResource<Bus>("cl.bus", { hits: [], deaths: [] });
    },
  },
  {
    id: "cl.loot",
    stage: "post",
    run(world) {
      for (const e of world.query(CLoot)) {
        if (--world.read(e, CLoot).ttl <= 0) world.destroy(e);
      }
    },
  },
  {
    id: "cl.explore",
    stage: "post",
    run(world) {
      const [hero] = world.query(CHero);
      const p = world.read(hero!, CPos);
      const ex = world.getResource<Explore>("cl.explore")!;
      const i = (p.y >> 8) * 128 + (p.x >> 8);
      const bit = 1 << (i & 31);
      if ((ex.bits[i >> 5]! & bit) === 0) {
        ex.bits[i >> 5]! |= bit;
        ex.revealed++;
      }
    },
  },
];

function classicSetup(world: World, ctx: SimContext): void {
  const hero = world.create();
  world.add(hero, CHero, { name: "bench" });
  world.add(hero, CPos, { x: SIZE / 2, y: SIZE / 2 });
  world.add(hero, CVel, { dx: 3, dy: 1 });
  world.add(hero, CHp, { hp: 100, max: 100 });
  for (let i = 0; i < MONSTERS; i++) spawnMonster(world, ctx);
  world.setResource<Bus>("cl.bus", { hits: [], deaths: [] });
  world.setResource<Explore>("cl.explore", {
    revealed: 0,
    bits: Array.from({ length: 512 }, () => 0),
  });
  world.setResource("cl.game", { seed: 7, depth: 3, gold: 0, quests: [{ id: "q1", done: false }] });
}

const classicLike = defineModule({
  id: "bench.classic",
  version: "1.0.0",
  setup: classicSetup,
  systems: classicSystems,
});

const catalog: ModuleSpec[] = [counter, filler, swarm, classicLike];

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

const classic20 = loadMode(
  defineMode({
    id: "bench-classic",
    name: "Bench classic-like",
    description: "300 monsters, projectiles and loot at 20 Hz",
    world: null,
    modules: ["bench.classic"],
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
  measure(
    "event mode, 1001 entities, rejected dispatch (rollback)",
    "dispatches",
    2_000,
    () => {
      for (let i = 0; i < 2_000; i++) sink = large.dispatch("bench.fail", null, "bench");
    },
    () => undefined,
    { minIterations: 3, minTimeMs: 1500 },
  ),
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

// step(1) is what a 20 Hz instance calls; measured as batches of 20 calls (1 s of sim time).
const sim1kSingle = createSim(fixed1k, { seed: 7 });
stepRows.push(
  measure(
    "fixed mode, 1000 entities, 20x step(1)",
    "ticks",
    20,
    () => {
      for (let i = 0; i < 20; i++) sink = sim1kSingle.step(1);
    },
    () => undefined,
    { minIterations: 5, minTimeMs: 1500 },
  ),
);

// Classic-like workload. The baseline runs the same systems on a bare world
// with a fake context: no sim, no rollback, no event buffer. It is the floor
// that step(1) can reach.
const classicSim = createSim(classic20, { seed: 11 });
const bare = createWorld();
const bareEvents: GameEvent[] = [];
let bareTick = 0;
const bareCtx = {
  mode: classic20.mode,
  registry: classic20.registry,
  rng: createRng(11),
  emit: (e: GameEvent) => void bareEvents.push(e),
  get tick() {
    return bareTick;
  },
  get timeMs() {
    return bareTick * 50;
  },
  actor: null,
} as SimContext;
classicSetup(bare, bareCtx);
const classicRows = [
  measure(
    "classic-like, systems only (no sim, no rollback)",
    "ticks",
    20,
    () => {
      for (let i = 0; i < 20; i++) {
        for (const s of classic20.systems) s.run(bare, bareCtx);
        bareTick++;
        bareEvents.length = 0;
      }
    },
    () => undefined,
    { minIterations: 5, minTimeMs: 2000 },
  ),
  measure(
    "classic-like, sim.step(1)",
    "ticks",
    20,
    () => {
      for (let i = 0; i < 20; i++) sink = classicSim.step(1);
    },
    () => undefined,
    { minIterations: 5, minTimeMs: 2000 },
  ),
];
const classicEntities = classicSim.world.query().length;
// Same seed, same systems: the bare run must match the sim run tick for tick.
const check = createSim(classic20, { seed: 11 });
check.step(bareTick);
if (
  stableHash([check.world.snapshot(), check.snapshot().rng]) !==
  stableHash([bare.snapshot(), bareCtx.rng.getState()])
) {
  throw new Error("classic-like bare run diverged from the sim");
}

printTable("Kernel: event-mode dispatch", dispatchRows);
printTable("Kernel: fixed-mode step()", stepRows);
printTable(`Kernel: classic-like 20 Hz step(1), ~${classicEntities} entities`, classicRows);
for (const r of [...stepRows.slice(1), ...classicRows]) {
  console.log(`${r.name}: ${fmt(r.medianMs / 20, 3)} ms per tick`);
}
// Entity updates per second, the number a fixed-mode game cares about.
console.log(
  `\nFixed mode: ${fmt(stepRows[0]!.throughput * 1000, 0)} entity updates/s (1000 entities x ticks/s).`,
);
console.log(`Sim hash after bench (sanity): ${sim1k.hash()}`);
void sink;

writeResults(process.env.BENCH_RESULTS ?? "kernel", {
  dispatch: dispatchRows,
  step: stepRows,
  classic: classicRows,
  classicEntities,
});
