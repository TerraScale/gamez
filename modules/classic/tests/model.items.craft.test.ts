/**
 * Model: smith view (buildCraftView) and gem grouping on the real sim with the
 * item HUD fixture (economy: repair fullPct 100, upgrade chance 90/60/30,
 * sockets addCost 100/200/300, combine 60/120/240/480).
 */
import { describe, expect, it } from "vite-plus/test";
import { buildHud } from "../src/client/hudModel.ts";
import type { CraftView, HudSnapshot } from "../src/client/contract.ts";
import {
  ECON,
  GEM_RUBY_1,
  GEM_RUBY_2,
  GEM_RUBY_5,
  GEM_TOPAZ_1,
  itemOf,
  itemsSim,
  setBag,
  setWorn,
  spawnHero,
  spawnNpc,
  SMITH,
  JUNK,
} from "./model.items.fixture.ts";
import type { Sim } from "@gamez/kernel";
import type { Entity } from "@gamez/kernel";

function snapshot(sim: Sim, vendor: Entity = 0): HudSnapshot {
  return buildHud(sim.world, sim.loaded.registry, { tick: 0, hovered: 0, vendor, prev: null });
}

function craftOf(sim: Sim, vendor: Entity): CraftView {
  const craft = snapshot(sim, vendor).craft;
  if (!craft) throw new Error("expected a craft view");
  return craft;
}

describe("smith view: who is a smith", () => {
  it("is null without a vendor, for a junk buyer, and for a crafting smith it is set", () => {
    const sim = itemsSim();
    spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    const junk = spawnNpc(sim.world, JUNK);
    expect(snapshot(sim, 0).craft).toBeNull();
    expect(snapshot(sim, junk).craft).toBeNull();
    expect(snapshot(sim, smith).craft?.npc).toBe(smith);
  });
});

describe("smith view: prices", () => {
  it("lists bag items first, then equipped items, each with its prices (null when impossible)", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", { value: 30, dur: { cur: 30, max: 60 } }),
    });
    setBag(sim.world, hero, [itemOf(2, "test.item.potion.life", { value: 25 })]);
    const craft = craftOf(sim, smith);
    expect(craft.items.map((r) => [r.where, r.item.uid])).toEqual([
      ["bag", 2],
      ["equipped", 1],
    ]);
    const potion = craft.items[0]!;
    expect(potion).toMatchObject({
      repairCost: null,
      upgradeCost: null,
      upgradeChance: null,
      rerollCost: null,
      socketCost: null,
      canSocket: false,
      unsocketCost: null,
    });
  });

  it("prices a damaged weapon: repair pro rata, upgrade at costPct, chance, socket add cost", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", { value: 30, dur: { cur: 30, max: 60 } }),
    });
    const row = craftOf(sim, smith).items[0]!;
    // value 30 x fullPct 100% x 30 missing / (100 x 60) = 15
    expect(row.repairCost).toBe(15);
    // upgrade L0 -> L1: value x costPct[0] = 30, chance chancePct[0] = 90
    expect(row.upgradeCost).toBe(30);
    expect(row.upgradeChance).toBe(ECON.upgrade.chancePct[0]);
    // a normal item cannot be rerolled
    expect(row.rerollCost).toBeNull();
    // no sockets yet: the first socket costs addCost[0]
    expect(row.socketCost).toBe(ECON.sockets.addCost[0]);
    expect(row.unsocketCost).toBeNull();
  });

  it("has no repair cost for undamaged or indestructible items and a full repair for broken ones", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", { value: 30 }),
      ring1: itemOf(3, "test.item.ring", { value: 50 }),
    });
    setBag(sim.world, hero, [
      itemOf(4, "test.item.sword", { value: 30, dur: { cur: 0, max: 60 } }),
    ]);
    const craft = craftOf(sim, smith);
    const bagSword = craft.items.find((r) => r.item.uid === 4)!;
    const worn = craft.items.find((r) => r.item.uid === 1)!;
    const ring = craft.items.find((r) => r.item.uid === 3)!;
    expect(worn.repairCost).toBeNull();
    expect(ring.repairCost).toBeNull();
    // broken: 30 x 100% x 60 / (100 x 60) = 30
    expect(bagSword.repairCost).toBe(30);
    expect(bagSword.item.broken).toBe(true);
  });

  it("sums repair-all over the bag and the worn items", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", { value: 30, dur: { cur: 30, max: 60 } }),
    });
    setBag(sim.world, hero, [
      itemOf(2, "test.item.cap", { value: 40, dur: { cur: 10, max: 50 } }),
      itemOf(3, "test.item.potion.life", { value: 25 }),
    ]);
    // weapon: 15; cap: 40 x 40 / 50 = 32 (ceil 32); potion 0
    expect(craftOf(sim, smith).repairAllCost).toBe(15 + 32);
  });

  it("upgrades pick the chance of the current level and stop at the max level", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    setWorn(sim.world, hero, { weapon: itemOf(1, "test.item.sword", { value: 30, upgrade: 1 }) });
    setBag(sim.world, hero, [itemOf(2, "test.item.sword", { value: 30, upgrade: 3 })]);
    const craft = craftOf(sim, smith);
    const mid = craft.items.find((r) => r.item.uid === 1)!;
    const top = craft.items.find((r) => r.item.uid === 2)!;
    // L1 -> L2: value x costPct[1] = 30 x 150% = 45, chance chancePct[1] = 60
    expect(mid.upgradeCost).toBe(45);
    expect(mid.upgradeChance).toBe(ECON.upgrade.chancePct[1]);
    expect(top.upgradeCost).toBeNull();
    expect(top.upgradeChance).toBeNull();
  });

  it("socketing: canSocket needs an empty socket and a gem in the bag; removing needs a gem", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", { sockets: [null, GEM_RUBY_1] }),
    });
    setBag(sim.world, hero, [itemOf(5, GEM_RUBY_2)]);
    const withGem = craftOf(sim, smith).items.find((r) => r.item.uid === 1)!;
    expect(withGem.canSocket).toBe(true);
    // two sockets (the 1H weapon's default max is 2): full, so no more sockets
    expect(withGem.socketCost).toBeNull();
    // one gem is socketed: removing costs unsocketCost
    expect(withGem.unsocketCost).toBe(ECON.sockets.unsocketCost);

    setBag(sim.world, hero, []);
    const noGem = craftOf(sim, smith).items.find((r) => r.item.uid === 1)!;
    expect(noGem.canSocket).toBe(false);
    expect(noGem.unsocketCost).toBe(ECON.sockets.unsocketCost);
  });

  it("a worn weapon with an empty socket and a bag gem can socket", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    setWorn(sim.world, hero, { weapon: itemOf(1, "test.item.sword", { sockets: [null] }) });
    setBag(sim.world, hero, [itemOf(5, GEM_TOPAZ_1)]);
    const row = craftOf(sim, smith).items.find((r) => r.item.uid === 1)!;
    expect(row.canSocket).toBe(true);
    // one socket of two: the next costs addCost[1]
    expect(row.socketCost).toBe(ECON.sockets.addCost[1]);
  });
});

describe("smith view: gems", () => {
  it("groups bag gems by base (sorted by base id) with uids, and combine costs", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    setBag(sim.world, hero, [
      itemOf(10, GEM_RUBY_1),
      itemOf(11, GEM_RUBY_1),
      itemOf(12, GEM_RUBY_1),
      itemOf(13, GEM_RUBY_5),
      itemOf(14, GEM_RUBY_2),
    ]);
    const gems = craftOf(sim, smith).gems;
    expect(gems.map((g) => [g.base, g.count, g.uids, g.tier])).toEqual([
      [GEM_RUBY_1, 3, [10, 11, 12], 1],
      [GEM_RUBY_2, 1, [14], 2],
      [GEM_RUBY_5, 1, [13], 5],
    ]);
    // three of tier 1 combine into tier 2 for combineCost[0]
    expect(gems[0]!.combineCost).toBe(ECON.sockets.combineCost[0]);
    // one gem cannot combine; tier 5 never combines
    expect(gems[1]!.combineCost).toBeNull();
    expect(gems[2]!.combineCost).toBeNull();
  });

  it("needs three of a kind: two gems give no combine cost", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    setBag(sim.world, hero, [itemOf(20, GEM_RUBY_1), itemOf(21, GEM_RUBY_1)]);
    const gems = craftOf(sim, smith).gems;
    expect(gems).toHaveLength(1);
    expect(gems[0]!.count).toBe(2);
    expect(gems[0]!.combineCost).toBeNull();
  });

  it("gems are listed as bag items with no service prices (they are not smithed)", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    const smith = spawnNpc(sim.world, SMITH);
    setBag(sim.world, hero, [itemOf(30, GEM_RUBY_1)]);
    const row = craftOf(sim, smith).items[0]!;
    expect(row.item.category).toBe("gem");
    expect(row.repairCost).toBeNull();
    expect(row.upgradeCost).toBeNull();
    expect(row.socketCost).toBeNull();
    expect(row.canSocket).toBe(false);
  });
});
