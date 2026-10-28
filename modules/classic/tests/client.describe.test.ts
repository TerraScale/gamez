/** Item, stat and skill text (docs/design/classic.md §13). */
import { createRegistry, type FrozenRegistry } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import {
  itemLines,
  potionText,
  skillDetailLines,
  skillTooltip,
  STAT_TEXT,
  statDiffs,
  statText,
  statTotals,
  ticksToSeconds,
} from "../src/client/describe.ts";
import {
  BALANCE_ID,
  KIND,
  type ItemBaseProto,
  type ItemInstance,
  type StatId,
} from "../src/types.ts";
import { TEST_BALANCE, TEST_SKILLS } from "./support/content.ts";
import { testContent } from "./support/content.ts";

const ALL_STATS: StatId[] = [
  "str",
  "dex",
  "mag",
  "vit",
  "allAttrs",
  "life",
  "mana",
  "lifePct",
  "manaPct",
  "lifeRegen",
  "manaRegenPct",
  "armor",
  "armorPct",
  "toHit",
  "toHitPct",
  "dmgMin",
  "dmgMax",
  "dmgPct",
  "spellPct",
  "fireDmg",
  "coldDmg",
  "lightningDmg",
  "poisonDmg",
  "attackSpeed",
  "castSpeed",
  "moveSpeed",
  "critPct",
  "critDmgPct",
  "blockPct",
  "resFire",
  "resCold",
  "resLightning",
  "resPoison",
  "resAll",
  "lifeSteal",
  "manaSteal",
  "lifeOnKill",
  "manaOnKill",
  "thorns",
  "magicFind",
  "goldFind",
  "lightRadius",
  "allSkills",
  "potionPct",
];

/** A registry with the test content (items, skills, balance) and nothing else. */
function registry(): FrozenRegistry {
  // Build the frozen registry the same way the kernel does for the test content.
  const reg = createRegistry();
  testContent.data?.(reg);
  return reg.freeze();
}

function item(base: string, mods: ItemInstance["mods"] = [], uid = 1): ItemInstance {
  return {
    uid,
    base,
    rarity: "normal",
    ilvl: 1,
    name: "Test Item",
    mods,
    affixes: [],
    value: 10,
  };
}

describe("stat text", () => {
  it("covers every StatId", () => {
    expect(Object.keys(STAT_TEXT).sort()).toEqual([...ALL_STATS].sort());
    for (const s of ALL_STATS) expect(statText(s, 1).length).toBeGreaterThan(3);
  });

  it("formats flat, percent and regen values", () => {
    expect(statText("life", 12)).toBe("+12 to Life");
    expect(statText("resFire", -20)).toBe("-20% Fire Resistance");
    expect(statText("lifeRegen", 15)).toBe("+1.5 Life per second");
    expect(statText("dmgPct", 25)).toBe("+25% Damage");
  });
});

describe("item lines", () => {
  it("lists base damage, then implicits and rolled mods", () => {
    const reg = registry();
    const sword = item("test.item.sword", [{ stat: "dmgPct", value: 25 }]);
    expect(itemLines(reg, sword)).toEqual(["2-6 damage", "+25% Damage"]);
  });

  it("shows armor for armour pieces and the requirements when above level 1", () => {
    const reg = registry();
    const cap = item("test.item.cap", [{ stat: "vit", value: 3 }]);
    const lines = itemLines(reg, cap);
    expect(lines[0]).toBe("4 Armor");
    expect(lines).toContain("+3 to Vitality");
  });

  it("describes potions", () => {
    const reg = registry();
    expect(itemLines(reg, item("test.item.potion.life"))).toEqual(["Restores 50 Life"]);
    const base = reg.require<ItemBaseProto>(KIND.itemBase, "test.item.potion.mana");
    expect(potionText(base)).toBe("Restores 30 Mana");
  });

  it("falls back to the item name for unknown bases", () => {
    const reg = registry();
    expect(itemLines(reg, item("missing.base"))).toEqual(["Test Item"]);
  });
});

describe("stat comparison", () => {
  it("totals implicits and rolled mods, then lists only the differences", () => {
    const own = statTotals(
      {
        uid: 1,
        base: "x",
        rarity: "magic",
        ilvl: 1,
        name: "n",
        mods: [{ stat: "armor", value: 5 }],
        affixes: [],
        value: 1,
      },
      undefined,
    );
    const cur = { armor: 3, dex: 3 };
    // STAT_TEXT order: Dexterity comes before Armor.
    expect(statDiffs(own, cur)).toEqual([
      { text: "-3 to Dexterity", delta: -3 },
      { text: "+2 to Armor", delta: 2 },
    ]);
  });

  it("reports an empty difference list for identical stats", () => {
    expect(statDiffs({ dex: 2 }, { dex: 2 })).toEqual([]);
  });
});

describe("skill tooltips", () => {
  it("shows cost, range and damage of a skill at a rank", () => {
    const lines = skillTooltip(TEST_SKILLS["test.skill.bolt"]!, 1);
    expect(lines[0]).toBe("Bolt");
    expect(lines).toContain("Mana: 3");
    expect(lines).toContain("Range: 10.0 tiles");
    expect(lines).toContain("6-10 fire damage");
  });

  it("formats seconds from ticks with the one HUD duration format", () => {
    expect(ticksToSeconds(40)).toBe("2.0s");
    expect(ticksToSeconds(5)).toBe("0.3s");
    expect(ticksToSeconds(200)).toBe("10s");
  });

  it("shows mana and cooldown once: the detail lines leave them out", () => {
    const bolt = TEST_SKILLS["test.skill.bolt"]!;
    const details = skillDetailLines(bolt, 1);
    expect(details.some((l) => /^(Mana|Cooldown):/.test(l))).toBe(false);
    expect(details).toContain("Range: 10.0 tiles");
    expect(skillTooltip(bolt, 1).filter((l) => l.startsWith("Mana:"))).toHaveLength(1);
  });

  it("uses the registry balance id constant", () => {
    expect(BALANCE_ID).toBe("classic.balance");
    expect(TEST_BALANCE.maxLevel).toBe(60);
  });
});
