import { describe, expect, it, vi } from "vite-plus/test";
import { createSlotRegistry, type SlotComponent } from "../src/slots/registry.ts";

const A: SlotComponent = () => null;
const B: SlotComponent = () => null;
const C: SlotComponent = () => null;

describe("createSlotRegistry", () => {
  it("lists entries sorted by order, then id", () => {
    const r = createSlotRegistry();
    r.register("hud.left", { id: "zeta", moduleId: "m", component: A });
    r.register("hud.left", { id: "beta", moduleId: "m", component: B, order: 5 });
    r.register("hud.left", { id: "alpha", moduleId: "m", component: C, order: -1 });
    r.register("hud.left", { id: "gamma", moduleId: "m", component: A });
    expect(r.list("hud.left").map((e) => e.id)).toEqual(["alpha", "gamma", "zeta", "beta"]);
  });

  it("keeps slots separate", () => {
    const r = createSlotRegistry();
    r.register("hud.left", { id: "x", moduleId: "m", component: A });
    expect(r.list("hud.right")).toEqual([]);
    expect(r.list("hud.left")).toHaveLength(1);
  });

  it("rejects a duplicate id in the same slot but allows it in another", () => {
    const r = createSlotRegistry();
    r.register("hud.left", { id: "x", moduleId: "m", component: A });
    expect(() => r.register("hud.left", { id: "x", moduleId: "n", component: B })).toThrow(
      /already has an entry "x"/,
    );
    expect(() =>
      r.register("panel.character", { id: "x", moduleId: "n", component: B }),
    ).not.toThrow();
  });

  it("does not keep a reference to the registered object", () => {
    const r = createSlotRegistry();
    const entry = { id: "x", moduleId: "m", component: A };
    r.register("s", entry);
    entry.component = B;
    expect(r.list("s")[0]!.component).toBe(A);
  });

  it("replaces a component but keeps id, module and order", () => {
    const r = createSlotRegistry();
    r.register("s", { id: "x", moduleId: "base", component: A, order: 3 });
    r.replace("s", "x", B);
    const [entry] = r.list("s");
    expect(entry).toMatchObject({ id: "x", moduleId: "base", order: 3, component: B });
  });

  it("throws when replacing an unknown id", () => {
    const r = createSlotRegistry();
    expect(() => r.replace("s", "missing", A)).toThrow(/no entry "missing"/);
  });

  it("removes an entry, and removing a missing one is a no-op", () => {
    const r = createSlotRegistry();
    r.register("s", { id: "x", moduleId: "m", component: A });
    r.remove("s", "x");
    r.remove("s", "x");
    r.remove("never", "x");
    expect(r.list("s")).toEqual([]);
  });

  it("returns the same snapshot until the slot changes", () => {
    const r = createSlotRegistry();
    r.register("s", { id: "x", moduleId: "m", component: A });
    const first = r.list("s");
    expect(r.list("s")).toBe(first);
    r.register("other", { id: "y", moduleId: "m", component: A });
    expect(r.list("s")).toBe(first);
    r.replace("s", "x", B);
    expect(r.list("s")).not.toBe(first);
    expect(r.list("s")[0]!.component).toBe(B);
  });

  it("returns a stable empty snapshot for an empty slot", () => {
    const r = createSlotRegistry();
    expect(r.list("nothing")).toBe(r.list("also-nothing"));
  });

  it("notifies subscribers on every change and stops after unsubscribe", () => {
    const r = createSlotRegistry();
    const listener = vi.fn();
    const off = r.subscribe(listener);
    r.register("s", { id: "x", moduleId: "m", component: A });
    r.replace("s", "x", B);
    r.remove("s", "x");
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    r.register("s", { id: "y", moduleId: "m", component: A });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("does not notify when a remove finds nothing", () => {
    const r = createSlotRegistry();
    const listener = vi.fn();
    r.subscribe(listener);
    r.remove("s", "x");
    expect(listener).not.toHaveBeenCalled();
  });
});
