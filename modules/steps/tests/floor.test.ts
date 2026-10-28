import { findPath, isWalkable } from "@gamez/world";
import { describe, expect, it } from "vite-plus/test";
import { chebyshev, floorOf, PROP_STAIRS, PROP_TREE } from "../src/components.ts";
import { createSim } from "@gamez/kernel";
import { descendScripted, floorOfSim, loaded, monsters, newSim } from "./fixtures.ts";

describe("floor generation", () => {
  it("builds a 24x24 floor whose layers match the TileMap shape", () => {
    const floor = floorOfSim(newSim(3));
    expect(floor.width).toBe(24);
    expect(floor.height).toBe(24);
    expect(floor.ground).toHaveLength(24 * 24);
    expect(floor.objects).toHaveLength(24 * 24);
    expect(floor.walkable).toHaveLength(24 * 24);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "seed %i: stairs reachable from spawn, walls blocked",
    (seed) => {
      const sim = newSim(seed);
      const floor = floorOfSim(sim);
      expect(isWalkable(floor, floor.spawn.x, floor.spawn.y)).toBe(true);
      expect(isWalkable(floor, floor.stairs.x, floor.stairs.y)).toBe(true);
      expect(floor.objects[floor.stairs.y * floor.width + floor.stairs.x]).toBe(PROP_STAIRS);
      expect(findPath(floor, floor.spawn, floor.stairs)).not.toBeNull();
      floor.objects.forEach((obj, i) => {
        if (obj === PROP_TREE) expect(floor.walkable[i]).toBe(0);
      });
    },
  );

  it("spawns monsters on open tiles away from the spawn and off the stairs", () => {
    for (const seed of [1, 2, 3]) {
      const sim = newSim(seed);
      const floor = floorOfSim(sim);
      const mobs = monsters(sim);
      expect(mobs.length).toBeGreaterThanOrEqual(4);
      for (const m of mobs) {
        expect(isWalkable(floor, m.pos.x, m.pos.y)).toBe(true);
        expect(chebyshev(m.pos, floor.spawn)).toBeGreaterThanOrEqual(4);
        expect(m.pos).not.toEqual(floor.stairs);
      }
    }
  });

  it("regenerates a reachable floor with more monsters on descend", () => {
    const sim = createSim(loaded, { seed: 11 });
    const events: { type: string }[] = [];
    expect(descendScripted(sim, events)).toBe(true);
    const deeper = floorOf(sim.world);
    expect(deeper.depth).toBe(2);
    expect(findPath(deeper, deeper.spawn, deeper.stairs)).not.toBeNull();
    expect(monsters(sim).length).toBeGreaterThanOrEqual(5);
  });
});
