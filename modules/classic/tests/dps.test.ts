/**
 * Character DPS view (client/model/dps.ts): the averages, casts per second and mana rate of the
 * bar skills, effective life and the stat sources, checked against direct arithmetic on the
 * test content (tests/support/content.ts) with a known hero.
 */
import { describe, expect, it } from "vite-plus/test";
import { setBonusSource } from "../src/bonus.ts";
import { Equipment, type CombatStatsValue } from "../src/components.ts";
import { buildHud } from "../src/client/hudModel.ts";
import { effectiveLifeOf, expectedHit } from "../src/client/model/dps.ts";
import { statText } from "../src/client/describe.ts";
import { physReduction, rollSkillDamage } from "../src/rules.ts";
import type { ItemInstance, SkillProto } from "../src/types.ts";
import { TEST_SKILLS } from "./support/content.ts";
import { baseCombatStats, spawnTestHero, testSim, useOpenMap } from "./support/harness.ts";

const MAG_20 = { str: 20, dex: 20, mag: 20, vit: 20 };
const strike = TEST_SKILLS["test.skill.strike"] as SkillProto;
const bolt = TEST_SKILLS["test.skill.bolt"] as SkillProto;

function sword(uid = 1): ItemInstance {
  return {
    uid,
    base: "test.item.sword",
    rarity: "magic",
    ilvl: 3,
    name: "Keen Test Sword",
    mods: [{ stat: "dmgPct", value: 20 }],
    affixes: ["test.affix.keen"],
    value: 30,
  };
}

/** A hero on an open map with no crit, so every average is an exact midpoint. */
function setup(stats: Partial<CombatStatsValue> = {}) {
  const sim = testSim([]);
  useOpenMap(sim, 1);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5, stats: { critPct: 0, ...stats } });
  return { sim, hero };
}

function viewOf(sim: ReturnType<typeof testSim>) {
  const hud = buildHud(sim.world, sim.loaded.registry, {
    tick: 0,
    hovered: 0,
    vendor: 0,
    prev: null,
  });
  if (!hud.dps) throw new Error("expected a DPS view");
  return hud.dps;
}

describe("DPS of the bar skills on a known hero", () => {
  it("lists the bar skills in bar order, with their names", () => {
    const { sim } = setup();
    const dps = viewOf(sim);
    expect(dps.skills.map((s) => s.skill)).toEqual(["test.skill.strike", "test.skill.bolt"]);
    expect(dps.skills.map((s) => s.name)).toEqual(["Strike", "Bolt"]);
  });

  it("averages a basic weapon hit at the midpoint roll (2-6 gives 4) with no crit", () => {
    const { sim } = setup();
    // Direct: midpoint of 2..6 = 4, weaponPct 100, no crit.
    expect(viewOf(sim).skills[0]!.avgHit).toBe(4);
  });

  it("casts a basic attack every 12 ticks at 100% attack speed", () => {
    const { sim } = setup();
    const row = viewOf(sim).skills[0]!;
    // Direct: attackTicks 12 at 100 %, no cooldown: 20 / 12 casts per second.
    expect(row.perSecond).toBe(Math.round((20 / 12) * 100) / 100);
    expect(row.dps).toBe(Math.round(4 * (20 / 12)));
  });

  it("averages the spell at the midpoint of 6-10 with the mag bonus (mag 20 gives +20 %)", () => {
    const { sim } = setup();
    const row = viewOf(sim).skills[1]!;
    // Direct: midpoint 8, x (100 + 20) % = 9.
    expect(expectedHit(bolt, 1, baseCombatStats(1, { critPct: 0 }), MAG_20, 0)).toBe(9);
    expect(row.avgHit).toBe(9);
    // A cast every 10 ticks (castSpeed 100): two per second, so 18 dps and 6 mana per second.
    expect(row.perSecond).toBe(2);
    expect(row.dps).toBe(18);
    expect(row.manaPerSecond).toBe(6);
  });

  it("applies critical chance x critical multiplier to the average", () => {
    const { sim } = setup({ critPct: 50, critMult: 150 });
    // Direct: 4 x (1 + 0.5 x 0.5) = 5.
    expect(viewOf(sim).skills[0]!.avgHit).toBe(5);
  });

  it("applies a talent skill modifier (+25 % damage) and leaves speed and mana alone", () => {
    const { sim, hero } = setup();
    setBonusSource(
      sim.world,
      hero,
      "classic.talents",
      [],
      [{ skill: "test.skill.bolt", field: "damagePct", value: 25 }],
    );
    const row = viewOf(sim).skills[1]!;
    // Direct: the roll is 9 (above), then 9 x 125 % = 11, two casts a second.
    expect(row.avgHit).toBe(11);
    expect(row.dps).toBe(22);
    expect(row.manaPerSecond).toBe(6);
  });

  it("reports the highest dps of the bar as best", () => {
    const { sim } = setup();
    const dps = viewOf(sim);
    expect(dps.best).toBe(Math.max(...dps.skills.map((s) => s.dps)));
    expect(dps.best).toBe(18);
  });

  it("matches rules.rollSkillDamage at the midpoint for the average hit", () => {
    const { sim } = setup();
    const direct = rollSkillDamage(strike, 1, baseCombatStats(1, { critPct: 0 }), MAG_20, null);
    const total = direct.phys + direct.fire + direct.cold + direct.lightning + direct.poison;
    expect(viewOf(sim).skills[0]!.avgHit).toBe(total);
  });
});

describe("effective life against a physical hit", () => {
  it("uses the armor reduction of a level-matched monster (armor 10 at level 1 = 14 %)", () => {
    expect(physReduction(10, 1)).toBe(14);
    // Direct: 100 x 100 / (100 - 14) = 116.
    expect(effectiveLifeOf(100, 10, 1, 0)).toBe(116);
    const { sim } = setup();
    expect(viewOf(sim).effectiveLife).toBe(116);
  });

  it("adds block on top of the armor (30 % block turns 116 into 165)", () => {
    expect(effectiveLifeOf(100, 10, 1, 30)).toBe(165);
  });

  it("caps block like combat does (75 %)", () => {
    expect(effectiveLifeOf(100, 0, 1, 90)).toBe(400);
  });
});

describe("stat sources", () => {
  it("lists Items, Sets, Talents and Buffs in that order", () => {
    const { sim } = setup();
    expect(viewOf(sim).sources.map((s) => s.source)).toEqual(["Items", "Sets", "Talents", "Buffs"]);
  });

  it("lists the equipped item's stats under Items", () => {
    const { sim, hero } = setup();
    sim.world.update(hero, Equipment, { weapon: sword() });
    expect(viewOf(sim).sources[0]!.lines).toContain(statText("dmgPct", 20));
  });

  it("lists talent stat mods and skill modifiers under Talents, with the skill's name", () => {
    const { sim, hero } = setup();
    setBonusSource(
      sim.world,
      hero,
      "classic.talents",
      [{ stat: "life", value: 10 }],
      [{ skill: "test.skill.bolt", field: "damagePct", value: 25 }],
    );
    const talents = viewOf(sim).sources[2]!;
    expect(talents.lines).toContain(statText("life", 10));
    expect(talents.lines).toContain("Bolt: +25% damage");
  });

  it("shows no lines for an empty source", () => {
    const { sim } = setup();
    expect(viewOf(sim).sources[3]!.lines).toEqual([]);
  });

  it("is null without a hero", () => {
    const sim = testSim([]);
    const hud = buildHud(sim.world, sim.loaded.registry, {
      tick: 0,
      hovered: 0,
      vendor: 0,
      prev: null,
    });
    expect(hud.dps).toBeNull();
  });
});
