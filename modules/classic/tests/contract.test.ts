/** Architect-owned tests of the implemented contract helpers (fixed maths, grid, rules, bus, harness). */
import { createSim, loadMode } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf, pushCommand, takeCommands } from "../src/bus.ts";
import {
  angleOf,
  angleVec,
  facingOf,
  isqrt,
  mix,
  scaleTo,
  SUB,
  tileCenter,
  toTile,
} from "../src/fixed.ts";
import { mode, modules } from "../src/index.ts";
import { gameOf } from "../src/resources.ts";
import {
  hitChance,
  isBossDepth,
  isWaypointDepth,
  levelForXp,
  monsterLevel,
  physReduction,
  rollSkillDamage,
  scaledTicks,
  xpAtLevel,
  xpForKill,
  xpToNext,
} from "../src/rules.ts";
import { gridOf } from "../src/spatial.ts";
import { lineOfSight, openTestMap } from "../src/world/maps.ts";
import { TEST_BALANCE, TEST_SKILLS } from "./support/content.ts";
import {
  baseCombatStats,
  spawnTestHero,
  spawnTestMonster,
  testSim,
  useOpenMap,
} from "./support/harness.ts";

describe("fixed-point maths", () => {
  it("converts tiles and sub units", () => {
    expect(SUB).toBe(256);
    expect(tileCenter(3)).toBe(3 * 256 + 128);
    expect(toTile(tileCenter(7))).toBe(7);
    expect(isqrt(99)).toBe(9);
    expect(scaleTo(300, 400, 100)).toEqual([60, 80]);
  });

  it("maps angles and facings with integer tables", () => {
    expect(angleOf(1, 0)).toBe(0);
    expect(angleOf(0, 1)).toBe(16);
    expect(angleOf(-1, 0)).toBe(32);
    expect(angleVec(16, 100)).toEqual([0, 100]);
    // Tile-space deltas -> iso facings (matches apps/game facingFromDelta).
    expect(facingOf(-1, -1)).toBe("n");
    expect(facingOf(0, -1)).toBe("ne");
    expect(facingOf(1, -1)).toBe("e");
    expect(facingOf(1, 0)).toBe("se");
    expect(facingOf(1, 1)).toBe("s");
    expect(facingOf(0, 1)).toBe("sw");
    expect(facingOf(-1, 1)).toBe("w");
    expect(facingOf(-1, 0)).toBe("nw");
    expect(facingOf(0, 0, "e")).toBe("e");
  });

  it("mixes seeds deterministically", () => {
    expect(mix(1, 2)).toBe(mix(1, 2));
    expect(mix(1, 2)).not.toBe(mix(2, 1));
    expect(mix(5, 0) >>> 0).toBe(mix(5, 0));
  });
});

describe("rules", () => {
  it("has a monotonic XP curve", () => {
    expect(xpToNext(TEST_BALANCE, 1)).toBe(100);
    expect(xpAtLevel(TEST_BALANCE, 3)).toBe(100 + 300);
    expect(levelForXp(TEST_BALANCE, 0)).toBe(1);
    expect(levelForXp(TEST_BALANCE, 399)).toBe(2);
    expect(levelForXp(TEST_BALANCE, 400)).toBe(3);
    expect(xpForKill(TEST_BALANCE, 20, 10, 100)).toBe(25);
    expect(xpForKill(TEST_BALANCE, 5, 10, 100)).toBe(100);
  });

  it("structures depths and scales combat", () => {
    expect([1, 2, 3, 4, 5].map(monsterLevel)).toEqual([1, 2, 4, 5, 7]);
    expect(isBossDepth(4) && !isBossDepth(5)).toBe(true);
    expect(isWaypointDepth(1) && isWaypointDepth(5) && !isWaypointDepth(4)).toBe(true);
    expect(hitChance(100, 1, 100, 1)).toBe(50);
    expect(hitChance(1, 1, 1000, 50)).toBe(5);
    expect(physReduction(0, 1)).toBe(0);
    expect(physReduction(100000, 1)).toBe(75);
    expect(scaledTicks(12, 100)).toBe(12);
    expect(scaledTicks(12, 150)).toBe(8);
  });

  it("averages skill damage without an rng", () => {
    const d = rollSkillDamage(
      TEST_SKILLS["test.skill.bolt"]!,
      1,
      baseCombatStats(),
      { str: 0, dex: 0, mag: 50, vit: 0 },
      null,
    );
    expect(d.fire).toBe(12); // avg(6,10)=8 x 150%
    const m = rollSkillDamage(TEST_SKILLS["test.skill.strike"]!, 1, baseCombatStats(), null, null);
    expect(m.phys).toBe(4);
  });
});

describe("maps and grid", () => {
  it("line of sight stops at walls", () => {
    const map = openTestMap(16, 16);
    expect(lineOfSight(map, tileCenter(2), tileCenter(2), tileCenter(10), tileCenter(10))).toBe(
      true,
    );
    expect(lineOfSight(map, tileCenter(2), tileCenter(2), tileCenter(20), tileCenter(2))).toBe(
      false,
    );
  });

  it("indexes units of the current area and answers sorted range queries", () => {
    const sim = testSim(["classic.core"]);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const near = spawnTestMonster(sim.world, { x: 7, y: 5, depth: 1 });
    spawnTestMonster(sim.world, { x: 25, y: 25, depth: 1 });
    spawnTestMonster(sim.world, { x: 6, y: 5, depth: 0 }); // other area: never indexed
    sim.step(1);
    const grid = gridOf(sim.world);
    expect(grid.size).toBe(3);
    expect(grid.query(tileCenter(5), tileCenter(5), 3 * SUB)).toEqual([hero, near]);
    expect(grid.nearest(tileCenter(5), tileCenter(5), 10 * SUB, (e) => e !== hero)).toBe(near);
  });
});

describe("bus", () => {
  it("routes commands to their owner and drops leftovers at cleanup", () => {
    const sim = testSim(["classic.core"]);
    pushCommand(sim.world, { op: "drink", slot: 0 });
    pushCommand(sim.world, { op: "learn", skill: "x" });
    expect(takeCommands(sim.world, ["drink"])).toEqual([{ op: "drink", slot: 0 }]);
    expect(busOf(sim.world).commands).toHaveLength(1);
    // Leftovers are carried one tick (a later owner may still drain them), then dropped.
    expect(sim.step(1).some((e) => e.type === "classic.command.failed")).toBe(false);
    expect(busOf(sim.world).commands).toHaveLength(1);
    const events = sim.step(1);
    expect(events.some((e) => e.type === "classic.command.failed")).toBe(true);
    expect(busOf(sim.world).commands).toHaveLength(0);
  });
});

describe("mode", () => {
  it("loads every classic module and steps deterministically", () => {
    const loaded = loadMode(mode, modules);
    expect(loaded.mode.tick).toEqual({ kind: "fixed", hz: 20 });
    const a = createSim(loaded, { seed: 7 });
    const b = createSim(loaded, { seed: 7 });
    a.step(20);
    b.step(20);
    expect(a.hash()).toBe(b.hash());
    expect(gameOf(a.world).phase).toBe("choose");
  });
});
