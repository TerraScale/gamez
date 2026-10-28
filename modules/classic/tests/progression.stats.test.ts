/**
 * classic.progression stats: computeHeroStats formulas (docs/design/classic.md
 * §6.2) on a registry with a shield and a status buff, plus the stats system
 * on a spawned hero.
 */
import { defineMode, defineModule, loadMode, type FrozenRegistry } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { computeHeroStats, type HeroStatsInput } from "../src/progression/index.ts";
import { Life } from "../src/components.ts";
import { KIND, type ItemBaseProto, type ItemInstance } from "../src/types.ts";
import { testContent, TEST_BALANCE } from "./support/content.ts";
import { spawnTestHero, testSim } from "./support/harness.ts";

/** Extra bases for the formulas the shared test content does not cover. */
const extra = defineModule({
  id: "test.progression.extra",
  version: "0.0.1",
  deps: ["test.content"],
  data(reg) {
    const base = (
      p: Partial<ItemBaseProto> & Pick<ItemBaseProto, "name" | "category">,
    ): ItemBaseProto => ({
      slots: [],
      size: { w: 1, h: 1 },
      icon: "icon.item.test",
      ilvl: 1,
      reqLevel: 1,
      reqStr: 0,
      reqDex: 0,
      implicit: [],
      value: 10,
      dropWeight: 10,
      ...p,
    });
    reg.define(
      KIND.itemBase,
      "test.item.buckler",
      base({
        name: "Buckler",
        category: "shield",
        slots: ["offhand"],
        block: 15,
      }),
    );
    reg.define(
      KIND.itemBase,
      "test.item.leather",
      base({
        name: "Leather",
        category: "armor",
        slots: ["armor"],
        armor: 10,
      }),
    );
  },
});

let cached: FrozenRegistry | undefined;
/** Frozen registry: the test content plus the extra bases. */
function registry(): FrozenRegistry {
  if (!cached) {
    const m = defineMode({
      id: "classic",
      name: "stats",
      description: "stats",
      world: null,
      modules: ["test.content", "test.progression.extra"],
      tick: { kind: "fixed", hz: 20 },
    });
    cached = loadMode(m, [testContent, extra]).registry;
  }
  return cached;
}

const ATTRS20 = { str: 20, dex: 20, mag: 20, vit: 20 };

function item(
  base: string,
  mods: { stat: ItemInstance["mods"][number]["stat"]; value: number }[] = [],
): ItemInstance {
  return { uid: 1, base, rarity: "normal", ilvl: 1, name: base, mods, affixes: [], value: 10 };
}

function input(over: Partial<HeroStatsInput> = {}): HeroStatsInput {
  return {
    classId: "test.class.fighter",
    level: 1,
    base: ATTRS20,
    equipment: null,
    buffs: [],
    ...over,
  };
}

describe("computeHeroStats", () => {
  it("uses the class base with no items", () => {
    const { combat, sheet } = computeHeroStats(registry(), input());
    expect(sheet.attrs).toEqual(ATTRS20);
    expect(sheet.lifeMax).toBe(80); // 40 + 20*2
    expect(sheet.manaMax).toBe(30); // 10 + 20*1
    expect(combat.armor).toBe(5); // floor(20/4)
    expect(combat.toHit).toBe(110); // 20*5 + 1*10
    expect(combat.dmgMin).toBe(1); // fists 1..3 at 120%
    expect(combat.dmgMax).toBe(3);
    expect(combat.critPct).toBe(7); // 5 + floor(20/10)
    expect(combat.critMult).toBe(150);
    expect(combat.attackSpeed).toBe(100);
    expect(combat.attackTicks).toBe(12);
    expect(combat.attackRange).toBe(400);
    expect(combat.attackProjectile).toBe("");
    expect(combat.attackElement).toBe("phys");
    expect(sheet.lifeRegen).toBe(9); // 5 + floor(20/5)
    expect(sheet.manaRegen).toBe(7); // floor(30*10/40)
    expect(sheet.lightRadius).toBe(TEST_BALANCE.lightRadius);
    expect(sheet.primary).toBe("str");
    expect(sheet.twoHanded).toBe(false);
  });

  it("scales life with vit and mana with mag, including per-level growth", () => {
    const { sheet } = computeHeroStats(
      registry(),
      input({ level: 5, base: { str: 20, dex: 20, mag: 30, vit: 30 } }),
    );
    expect(sheet.lifeMax).toBe(40 + 30 * 2 + 4 * 2); // 108
    expect(sheet.manaMax).toBe(10 + 30 * 1 + 4 * 1); // 44
  });

  it("takes weapon damage from the base and scales it by the primary attribute", () => {
    const sword = computeHeroStats(
      registry(),
      input({ equipment: { weapon: item("test.item.sword") } }),
    );
    expect(sword.combat.dmgMin).toBe(2); // 2 x 120%
    expect(sword.combat.dmgMax).toBe(7); // 6 x 120% = 7.2
    expect(sword.combat.attackTicks).toBe(12);

    const strong = computeHeroStats(
      registry(),
      input({ equipment: { weapon: item("test.item.sword", [{ stat: "str", value: 20 }]) } }),
    );
    expect(strong.sheet.attrs.str).toBe(40);
    expect(strong.combat.dmgMax).toBe(8); // 6 x 140% = 8.4

    const more = computeHeroStats(
      registry(),
      input({ equipment: { weapon: item("test.item.sword", [{ stat: "dmgPct", value: 50 }]) } }),
    );
    expect(more.combat.dmgMin).toBe(3); // 2 x 170% = 3.4
    expect(more.combat.dmgMax).toBe(10); // 6 x 170% = 10.2
  });

  it("gives block only with a shield and adds the block mods", () => {
    const shield = computeHeroStats(
      registry(),
      input({
        equipment: { offhand: item("test.item.buckler", [{ stat: "blockPct", value: 5 }]) },
      }),
    );
    expect(shield.combat.blockPct).toBe(20); // 15 base + 5 mod

    const noShield = computeHeroStats(
      registry(),
      input({ equipment: { helm: item("test.item.cap", [{ stat: "blockPct", value: 5 }]) } }),
    );
    expect(noShield.combat.blockPct).toBe(0);
  });

  it("adds item armor and sums resists (resAll adds to every element)", () => {
    const { combat } = computeHeroStats(
      registry(),
      input({
        equipment: {
          armor: item("test.item.leather", [
            { stat: "resFire", value: 30 },
            { stat: "resAll", value: 10 },
          ]),
        },
      }),
    );
    expect(combat.armor).toBe(5 + 10); // floor(20/4) + base armor 10
    expect(combat.resFire).toBe(40);
    expect(combat.resCold).toBe(10);
    expect(combat.resLightning).toBe(10);
    expect(combat.resPoison).toBe(10);
  });

  it("applies buff mods scaled by the status power", () => {
    const { combat } = computeHeroStats(
      registry(),
      input({ buffs: [{ id: "test.status.rally", power: 40 }] }),
    );
    expect(combat.armor).toBe(7); // floor(5 x 140%)
    expect(combat.dmgMax).toBe(4); // 3 x 160% = 4.8
  });

  it("is pure: the same input gives the same output", () => {
    const a = computeHeroStats(registry(), input({ level: 3 }));
    const b = computeHeroStats(registry(), input({ level: 3 }));
    expect(a).toEqual(b);
  });
});

describe("classic.progression.stats system", () => {
  it("writes the derived values onto the hero and clamps Life to the new maximum", () => {
    const sim = testSim(["classic.core", "classic.progression"]);
    const hero = spawnTestHero(sim.world, { life: 100 });
    sim.step(1);
    expect(sim.world.read(hero, Life).max).toBe(80);
    expect(sim.world.read(hero, Life).hp).toBe(80);
  });
});
