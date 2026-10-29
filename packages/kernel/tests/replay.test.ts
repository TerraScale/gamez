import { describe, expect, it } from "vite-plus/test";
import {
  ActionError,
  createSim,
  defineMode,
  defineModule,
  loadMode,
  replaySegment,
  SegmentRecorder,
  type RecordedSegment,
  type Sim,
} from "../src/index.ts";

interface Clock {
  ticks: number;
  sum: number;
  speed: number;
}

const clockCore = defineModule({
  id: "rclock.core",
  version: "1.0.0",
  setup(world) {
    world.setResource<Clock>("rclock.clock", { ticks: 0, sum: 0, speed: 1 });
  },
  systems: [
    {
      id: "rclock.tick",
      stage: "update",
      run(world, ctx) {
        const c = world.getResource<Clock>("rclock.clock")!;
        c.ticks += 1;
        c.sum += ctx.rng.int(0, 9);
        if (c.ticks % 10 === 0) ctx.emit({ type: "rclock.ten", ticks: c.ticks });
      },
    },
  ],
  actions: [
    {
      name: "rclock.add",
      parse(_w, p) {
        const by = (p as { by?: unknown } | null)?.by;
        if (typeof by !== "number" || !Number.isInteger(by))
          throw new ActionError("bad_payload", "by");
        return by;
      },
      apply(world, by: number, ctx) {
        const c = world.getResource<Clock>("rclock.clock")!;
        c.sum += by;
        if (c.sum > 10_000) throw new ActionError("too_big", "too big");
        ctx.emit({ type: "rclock.added", by });
      },
    },
    {
      name: "rclock.speed",
      parse: (_w, p) => (p as { speed: number }).speed,
      apply(world, speed: number) {
        world.getResource<Clock>("rclock.clock")!.speed = speed;
      },
    },
    { name: "rclock.secret", parse: () => null, apply() {} },
  ],
});

const mode = defineMode({
  id: "rclock",
  name: "Replay clock",
  description: "replay tests",
  world: null,
  modules: ["rclock.*"],
  tick: { kind: "fixed", hz: 20 },
});
const loaded = loadMode(mode, [clockCore]);
const opts = {
  actor: "local",
  maxTicks: 400,
  maxInputs: 64,
  serverOnly: new Set(["rclock.secret"]),
  speedOf: (w: Sim["world"]) => w.getResource<Clock>("rclock.clock")!.speed,
  maxSpeed: 8,
};

/** Plays a script on a client sim with odd step chunks; returns the cut segments. */
function play(sim: Sim): RecordedSegment[] {
  const rec = new SegmentRecorder(sim.tick);
  const segs: RecordedSegment[] = [];
  const act = (name: string, payload: unknown) => {
    const res = sim.dispatch(name, payload, "local");
    if (res.ok) rec.record(sim.tick, name, payload);
  };
  sim.step(3);
  act("rclock.add", { by: 5 });
  act("rclock.add", { by: "x" }); // rejected: not recorded
  act("rclock.add", { by: 7 });
  sim.step(1);
  sim.step(6);
  segs.push(rec.cut(sim)!);
  act("rclock.speed", { speed: 4 });
  sim.step(40);
  act("rclock.add", { by: 1 });
  sim.step(2);
  segs.push(rec.cut(sim)!);
  return segs;
}

describe("replaySegment", () => {
  it("replays recorded segments to the client's hash and accounts speed", () => {
    const client = createSim(loaded, { seed: 42 });
    const server = createSim(loaded, { seed: 42 });
    const [a, b] = play(client);
    const ra = replaySegment(server, a!, { ...opts, expectHash: a!.hash });
    expect(ra).toEqual({ ok: true, hash: a!.hash, costMs: 10 * 50 });
    const rb = replaySegment(server, b!, { ...opts, expectHash: b!.hash });
    expect(rb.ok).toBe(true);
    // 42 ticks at speed 4 = 525 ms.
    expect(rb.ok && rb.costMs).toBe((42 * 50) / 4);
    expect(server.hash()).toBe(client.hash());
  });

  it("detects tampered inputs and wrong hashes", () => {
    const client = createSim(loaded, { seed: 7 });
    const [a] = play(client);
    const tampered = { ...a!, inputs: a!.inputs.map((i) => ({ ...i, payload: { by: 99 } })) };
    const server = createSim(loaded, { seed: 7 });
    const res = replaySegment(server, tampered, { ...opts, expectHash: a!.hash });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe("hash_mismatch");
  });

  it("rejects bad shapes, server-only actions and rejected inputs", () => {
    const sim = () => createSim(loaded, { seed: 1 });
    const code = (seg: Parameters<typeof replaySegment>[1]) => {
      const r = replaySegment(sim(), seg, opts);
      return r.ok ? "ok" : r.code;
    };
    expect(code({ fromTick: 1, toTick: 5, inputs: [] })).toBe("bad_segment");
    expect(code({ fromTick: 0, toTick: 0, inputs: [] })).toBe("bad_segment");
    expect(code({ fromTick: 0, toTick: 401, inputs: [] })).toBe("bad_segment");
    expect(
      code({
        fromTick: 0,
        toTick: 5,
        inputs: [
          { tick: 3, name: "rclock.add", payload: { by: 1 } },
          { tick: 2, name: "rclock.add", payload: { by: 1 } },
        ],
      }),
    ).toBe("bad_segment");
    expect(
      code({
        fromTick: 0,
        toTick: 5,
        inputs: [{ tick: 5, name: "rclock.add", payload: { by: 1 } }],
      }),
    ).toBe("bad_segment");
    expect(
      code({ fromTick: 0, toTick: 5, inputs: [{ tick: 1, name: "rclock.secret", payload: null }] }),
    ).toBe("server_only_action");
    expect(
      code({
        fromTick: 0,
        toTick: 5,
        inputs: [{ tick: 1, name: "rclock.add", payload: { by: 1e6 } }],
      }),
    ).toBe("input_rejected");
    expect(
      code({ fromTick: 0, toTick: 5, inputs: [{ tick: 1, name: "nope", payload: null }] }),
    ).toBe("input_rejected");
  });

  it("hands every step and dispatch event to onEvents, in order", () => {
    const client = createSim(loaded, { seed: 11 });
    const server = createSim(loaded, { seed: 11 });
    const [a, b] = play(client);
    const seen: string[] = [];
    const onEvents = (events: readonly { type: string; [k: string]: unknown }[]) => {
      for (const e of events) seen.push(`${e.type}:${String(e.by ?? e.ticks)}`);
    };
    expect(replaySegment(server, a!, { ...opts, onEvents }).ok).toBe(true);
    expect(seen).toEqual(["rclock.added:5", "rclock.added:7", "rclock.ten:10"]);
    seen.length = 0;
    expect(replaySegment(server, b!, { ...opts, onEvents }).ok).toBe(true);
    expect(seen).toEqual([
      "rclock.ten:20",
      "rclock.ten:30",
      "rclock.ten:40",
      "rclock.ten:50",
      "rclock.added:1",
    ]);
  });

  it("ignores an onEvents observer that throws", () => {
    const client = createSim(loaded, { seed: 12 });
    const server = createSim(loaded, { seed: 12 });
    const [a] = play(client);
    const r = replaySegment(server, a!, {
      ...opts,
      expectHash: a!.hash,
      onEvents: () => {
        throw new Error("observer bug");
      },
    });
    expect(r.ok).toBe(true);
  });

  it("clamps speed to maxSpeed", () => {
    const s = createSim(loaded, { seed: 3 });
    s.dispatch("rclock.speed", { speed: 1000 }, "local");
    const r = replaySegment(s, { fromTick: 0, toTick: 80, inputs: [] }, opts);
    expect(r.ok && r.costMs).toBe((80 * 50) / 8);
  });
});

describe("SegmentRecorder", () => {
  it("returns null without elapsed ticks and refuses a cut after a same-tick dispatch", () => {
    const sim = createSim(loaded, { seed: 5 });
    const rec = new SegmentRecorder(sim.tick);
    expect(rec.cut(sim)).toBeNull();
    sim.step(2);
    sim.dispatch("rclock.add", { by: 1 }, "local");
    rec.record(sim.tick, "rclock.add", { by: 1 });
    expect(() => rec.cut(sim)).toThrow(/cut tick/);
    sim.step(1);
    const seg = rec.cut(sim)!;
    expect(seg).toMatchObject({ fromTick: 0, toTick: 3, inputs: [{ tick: 2 }] });
    rec.reset(10);
    expect(rec.fromTick).toBe(10);
    expect(() => rec.record(9, "rclock.add", {})).toThrow(RangeError);
  });
});
