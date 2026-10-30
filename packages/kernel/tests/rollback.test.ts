/**
 * Rollback through the world's undo log: in-place mutation of live values,
 * create/destroy, resources, step() failures, and a randomized check that
 * rollback restores the exact snapshot and commit matches a plain run.
 */
import { describe, expect, it } from "vite-plus/test";
import { cloneJson } from "../src/hash.ts";
import { ActionError, createRng, createSim, defineComponent, loadMode } from "../src/index.ts";
import type { ComponentType, Rng, Sim, World } from "../src/index.ts";
import { WorldImpl } from "../src/world.ts";
import { mod, modeOf } from "./fixtures.ts";

const Pos = defineComponent<{ x: number; y: number }>("r.pos");
const Bag = defineComponent<{ items: { id: string; n: number }[]; meta: { tags: string[] } }>(
  "r.bag",
);
const Label = defineComponent<string>("r.label");

interface Deep {
  level: { rooms: { id: number; doors: number[] }[]; flags: Record<string, boolean> };
  count: number;
}

/** Event-mode sim whose "r.go" action runs `fn` and then throws when `fail` is set. */
function simWith(fn: (w: World) => void, setup?: (w: World) => void): Sim {
  const m = mod("r.a", {
    setup: (w) => setup?.(w),
    actions: [
      {
        name: "r.go",
        parse: (_w, p) => p as { fail: boolean },
        apply(w, p: { fail: boolean }) {
          fn(w);
          if (p.fail) throw new ActionError("nope", "rejected after mutating");
        },
      },
    ],
  });
  return createSim(loadMode(modeOf(["r.*"]), [m]), { seed: 1 });
}

function populate(w: World): void {
  const a = w.create();
  w.add(a, Pos, { x: 1, y: 2 });
  w.add(a, Bag, { items: [{ id: "gold", n: 5 }], meta: { tags: ["a"] } });
  const b = w.create();
  w.add(b, Pos, { x: 3, y: 4 });
  w.add(b, Label, "b");
  w.setResource<Deep>("r.deep", {
    level: { rooms: [{ id: 1, doors: [2, 3] }], flags: { lit: true } },
    count: 0,
  });
}

describe("peek (read-only view, no rollback copy)", () => {
  it("returns the live value and an update() after a peek still rolls back", () => {
    let seen: Readonly<{ x: number; y: number }> | undefined;
    const sim = simWith((w) => {
      seen = w.peek(1, Pos);
      expect(seen).toBe(w.get(1, Pos));
      expect(w.peek(1, Label)).toBeUndefined();
      w.update(1, Pos, { x: 77 });
      w.update(2, Pos, { y: 55 });
      expect(w.peek(2, Pos)?.y).toBe(55);
    }, populate);
    const before = sim.hash();
    expect(sim.dispatch("r.go", { fail: true }, null).ok).toBe(false);
    expect(sim.hash()).toBe(before);
    expect(sim.dispatch("r.go", { fail: false }, null).ok).toBe(true);
    expect(sim.world.peek(1, Pos)).toEqual({ x: 77, y: 2 });
  });
});

describe("peekResource (read-only view)", () => {
  it("returns the stored value and a later getResource() mutation still rolls back", () => {
    const sim = simWith((w) => {
      const seen = w.peekResource<Deep>("r.deep");
      expect(seen).toBe(w.getResource<Deep>("r.deep"));
      expect(w.peekResource("r.none")).toBeUndefined();
      w.getResource<Deep>("r.deep")!.count = 9;
      expect(w.peekResource<Deep>("r.deep")!.count).toBe(9);
    }, populate);
    const before = sim.hash();
    expect(sim.dispatch("r.go", { fail: true }, null).ok).toBe(false);
    expect(sim.hash()).toBe(before);
    expect(sim.world.peekResource<Deep>("r.deep")!.count).toBe(0);
  });
});

describe("field entries of update()", () => {
  it("restore patched fields, also after promotion, replacement and destroy", () => {
    const sim = simWith((w) => {
      w.update(1, Bag, { items: [{ id: "silver", n: 1 }] });
      w.update(1, Bag, { items: [{ id: "copper", n: 2 }] }); // same key: first save wins
      w.update(1, Pos, { x: 50 });
      w.read(1, Pos).y = 60; // promotion: field entry -> value entry
      w.update(2, Pos, { y: 40 });
      w.add(2, Pos, { x: 0, y: 0 }); // replaced after a field entry
      w.update(1, Bag, { meta: { tags: ["b"] } });
      w.destroy(1);
    }, populate);
    const before = JSON.stringify(sim.world.snapshot());
    expect(sim.dispatch("r.go", { fail: true }, null).ok).toBe(false);
    expect(JSON.stringify(sim.world.snapshot())).toBe(before);
    expect(sim.dispatch("r.go", { fail: false }, null).ok).toBe(true);
    expect(sim.world.exists(1)).toBe(false);
    expect(sim.world.peek(2, Pos)).toEqual({ x: 0, y: 0 });
  });
});

describe("rollback of in-place mutation", () => {
  it("restores values mutated through get() and read(), including nested arrays", () => {
    const sim = simWith((w) => {
      const p = w.get(1, Pos)!;
      p.x = 100;
      const bag = w.read(1, Bag);
      bag.items[0]!.n = 99;
      bag.items.push({ id: "gem", n: 1 });
      bag.meta.tags.splice(0, 1, "z", "y");
      // A second read in the same transaction returns the same live object.
      expect(w.read(1, Bag)).toBe(bag);
      w.read(2, Pos).y = -1;
    }, populate);
    const before = sim.hash();
    const res = sim.dispatch("r.go", { fail: true }, null);
    expect(res.error?.code).toBe("nope");
    expect(sim.hash()).toBe(before);
    expect(sim.world.read(1, Pos)).toEqual({ x: 1, y: 2 });
    expect(sim.world.read(1, Bag)).toEqual({
      items: [{ id: "gold", n: 5 }],
      meta: { tags: ["a"] },
    });
    expect(sim.world.read(2, Pos)).toEqual({ x: 3, y: 4 });
    // The same mutation commits when the action succeeds.
    expect(sim.dispatch("r.go", { fail: false }, null).ok).toBe(true);
    expect(sim.world.read(1, Pos).x).toBe(100);
    expect(sim.world.read(1, Bag).items).toHaveLength(2);
  });

  it("restores nested resources mutated through getResource()", () => {
    const sim = simWith((w) => {
      const d = w.getResource<Deep>("r.deep")!;
      d.count++;
      d.level.rooms[0]!.doors.push(9);
      d.level.rooms.push({ id: 2, doors: [] });
      d.level.flags.dark = true;
      delete (d.level.flags as Partial<Record<string, boolean>>).lit;
    }, populate);
    const before = sim.hash();
    sim.dispatch("r.go", { fail: true }, null);
    expect(sim.hash()).toBe(before);
    expect(sim.world.getResource("r.deep")).toEqual({
      level: { rooms: [{ id: 1, doors: [2, 3] }], flags: { lit: true } },
      count: 0,
    });
  });

  it("restores the exact key order of a value reordered in place", () => {
    const sim = simWith((w) => {
      const p = w.read(1, Pos) as { x?: number; y: number };
      delete p.x;
      p.x = 5;
      expect(Object.keys(p)).toEqual(["y", "x"]);
    }, populate);
    const json = JSON.stringify(sim.world.snapshot());
    sim.dispatch("r.go", { fail: true }, null);
    expect(Object.keys(sim.world.read(1, Pos))).toEqual(["x", "y"]);
    expect(JSON.stringify(sim.world.snapshot())).toBe(json);
  });

  it("does not let references from a failed dispatch reach the restored world", () => {
    let leaked: { x: number } | undefined;
    const sim = simWith((w) => {
      leaked = w.read(1, Pos);
      leaked.x = 50;
    }, populate);
    sim.dispatch("r.go", { fail: true }, null);
    leaked!.x = 77;
    expect(sim.world.read(1, Pos).x).toBe(1);
  });

  it("rolls back changes made through update(), add() over a value, remove() and setResource()", () => {
    const sim = simWith((w) => {
      w.read(1, Pos).x = 10; // live mutation, then...
      w.update(1, Pos, { y: 20 }); // ...a patch of the same value
      w.add(2, Pos, { x: 0, y: 0 }); // replace
      w.add(2, Label, "renamed");
      w.remove(1, Bag);
      w.add(1, Bag, { items: [], meta: { tags: [] } }); // re-add after remove
      w.setResource("r.deep", { level: { rooms: [], flags: {} }, count: 9 });
      w.setResource("r.new", [1, 2, 3]);
      w.deleteResource("r.new");
      w.setResource("r.new", { again: true });
    }, populate);
    const before = sim.hash();
    sim.dispatch("r.go", { fail: true }, null);
    expect(sim.hash()).toBe(before);
    expect(sim.world.getResource("r.new")).toBeUndefined();
    expect(sim.world.read(2, Label)).toBe("b");
  });
});

describe("rollback of create and destroy", () => {
  it("removes entities created and revives entities destroyed in a failed dispatch", () => {
    let created: number[] = [];
    const sim = simWith((w) => {
      created = [w.create(), w.create(), w.create()];
      w.add(created[0]!, Pos, { x: 9, y: 9 });
      w.add(created[1]!, Label, "temp");
      w.destroy(created[1]!); // created and destroyed in the same transaction
      w.read(1, Bag).items.length = 0;
      w.destroy(1); // has Pos and Bag (Bag was mutated first)
      w.destroy(2);
      w.destroy(2); // no-op
    }, populate);
    const before = sim.world.snapshot();
    const res = sim.dispatch("r.go", { fail: true }, null);
    expect(res.ok).toBe(false);
    expect(sim.world.snapshot()).toEqual(before);
    expect(created).toEqual([3, 4, 5]);
    for (const e of created) expect(sim.world.exists(e)).toBe(false);
    expect(sim.world.query(Pos)).toEqual([1, 2]);
    expect(sim.world.query()).toEqual([1, 2]);
    expect(sim.world.read(1, Bag).items).toEqual([{ id: "gold", n: 5 }]);
    expect(sim.world.read(2, Label)).toBe("b");
    // Ids are handed out again from where they were before the failed dispatch.
    sim.dispatch("r.go", { fail: false }, null);
    expect(created).toEqual([3, 4, 5]);
    expect(sim.world.query(Pos)).toEqual([3]);
  });

  it("restores state after a world method throws in the middle of an action", () => {
    const sim = simWith((w) => {
      w.read(1, Pos).x = 3;
      const e = w.create();
      w.add(e, Pos, { x: Number.NaN, y: 0 });
    }, populate);
    const before = sim.hash();
    const res = sim.dispatch("r.go", { fail: false }, null);
    expect(res.error?.code).toBe("internal");
    expect(res.error?.message).toMatch(/Not plain JSON data at r\.pos\[3\]\.x: NaN/);
    expect(sim.hash()).toBe(before);
  });
});

describe("step() failure rollback", () => {
  const Mover = defineComponent<{ x: number; trail: number[] }>("r.mover");
  const stepMod = mod("r.s", {
    setup(w) {
      for (let i = 0; i < 3; i++) w.add(w.create(), Mover, { x: i, trail: [] });
      w.setResource("r.stats", { spawned: 0, log: [] as number[] });
    },
    systems: [
      {
        id: "r.s.move",
        run(w, ctx) {
          for (const e of w.query(Mover)) {
            const m = w.read(e, Mover);
            m.x += ctx.rng.int(1, 3);
            m.trail.push(m.x);
          }
        },
      },
      {
        id: "r.s.spawn",
        run(w, ctx) {
          const stats = w.getResource<{ spawned: number; log: number[] }>("r.stats")!;
          stats.spawned++;
          stats.log.push(ctx.tick);
          w.add(w.create(), Mover, { x: 0, trail: [] });
          const [oldest] = w.query(Mover);
          if (ctx.tick % 2 === 1) w.destroy(oldest!);
          ctx.emit({ type: "r.spawned", tick: ctx.tick });
        },
      },
      {
        id: "r.s.bomb",
        stage: "post",
        run(w, ctx) {
          if (w.getResource<number>("r.bomb") === ctx.tick) throw new Error("boom");
        },
      },
    ],
  });
  const loaded = loadMode(modeOf(["r.*"], "fixed"), [stepMod]);

  it("restores world, rng and tick after several ticks, and continues like an untouched twin", () => {
    const sim = createSim(loaded, { seed: 4 });
    const twin = createSim(loaded, { seed: 4 });
    sim.step(3);
    twin.step(3);
    sim.world.setResource("r.bomb", 6);
    twin.world.setResource("r.bomb", 6);
    const before = sim.snapshot();
    expect(() => sim.step(5)).toThrow(/System "r\.s\.bomb" failed: boom/);
    expect(sim.tick).toBe(3);
    expect(sim.snapshot()).toEqual(before);
    expect(JSON.stringify(sim.snapshot())).toBe(JSON.stringify(before));
    // Without the bomb, both continue identically (rng and entity ids included).
    sim.world.deleteResource("r.bomb");
    twin.world.deleteResource("r.bomb");
    expect(sim.step(4)).toEqual(twin.step(4));
    expect(sim.hash()).toBe(twin.hash());
  });

  it("keeps earlier committed steps when a later step fails", () => {
    const sim = createSim(loaded, { seed: 4 });
    sim.world.setResource("r.bomb", 2);
    expect(sim.step(2)).toHaveLength(2);
    const hash = sim.hash();
    expect(() => sim.step(1)).toThrow(/boom/);
    expect(sim.hash()).toBe(hash);
    expect(sim.tick).toBe(2);
  });
});

describe("world transactions", () => {
  it("do not nest and must be open to commit or roll back", () => {
    const w = new WorldImpl();
    expect(() => w.commit()).toThrow(/no transaction/);
    expect(() => w.rollback()).toThrow(/no transaction/);
    w.begin();
    expect(() => w.begin()).toThrow(/already open/);
    expect(() => w.load({ nextEntity: 1, components: {}, resources: {} })).toThrow(/transaction/);
    w.commit();
    w.begin();
    w.rollback();
  });

  it("restore the exact snapshot after random operations, and commit like a plain world", () => {
    const comps: ComponentType<unknown>[] = [Pos, Bag, Label];
    const values = (rng: Rng): unknown[] => [
      { x: rng.int(0, 9), y: rng.int(0, 9) },
      { items: [{ id: `i${rng.int(0, 9)}`, n: rng.int(1, 5) }], meta: { tags: ["t"] } },
      `l${rng.int(0, 99)}`,
    ];
    /** One random operation, the same on any world given the same rng state. */
    const op = (w: World, rng: Rng): void => {
      const alive = w.query();
      const e = alive.length > 0 ? rng.pick(alive) : w.create();
      const ci = rng.int(0, 2);
      const c = comps[ci]!;
      switch (rng.int(0, 14)) {
        case 0:
          w.create();
          break;
        case 1:
          w.destroy(e);
          break;
        case 2:
          w.add(e, c, values(rng)[ci]);
          break;
        case 3:
          w.remove(e, c);
          break;
        case 4: {
          const p = w.get(e, Pos);
          if (p) p.x += rng.int(1, 5);
          break;
        }
        case 5: {
          const b = w.get(e, Bag);
          if (b) {
            b.items.push({ id: "new", n: rng.int(1, 3) });
            b.meta.tags.reverse();
          }
          break;
        }
        case 6:
          if (w.has(e, Pos)) w.update(e, Pos, { y: rng.int(0, 9) });
          break;
        case 7:
          w.setResource(`r.res${rng.int(0, 2)}`, { n: rng.int(0, 9), list: [rng.int(0, 9)] });
          break;
        case 8:
          w.deleteResource(`r.res${rng.int(0, 2)}`);
          break;
        case 9: {
          const r = w.getResource<{ n: number; list: number[] }>(`r.res${rng.int(0, 2)}`);
          if (r) {
            r.n++;
            r.list.push(r.n);
          }
          break;
        }
        case 10: {
          const p = w.get(e, Pos) as { x?: number; y: number } | undefined;
          if (p) {
            delete p.x;
            p.x = rng.int(0, 9);
          }
          break;
        }
        case 11:
          // A field entry (existing keys only), nested value replaced.
          if (w.has(e, Bag)) w.update(e, Bag, { items: [{ id: `u${rng.int(0, 9)}`, n: 1 }] });
          break;
        case 12: {
          // A field entry, then the same value handed out live and mutated (promotion).
          if (!w.has(e, Bag)) break;
          w.update(e, Bag, { meta: { tags: [`m${rng.int(0, 9)}`] } });
          const b = w.get(e, Bag)!;
          b.items.push({ id: "late", n: 2 });
          b.meta.tags.push("late");
          break;
        }
        case 13:
          // Adds or deletes a key: logs the whole value.
          if (w.has(e, Pos)) {
            w.update(e, Pos as ComponentType<Record<string, number | undefined>>, {
              z: rng.chance(0.5) ? undefined : rng.int(0, 9),
            });
          }
          break;
        default:
          w.add(w.create(), Pos, { x: 0, y: 0 });
      }
    };

    for (let round = 0; round < 60; round++) {
      const seedRng = createRng(round);
      const journaled = new WorldImpl();
      const plain = new WorldImpl();
      for (let i = 0; i < 30; i++) op(journaled, seedRng);
      plain.load(journaled.snapshot());
      // Both worlds reach the same state; key order is compared via JSON text.
      const base = JSON.stringify(journaled.snapshot());
      expect(JSON.stringify(plain.snapshot())).toBe(base);

      const opsSeed = 1000 + round;
      journaled.begin();
      const a = createRng(opsSeed);
      for (let i = 0; i < 40; i++) op(journaled, a);
      journaled.rollback();
      expect(JSON.stringify(journaled.snapshot())).toBe(base);

      journaled.begin();
      const b = createRng(opsSeed);
      const c = createRng(opsSeed);
      for (let i = 0; i < 40; i++) {
        op(journaled, b);
        op(plain, c);
      }
      journaled.commit();
      expect(JSON.stringify(journaled.snapshot())).toBe(JSON.stringify(plain.snapshot()));
      // Ids continue identically after rollback + commit.
      expect(journaled.create()).toBe(plain.create());
    }
  });
});

describe("cloneJson", () => {
  it("keeps exact error paths and accepts deep data", () => {
    expect(() => cloneJson({ a: [1, { b: Number.POSITIVE_INFINITY }] }, "v")).toThrow(
      "Not plain JSON data at v.a[1].b: Infinity",
    );
    expect(() => cloneJson({ f: () => 1 }, () => "lazy")).toThrow(
      "Not plain JSON data at lazy.f: a function",
    );
    const cyc: Record<string, unknown> = { x: 1 };
    cyc.self = { back: cyc };
    expect(() => cloneJson(cyc)).toThrow("Not plain JSON data at $.self.back: circular reference");
    let deep: unknown = 0;
    for (let i = 0; i < 200; i++) deep = { d: deep };
    expect(cloneJson(deep)).toEqual(deep);
    const shared = { n: 1 };
    const out = cloneJson({ b: shared, a: shared, u: undefined });
    expect(out).toEqual({ a: { n: 1 }, b: { n: 1 } });
    expect(Object.keys(out)).toEqual(["a", "b"]);
    expect(out.a).not.toBe(out.b);
  });
});
