import { describe, expect, it } from "vite-plus/test";
import { Health, heroEntity, Position } from "../src/components.ts";
import { act, floorOfSim, isOver, monsters, newSim } from "./fixtures.ts";

/**
 * Puts the hero on a free tile next to a monster with one hit point left, so
 * the next wait is fatal. Test-only state editing through the kernel's World.
 */
function setUpFatalMeeting(seed: number) {
  const sim = newSim(seed);
  const floor = floorOfSim(sim);
  const hero = heroEntity(sim.world);
  const target = monsters(sim)[0];
  if (!target) throw new Error("no monster to meet");
  const spot = [-1, 0, 1]
    .flatMap((dy) => [-1, 0, 1].map((dx) => ({ x: target.pos.x + dx, y: target.pos.y + dy })))
    .find(
      (p) =>
        (p.x !== target.pos.x || p.y !== target.pos.y) &&
        p.x >= 0 &&
        p.y >= 0 &&
        p.x < floor.width &&
        p.y < floor.height &&
        floor.walkable[p.y * floor.width + p.x] === 1 &&
        !monsters(sim).some((m) => m.pos.x === p.x && m.pos.y === p.y),
    );
  if (!spot) throw new Error("no free tile next to the monster");
  sim.world.update(hero, Position, { x: spot.x, y: spot.y });
  sim.world.update(hero, Health, { hp: 1 });
  return sim;
}

describe("death ends the run", () => {
  it("the hero dies, the run is over and every later action is rejected", () => {
    const sim = setUpFatalMeeting(2);
    const res = act(sim, "steps.wait");
    expect(res.ok).toBe(true);
    expect(res.events.map((e) => e.type)).toContain("steps.hero_died");
    expect(isOver(sim)).toBe(true);
    expect(sim.world.read(heroEntity(sim.world), Health).hp).toBe(0);

    const before = sim.hash();
    for (const [name, payload] of [
      ["steps.move", { dx: 1, dy: 0 }],
      ["steps.wait", {}],
      ["steps.descend", {}],
    ] as const) {
      const rejected = act(sim, name, payload);
      expect(rejected.ok).toBe(false);
      expect(rejected.error?.code).toBe("run_over");
    }
    expect(sim.hash()).toBe(before);
  });

  it("an adjacent monster strikes the hero on the same turn the hero waits", () => {
    const sim = setUpFatalMeeting(2);
    const res = act(sim, "steps.wait");
    const hit = res.events.find((e) => e.type === "steps.attacked");
    expect(hit).toMatchObject({ type: "steps.attacked", heroHit: true, hp: 0 });
  });
});
