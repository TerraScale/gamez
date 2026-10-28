/** Architect-owned tests of the wave A contract helpers (rules, bonus, loot). docs/design/wave-A.md §2.4. */
import { defineModule, loadMode, createSim, defineMode, type Registry } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { bonusMods, setBonusSource, skillModsOf } from "../src/bonus.ts";
import { BonusStats } from "../src/components.ts";
import { itemVisible, lootVisible } from "../src/loot.ts";
import { DEFAULT_LOOT_FILTER } from "../src/resources.ts";
import {
  addItemStats,
  effectiveCooldown,
  effectiveManaCost,
  gemMods,
  isBossDepth,
  isBroken,
  isRiftDepth,
  isWaypointDepth,
  maxSocketsOf,
  monsterLevel,
  rarityRank,
  repairCost,
  riftDepth,
  riftLevelOf,
  riftScore,
  setBonusMods,
  stashCapacity,
  sumSkillMods,
  upgradeCost,
  upgradeMods,
} from "../src/rules.ts";
import { ECONOMY } from "../src/content/economy.ts";
import { KIND, type ItemBaseProto, type ItemInstance, type SkillProto } from "../src/types.ts";
import { TEST_BALANCE, TEST_SKILLS } from "./support/content.ts";

const SWORD: ItemBaseProto = {
  name: "Test Sword",
  category: "weapon",
  slots: ["weapon"],
  weaponClass: "sword",
  size: { w: 1, h: 3 },
  icon: "icon.item.sword",
  ilvl: 1,
  reqLevel: 1,
  reqStr: 0,
  reqDex: 0,
  dmgMin: 2,
  dmgMax: 6,
  implicit: [],
  value: 40,
  dropWeight: 10,
};
const VEST: ItemBaseProto = {
  ...SWORD,
  name: "Vest",
  category: "armor",
  slots: ["armor"],
  armor: 20,
};
const RUBY: ItemBaseProto = {
  ...SWORD,
  name: "Chipped Ruby",
  category: "gem",
  slots: [],
  size: { w: 1, h: 1 },
  gem: {
    kind: "ruby",
    tier: 1,
    weapon: [{ stat: "fireDmg", value: 3 }],
    armor: [{ stat: "life", value: 10 }],
    jewelry: [{ stat: "resFire", value: 8 }],
  },
};

function registry() {
  const content = defineModule({
    id: "t.content",
    version: "1.0.0",
    data(reg: Registry) {
      reg.define(KIND.itemBase, "t.sword", SWORD);
      reg.define(KIND.itemBase, "t.vest", VEST);
      reg.define(KIND.itemBase, "t.ruby", RUBY);
      reg.define(KIND.set, "t.set", {
        name: "Test Set",
        classId: null,
        pieces: ["t.piece.a", "t.piece.b"],
        bonuses: [{ count: 2, mods: [{ stat: "life", value: 50 }] }],
      });
      reg.define(KIND.setItem, "t.piece.a", {
        name: "A",
        set: "t.set",
        base: "t.sword",
        ilvl: 1,
        mods: [],
        weight: 1,
      });
      reg.define(KIND.setItem, "t.piece.b", {
        name: "B",
        set: "t.set",
        base: "t.vest",
        ilvl: 1,
        mods: [],
        weight: 1,
      });
      for (const [id, s] of Object.entries(TEST_SKILLS)) reg.define(KIND.skill, id, s);
    },
  });
  const m = defineMode({
    id: "t",
    name: "t",
    description: "t",
    world: null,
    modules: ["t.content"],
    tick: { kind: "event" },
  });
  return loadMode(m, [content]);
}

function item(base: string, over: Partial<ItemInstance> = {}): ItemInstance {
  return {
    uid: 1,
    base,
    rarity: "normal",
    ilvl: 1,
    name: base,
    mods: [],
    affixes: [],
    value: 100,
    ...over,
  };
}

describe("rift depths", () => {
  it("round-trips level and run, and is never a boss or waypoint depth", () => {
    const d = riftDepth(7, 1234);
    expect(isRiftDepth(d)).toBe(true);
    expect(riftLevelOf(d)).toBe(7);
    expect(isBossDepth(d)).toBe(false);
    expect(isWaypointDepth(d)).toBe(false);
    expect(monsterLevel(d)).toBe(22 + 2 * 7);
    expect(isRiftDepth(16)).toBe(false);
    expect(riftLevelOf(16)).toBe(0);
    expect(monsterLevel(4)).toBe(5);
  });
  it("scores completed runs by level and seconds left", () => {
    expect(riftScore(3, 1200, 7200, true)).toBe(3000 + 300);
    expect(riftScore(3, 9000, 7200, true)).toBe(3000);
    expect(riftScore(3, 100, 7200, false)).toBe(0);
  });
});

describe("item stats with wave A fields", () => {
  const reg = registry().registry;
  it("ranks set between rare and unique", () => {
    expect(rarityRank("rare")).toBeLessThan(rarityRank("set"));
    expect(rarityRank("set")).toBeLessThan(rarityRank("unique"));
  });
  it("adds gems by socket group, upgrades and set bonuses; broken items add nothing", () => {
    const sword = item("t.sword", { sockets: ["t.ruby", null], upgrade: 2, set: "t.piece.a" });
    const vest = item("t.vest", { sockets: ["t.ruby"], set: "t.piece.b" });
    const t = addItemStats(reg, [sword, vest]);
    expect(t.fireDmg).toBe(3);
    expect(t.dmgPct).toBe(12);
    expect(t.life).toBe(10 + 50);
    expect(setBonusMods(reg, [sword])).toEqual([]);
    const broken = { ...vest, dur: { cur: 0, max: 70 } };
    expect(isBroken(broken)).toBe(true);
    expect(addItemStats(reg, [sword, broken]).life).toBeUndefined();
    expect(gemMods(reg, RUBY, ["t.ruby"])).toEqual([]);
    expect(upgradeMods(VEST, 1)).toEqual([{ stat: "armor", value: 3 }]);
    expect(maxSocketsOf(SWORD)).toBe(2);
  });
  it("prices from the economy table", () => {
    expect(repairCost(ECONOMY, item("t.sword"))).toBe(0);
    expect(repairCost(ECONOMY, item("t.sword", { dur: { cur: 30, max: 60 } }))).toBe(13);
    expect(upgradeCost(ECONOMY, item("t.sword", { upgrade: 5 }))).toBeNull();
    expect(upgradeCost(ECONOMY, item("t.sword"))).toBe(40);
    expect(stashCapacity({ ...TEST_BALANCE, stashTabs: 4 })).toBe(200);
    expect(stashCapacity(TEST_BALANCE)).toBe(TEST_BALANCE.stashSize);
  });
});

describe("skill modifiers and bonus sources", () => {
  const loaded = registry();
  const skillId = Object.keys(TEST_SKILLS)[0]!;
  const skill: SkillProto = TEST_SKILLS[skillId]!;
  it("matches exact ids, '*' and tags", () => {
    const t = sumSkillMods(
      [
        { skill: skillId, field: "damagePct", value: 10 },
        { skill: "*", field: "damagePct", value: 5 },
        { skill: `tag:${skill.ai.tags[0]}`, field: "manaCostPct", value: -50 },
        { skill: "other", field: "damagePct", value: 99 },
      ],
      skillId,
      skill,
    );
    expect(t.damagePct).toBe(skill.users === "hero" ? 15 : 10);
    expect(t.manaCostPct).toBe(-50);
    expect(effectiveCooldown({ ...skill, cooldown: 100 }, { ...t, cooldownPct: -25 })).toBe(75);
    expect(effectiveManaCost({ ...skill, manaCost: 10, manaPerRank: 0 }, 1, t)).toBe(5);
  });
  it("keeps one sorted entry per source and removes empty ones", () => {
    const sim = createSim(loaded, { seed: 1 });
    const w = sim.world;
    const e = w.create();
    setBonusSource(w, e, "z.src", [{ stat: "life", value: 5 }], []);
    setBonusSource(
      w,
      e,
      "a.src",
      [{ stat: "mana", value: 2 }],
      [{ skill: skillId, field: "damagePct", value: 20 }],
    );
    expect(w.read(e, BonusStats).sources.map((s) => s.source)).toEqual(["a.src", "z.src"]);
    expect(bonusMods(w, e)).toEqual([
      { stat: "mana", value: 2 },
      { stat: "life", value: 5 },
    ]);
    expect(skillModsOf(w, loaded.registry, e, skillId).damagePct).toBe(20);
    setBonusSource(w, e, "a.src", [], []);
    expect(w.read(e, BonusStats).sources.map((s) => s.source)).toEqual(["z.src"]);
  });
});

describe("loot filter", () => {
  const reg = registry().registry;
  it("hides by category minimum, never hides sets and uniques", () => {
    const f = {
      ...DEFAULT_LOOT_FILTER,
      minRarity: { ...DEFAULT_LOOT_FILTER.minRarity, weapon: "rare" as const },
    };
    expect(itemVisible(f, reg, item("t.sword", { rarity: "magic" }))).toBe(false);
    expect(itemVisible(f, reg, item("t.sword", { rarity: "rare" }))).toBe(true);
    expect(itemVisible(f, reg, item("t.sword", { rarity: "set" }))).toBe(true);
    const none = { ...f, minRarity: { ...f.minRarity, armor: "none" as const } };
    expect(itemVisible(none, reg, item("t.vest", { rarity: "rare" }))).toBe(false);
    expect(lootVisible({ ...f, minGold: 10 }, reg, { kind: "gold", item: null, gold: 5 })).toBe(
      false,
    );
    expect(lootVisible(f, reg, { kind: "potion", item: null, gold: 0 })).toBe(true);
  });
});
