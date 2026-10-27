import type { GameEvent } from "@gamez/kernel";
import { createSim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { act, descendScripted, loaded, newSim } from "./fixtures.ts";

describe("determinism", () => {
  it("same seed and script give the same events and hash", () => {
    const run = (seed: number) => {
      const sim = newSim(seed);
      const events: GameEvent[] = [];
      descendScripted(sim, events);
      return { hash: sim.hash(), events: JSON.stringify(events), tick: sim.tick };
    };
    expect(run(5)).toEqual(run(5));
  });

  it("a different seed gives a different floor", () => {
    expect(newSim(1).hash()).not.toBe(newSim(2).hash());
  });

  it("a restored snapshot continues exactly like an uninterrupted sim", () => {
    const straight = newSim(9);
    const resumed = newSim(9);
    const script = [
      ["steps.wait", {}],
      ["steps.move", { dx: 1, dy: 0 }],
      ["steps.wait", {}],
    ] as const;
    for (const [name, payload] of script) {
      act(straight, name, payload);
      act(resumed, name, payload);
    }
    const restored = createSim(loaded, { seed: 0, from: resumed.snapshot() });
    expect(restored.hash()).toBe(straight.hash());
    for (const [name, payload] of script) {
      act(straight, name, payload);
      act(restored, name, payload);
    }
    expect(restored.hash()).toBe(straight.hash());
    expect(JSON.stringify(restored.snapshot())).toBe(JSON.stringify(straight.snapshot()));
  });
});
