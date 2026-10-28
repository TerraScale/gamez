/** HUD model on harness worlds: hero, bar, belt, items, target, vendor, quests, sharing (docs/design/classic.md §13). */
import { describe, expect, it } from "vite-plus/test";
import {
  AreaTag,
  Dead,
  Intent,
  Inventory,
  Npc,
  Pos,
  SkillBook,
  Statuses,
  Supplies,
} from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { RES, type GameState } from "../src/resources.ts";
import {
  buildHud,
  itemView,
  junkBuyPct,
  meetsRequirements,
  minimapData,
  shareStructure,
  type HudContext,
} from "../src/client/hudModel.ts";
import { KIND, type ItemBaseProto, type ItemInstance } from "../src/types.ts";
import { sellPrice } from "../src/rules.ts";
import { spawnTestHero, spawnTestMonster, testSim, useOpenMap } from "./support/harness.ts";

function ctx(over: Partial<HudContext> = {}): HudContext {
  return { tick: 0, hovered: 0, vendor: 0, prev: null, ...over };
}

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

describe("hud on an empty world", () => {
  it("shows the class choice screen before a hero exists", () => {
    const sim = testSim([]);
    sim.world.getResource<GameState>(RES.game)!.phase = "choose";
    const hud = buildHud(sim.world, sim.loaded.registry, ctx());
    expect(hud.phase).toBe("choose");
    expect(hud.hero).toBeNull();
    expect(hud.classes).toEqual([
      { id: "test.class.fighter", name: "Fighter", description: "Test class" },
    ]);
    expect(hud.skillBar).toHaveLength(6);
    expect(hud.belt).toHaveLength(4);
    expect(hud.target).toBeNull();
    expect(hud.vendor).toBeNull();
    expect(hud.skillBar.every((s) => !s.usable)).toBe(true);
  });
});

describe("hud with a hero", () => {
  function setup() {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, gold: 42 });
    return { sim, hero };
  }

  it("builds the hero, area and control views", () => {
    const { sim } = setup();
    const hud = buildHud(sim.world, sim.loaded.registry, ctx({ tick: 7 }));
    expect(hud.phase).toBe("play");
    expect(hud.hero).toMatchObject({
      name: "Tester",
      classId: "test.class.fighter",
      className: "Fighter",
      level: 1,
      life: 100,
      lifeMax: 100,
      mana: 50,
      manaMax: 50,
      gold: 42,
      tpScrolls: 2,
      x: 5.5,
      y: 5.5,
      dead: false,
    });
    expect(hud.area).toMatchObject({ depth: 1, isTown: false, theme: "test.theme" });
    expect(hud.control).toMatchObject({
      mode: "manual",
      speed: 1,
      overridden: false,
      plan: "none",
    });
    expect(hud.tick).toBe(7);
  });

  it("builds the skill bar with keys, costs and cooldowns", () => {
    const { sim } = setup();
    const strike = buildHud(sim.world, sim.loaded.registry, ctx());
    expect(strike.skillBar[0]).toMatchObject({
      key: "1",
      skill: "test.skill.strike",
      name: "Strike",
      usable: true,
    });
    expect(strike.skillBar[1]).toMatchObject({
      key: "2",
      skill: "test.skill.bolt",
      manaCost: 3,
      usable: true,
    });
    expect(strike.skillBar[2]).toMatchObject({ skill: null, usable: false });

    sim.world.update(sim.world.getResource<GameState>(RES.game)!.hero, SkillBook, {
      cooldowns: [{ skill: "test.skill.bolt", readyAt: 10 }],
    });
    const cooling = buildHud(sim.world, sim.loaded.registry, ctx({ tick: 4 }));
    expect(cooling.skillBar[1]).toMatchObject({ cooldownLeft: 6, usable: false });
  });

  it("builds the belt with Q W E R keys and potion kinds", () => {
    const { sim } = setup();
    const hud = buildHud(sim.world, sim.loaded.registry, ctx());
    expect(hud.belt[0]).toMatchObject({
      key: "Q",
      base: "test.item.potion.life",
      kind: "life",
      count: 3,
    });
    expect(hud.belt[1]).toMatchObject({ key: "W", base: null, count: 0 });
    expect(hud.belt.map((b) => b.key)).toEqual(["Q", "W", "E", "R"]);
  });

  it("builds bag items with their lines, prices and upgrade hint", () => {
    const { sim, hero } = setup();
    sim.world.update(hero, Inventory, { items: [{ item: sword(), x: 0, y: 0 }] });
    const hud = buildHud(sim.world, sim.loaded.registry, ctx());
    const entry = hud.inventory.items[0]!;
    expect(hud.inventory).toMatchObject({ cols: 10, rows: 4 });
    expect(entry).toMatchObject({ x: 0, y: 0 });
    expect(entry.item).toMatchObject({
      name: "Keen Test Sword",
      rarity: "magic",
      category: "weapon",
      usable: true,
      w: 1,
      h: 3,
      value: 30,
      sellPrice: 3,
    });
    expect(entry.item.lines).toEqual(["2-6 damage", "+20% Damage"]);
    expect(entry.item.upgrade).toBeGreaterThan(0);
  });

  it("shows the monster under the pointer as the target", () => {
    const { sim } = setup();
    const monster = spawnTestMonster(sim.world, { x: 8, y: 5 });
    const hud = buildHud(sim.world, sim.loaded.registry, ctx({ hovered: monster }));
    expect(hud.target).toMatchObject({
      entity: monster,
      name: "Dummy",
      rarity: "normal",
      level: 1,
      lifeMax: 20,
    });
    expect(buildHud(sim.world, sim.loaded.registry, ctx()).target).toBeNull();
  });

  it("shows the monster being attacked when nothing is hovered", () => {
    const { sim, hero } = setup();
    const monster = spawnTestMonster(sim.world, { x: 8, y: 5 });
    sim.world.update(hero, Intent, {
      kind: "skill",
      source: "manual",
      at: 0,
      skill: "test.skill.strike",
      target: monster,
      x: 0,
      y: 0,
      repeat: true,
    });
    const hud = buildHud(sim.world, sim.loaded.registry, ctx());
    expect(hud.target?.entity).toBe(monster);
  });

  it("builds the vendor view of an open alchemist with the tp scroll price", () => {
    const { sim } = setup();
    const npc = sim.world.create();
    sim.world.add(npc, Npc, { proto: "test.npc.alchemist" });
    sim.world.add(npc, Pos, { x: tileCenter(2), y: tileCenter(2) });
    sim.world.add(npc, AreaTag, { depth: 1 });
    const hud = buildHud(sim.world, sim.loaded.registry, ctx({ vendor: npc }));
    expect(hud.vendor).toMatchObject({ npc, name: "Test alchemist", role: "alchemist", buyPct: 0 });
    expect(hud.vendor?.potions.map((p) => [p.base, p.price])).toEqual([
      ["test.item.potion.life", 25],
      ["test.item.potion.mana", 30],
      ["tp", 50],
    ]);
  });

  it("lists the hero's active statuses with seconds left, soonest first (status bar)", () => {
    const { sim, hero } = setup();
    sim.world.add(hero, Statuses, {
      list: [
        { id: "test.status.burn", until: 100, power: 5, source: 0, nextAt: 10, remaining: 5 },
        { id: "test.status.chill", until: 41, power: 40, source: 0, nextAt: 0, remaining: 0 },
        { id: "test.status.chill", until: 5, power: 40, source: 0, nextAt: 0, remaining: 0 },
      ],
    });
    const hud = buildHud(sim.world, sim.loaded.registry, ctx({ tick: 10 }));
    expect(hud.hero?.statuses).toEqual([
      { id: "test.status.chill", name: "Chilled", kind: "slow", secondsLeft: 2, tint: 0x7fd4ff },
      { id: "test.status.burn", name: "Burning", kind: "dot", secondsLeft: 5, tint: 0xff8a3d },
    ]);
  });

  it("lists the class skills and marks learnable ones", () => {
    const { sim, hero } = setup();
    const hud = buildHud(sim.world, sim.loaded.registry, ctx());
    const strike = hud.skills.find((s) => s.id === "test.skill.strike");
    expect(strike).toMatchObject({ rank: 1, onBar: 0, learnable: false });
    const nova = hud.skills.find((s) => s.id === "test.skill.nova");
    expect(nova).toMatchObject({ rank: 0, learnable: false, onBar: null });
    sim.world.update(hero, Supplies, { tpScrolls: 9 });
    expect(buildHud(sim.world, sim.loaded.registry, ctx()).hero?.tpScrolls).toBe(9);
  });

  it("shows the default quest as available for a level one hero", () => {
    const { sim } = setup();
    const hud = buildHud(sim.world, sim.loaded.registry, ctx());
    expect(hud.quests).toEqual([
      expect.objectContaining({
        id: "test.quest.hunt",
        state: "available",
        giver: "Test quest",
        reward: "100 gold, 50 XP",
      }),
    ]);
  });

  it("reports the respawn countdown of a dead hero", () => {
    const { sim, hero } = setup();
    sim.world.add(hero, Dead, { at: 0, killer: 0 });
    const hud = buildHud(sim.world, sim.loaded.registry, ctx({ tick: 10 }));
    expect(hud.hero).toMatchObject({ dead: true, respawnIn: 50 });
  });

  it("reuses unchanged parts when the world does not change (structural sharing)", () => {
    const { sim, hero } = setup();
    sim.world.update(hero, Inventory, { items: [{ item: sword(), x: 0, y: 0 }] });
    const first = buildHud(sim.world, sim.loaded.registry, ctx({ tick: 1 }));
    const second = buildHud(sim.world, sim.loaded.registry, ctx({ tick: 2, prev: first }));
    expect(second).not.toBe(first);
    expect(second.hero).toBe(first.hero);
    expect(second.inventory).toBe(first.inventory);
    expect(second.belt).toBe(first.belt);
    const third = buildHud(
      sim.world,
      sim.loaded.registry,
      ctx({ tick: 3, prev: second, hovered: spawnTestMonster(sim.world, { x: 8, y: 5 }) }),
    );
    expect(third.target).not.toBeNull();
    expect(third.inventory).toBe(first.inventory);
  });

  it("builds minimap dots for monsters, stairs and the waypoint of the area", () => {
    const { sim } = setup();
    const monster = spawnTestMonster(sim.world, { x: 8, y: 5 });
    const data = minimapData(sim.world, sim.loaded.registry);
    expect(data).not.toBeNull();
    expect(data?.explored).toBeNull();
    expect(data?.heroX).toBe(5.5);
    expect(data?.dots).toContainEqual({ x: 8, y: 5, kind: "monster" });
    expect(monster).toBeGreaterThan(0);
  });
});

describe("hud helpers", () => {
  it("shares equal structures and keeps changed ones", () => {
    const a = { x: { n: 1 }, list: [1, 2] };
    const same = shareStructure(a, { x: { n: 1 }, list: [1, 2] });
    expect(same).toBe(a);
    const changed = shareStructure(a, { x: { n: 2 }, list: [1, 2] });
    expect(changed).not.toBe(a);
    expect(changed.list).toBe(a.list);
  });

  it("computes junk prices and requirements", () => {
    const sim = testSim([]);
    expect(junkBuyPct(sim.loaded.registry)).toBe(10);
    const sw = sword();
    expect(sellPrice(sw, 10)).toBe(3);
    const req = (reqLevel: number, reqStr: number): ItemBaseProto => ({
      ...sim.loaded.registry.require<ItemBaseProto>(KIND.itemBase, "test.item.sword"),
      reqLevel,
      reqStr,
    });
    expect(meetsRequirements(req(5, 0), 1, { str: 20, dex: 20, mag: 0, vit: 0 })).toBe(false);
    expect(meetsRequirements(req(1, 30), 5, { str: 20, dex: 20, mag: 0, vit: 0 })).toBe(false);
    expect(meetsRequirements(req(1, 0), 1, { str: 0, dex: 0, mag: 0, vit: 0 })).toBe(true);
  });

  it("describes an item without an upgrade when it fits no slot", () => {
    const sim = testSim([]);
    const potion = itemView(
      {
        uid: 9,
        base: "test.item.potion.life",
        rarity: "normal",
        ilvl: 1,
        name: "Test Life Potion",
        mods: [],
        affixes: [],
        value: 25,
      },
      {
        registry: sim.loaded.registry,
        heroLevel: 1,
        attrs: { str: 0, dex: 0, mag: 0, vit: 0 },
        primary: "str",
        equipped: null,
        junkPct: 10,
      },
    );
    expect(potion.upgrade).toBe(0);
    expect(potion.lines).toEqual(["Restores 50 Life"]);
  });
});
