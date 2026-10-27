import type { Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { type FloorState, heroEntity, type Pos, Position } from "../src/components.ts";
import { act, floorOfSim, newSim } from "./fixtures.ts";

/** Asserts that a rejected action changed neither the hash nor the tick. */
function expectRejected(sim: Sim, name: string, payload: unknown, code: string): void {
  const before = sim.hash();
  const tick = sim.tick;
  const res = act(sim, name, payload);
  expect(res.ok).toBe(false);
  expect(res.error?.code).toBe(code);
  expect(res.events).toEqual([]);
  expect(sim.hash()).toBe(before);
  expect(sim.tick).toBe(tick);
}

describe("invalid actions are rejected without changing the state", () => {
  it("walking into a wall is blocked", () => {
    const sim = newSim(4);
    const floor = floorOfSim(sim);
    // Test-only: stand the hero on an open tile with a wall directly to its east.
    const open = findTile(
      floor,
      (x, y) => isOpen(floor, x, y) && floor.walkable[y * floor.width + x + 1] === 0,
    );
    expect(open).not.toBeNull();
    sim.world.update(heroEntity(sim.world), Position, open ?? { x: 0, y: 0 });
    expectRejected(sim, "steps.move", { dx: 1, dy: 0 }, "blocked");
  });

  it("rejects steps out of range, a zero step and malformed payloads", () => {
    const sim = newSim(4);
    expectRejected(sim, "steps.move", { dx: 2, dy: 0 }, "out_of_range");
    expectRejected(sim, "steps.move", { dx: 0, dy: -2 }, "out_of_range");
    expectRejected(sim, "steps.move", { dx: 1.5, dy: 0 }, "out_of_range");
    expectRejected(sim, "steps.move", { dx: "1", dy: 0 }, "out_of_range");
    expectRejected(sim, "steps.move", { dx: 0, dy: 0 }, "no_move");
    expectRejected(sim, "steps.move", null, "bad_payload");
    expectRejected(sim, "steps.move", 5, "bad_payload");
  });

  it("rejects descending off the stairs", () => {
    const sim = newSim(4);
    expectRejected(sim, "steps.descend", {}, "not_on_stairs");
  });

  it("rejects unknown actions", () => {
    const sim = newSim(4);
    expectRejected(sim, "steps.teleport", {}, "unknown_action");
  });

  it("cutting the corner of a wall is rejected", () => {
    const sim = newSim(4);
    const floor = floorOfSim(sim);
    // Open tile whose east neighbour and south-east diagonal are open but whose south neighbour is a wall.
    const corner = findTile(
      floor,
      (x, y) =>
        isOpen(floor, x, y) &&
        isOpen(floor, x + 1, y + 1) &&
        floor.walkable[(y + 1) * floor.width + x] === 0 &&
        isOpen(floor, x + 1, y),
    );
    expect(corner).not.toBeNull();
    sim.world.update(heroEntity(sim.world), Position, corner ?? { x: 0, y: 0 });
    expectRejected(sim, "steps.move", { dx: 1, dy: 1 }, "corner");
  });
});

function isOpen(floor: FloorState, x: number, y: number): boolean {
  return (
    x >= 0 &&
    y >= 0 &&
    x < floor.width &&
    y < floor.height &&
    floor.walkable[y * floor.width + x] === 1
  );
}

function findTile(floor: FloorState, pred: (x: number, y: number) => boolean): Pos | null {
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) if (pred(x, y)) return { x, y };
  }
  return null;
}
