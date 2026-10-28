/**
 * QA cheats (docs/design/wave-A.md §11.1): classic.debug.grant exists only in the
 * cheat variant of the mode, its payload is validated strictly and the grants
 * reach the owners (levels and gold through the next step, the rest at once).
 */
import { createSim, loadMode, ActionError, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { Inventory, Level, Talents, Wallet } from "../src/components.ts";
import { DEBUG_GRANT, parseGrant } from "../src/debug/index.ts";
import { mode, modules, debugModules } from "../src/index.ts";
import { heroOf, riftOf, RES, type DungeonState } from "../src/resources.ts";

/** The cheat variant, loaded the way client/index.ts loads it for ?debug=1&cheats=1. */
function cheatModeLoaded() {
  return loadMode({ ...mode }, [...modules, ...debugModules]);
}

function cheatSim(seed = 4242): Sim {
  return createSim(cheatModeLoaded(), { seed });
}

function heroSim(): Sim {
  const sim = cheatSim();
  const r = sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Tester" }, "local");
  if (!r.ok) throw new Error(`newHero failed: ${r.error?.message}`);
  sim.step(1);
  return sim;
}

describe("cheat gating", () => {
  it("is not in the playable mode", () => {
    const loaded = loadMode(mode, modules);
    expect(loaded.actions.has(DEBUG_GRANT)).toBe(false);
  });

  it("is in the cheat variant, whose content hash differs from the real mode", () => {
    const real = loadMode(mode, modules);
    const cheats = cheatModeLoaded();
    expect(cheats.actions.has(DEBUG_GRANT)).toBe(true);
    expect(cheats.contentHash).not.toBe(real.contentHash);
    expect(debugModules.map((m) => m.id)).toEqual(["classic.debug"]);
  });
});

describe("parseGrant", () => {
  it("accepts every field and keeps the values", () => {
    expect(
      parseGrant({
        gold: 10,
        levels: 2,
        items: { count: 3, rarity: "rare", ilvl: 5, category: "weapon" },
        gems: 2,
        unlockRift: true,
        bossesKilled: [4, 16],
        deepest: 9,
        talentPoints: 3,
      }),
    ).toEqual({
      gold: 10,
      levels: 2,
      items: { count: 3, rarity: "rare", ilvl: 5, category: "weapon" },
      gems: 2,
      unlockRift: true,
      bossesKilled: [4, 16],
      deepest: 9,
      talentPoints: 3,
    });
  });

  it("rejects bad payloads with bad_payload and never grants a partial one", () => {
    const bad: unknown[] = [
      null,
      [],
      {},
      { mystery: 1 },
      { gold: 0 },
      { gold: 1.5 },
      { levels: 201 },
      { gems: 0 },
      { talentPoints: 0 },
      { deepest: -1 },
      { unlockRift: "yes" },
      { bossesKilled: "4" },
      { bossesKilled: [0] },
      { items: { count: 0, rarity: "rare", ilvl: 1 } },
      { items: { count: 1, rarity: "mythic", ilvl: 1 } },
      { items: { count: 1, rarity: "rare", ilvl: 1, category: "nope" } },
      { items: { count: 1, rarity: "rare", ilvl: 1, extra: 1 } },
    ];
    for (const payload of bad) {
      let code = "";
      try {
        parseGrant(payload);
      } catch (err) {
        code = err instanceof ActionError ? err.code : "other";
      }
      expect(code, JSON.stringify(payload)).toBe("bad_payload");
    }
  });
});

describe("classic.debug.grant on a sim", () => {
  it("refuses before a hero exists", () => {
    const sim = cheatSim();
    const r = sim.dispatch(DEBUG_GRANT, { gold: 10 }, "local");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("no_hero");
  });

  it("leaves the sim unchanged when the payload is rejected", () => {
    const sim = heroSim();
    const before = sim.hash();
    const r = sim.dispatch(DEBUG_GRANT, { gold: 0 }, "local");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("bad_payload");
    expect(sim.hash()).toBe(before);
  });

  it("adds talent points at once", () => {
    const sim = heroSim();
    const hero = heroOf(sim.world);
    const before = sim.world.get(hero, Talents)?.points ?? 0;
    const r = sim.dispatch(DEBUG_GRANT, { talentPoints: 3 }, "local");
    expect(r.ok).toBe(true);
    expect(sim.world.get(hero, Talents)?.points).toBe(before + 3);
  });

  it("grants gold on the next step", () => {
    const sim = heroSim();
    const hero = heroOf(sim.world);
    const before = sim.world.read(hero, Wallet).gold;
    expect(sim.dispatch(DEBUG_GRANT, { gold: 500 }, "local").ok).toBe(true);
    sim.step(2);
    expect(sim.world.read(hero, Wallet).gold).toBeGreaterThanOrEqual(before + 500);
  });

  it("grants levels through the XP the levels need", () => {
    const sim = heroSim();
    const hero = heroOf(sim.world);
    expect(sim.dispatch(DEBUG_GRANT, { levels: 2 }, "local").ok).toBe(true);
    sim.step(3);
    expect(sim.world.read(hero, Level).level).toBeGreaterThanOrEqual(3);
  });

  it("grants bag items on the next step", () => {
    const sim = heroSim();
    const hero = heroOf(sim.world);
    const before = sim.world.read(hero, Inventory).items.length;
    expect(
      sim.dispatch(DEBUG_GRANT, { items: { count: 2, rarity: "rare", ilvl: 10 } }, "local").ok,
    ).toBe(true);
    sim.step(3);
    expect(sim.world.read(hero, Inventory).items.length).toBeGreaterThanOrEqual(before + 1);
  });

  it("unlocks the rift: the boss depth counts as killed and the depth is reached", () => {
    const sim = heroSim();
    expect(sim.dispatch(DEBUG_GRANT, { unlockRift: true }, "local").ok).toBe(true);
    const dungeon = sim.world.getResource<DungeonState>(RES.dungeon);
    expect(dungeon?.bossesKilled).toContain(16);
    expect(dungeon?.deepest ?? 0).toBeGreaterThanOrEqual(16);
    expect(riftOf(sim.world)?.unlocked).toBe(true);
  });

  it("records killed bosses and the deepest depth, without lowering the deepest", () => {
    const sim = heroSim();
    expect(sim.dispatch(DEBUG_GRANT, { bossesKilled: [4, 8, 4], deepest: 7 }, "local").ok).toBe(
      true,
    );
    const dungeon = sim.world.getResource<DungeonState>(RES.dungeon);
    expect(dungeon?.bossesKilled).toEqual([4, 8]);
    expect(dungeon?.deepest).toBeGreaterThanOrEqual(7);
    const before = dungeon?.deepest ?? 0;
    expect(sim.dispatch(DEBUG_GRANT, { deepest: 1 }, "local").ok).toBe(true);
    expect(dungeon?.deepest).toBe(before);
  });
});
