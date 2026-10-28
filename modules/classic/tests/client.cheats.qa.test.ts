/**
 * QA routes added after the wave A browser QA (tools/qa classic-boss and
 * classic-features): `set` grants every piece of a set (the 2-piece bonus was
 * unreachable through rarity grants), `riftProgress` fills the open run so the
 * guardian path can be checked end to end, and `spawnBoss` puts a boss next
 * to the hero so its telegraphs and phases can be watched live.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { AreaTag, Dead, Interactable, Inventory, Monster, Pos } from "../src/components.ts";
import { DEBUG_GRANT, parseGrant } from "../src/debug/index.ts";
import { mode, modules, debugModules } from "../src/index.ts";
import { currentDepth, heroOf, riftOf } from "../src/resources.ts";
import { isRiftDepth } from "../src/rules.ts";
import type { Entity } from "@gamez/kernel";

function heroSim(seed = 4242): Sim {
  const sim = createSim(loadMode({ ...mode }, [...modules, ...debugModules]), { seed });
  const r = sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Tester" }, "local");
  if (!r.ok) throw new Error(`newHero failed: ${r.error?.message}`);
  sim.step(1);
  sim.dispatch(ACTION.setControl, { mode: "manual" }, "local");
  return sim;
}

function grant(sim: Sim, payload: Record<string, unknown>) {
  return sim.dispatch(DEBUG_GRANT, payload, "local");
}

function obeliskOf(sim: Sim): Entity {
  for (const e of sim.world.query(Interactable, AreaTag)) {
    if (sim.world.read(e, Interactable).kind === "riftObelisk") return e;
  }
  return 0;
}

/** Unlocks the rift, stands the hero on the obelisk and opens level 1. Returns the rift depth. */
function enterRift(sim: Sim): number {
  expect(grant(sim, { unlockRift: true, gold: 5000 }).ok).toBe(true);
  sim.step(2);
  const hero = heroOf(sim.world);
  const obelisk = obeliskOf(sim);
  expect(obelisk).toBeGreaterThan(0);
  const p = sim.world.read(obelisk, Pos);
  sim.world.update(hero, Pos, { x: p.x, y: p.y });
  const r = sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, "local");
  expect(r.ok).toBe(true);
  sim.step(1);
  const depth = currentDepth(sim.world);
  expect(isRiftDepth(depth)).toBe(true);
  return depth;
}

function bossesAt(sim: Sim, depth: number): Entity[] {
  return sim.world
    .query(Monster, AreaTag)
    .filter(
      (e) =>
        sim.world.read(e, AreaTag).depth === depth &&
        sim.world.read(e, Monster).rarity === "boss" &&
        !sim.world.has(e, Dead),
    );
}

describe("parseGrant (QA routes)", () => {
  it("accepts set, riftProgress and spawnBoss", () => {
    expect(
      parseGrant({
        set: "classic.set.ashen_choir",
        riftProgress: 100,
        spawnBoss: "classic.monster.boss_warden",
        woundBosses: 50,
      }),
    ).toEqual({
      woundBosses: 50,
      set: "classic.set.ashen_choir",
      riftProgress: 100,
      spawnBoss: "classic.monster.boss_warden",
    });
  });

  it("rejects malformed ids and out-of-range progress", () => {
    for (const bad of [
      { set: "" },
      { set: 3 },
      { set: "../etc" },
      { spawnBoss: "boss_warden" },
      { riftProgress: 0 },
      { riftProgress: 101 },
      { riftProgress: 1.5 },
      { woundBosses: 100 },
      { woundBosses: 0 },
    ]) {
      expect(() => parseGrant(bad)).toThrow();
    }
  });
});

describe("set grant", () => {
  it("puts every piece of the set in the bag, and two pieces worn activate the bonus", () => {
    const sim = heroSim();
    const hero = heroOf(sim.world);
    expect(grant(sim, { levels: 30 }).ok).toBe(true);
    sim.step(3);
    expect(grant(sim, { set: "classic.set.ashen_choir" }).ok).toBe(true);
    sim.step(3);
    const pieces = sim.world
      .read(hero, Inventory)
      .items.map((p) => p.item)
      .filter((i) => i.rarity === "set");
    expect(pieces.length).toBe(4);
    expect(new Set(pieces.map((i) => i.set)).size).toBe(4);

    const events: GameEvent[] = [];
    for (const item of pieces.slice(0, 2)) {
      const r = sim.dispatch(ACTION.equip, { uid: item.uid, slot: null }, "local");
      expect(r.ok).toBe(true);
      events.push(...(r.events ?? []));
      events.push(...sim.step(1));
    }
    const bonus = events.filter((e) => e.type === "classic.set.bonus");
    expect(bonus.length).toBeGreaterThan(0);
    expect(bonus.at(-1)).toMatchObject({ set: "classic.set.ashen_choir", pieces: 2, active: 1 });
  });

  it("refuses an unknown set and changes nothing", () => {
    const sim = heroSim();
    const before = sim.hash();
    const r = grant(sim, { set: "classic.set.nope" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("unknown_id");
    expect(sim.hash()).toBe(before);
  });
});

describe("rift progress grant", () => {
  it("is refused without an open run", () => {
    const sim = heroSim();
    const before = sim.hash();
    const r = grant(sim, { riftProgress: 100 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("not_in_rift");
    expect(sim.hash()).toBe(before);
  });

  it("fills the bar and calls the guardian", () => {
    const sim = heroSim();
    const depth = enterRift(sim);
    expect(bossesAt(sim, depth)).toEqual([]);
    expect(grant(sim, { riftProgress: 100 }).ok).toBe(true);
    sim.step(3);
    const run = riftOf(sim.world)?.active;
    expect(run?.guardianSpawned).toBe(true);
    expect(run?.guardian).toBeGreaterThan(0);
    expect(bossesAt(sim, depth).length).toBe(1);
  });
});

describe("boss spawn grant", () => {
  it("woundBosses is refused without a living boss in the area", () => {
    const sim = heroSim();
    const before = sim.hash();
    const r = grant(sim, { woundBosses: 50 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("bad_target");
    expect(sim.hash()).toBe(before);
  });

  it("is refused in town, and for a monster that is not a boss", () => {
    const sim = heroSim();
    const before = sim.hash();
    const town = grant(sim, { spawnBoss: "classic.monster.boss_warden" });
    expect(town.ok).toBe(false);
    expect(town.error?.code).toBe("in_town");
    const notBoss = grant(sim, { spawnBoss: "classic.monster.husk" });
    expect(notBoss.ok).toBe(false);
    expect(notBoss.error?.code).toBe("unknown_id");
    expect(sim.hash()).toBe(before);
  });

  it("spawns the boss awake beside the hero, and it telegraphs and changes phase", () => {
    const sim = heroSim();
    const depth = enterRift(sim);
    // Clear the level's own monsters so only the boss fights the hero.
    for (const e of sim.world.query(Monster, AreaTag)) {
      if (sim.world.read(e, AreaTag).depth === depth) sim.world.destroy(e);
    }
    expect(grant(sim, { levels: 40, spawnBoss: "classic.monster.boss_warden" }).ok).toBe(true);
    sim.step(2);
    const [boss] = bossesAt(sim, depth);
    expect(boss).toBeDefined();
    const hp = sim.world.read(heroOf(sim.world), Pos);
    const bp = sim.world.read(boss!, Pos);
    const tiles = Math.max(
      Math.abs((hp.x >> 8) - (bp.x >> 8)),
      Math.abs((hp.y >> 8) - (bp.y >> 8)),
    );
    expect(tiles).toBeGreaterThanOrEqual(3);
    expect(tiles).toBeLessThanOrEqual(6);
    expect(sim.world.read(boss!, Monster).name).toContain("Morrow");

    // The boss engages on its own and telegraphs (the hero stays manual and idle).
    const seen = new Set<string>();
    for (let i = 0; i < 60 && !seen.has("classic.telegraph"); i++) {
      for (const e of sim.step(10)) seen.add(e.type);
    }
    expect(seen.has("classic.telegraph")).toBe(true);
    expect(seen.has("classic.boss.phase")).toBe(false);

    // woundBosses drops it below its first phase threshold (70 %): the phase starts at once.
    expect(grant(sim, { woundBosses: 60 }).ok).toBe(true);
    const phase = sim.step(5).filter((e) => e.type === "classic.boss.phase");
    expect(phase.length).toBe(1);
    expect(phase[0]).toMatchObject({ phase: 1 });
  });
});
