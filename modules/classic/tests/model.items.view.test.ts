/**
 * Model: wave A fields of every ItemView (extendItemView via buildHud): set
 * block and bonus activity, sockets, durability and broken, upgrade lines,
 * stash tab, loot-filter flag and the comparison with the equipped item.
 */
import type { Entity, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { buildHud } from "../src/client/hudModel.ts";
import type { HudSnapshot, ItemView } from "../src/client/contract.ts";
import { RES, type StashState } from "../src/resources.ts";
import {
  GEM_RUBY_1,
  GEM_TOPAZ_1,
  itemOf,
  itemsSim,
  OAK_CAP,
  OAK_STAFF,
  setBag,
  setLootFilter,
  setWorn,
  spawnHero,
} from "./model.items.fixture.ts";

function snapshot(sim: Sim, vendor: Entity = 0): HudSnapshot {
  return buildHud(sim.world, sim.loaded.registry, { tick: 0, hovered: 0, vendor, prev: null });
}

/** The bag item with the uid, as the HUD shows it. */
function bagView(sim: Sim, uid: number): ItemView {
  const hit = snapshot(sim).inventory.items.find((p) => p.item.uid === uid);
  if (!hit) throw new Error(`no bag item ${uid}`);
  return hit.item;
}

describe("set block", () => {
  it("lists the pieces with worn flags and the bonus active only with enough pieces", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", {
        rarity: "set",
        set: OAK_STAFF,
        name: "Oak Staff of Ash",
      }),
    });
    setBag(sim.world, hero, [
      itemOf(2, "test.item.cap", { rarity: "set", set: OAK_CAP, name: "Oak Cap of Ash" }),
    ]);
    const cap = bagView(sim, 2);
    expect(cap.set).toEqual({
      id: "test.set.oak",
      name: "Ash Circle",
      pieces: [
        { name: "Oak Staff of Ash", worn: true },
        { name: "Oak Cap of Ash", worn: false },
      ],
      bonuses: [{ count: 2, lines: ["+5 to Strength"], active: false }],
    });
  });

  it("activates the bonus when both pieces are worn (seen from the bag and from the worn piece)", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", {
        rarity: "set",
        set: OAK_STAFF,
        name: "Oak Staff of Ash",
      }),
      helm: itemOf(3, "test.item.cap", { rarity: "set", set: OAK_CAP, name: "Oak Cap of Ash" }),
    });
    setBag(sim.world, hero, [itemOf(2, "test.item.sword", { rarity: "set", set: OAK_STAFF })]);
    const hud = snapshot(sim);
    expect(hud.equipment.helm?.set?.bonuses[0]?.active).toBe(true);
    expect(hud.equipment.weapon?.set?.pieces.map((p) => p.worn)).toEqual([true, true]);
    expect(bagView(sim, 2).set?.bonuses[0]?.active).toBe(true);
  });

  it("is absent for items that are not set pieces", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setBag(sim.world, hero, [itemOf(2, "test.item.sword")]);
    expect(bagView(sim, 2).set).toBeUndefined();
  });
});

describe("sockets", () => {
  it("gives one entry per socket: the gem with its lines for the host's group, or an empty socket", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", { sockets: [GEM_RUBY_1, null] }),
    });
    const sword = snapshot(sim).equipment.weapon!;
    expect(sword.sockets).toEqual([
      { gem: GEM_RUBY_1, name: "Chipped Ruby", lines: ["+3 Fire Damage"] },
      { gem: null, name: "Empty socket", lines: [] },
    ]);
  });

  it("uses the armour group for armour pieces and the topaz weapon line for weapons", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setBag(sim.world, hero, [
      itemOf(2, "test.item.cap", { sockets: [GEM_RUBY_1] }),
      itemOf(3, "test.item.sword", { sockets: [GEM_TOPAZ_1] }),
    ]);
    expect(bagView(sim, 2).sockets).toEqual([
      { gem: GEM_RUBY_1, name: "Chipped Ruby", lines: ["+10 to Life"] },
    ]);
    expect(bagView(sim, 3).sockets).toEqual([
      { gem: GEM_TOPAZ_1, name: "Chipped Topaz", lines: ["+2 Lightning Damage"] },
    ]);
  });

  it("is absent for items without a sockets field", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setBag(sim.world, hero, [itemOf(2, "test.item.sword")]);
    expect(bagView(sim, 2).sockets).toBeUndefined();
  });
});

describe("durability and broken", () => {
  it("shows full durability for a never-worn item with a default, and none for indestructible ones", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setBag(sim.world, hero, [itemOf(2, "test.item.sword"), itemOf(3, "test.item.ring")]);
    expect(bagView(sim, 2).durability).toEqual({ cur: 60, max: 60 });
    expect(bagView(sim, 3).durability).toBeUndefined();
    expect(bagView(sim, 2).broken).toBeUndefined();
  });

  it("reports the stored durability, and broken when it reached zero", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setBag(sim.world, hero, [
      itemOf(2, "test.item.sword", { dur: { cur: 12, max: 60 } }),
      itemOf(3, "test.item.sword", { dur: { cur: 0, max: 60 } }),
    ]);
    expect(bagView(sim, 2)).toMatchObject({ durability: { cur: 12, max: 60 } });
    expect(bagView(sim, 2).broken).toBeUndefined();
    expect(bagView(sim, 3)).toMatchObject({ durability: { cur: 0, max: 60 }, broken: true });
  });
});

describe("upgrade level", () => {
  it("adds the upgrade level and its stat lines; nothing for level 0", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setBag(sim.world, hero, [
      itemOf(2, "test.item.sword", { upgrade: 2 }),
      itemOf(3, "test.item.sword"),
    ]);
    const up = bagView(sim, 2);
    expect(up.upgradeLevel).toBe(2);
    // weapons: +6 % damage per level
    expect(up.lines).toContain("+12% Damage (upgrade +2)");
    expect(bagView(sim, 3).upgradeLevel).toBeUndefined();
    expect(bagView(sim, 3).lines).toEqual(["2-6 damage"]);
  });
});

describe("stash tab and loot filter flag", () => {
  it("exposes the tab of a stashed item and leaves bag items without one", () => {
    const sim = itemsSim();
    spawnHero(sim.world);
    sim.world.setResource<StashState>(RES.stash, {
      items: [itemOf(4, "test.item.ring", { tab: 3 }), itemOf(5, "test.item.ring")],
    });
    const stash = snapshot(sim).stash;
    expect(stash.map((s) => [s.uid, s.tab])).toEqual([
      [4, 3],
      [5, undefined],
    ]);
  });

  it("marks normal weapons as filtered when the weapon minimum is magic, and keeps sets and magic ones", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
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
    });
    setBag(sim.world, hero, [
      itemOf(2, "test.item.sword", { rarity: "normal" }),
      itemOf(3, "test.item.sword", { rarity: "magic" }),
      itemOf(4, "test.item.sword", { rarity: "set" }),
      itemOf(5, "test.item.ring", { rarity: "normal" }),
    ]);
    expect([2, 3, 4, 5].map((uid) => bagView(sim, uid).filtered)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("comparison with the equipped item counts gems and upgrades", () => {
  it("adds the smith upgrade of the bag item to the stat differences", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setWorn(sim.world, hero, { weapon: itemOf(1, "test.item.sword", { upgrade: 0 }) });
    setBag(sim.world, hero, [itemOf(2, "test.item.sword", { upgrade: 3 })]);
    const cmp = bagView(sim, 2).compare;
    expect(cmp?.slot).toBe("weapon");
    expect(cmp?.equipped?.uid).toBe(1);
    expect(cmp?.stats.map((s) => s.text)).toEqual(["+18% Damage"]);
  });

  it("counts a socketed gem of the bag item in the comparison", () => {
    const sim = itemsSim();
    const hero = spawnHero(sim.world);
    setWorn(sim.world, hero, { weapon: itemOf(1, "test.item.sword") });
    setBag(sim.world, hero, [itemOf(2, "test.item.sword", { sockets: [GEM_RUBY_1] })]);
    expect(bagView(sim, 2).compare?.stats.map((s) => s.text)).toEqual(["+3 Fire Damage"]);
  });
});
