import type { EntityState } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { checkSeq, WorldState } from "../../src/client/state.ts";

function entity(id: string, x = 1, y = 1): EntityState {
  return {
    id,
    kind: "player",
    name: id,
    appearance: "unit.hero",
    pos: { x, y },
    path: [],
    pathStartedAt: 0,
    speed: 4,
  };
}

const welcome = (entities: EntityState[]) =>
  ({ t: "welcome", selfId: "me", chunkId: "c", serverTime: 0, entities }) as const;
const delta = (seq: number, upserts: EntityState[] = [], removes: string[] = []) =>
  ({ t: "delta", chunkId: "c", seq, upserts, removes }) as const;

describe("checkSeq", () => {
  it("accepts any seq as the base after a welcome", () => {
    expect(checkSeq(null, 42)).toBe("apply");
  });

  it("accepts the next seq, ignores old ones and flags gaps", () => {
    expect(checkSeq(5, 6)).toBe("apply");
    expect(checkSeq(5, 5)).toBe("stale");
    expect(checkSeq(5, 2)).toBe("stale");
    expect(checkSeq(5, 7)).toBe("gap");
  });
});

describe("WorldState", () => {
  it("applies deltas in order and reports a gap", () => {
    const w = new WorldState();
    w.reset(welcome([entity("me"), entity("a")]));
    expect(w.applyDelta(delta(10, [entity("b")], ["a"]))).toBe("apply");
    expect([...w.entities.keys()].sort()).toEqual(["b", "me"]);
    expect(w.drainRemoved()).toEqual(["a"]);
    expect(w.applyDelta(delta(10, [entity("c")]))).toBe("stale");
    expect(w.applyDelta(delta(12, [entity("c")]))).toBe("gap");
    expect(w.entities.has("c")).toBe(false);
  });

  it("reports entities missing from a new welcome as removed", () => {
    const w = new WorldState();
    w.reset(welcome([entity("me"), entity("a")]));
    w.reset(welcome([entity("me")]));
    expect(w.drainRemoved()).toEqual(["a"]);
  });

  it("overlays a self prediction until the server path arrives", () => {
    const w = new WorldState();
    w.reset(welcome([entity("me")]));
    w.predictSelf({ pos: { x: 1, y: 1 }, path: [{ x: 2, y: 1 }], pathStartedAt: 100 });
    expect(w.self()?.path).toEqual([{ x: 2, y: 1 }]);
    expect([...w.visible()].find((e) => e.id === "me")?.pathStartedAt).toBe(100);
    w.applyDelta(delta(1, [{ ...entity("me"), path: [{ x: 1, y: 2 }] }]));
    expect(w.self()?.path).toEqual([{ x: 1, y: 2 }]);
  });
});
