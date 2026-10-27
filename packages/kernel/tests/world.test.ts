import { describe, expect, it } from "vite-plus/test";
import { createWorld, defineComponent, restoreWorld } from "../src/index.ts";

const Pos = defineComponent<{ x: number; y: number; tags?: string[] }>("t.pos");
const Tag = defineComponent<true>("t.tag");
const Name = defineComponent<string>("t.name");

describe("world", () => {
  it("allocates monotonic ids that are never reused", () => {
    const w = createWorld();
    const a = w.create();
    const b = w.create();
    expect(b).toBeGreaterThan(a);
    w.destroy(a);
    expect(w.exists(a)).toBe(false);
    const c = w.create();
    expect(c).toBeGreaterThan(b);
  });

  it("adds, updates, removes and reads components", () => {
    const w = createWorld();
    const e = w.create();
    w.add(e, Pos, { x: 1, y: 2 });
    expect(w.has(e, Pos)).toBe(true);
    w.update(e, Pos, { x: 5 });
    expect(w.read(e, Pos)).toEqual({ x: 5, y: 2 });
    w.remove(e, Pos);
    expect(w.get(e, Pos)).toBeUndefined();
    expect(() => w.read(e, Pos)).toThrow(/no such component/);
    expect(() => w.update(e, Pos, { x: 1 })).toThrow(/no such component/);
    expect(() => w.add(999, Pos, { x: 1, y: 1 })).toThrow(/does not exist/);
    w.add(e, Name, "bob");
    expect(() => w.update(e, Name as never, {})).toThrow(/not an object/);
    w.destroy(e);
    expect(w.has(e, Name)).toBe(false);
  });

  it("queries entities with all components in ascending id order", () => {
    const w = createWorld();
    const ids = [w.create(), w.create(), w.create(), w.create()];
    for (const e of [...ids].reverse()) w.add(e, Pos, { x: e, y: 0 });
    w.add(ids[3]!, Tag, true);
    w.add(ids[1]!, Tag, true);
    expect(w.query(Pos)).toEqual(ids);
    expect(w.query(Tag, Pos)).toEqual([ids[1], ids[3]]);
    expect(w.query(defineComponent("t.none"))).toEqual([]);
  });

  it("stores resources by value", () => {
    const w = createWorld();
    const floor = { depth: 1 };
    w.setResource("t.floor", floor);
    floor.depth = 2;
    expect(w.getResource("t.floor")).toEqual({ depth: 1 });
    w.deleteResource("t.floor");
    expect(w.getResource("t.floor")).toBeUndefined();
    expect(() => w.setResource("t.x", undefined)).toThrow();
  });

  it("deep-clones values on add/update/snapshot so callers cannot alias internal state", () => {
    const w = createWorld();
    const e = w.create();
    const value = { x: 1, y: 1, tags: ["a"] };
    w.add(e, Pos, value);
    value.tags.push("leak");
    value.x = 100;
    expect(w.read(e, Pos)).toEqual({ x: 1, y: 1, tags: ["a"] });
    const tags = ["b"];
    w.update(e, Pos, { tags });
    tags.push("leak");
    expect(w.read(e, Pos).tags).toEqual(["b"]);
    const snap = w.snapshot();
    (snap.components["t.pos"]![0]![1] as { x: number }).x = 42;
    expect(w.read(e, Pos).x).toBe(1);
    // Live values returned by get() may be mutated by sim code.
    w.read(e, Pos).x = 7;
    expect(w.snapshot().components["t.pos"]![0]![1]).toMatchObject({ x: 7 });
  });

  it("rejects non-JSON component values and drops undefined fields", () => {
    const w = createWorld();
    const e = w.create();
    expect(() => w.add(e, Pos, { x: Number.NaN, y: 0 })).toThrow(/NaN/);
    expect(() => w.add(e, defineComponent<Date>("t.date"), new Date(0))).toThrow(/Date/);
    w.add(e, Pos, { x: 1, y: 2, tags: undefined });
    expect(Object.keys(w.read(e, Pos))).toEqual(["x", "y"]);
    w.update(e, Pos, { tags: ["t"] });
    w.update(e, Pos, { tags: undefined });
    expect(w.read(e, Pos)).toEqual({ x: 1, y: 2 });
  });

  it("round-trips snapshot/restore exactly, including bare entities", () => {
    const w = createWorld();
    const a = w.create();
    const bare = w.create();
    const dead = w.create();
    w.add(a, Pos, { x: 1, y: 2, tags: ["z"] });
    w.add(a, Tag, true);
    w.add(dead, Tag, true);
    w.destroy(dead);
    w.add(w.create(), Name, "late");
    w.setResource("t.b", [1, 2]);
    w.setResource("t.a", { n: null });
    const snap = w.snapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(Object.keys(snap.resources)).toEqual(["t.a", "t.b"]);

    const r = restoreWorld(snap);
    expect(r.snapshot()).toEqual(snap);
    expect(JSON.stringify(r.snapshot())).toBe(JSON.stringify(snap));
    expect(r.exists(bare)).toBe(true);
    expect(r.exists(dead)).toBe(false);
    expect(r.query(Tag)).toEqual([a]);
    expect(r.create()).toBe(w.create());

    // The restored world does not share state with the snapshot.
    (snap.components["t.pos"]![0]![1] as { x: number }).x = 9;
    expect(r.read(a, Pos).x).toBe(1);
  });

  it("validates snapshots and protects the reserved entity component", () => {
    expect(() => restoreWorld({ nextEntity: 0, components: {}, resources: {} })).toThrow();
    expect(() =>
      restoreWorld({ nextEntity: 2, components: { "t.tag": [[1, true]] }, resources: {} }),
    ).toThrow(/dead entity/);
    const w = createWorld();
    const e = w.create();
    const entity = defineComponent<true>("kernel.entity");
    expect(() => w.add(e, entity, true)).toThrow(/reserved/);
    expect(w.query(entity)).toEqual([e]);
  });
});
