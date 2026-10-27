import { findPath, isWalkable } from "@gamez/world";
import { describe, expect, it } from "vite-plus/test";
import { townMap } from "../src/index.ts";

describe("townMap", () => {
  const { width, height } = townMap;

  it("has one entry per tile in every layer", () => {
    expect(townMap.ground).toHaveLength(width * height);
    expect(townMap.objects).toHaveLength(width * height);
    expect(townMap.walkable).toHaveLength(width * height);
  });

  it("spawns on a walkable tile", () => {
    expect(isWalkable(townMap, townMap.spawn.x, townMap.spawn.y)).toBe(true);
  });

  it("blocks every tile that holds a prop", () => {
    townMap.objects.forEach((obj, i) => {
      if (obj !== null) expect(townMap.walkable[i], `tile ${i}`).toBe(0);
    });
  });

  it("can reach the far corners from spawn", () => {
    for (const target of [
      { x: 1, y: 1 },
      { x: width - 2, y: height - 2 },
    ]) {
      expect(findPath(townMap, townMap.spawn, target)).not.toBeNull();
    }
  });
});
