import { describe, expect, it } from "vite-plus/test";
import { createSim, loadMode } from "../src/index.ts";
import type { Sim } from "../src/index.ts";
import { swarmCore, swarmMode, walkCore, walkMode } from "./fixtures.ts";

/** A scripted session including rejected actions. */
const SCRIPT: [string, unknown, string][] = [
  ["walk.join", {}, "p1"],
  ["walk.join", {}, "p2"],
  ["walk.move", { dx: 1, dy: 0 }, "p1"],
  ["walk.move", { dx: -3, dy: 0 }, "p2"],
  ["walk.move", { dx: 0, dy: 2 }, "p2"],
  ["walk.move", { dx: "bad" }, "p1"],
  ["walk.move", { dx: 2, dy: 2 }, "p1"],
  ["walk.fly", {}, "p1"],
  ["walk.move", { dx: 1, dy: -1 }, "p2"],
];

function play(sim: Sim, script: typeof SCRIPT) {
  return script.map(([name, payload, actor]) => sim.dispatch(name, payload, actor));
}

describe("determinism", () => {
  it("same seed + same action script -> identical hash and results", () => {
    const loaded = loadMode(walkMode, [walkCore]);
    const a = createSim(loaded, { seed: 1234 });
    const b = createSim(loadMode(walkMode, [walkCore]), { seed: 1234 });
    expect(play(b, SCRIPT)).toEqual(play(a, SCRIPT));
    expect(b.hash()).toBe(a.hash());
    expect(a.hash()).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(b.snapshot())).toBe(JSON.stringify(a.snapshot()));
  });

  it("different seeds diverge", () => {
    const loaded = loadMode(walkMode, [walkCore]);
    const a = createSim(loaded, { seed: 1 });
    const b = createSim(loaded, { seed: 2 });
    play(a, SCRIPT);
    play(b, SCRIPT);
    expect(b.hash()).not.toBe(a.hash());
  });

  it("restore from a snapshot continues identically to an uninterrupted event-mode sim", () => {
    const loaded = loadMode(walkMode, [walkCore]);
    const whole = createSim(loaded, { seed: 77 });
    const results = play(whole, SCRIPT);

    const first = createSim(loaded, { seed: 77 });
    const head = play(first, SCRIPT.slice(0, 4));
    // Round-trip through JSON like persistence would.
    const snap = JSON.parse(JSON.stringify(first.snapshot()));
    const resumed = createSim(loaded, { seed: 0, from: snap });
    expect(resumed.hash()).toBe(first.hash());
    const tail = play(resumed, SCRIPT.slice(4));
    expect([...head, ...tail]).toEqual(results);
    expect(resumed.hash()).toBe(whole.hash());
    expect(resumed.tick).toBe(whole.tick);
  });

  it("restore from a snapshot continues identically to an uninterrupted fixed-mode sim", () => {
    const loaded = loadMode(swarmMode, [swarmCore]);
    const whole = createSim(loaded, { seed: 5 });
    const events = whole.step(60);
    const first = createSim(loaded, { seed: 5 });
    const head = first.step(25);
    const resumed = createSim(loaded, {
      seed: 5,
      from: JSON.parse(JSON.stringify(first.snapshot())),
    });
    const tail = resumed.step(35);
    expect([...head, ...tail]).toEqual(events);
    expect(resumed.hash()).toBe(whole.hash());
  });

  it("fixed modes with the same seed match and different seeds diverge", () => {
    const loaded = loadMode(swarmMode, [swarmCore]);
    const a = createSim(loaded, { seed: 8 });
    const b = createSim(loaded, { seed: 8 });
    const c = createSim(loaded, { seed: 9 });
    a.step(40);
    b.step(40);
    c.step(40);
    expect(b.hash()).toBe(a.hash());
    expect(c.hash()).not.toBe(a.hash());
  });
});
