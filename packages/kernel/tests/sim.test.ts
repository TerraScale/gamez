import { describe, expect, it } from "vite-plus/test";
import { ActionError, createSim, loadMode } from "../src/index.ts";
import type { GameEvent } from "../src/index.ts";
import {
  Hp,
  Player,
  Pos,
  Spark,
  mod,
  modeOf,
  swarmCore,
  swarmMode,
  walkCore,
  walkMode,
} from "./fixtures.ts";

const walk = () => loadMode(walkMode, [walkCore]);
const swarm = () => loadMode(swarmMode, [swarmCore]);

describe("createSim", () => {
  it("runs setup() of every module in load order with no actor", () => {
    const log: string[] = [];
    const m = (id: string, deps: string[] = []) =>
      mod(id, {
        deps,
        setup: (w, ctx) => {
          log.push(`${id}:${String(ctx.actor)}:${ctx.tick}`);
          w.setResource(id, true);
        },
      });
    const sim = createSim(loadMode(modeOf(["s.*"]), [m("s.b", ["s.c"]), m("s.c"), m("s.a")]), {
      seed: 1,
    });
    expect(log).toEqual(["s.a:null:0", "s.c:null:0", "s.b:null:0"]);
    expect(sim.tick).toBe(0);
  });

  it("names the module whose setup failed", () => {
    const bad = mod("s.bad", {
      setup: () => {
        throw new Error("nope");
      },
    });
    expect(() => createSim(loadMode(modeOf(["s.*"]), [bad]), { seed: 1 })).toThrow(
      'Module "s.bad" failed in setup: nope',
    );
  });

  it("uses the frozen registry and seeded rng in setup", () => {
    const sim = createSim(walk(), { seed: 5 });
    const monsters = sim.world.query(Hp, Pos);
    expect(monsters).toHaveLength(3);
    expect(sim.world.read(monsters[0]!, Hp)).toEqual({ hp: 5 });
  });

  it("rejects restoring a snapshot from another content version or mode", () => {
    const sim = createSim(walk(), { seed: 1 });
    const snap = sim.snapshot();
    expect(() =>
      createSim(walk(), { seed: 1, from: { ...snap, contentHash: "0000000000000000" } }),
    ).toThrow(/contentHash/);
    expect(() => createSim(walk(), { seed: 1, from: { ...snap, modeId: "duel" } })).toThrow(
      /"duel" snapshot/,
    );
  });
});

describe("dispatch", () => {
  it("applies an action, runs systems once and advances the tick in event modes", () => {
    const sim = createSim(walk(), { seed: 1 });
    const before = sim.world.query(Hp, Pos).map((e) => ({ ...sim.world.read(e, Pos) }));
    const res = sim.dispatch("walk.join", {}, "p1");
    expect(res).toEqual({ ok: true, events: [{ type: "walk.joined", entity: 4 }], tick: 1 });
    expect(sim.tick).toBe(1);
    const after = sim.world.query(Hp, Pos).map((e) => sim.world.read(e, Pos));
    expect(after).not.toEqual(before);
    const moved = sim.dispatch("walk.move", { dx: 2, dy: 1 }, "p1");
    expect(moved.ok).toBe(true);
    expect(moved.events).toEqual([{ type: "walk.moved", x: 2, y: 1 }]);
    expect(moved.tick).toBe(2);
  });

  it("rolls back on a parse error", () => {
    const sim = createSim(walk(), { seed: 1 });
    sim.dispatch("walk.join", {}, "p1");
    const hash = sim.hash();
    const res = sim.dispatch("walk.move", { dx: "far" }, "p1");
    expect(res).toEqual({
      ok: false,
      error: { code: "bad_payload", message: "dx and dy must be numbers" },
      events: [],
      tick: 1,
    });
    expect(sim.hash()).toBe(hash);
  });

  it("rolls back world, rng and tick on an apply error after partial mutation", () => {
    const sim = createSim(walk(), { seed: 1 });
    sim.dispatch("walk.join", {}, "p1");
    const hash = sim.hash();
    const me = sim.world.query(Player)[0]!;
    const res = sim.dispatch("walk.move", { dx: -1, dy: 0 }, "p1");
    expect(res.ok).toBe(false);
    expect(res.error).toEqual({ code: "blocked", message: "wall" });
    expect(sim.world.read(me, Pos)).toEqual({ x: 0, y: 0 });
    expect(sim.hash()).toBe(hash);
    expect(sim.tick).toBe(1);
  });

  it("rolls back the whole dispatch when a system throws", () => {
    const sim = createSim(walk(), { seed: 1 });
    sim.dispatch("walk.join", {}, "p1");
    sim.world.setResource("walk.explode", true);
    const hash = sim.hash();
    const res = sim.dispatch("walk.move", { dx: 1, dy: 0 }, "p1");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("internal");
    expect(res.error?.message).toMatch(/System "walk\.monsters\.explode" failed: kaboom/);
    expect(res.events).toEqual([]);
    expect(sim.hash()).toBe(hash);
  });

  it("keeps the code of an ActionError thrown by a system, maps other throws to internal", () => {
    const thrower = (err: unknown) =>
      mod("x.a", {
        actions: [{ name: "x.go", parse: () => null, apply: () => {} }],
        systems: [
          {
            id: "x.sys",
            run: () => {
              throw err;
            },
          },
        ],
      });
    const res = createSim(
      loadMode(modeOf(["x.*"]), [thrower(new ActionError("dead", "you died"))]),
      {
        seed: 1,
      },
    ).dispatch("x.go", null, null);
    expect(res.error).toEqual({ code: "dead", message: "you died" });
    const res2 = createSim(loadMode(modeOf(["x.*"]), [thrower("str")]), { seed: 1 }).dispatch(
      "x.go",
      null,
      null,
    );
    expect(res2.error).toEqual({ code: "internal", message: 'System "x.sys" failed: str' });
  });

  it("reports unknown actions without touching state", () => {
    const sim = createSim(walk(), { seed: 1 });
    const hash = sim.hash();
    const res = sim.dispatch("walk.fly", {}, "p1");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unknown_action");
    expect(sim.hash()).toBe(hash);
  });

  it("exposes the actor and keeps world references valid across rollback", () => {
    const sim = createSim(walk(), { seed: 1 });
    const world = sim.world;
    sim.dispatch("walk.join", {}, "alice");
    sim.dispatch("walk.move", { dx: -5, dy: 0 }, "alice");
    expect(sim.world).toBe(world);
    expect(world.read(world.query(Player)[0]!, Player)).toEqual({ id: "alice" });
  });

  it("clones emitted events and rejects untyped ones", () => {
    const payload = { list: [1] };
    let leaked: GameEvent | null = null;
    const m = mod("e.a", {
      actions: [
        {
          name: "e.go",
          parse: () => null,
          apply: (_w, _p, ctx) => {
            const ev = { type: "e.ev", payload };
            ctx.emit(ev);
            leaked = ev;
          },
        },
        { name: "e.bad", parse: () => null, apply: (_w, _p, ctx) => ctx.emit({} as GameEvent) },
      ],
    });
    const sim = createSim(loadMode(modeOf(["e.*"]), [m]), { seed: 1 });
    const res = sim.dispatch("e.go", null, null);
    payload.list.push(2);
    expect(leaked).not.toBeNull();
    expect(res.events).toEqual([{ type: "e.ev", payload: { list: [1] } }]);
    expect(sim.dispatch("e.bad", null, null).error?.code).toBe("internal");
  });

  it("does not run systems or tick on dispatch in fixed modes", () => {
    const sim = createSim(swarm(), { seed: 1 });
    sim.step(10);
    const res = sim.dispatch("swarm.clear", null, "p1");
    expect(res.ok).toBe(true);
    expect(res.tick).toBe(10);
    expect(sim.world.query(Spark)).toEqual([]);
  });
});

describe("step", () => {
  it("runs n ticks of all systems in fixed modes and returns their events", () => {
    const sim = createSim(swarm(), { seed: 9 });
    const events = sim.step(20);
    expect(sim.tick).toBe(20);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === "swarm.spawned")).toBe(true);
    const times = events.map((e) => e.at as number);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times.every((t) => t % 50 === 0 && t < 1000)).toBe(true);
    expect(sim.step(0)).toEqual([]);
    expect(sim.step()).toBeInstanceOf(Array);
    expect(sim.tick).toBe(21);
  });

  it("matches n single steps", () => {
    const a = createSim(swarm(), { seed: 3 });
    const b = createSim(swarm(), { seed: 3 });
    const evA = a.step(15);
    const evB: GameEvent[] = [];
    for (let i = 0; i < 15; i++) evB.push(...b.step());
    expect(evB).toEqual(evA);
    expect(b.hash()).toBe(a.hash());
  });

  it("throws in event modes and rolls back a failing fixed step", () => {
    expect(() => createSim(walk(), { seed: 1 }).step()).toThrow(/event ticks/);
    const bomb = mod("b.a", {
      systems: [
        {
          id: "b.count",
          run: (w, ctx) => {
            w.setResource("n", ctx.tick);
            if (ctx.tick === 3) throw new Error("boom");
          },
        },
      ],
    });
    const sim = createSim(loadMode(modeOf(["b.*"], "fixed"), [bomb]), { seed: 1 });
    sim.step(2);
    const hash = sim.hash();
    expect(() => sim.step(5)).toThrow(/System "b\.count" failed: boom/);
    expect(sim.tick).toBe(2);
    expect(sim.hash()).toBe(hash);
    expect(() => sim.step(-1)).toThrow(RangeError);
  });

  it("reports timeMs from the tick rate", () => {
    let seen: number[] = [];
    const m = mod("t.a", {
      systems: [{ id: "t.s", run: (_w, ctx) => void seen.push(ctx.timeMs) }],
    });
    createSim(loadMode(modeOf(["t.*"], "fixed"), [m]), { seed: 1 }).step(3);
    expect(seen).toEqual([0, 100, 200]);
    seen = [];
    const ev = mod("t.a", {
      actions: [{ name: "t.go", parse: () => null, apply: () => {} }],
      systems: [{ id: "t.s", run: (_w, ctx) => void seen.push(ctx.timeMs) }],
    });
    const sim = createSim(loadMode(modeOf(["t.*"]), [ev]), { seed: 1 });
    sim.dispatch("t.go", null, null);
    sim.dispatch("t.go", null, null);
    expect(seen).toEqual([0, 1]);
  });

  it("rejects re-entrant dispatch from sim code", () => {
    const m = mod("r.a", {
      actions: [{ name: "r.go", parse: () => null, apply: () => sim.dispatch("r.go", null, null) }],
    });
    const sim = createSim(loadMode(modeOf(["r.*"]), [m]), { seed: 1 });
    expect(sim.dispatch("r.go", null, null).error?.message).toMatch(/cannot be called from inside/);
  });
});
