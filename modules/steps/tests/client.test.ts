import { createSim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Health, heroEntity, Position } from "../src/components.ts";
import {
  describeEvent,
  facingFor,
  intentForKey,
  onStairs,
  readBoard,
  renderEntities,
} from "../src/client/scene.ts";
import { loaded } from "./fixtures.ts";

describe("client read model", () => {
  it("maps keys to intents, WASD and arrows orthogonal, QEZC diagonal", () => {
    expect(intentForKey("ArrowUp")).toEqual({ kind: "move", dx: 0, dy: -1 });
    expect(intentForKey("d")).toEqual({ kind: "move", dx: 1, dy: 0 });
    expect(intentForKey("q")).toEqual({ kind: "move", dx: -1, dy: -1 });
    expect(intentForKey("E")).toEqual({ kind: "move", dx: 1, dy: -1 });
    expect(intentForKey("z")).toEqual({ kind: "move", dx: -1, dy: 1 });
    expect(intentForKey("c")).toEqual({ kind: "move", dx: 1, dy: 1 });
    expect(intentForKey(".")).toEqual({ kind: "wait" });
    expect(intentForKey(">")).toEqual({ kind: "descend" });
    expect(intentForKey("constructor")).toBeNull();
    expect(intentForKey("x")).toBeNull();
  });

  it("maps steps to the eight iso facings", () => {
    expect(facingFor(0, -1)).toBe("n");
    expect(facingFor(-3, 2)).toBe("sw");
    expect(facingFor(1, 1)).toBe("se");
    expect(facingFor(0, 0)).toBeNull();
  });

  it("builds a board with the hero first-class and monsters named from the registry", () => {
    const sim = createSim(loaded, { seed: 1 });
    const board = readBoard(sim.world, loaded.registry);
    expect(board).not.toBeNull();
    expect(board?.hero?.name).toBe("Wanderer");
    expect(board?.hero?.hp).toBe(12);
    expect(board?.units.filter((u) => !u.hero).every((u) => u.name.length > 0)).toBe(true);
    expect(onStairs(board!)).toBe(false);

    const drawn = renderEntities(board!, "e");
    const hero = drawn.find((d) => d.isSelf);
    expect(hero?.appearance).toBe("unit.hero");
    expect(hero?.facing).toBe("e");
    expect(
      drawn.filter((d) => !d.isSelf).every((d) => d.appearance.startsWith("unit.monster.")),
    ).toBe(true);
  });

  it("returns null for a world with no floor yet", () => {
    const sim = createSim(loaded, { seed: 1 });
    sim.world.deleteResource("steps.floor");
    expect(readBoard(sim.world, loaded.registry)).toBeNull();
  });

  it("describes combat events and skips quiet ones", () => {
    expect(
      describeEvent(
        {
          type: "steps.attacked",
          attacker: 1,
          target: 2,
          by: "steps.hero",
          victim: "steps.gloomcap",
          heroHit: false,
          dmg: 3,
          hp: 1,
        },
        loaded.registry,
      ),
    ).toBe("you hits Gloomcap for 3 (1 left)");
    expect(
      describeEvent(
        {
          type: "steps.attacked",
          attacker: 2,
          target: 1,
          by: "steps.cinderpup",
          victim: "steps.hero",
          heroHit: true,
          dmg: 2,
          hp: 10,
        },
        loaded.registry,
      ),
    ).toBe("Cinderpup hits you for 2 (10 left)");
    expect(describeEvent({ type: "steps.moved", x: 1, y: 1 }, loaded.registry)).toBeNull();
  });

  it("reads hero health through the same components the sim uses", () => {
    const sim = createSim(loaded, { seed: 1 });
    expect(sim.world.read(heroEntity(sim.world), Health).hp).toBe(12);
    expect(sim.world.has(heroEntity(sim.world), Position)).toBe(true);
  });
});
