/**
 * Model: gambler offers (buildGambleView), loot filter preview (buildLootFilterView)
 * and stash tabs (buildStashTabs) on the item HUD fixture.
 */
import type { Entity, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { buildHud } from "../src/client/hudModel.ts";
import type { HudSnapshot } from "../src/client/contract.ts";
import { RES, type StashState } from "../src/resources.ts";
import { gamblePrice } from "../src/rules.ts";
import { KIND, ECONOMY_ID, type EconomyProto } from "../src/types.ts";
import { TEST_BALANCE } from "./support/content.ts";
import {
  GAMBLER,
  GEM_RUBY_1,
  itemOf,
  itemsSim,
  JUNK,
  setLootFilter,
  spawnHero,
  spawnLoot,
  spawnNpc,
  SMITH,
  setBag,
} from "./model.items.fixture.ts";

function snapshot(sim: Sim, vendor: Entity = 0): HudSnapshot {
  return buildHud(sim.world, sim.loaded.registry, { tick: 0, hovered: 0, vendor, prev: null });
}

describe("gambler view", () => {
  it("is null for non-gamblers and lists the offered categories for the gambler", () => {
    const sim = itemsSim();
    spawnHero(sim.world, { gold: 1000, level: 10 });
    const gambler = spawnNpc(sim.world, GAMBLER);
    expect(snapshot(sim, 0).gamble).toBeNull();
    expect(snapshot(sim, spawnNpc(sim.world, SMITH, 7, 5)).gamble).toBeNull();
    expect(snapshot(sim, spawnNpc(sim.world, JUNK, 8, 5)).gamble).toBeNull();
    const view = snapshot(sim, gambler).gamble;
    expect(view?.npc).toBe(gambler);
    expect(view?.name).toBe("Mirelle Quickhand");
    expect(view?.offers.map((o) => o.category)).toEqual(["weapon", "ring"]);
  });

  it("prices each offer with gamblePrice at the hero level and marks affordability", () => {
    const sim = itemsSim();
    spawnHero(sim.world, { gold: 300, level: 10 });
    const gambler = spawnNpc(sim.world, GAMBLER);
    const econ = sim.loaded.registry.get<EconomyProto>(KIND.economy, ECONOMY_ID)!;
    const weapon = gamblePrice(econ, "weapon", 10);
    const ring = gamblePrice(econ, "ring", 10);
    const offers = snapshot(sim, gambler).gamble!.offers;
    expect(offers).toEqual([
      { category: "weapon", label: "Random weapon", price: weapon, affordable: weapon! <= 300 },
      { category: "ring", label: "Random ring", price: ring, affordable: ring! <= 300 },
    ]);
    // base 200 at +10% per level, level 10: 200 x 200% = 400; ring 100 x 200% = 200
    expect(weapon).toBe(400);
    expect(ring).toBe(200);
    expect(offers.map((o) => o.affordable)).toEqual([false, true]);
  });
});

describe("loot filter view", () => {
  it("returns the default filter and no hidden ground items without loot", () => {
    const sim = itemsSim();
    spawnHero(sim.world);
    const view = snapshot(sim).lootFilter;
    expect(view?.hiddenOnGround).toBe(0);
    expect(view?.filter.showGold).toBe(true);
    expect(view?.filter.minRarity.weapon).toBe("normal");
  });

  it("counts only ground loot of this area that the filter hides", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setBag(sim.world, hero, []);
    setLootFilter(sim.world, {
      minRarity: {
        weapon: "magic",
        shield: "normal",
        helm: "normal",
        armor: "normal",
        gloves: "normal",
        boots: "normal",
        ring: "normal",
        amulet: "normal",
        potion: "normal",
        gem: "normal",
      },
      minGold: 50,
      showPotions: false,
    });
    spawnLoot(sim.world, itemOf(1, "test.item.sword", { rarity: "normal" })); // hidden: below magic
    spawnLoot(sim.world, itemOf(2, "test.item.sword", { rarity: "magic" })); // shown
    spawnLoot(sim.world, itemOf(3, "test.item.sword", { rarity: "unique" })); // shown: uniques always
    spawnLoot(sim.world, itemOf(4, "test.item.sword", { rarity: "set" })); // shown: sets always
    spawnLoot(sim.world, null, "gold", 10); // hidden: below minGold 50
    spawnLoot(sim.world, null, "gold", 100); // shown
    spawnLoot(sim.world, null, "potion"); // hidden: potions off
    spawnLoot(sim.world, itemOf(5, GEM_RUBY_1), "item"); // shown: gems at normal
    spawnLoot(sim.world, itemOf(6, "test.item.sword", { rarity: "normal" }), "item", 0, 3); // another area: not counted
    const view = snapshot(sim).lootFilter!;
    expect(view.hiddenOnGround).toBe(3);
    expect(view.filter.minGold).toBe(50);
    expect(view.filter.showPotions).toBe(false);
  });
});

describe("stash tabs", () => {
  it("has the balance's tabs, names (or Tab n) and counts per tab", () => {
    const sim = itemsSim();
    spawnHero(sim.world);
    sim.world.setResource<StashState>(RES.stash, {
      items: [
        itemOf(1, "test.item.sword", { tab: 0 }),
        itemOf(2, "test.item.cap"),
        itemOf(3, "test.item.ring", { tab: 2 }),
      ],
      tabNames: ["Gear"],
    });
    const tabs = snapshot(sim).stashTabs!;
    expect(tabs).toEqual([
      { index: 0, name: "Gear", count: 2, size: TEST_BALANCE.stashSize },
      { index: 1, name: "Tab 2", count: 0, size: TEST_BALANCE.stashSize },
      { index: 2, name: "Tab 3", count: 1, size: TEST_BALANCE.stashSize },
      { index: 3, name: "Tab 4", count: 0, size: TEST_BALANCE.stashSize },
    ]);
    expect(tabs).toHaveLength(4);
  });
});
