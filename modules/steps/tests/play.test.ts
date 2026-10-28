import type { GameEvent } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { descendScripted, floorOfSim, heroHealth, isOver, newSim } from "./fixtures.ts";

const SEED = 1;

describe(`scripted playthrough (seed ${SEED})`, () => {
  it("walks to the stairs, fights through monsters and descends", () => {
    const sim = newSim(SEED);
    const events: GameEvent[] = [];
    expect(descendScripted(sim, events)).toBe(true);

    const types = events.map((e) => e.type);
    expect(types).toContain("steps.moved");
    expect(types).toContain("steps.attacked");
    expect(types).toContain("steps.slain");
    expect(events.find((e) => e.type === "steps.descended")).toEqual({
      type: "steps.descended",
      depth: 2,
    });
    expect(floorOfSim(sim).depth).toBe(2);
    expect(isOver(sim)).toBe(false);
    expect(heroHealth(sim).hp).toBeGreaterThan(0);
  });

  it("ends in a pinned state", () => {
    const sim = newSim(SEED);
    descendScripted(sim, []);
    expect(sim.tick).toBe(PINNED.tick);
    expect(sim.hash()).toBe(PINNED.hash);
  });
});

// Pinned from the first green run. Changing module data, versions or sim order changes these on purpose.
const PINNED = { tick: 25, hash: "5bbf56142454fa83" };
