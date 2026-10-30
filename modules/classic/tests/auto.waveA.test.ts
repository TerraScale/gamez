/**
 * classic.auto, wave A (docs/design/wave-A.md §8): the controller uses every
 * new system. Like tests/auto.test.ts this runs the controller in an
 * isolated mode (core infrastructure, classic.auto, test content plus a few
 * wave A prototypes, and a spy that records every queued HeroCommand), so
 * nothing depends on the owners of the ops (crafting, items, rift), which
 * are built in parallel. Covered: repair / craft / gamble / stash-tab town
 * steps, the loot filter and gems, telegraph dodging, the rift loop, the
 * depth-16 floor, talent mana costs and the new AutoConfig keys.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type Entity,
  type LoadedMode,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import type { HeroCommand } from "../src/actions.ts";
import { planCrafts, planGambles, planRepairs } from "../src/auto/craft.ts";
import { inZone, type Zone } from "../src/auto/dodge.ts";
import { barSkills } from "../src/auto/fight.ts";
import { classicAuto } from "../src/auto/index.ts";
import {
  chooseRiftLevel,
  riftLevelCap,
  riftReady,
  RIFT_FAIL_STREAK,
} from "../src/auto/riftLoop.ts";
import { makeAutoCtx } from "../src/auto/think.ts";
import { sortBag, TAB_GEMS, TAB_OVERFLOW, TAB_SPECIAL } from "../src/auto/town.ts";
import { busOf } from "../src/bus.ts";
import {
  AreaTag,
  AutoState,
  Belt,
  Body,
  BonusStats,
  Equipment,
  GroundEffect,
  Intent,
  Interactable,
  Inventory,
  Life,
  Loot,
  Npc,
  Pos,
  Supplies,
  type InteractableKind,
} from "../src/components.ts";
import { ECONOMY } from "../src/content/economy.ts";
import { cleanupSystem, setupCore, spatialSystem } from "../src/core/infra.ts";
import { tileCenter } from "../src/fixed.ts";
import { MODULE } from "../src/ids.ts";
import {
  DEFAULT_LOOT_FILTER,
  RES,
  type DungeonState,
  type LootFilter,
  type RiftRecord,
  type RiftState,
  type StashState,
} from "../src/resources.ts";
import {
  effectiveManaCost,
  emptySkillMods,
  gamblePrice,
  riftDepth,
  repairCost,
  upgradeCost,
} from "../src/rules.ts";
import {
  BALANCE_ID,
  ECONOMY_ID,
  KIND,
  RIFT_ID,
  type BalanceProto,
  type ItemBaseProto,
  type ItemInstance,
  type ItemRarity,
  type NpcProto,
  type RiftProto,
  type SkillProto,
} from "../src/types.ts";
import { testContent } from "./support/content.ts";
import { ensureResources, spawnTestHero, useOpenMap } from "./support/harness.ts";

// ---------------------------------------------------------------------------
// Isolated test mode
// ---------------------------------------------------------------------------

type LoggedCommand = HeroCommand & { tick: number };
const SPY = "test.spyA";

const infraCore = defineModule({
  id: MODULE.core,
  version: "0.0.0-auto-wave-a",
  setup: setupCore,
  systems: [spatialSystem, cleanupSystem],
});

const spy = defineModule({
  id: SPY,
  version: "0.0.1",
  deps: [MODULE.core],
  setup(world) {
    world.setResource<{ cmds: LoggedCommand[] }>(SPY, { cmds: [] });
  },
  systems: [
    {
      id: "test.spyA.commands",
      stage: "update",
      order: -1,
      run(world, ctx) {
        const log = world.getResource<{ cmds: LoggedCommand[] }>(SPY)!;
        const bus = busOf(world);
        for (const c of bus.commands) log.cmds.push({ ...c, tick: ctx.tick } as LoggedCommand);
        bus.commands.length = 0;
      },
    },
  ],
});

const gem = (kind: "ruby" | "topaz", tier: number): ItemBaseProto => ({
  name: `Test ${kind} ${tier}`,
  category: "gem",
  slots: [],
  size: { w: 1, h: 1 },
  icon: "icon.item.gem",
  ilvl: 1,
  reqLevel: 1,
  reqStr: 0,
  reqDex: 0,
  implicit: [],
  value: 10 * tier,
  dropWeight: 0,
  gem: {
    kind,
    tier,
    weapon: [{ stat: kind === "ruby" ? "fireDmg" : "lightningDmg", value: 2 * tier }],
    armor: [{ stat: kind === "ruby" ? "life" : "magicFind", value: 5 * tier }],
    jewelry: [{ stat: kind === "ruby" ? "resFire" : "resLightning", value: 4 * tier }],
  },
});

const RIFT: RiftProto = {
  unlockBossDepth: 16,
  size: 48,
  rooms: [4, 6],
  roomSize: [5, 8],
  packs: [4, 6],
  progress: { normal: 1, minion: 1, champion: 4, unique: 10, boss: 0, summon: 0 },
  goal: 20,
  timeLimit: 6000,
  guardians: ["test.monster.dummy"],
  feeBase: 200,
  feePerLevel: 80,
  reward: { goldPerLevel: 100, items: 1, bonusEvery: 5, minRarity: "rare" },
  themes: ["test.theme"],
};

/** Wave A prototypes the test content lacks: prices, a crafting smith, a gambler, gems, the rift. */
const waveAContent = defineModule({
  id: "test.waveA",
  version: "0.0.1",
  deps: ["test.content"],
  data(reg) {
    reg.define(KIND.economy, ECONOMY_ID, ECONOMY);
    reg.define(KIND.rift, RIFT_ID, RIFT);
    reg.define<NpcProto>(KIND.npc, "test.npc.forge", {
      name: "Test Forge",
      title: "smith",
      role: "smith",
      appearance: "unit.npc.smith",
      fallbackAppearance: "unit.hero",
      tint: 0,
      buyPct: 0,
      greeting: "Hm.",
      crafts: true,
    });
    reg.define<NpcProto>(KIND.npc, "test.npc.dice", {
      name: "Test Dice",
      title: "gambler",
      role: "gambler",
      appearance: "unit.npc.gambler",
      fallbackAppearance: "unit.hero",
      tint: 0,
      buyPct: 0,
      greeting: "Feeling lucky?",
      gamble: { categories: ["ring", "amulet", "weapon"] },
    });
    reg.define(KIND.itemBase, "test.item.gem_ruby_1", gem("ruby", 1));
    reg.define(KIND.itemBase, "test.item.gem_ruby_2", gem("ruby", 2));
    reg.define(KIND.itemBase, "test.item.gem_topaz_1", gem("topaz", 1));
  },
  dataUpdates(reg) {
    reg.patch<BalanceProto>(KIND.balance, BALANCE_ID, (b) => {
      b.stashTabs = 4;
      b.stashSize = 3;
    });
    reg.patch<ItemBaseProto>(KIND.itemBase, "test.item.sword", (b) => {
      b.maxSockets = 2;
    });
  },
});

let loadedCache: LoadedMode | null = null;
function loaded(): LoadedMode {
  if (loadedCache) return loadedCache;
  const mode = defineMode({
    id: "classic",
    name: "Classic (auto wave A test)",
    description: "auto wave A test",
    world: null,
    modules: [MODULE.core, MODULE.auto, "test.content", "test.waveA", SPY],
    tick: { kind: "fixed", hz: 20 },
  });
  loadedCache = loadMode(mode, [infraCore, classicAuto, testContent, waveAContent, spy]);
  return loadedCache;
}

function newSim(seed = 1): Sim {
  const sim = createSim(loaded(), { seed });
  ensureResources(sim.world);
  return sim;
}

function cmds(sim: Sim): LoggedCommand[] {
  return sim.world.getResource<{ cmds: LoggedCommand[] }>(SPY)!.cmds;
}
function plain(sim: Sim): HeroCommand[] {
  return cmds(sim).map(({ tick: _t, ...c }) => c as HeroCommand);
}

function setMode(sim: Sim, mode: "manual" | "auto" | "idle"): void {
  expect(sim.dispatch("classic.setControl", { mode }, null).ok).toBe(true);
}

function item(
  uid: number,
  base: string,
  rarity: ItemRarity,
  extra: Partial<ItemInstance> = {},
): ItemInstance {
  return { uid, base, rarity, ilvl: 1, name: base, mods: [], affixes: [], value: 200, ...extra };
}

function spawnNpc(sim: Sim, proto: string, x: number, y: number): Entity {
  const e = sim.world.create();
  sim.world.add(e, Npc, { proto });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth: 0 });
  sim.world.add(e, Body, { radius: 80, solid: true });
  return e;
}

function spawnInteractable(
  sim: Sim,
  kind: InteractableKind,
  x: number,
  y: number,
  depth: number,
): Entity {
  const e = sim.world.create();
  sim.world.add(e, Interactable, { kind, toDepth: 0 });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth });
  return e;
}

/** Town, hero at (10,10) with `gold`, the forge and the dice next to it. */
function town(gold: number): { sim: Sim; hero: Entity; forge: Entity; dice: Entity } {
  const sim = newSim();
  useOpenMap(sim, 0);
  const hero = spawnTestHero(sim.world, { x: 10, y: 10, depth: 0, gold, level: 10 });
  const forge = spawnNpc(sim, "test.npc.forge", 11, 10);
  const dice = spawnNpc(sim, "test.npc.dice", 10, 11);
  return { sim, hero, forge, dice };
}

function equip(sim: Sim, hero: Entity, slots: Partial<Record<string, ItemInstance>>): void {
  sim.world.update(hero, Equipment, { ...sim.world.read(hero, Equipment), ...slots });
}

function bag(sim: Sim, hero: Entity, items: ItemInstance[]): void {
  sim.world.update(hero, Inventory, {
    items: items.map((it, i) => ({ item: it, x: i % 10, y: Math.floor(i / 10) })),
  });
}

/** Runs the given town steps once (until the todo list is empty, at most `ticks` ticks). */
function runTown(sim: Sim, hero: Entity, ticks = 30): void {
  setMode(sim, "auto");
  sim.step(1);
  sim.world.getResource<{ cmds: LoggedCommand[] }>(SPY)!.cmds.length = 0;
  sim.world.update(hero, AutoState, { todo: ["repair", "craft", "gamble", "stash"] });
  for (let i = 0; i < ticks && sim.world.read(hero, AutoState).todo.length > 0; i++) sim.step(1);
}

function ctxOf(sim: Sim, hero: Entity) {
  return makeAutoCtx(sim.world, { tick: sim.tick, registry: sim.loaded.registry } as never, hero);
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

describe("auto repair", () => {
  it("repairs everything at once (uid 0) when the gold covers it", () => {
    const { sim, hero, forge } = town(5000);
    equip(sim, hero, {
      weapon: item(1, "test.item.sword", "magic", { dur: { cur: 20, max: 60 } }),
      helm: item(2, "test.item.cap", "normal", { dur: { cur: 50, max: 50 } }),
    });
    runTown(sim, hero);
    expect(plain(sim)).toContainEqual({ op: "repair", npc: forge, uid: 0 });
  });

  it("repairs broken pieces first, one by one, when the gold is short", () => {
    const { sim, hero } = town(0);
    const weapon = item(1, "test.item.sword", "magic", { dur: { cur: 30, max: 60 } });
    const helm = item(2, "test.item.cap", "normal", { dur: { cur: 0, max: 50 } });
    equip(sim, hero, { weapon, helm });
    const c = ctxOf(sim, hero);
    const helmCost = repairCost(ECONOMY, helm);
    const all = helmCost + repairCost(ECONOMY, weapon);
    expect(planRepairs(c, ECONOMY, all)).toEqual([0]);
    // Only enough for one: the broken helm.
    expect(planRepairs(c, ECONOMY, helmCost)).toEqual([2]);
    expect(planRepairs(c, ECONOMY, 0)).toEqual([]);
  });

  it("leaves gear above 60 % alone and honours autoRepair: false", () => {
    const { sim, hero } = town(5000);
    equip(sim, hero, {
      weapon: item(1, "test.item.sword", "magic", { dur: { cur: 50, max: 60 } }),
    });
    runTown(sim, hero);
    expect(plain(sim).filter((c) => c.op === "repair")).toEqual([]);

    const b = town(5000);
    equip(b.sim, b.hero, {
      weapon: item(1, "test.item.sword", "magic", { dur: { cur: 0, max: 60 } }),
    });
    expect(
      b.sim.dispatch("classic.setAutoConfig", { config: { autoRepair: false } }, null).ok,
    ).toBe(true);
    runTown(b.sim, b.hero);
    expect(plain(b.sim).filter((c) => c.op === "repair")).toEqual([]);
  });

  it("goes to town for a broken weapon (trip reason repair)", () => {
    const sim = newSim();
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1, gold: 1000 });
    equip(sim, hero, { weapon: item(1, "test.item.sword", "magic", { dur: { cur: 0, max: 60 } }) });
    setMode(sim, "auto");
    const events = sim.step(3);
    expect(plain(sim).map((c) => c.op)).toContain("townPortal");
    expect(events).toContainEqual({ type: "classic.auto.plan", plan: "toTown", note: "repair" });
  });
});

// ---------------------------------------------------------------------------
// Crafting
// ---------------------------------------------------------------------------

describe("auto crafting", () => {
  it("sockets the best bag gem into an empty socket, adds a socket for a spare gem, upgrades", () => {
    const { sim, hero, forge } = town(10_000);
    const sword = item(1, "test.item.sword", "magic", { sockets: [null] });
    equip(sim, hero, { weapon: sword });
    bag(sim, hero, [
      item(11, "test.item.gem_ruby_1", "normal", { value: 10 }),
      item(12, "test.item.gem_ruby_2", "normal", { value: 20 }),
    ]);
    runTown(sim, hero);
    const ops = plain(sim);
    // The tier-2 ruby (more fire damage) goes into the empty socket, the tier 1 into a new one.
    expect(ops).toContainEqual({ op: "socketGem", npc: forge, uid: 1, gem: 12 });
    expect(ops).toContainEqual({ op: "addSocket", npc: forge, uid: 1 });
    expect(ops).toContainEqual({ op: "socketGem", npc: forge, uid: 1, gem: 11 });
    expect(ops).toContainEqual({ op: "upgrade", npc: forge, uid: 1 });
    const iAdd = ops.findIndex((c) => c.op === "addSocket");
    const iSecond = ops.findIndex((c) => c.op === "socketGem" && c.gem === 11);
    expect(iAdd).toBeLessThan(iSecond);
  });

  it("combines three gems of a base and keeps the gold reserve", () => {
    const { sim, hero } = town(0);
    bag(sim, hero, [
      item(11, "test.item.gem_topaz_1", "normal"),
      item(12, "test.item.gem_topaz_1", "normal"),
      item(13, "test.item.gem_topaz_1", "normal"),
    ]);
    const c = ctxOf(sim, hero);
    expect(planCrafts(c, ECONOMY, 1000)).toEqual([
      { op: "combineGems", base: "test.item.gem_topaz_1" },
    ]);
    // No gold above the reserve: nothing that costs.
    expect(planCrafts(c, ECONOMY, 0)).toEqual([]);
  });

  it("upgrades the weapon first, then the body armor, within the budget; never the helm", () => {
    const { sim, hero } = town(0);
    const sword = item(1, "test.item.sword", "magic");
    const cap = item(2, "test.item.cap", "magic");
    const vest = item(3, "test.item.cap", "magic", { value: 120 });
    equip(sim, hero, { weapon: sword, helm: cap, armor: vest });
    const c = ctxOf(sim, hero);
    const swordCost = upgradeCost(ECONOMY, sword)!;
    expect(planCrafts(c, ECONOMY, swordCost)).toEqual([{ op: "upgrade", uid: 1 }]);
    expect(planCrafts(c, ECONOMY, swordCost + upgradeCost(ECONOMY, vest)!)).toEqual([
      { op: "upgrade", uid: 1 },
      { op: "upgrade", uid: 3 },
    ]);
    // Fully upgraded items are skipped.
    equip(sim, hero, { weapon: { ...sword, upgrade: ECONOMY.upgrade.maxLevel } });
    expect(planCrafts(ctxOf(sim, hero), ECONOMY, 100_000)).toEqual([{ op: "upgrade", uid: 3 }]);
  });

  it("honours autoCraft: false", () => {
    const { sim, hero } = town(10_000);
    equip(sim, hero, { weapon: item(1, "test.item.sword", "magic", { sockets: [null] }) });
    bag(sim, hero, [item(11, "test.item.gem_ruby_1", "normal")]);
    expect(sim.dispatch("classic.setAutoConfig", { config: { autoCraft: false } }, null).ok).toBe(
      true,
    );
    runTown(sim, hero);
    const crafting = ["socketGem", "addSocket", "upgrade", "combineGems"];
    expect(plain(sim).filter((c) => crafting.includes(c.op))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gambling and stash tabs
// ---------------------------------------------------------------------------

describe("auto gambling", () => {
  it("gambles rings and amulets with the gold above a level-scaled reserve", () => {
    const { sim, hero, dice } = town(50_000);
    runTown(sim, hero);
    const g = plain(sim).filter((c) => c.op === "gamble");
    expect(g.length).toBeGreaterThan(0);
    expect(g.length).toBeLessThanOrEqual(4);
    for (const c of g) {
      expect(c).toMatchObject({ op: "gamble", npc: dice });
      expect(["ring", "amulet"]).toContain((c as { category: string }).category);
    }
  });

  it("does not gamble below the reserve or with autoGamble: false", () => {
    const poor = town(200);
    runTown(poor.sim, poor.hero);
    expect(plain(poor.sim).filter((c) => c.op === "gamble")).toEqual([]);
    const c = ctxOf(poor.sim, poor.hero);
    const ring = gamblePrice(ECONOMY, "ring", 10)!;
    expect(planGambles(c, ECONOMY, ["ring", "amulet"], ring)).toEqual(["ring"]);
    expect(planGambles(c, ECONOMY, ["weapon"], 100_000)).toEqual([]);

    const off = town(50_000);
    expect(
      off.sim.dispatch("classic.setAutoConfig", { config: { autoGamble: false } }, null).ok,
    ).toBe(true);
    runTown(off.sim, off.hero);
    expect(plain(off.sim).filter((c) => c.op === "gamble")).toEqual([]);
  });
});

describe("auto stash tabs", () => {
  it("puts rares in tab 0, uniques and sets in tab 1, spare gems in tab 2, overflow in tab 3", () => {
    const { sim, hero } = town(0);
    const gems = Array.from({ length: 10 }, (_, i) =>
      item(100 + i, "test.item.gem_ruby_1", "normal"),
    );
    bag(sim, hero, [
      item(1, "test.item.ring", "rare", { mods: [] }),
      item(2, "test.item.ring", "unique"),
      item(3, "test.item.ring", "set"),
      ...gems,
    ]);
    // Rings are upgrades for an empty finger: fill both fingers with better rings first.
    const best = item(90, "test.item.ring", "unique", { mods: [{ stat: "str", value: 99 }] });
    equip(sim, hero, { ring1: best, ring2: { ...best, uid: 91 } });
    const { stash, sell } = sortBag(ctxOf(sim, hero));
    const tabOf = (uid: number): number | undefined => stash.find((p) => p.item.uid === uid)?.tab;
    expect(tabOf(1)).toBe(0);
    expect(tabOf(2)).toBe(TAB_SPECIAL);
    expect(tabOf(3)).toBe(TAB_SPECIAL);
    // 8 gems stay in the bag (crafting); the 2 extra go to the gem tab.
    expect(stash.filter((p) => p.tab === TAB_GEMS).map((p) => p.item.uid)).toEqual([108, 109]);
    expect(sell).toEqual([]);

    // Tab 0 full (stashSize 3 in this content): the next rare goes to the overflow tab.
    const full: StashState = {
      items: [
        item(500, "test.item.ring", "rare"),
        item(501, "test.item.ring", "rare"),
        item(502, "test.item.ring", "rare"),
      ],
    };
    sim.world.setResource(RES.stash, full);
    bag(sim, hero, [item(1, "test.item.ring", "rare")]);
    expect(sortBag(ctxOf(sim, hero)).stash).toEqual([
      { item: item(1, "test.item.ring", "rare"), tab: TAB_OVERFLOW },
    ]);
  });

  it("queues stashPut with the tab", () => {
    const { sim, hero } = town(0);
    const stashChest = spawnInteractable(sim, "stash", 9, 10, 0);
    expect(stashChest).toBeGreaterThan(0);
    const best = item(90, "test.item.ring", "unique", { mods: [{ stat: "str", value: 99 }] });
    equip(sim, hero, { ring1: best, ring2: { ...best, uid: 91 } });
    bag(sim, hero, [item(2, "test.item.ring", "unique")]);
    runTown(sim, hero);
    expect(plain(sim)).toContainEqual({ op: "stashPut", uid: 2, tab: TAB_SPECIAL });
  });
});

// ---------------------------------------------------------------------------
// Loot filter and gems
// ---------------------------------------------------------------------------

function spawnLoot(sim: Sim, x: number, y: number, it: ItemInstance): Entity {
  const e = sim.world.create();
  sim.world.add(e, Loot, { kind: "item", item: it, gold: 0, potion: "", droppedAt: 0 });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth: 1 });
  return e;
}

describe("auto loot filter", () => {
  it("never picks up loot the filter hides", () => {
    const sim = newSim();
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const filter: LootFilter = {
      ...DEFAULT_LOOT_FILTER,
      minRarity: { ...DEFAULT_LOOT_FILTER.minRarity, helm: "none" },
    };
    sim.world.setResource(RES.lootFilter, filter);
    spawnLoot(sim, 8, 5, item(1, "test.item.cap", "rare"));
    setMode(sim, "auto");
    sim.step(3);
    expect(sim.world.read(hero, AutoState).plan).not.toBe("loot");
    expect(sim.world.read(hero, Intent).kind).not.toBe("pickup");
  });

  it("always picks up gems, whatever pickupRarity says", () => {
    const sim = newSim();
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    expect(
      sim.dispatch("classic.setAutoConfig", { config: { pickupRarity: "rare" } }, null).ok,
    ).toBe(true);
    const g = spawnLoot(sim, 8, 5, item(1, "test.item.gem_ruby_1", "normal"));
    spawnLoot(sim, 7, 5, item(2, "test.item.cap", "magic"));
    setMode(sim, "auto");
    sim.step(3);
    expect(sim.world.read(hero, AutoState)).toMatchObject({ plan: "loot", focus: g });
  });
});

// ---------------------------------------------------------------------------
// Telegraph dodge
// ---------------------------------------------------------------------------

function telegraph(
  sim: Sim,
  x: number,
  y: number,
  o: Partial<{
    shape: "circle" | "cone" | "line";
    radius: number;
    angle: number;
    arc: number;
    length: number;
    width: number;
    team: "hero" | "monster";
    ticks: number;
  }> = {},
): Entity {
  const e = sim.world.create();
  const fireAt = sim.tick + (o.ticks ?? 30);
  sim.world.add(e, GroundEffect, {
    skill: "test.mskill.bite",
    rank: 1,
    owner: 0,
    team: o.team ?? "monster",
    radius: o.radius ?? 512,
    until: fireAt,
    nextAt: fireAt,
    every: 0,
    damage: { phys: 50, fire: 0, cold: 0, lightning: 0, poison: 0 },
    effect: "fx.telegraph",
    once: true,
    shape: o.shape ?? "circle",
    angle: o.angle ?? 0,
    arc: o.arc ?? 8,
    length: o.length ?? 0,
    width: o.width ?? 256,
    placedAt: sim.tick,
  });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth: 1 });
  return e;
}

describe("auto telegraph dodge", () => {
  it("steps out of a monster circle telegraph to the nearest safe tile", () => {
    const sim = newSim();
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 10, y: 10, depth: 1 });
    telegraph(sim, 10, 10, { radius: 512 });
    setMode(sim, "auto");
    const events = sim.step(1);
    const intent = sim.world.read(hero, Intent);
    expect(intent.kind).toBe("move");
    const m = intent as Extract<typeof intent, { kind: "move" }>;
    // Outside radius 2 tiles + body 80 + margin 64 (656 sub), and the nearest such tile.
    const d2 = (m.x - 10) ** 2 + (m.y - 10) ** 2;
    expect(d2 * 256 * 256).toBeGreaterThan(656 * 656);
    expect(Math.max(Math.abs(m.x - 10), Math.abs(m.y - 10))).toBeLessThanOrEqual(3);
    expect(events).toContainEqual({ type: "classic.auto.plan", plan: "recover", note: "dodge" });
  });

  it("ignores hero telegraphs and spent ones", () => {
    const sim = newSim();
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 10, y: 10, depth: 1 });
    telegraph(sim, 10, 10, { team: "hero" });
    setMode(sim, "auto");
    sim.step(1);
    expect(sim.world.read(hero, AutoState).plan).not.toBe("recover");
  });

  it("zone geometry: circle, cone and line", () => {
    const base: Zone = {
      x: 0,
      y: 0,
      shape: "circle",
      radius: 512,
      angle: 0,
      arc: 8,
      length: 0,
      width: 256,
      fireAt: 10,
    };
    expect(inZone(base, 600, 0, 96, 0)).toBe(true);
    expect(inZone(base, 700, 0, 96, 0)).toBe(false);
    const cone: Zone = { ...base, shape: "cone", length: 768, angle: 0, arc: 8 };
    // Angle 0 points along +x.
    expect(inZone(cone, 600, 0, 96, 0)).toBe(true);
    expect(inZone(cone, -600, 0, 96, 0)).toBe(false);
    expect(inZone(cone, 0, 600, 96, 0)).toBe(false);
    const line: Zone = { ...base, shape: "line", length: 1024, width: 256 };
    expect(inZone(line, 900, 100, 96, 0)).toBe(true);
    expect(inZone(line, 900, 400, 96, 0)).toBe(false);
    expect(inZone(line, 1400, 0, 96, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rift loop and the depth-16 floor
// ---------------------------------------------------------------------------

function record(level: number, ticks: number, completed: boolean): RiftRecord {
  return {
    level,
    ticks,
    score: 0,
    deaths: 0,
    completed,
    reason: completed ? "" : "death",
    heroLevel: 30,
    classId: "x",
    heroName: "x",
    worldSeed: 1,
    endTick: 0,
    run: 1,
  };
}

function riftState(o: Partial<RiftState> = {}): RiftState {
  return {
    unlocked: true,
    maxCompleted: 0,
    best: null,
    history: [],
    active: null,
    nextRun: 1,
    ...o,
  };
}

describe("auto rift loop", () => {
  it("chooses the level: 1 first, up after a fast clear, down after a slow or failed run", () => {
    expect(chooseRiftLevel(riftState(), RIFT, 40)).toBe(1);
    const fast = riftState({ maxCompleted: 3, history: [record(3, 3000, true)] });
    expect(chooseRiftLevel(fast, RIFT, 40)).toBe(4);
    const slow = riftState({ maxCompleted: 3, history: [record(3, 7000, true)] });
    expect(chooseRiftLevel(slow, RIFT, 40)).toBe(2);
    const failed = riftState({ maxCompleted: 3, history: [record(1, 100, false)] });
    expect(chooseRiftLevel(failed, RIFT, 40)).toBe(1);
    // Hero level caps it (monster level 18 + 2L <= level + 2).
    expect(riftLevelCap(26)).toBe(5);
    expect(
      chooseRiftLevel(riftState({ maxCompleted: 9, history: [record(9, 10, true)] }), RIFT, 26),
    ).toBe(5);
  });

  it("opens a rift at the obelisk once the main dungeon is done", () => {
    const sim = newSim();
    useOpenMap(sim, 0);
    const hero = spawnTestHero(sim.world, { x: 10, y: 10, depth: 0, gold: 5000, level: 30 });
    const obelisk = spawnInteractable(sim, "riftObelisk", 11, 10, 0);
    const d = sim.world.getResource<DungeonState>(RES.dungeon)!;
    d.deepest = 16;
    d.bossesKilled = [4, 8, 12, 16];
    sim.world.setResource(RES.rift, riftState());
    setMode(sim, "auto");
    const events = sim.step(5);
    expect(plain(sim)).toContainEqual({ op: "openRift", target: obelisk, level: 1 });
    expect(events).toContainEqual({ type: "classic.auto.plan", plan: "toDungeon", note: "rift 1" });
    expect(hero).toBeGreaterThan(0);
  });

  it("does not open a rift before the depth-16 boss died, or with autoRift: false", () => {
    const sim = newSim();
    useOpenMap(sim, 0);
    spawnTestHero(sim.world, { x: 10, y: 10, depth: 0, gold: 5000, level: 30 });
    spawnInteractable(sim, "riftObelisk", 11, 10, 0);
    const d = sim.world.getResource<DungeonState>(RES.dungeon)!;
    d.deepest = 16;
    d.bossesKilled = [4, 8, 12];
    sim.world.setResource(RES.rift, riftState());
    setMode(sim, "auto");
    sim.step(5);
    expect(plain(sim).map((c) => c.op)).not.toContain("openRift");

    const off = newSim();
    useOpenMap(off, 0);
    spawnTestHero(off.world, { x: 10, y: 10, depth: 0, gold: 5000, level: 30 });
    spawnInteractable(off, "riftObelisk", 11, 10, 0);
    const d2 = off.world.getResource<DungeonState>(RES.dungeon)!;
    d2.deepest = 16;
    d2.bossesKilled = [16];
    off.world.setResource(RES.rift, riftState());
    expect(off.dispatch("classic.setAutoConfig", { config: { autoRift: false } }, null).ok).toBe(
      true,
    );
    setMode(off, "auto");
    off.step(5);
    expect(plain(off).map((c) => c.op)).not.toContain("openRift");
  });

  it("after the run walks to the rift exit and takes it; never uses a town portal in a rift", () => {
    const sim = newSim();
    const depth = riftDepth(1, 1);
    useOpenMap(sim, depth);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth, level: 30 });
    sim.world.setResource(RES.rift, riftState({ maxCompleted: 1 }));
    const exit = spawnInteractable(sim, "riftExit", 12, 5, depth);
    setMode(sim, "auto");
    sim.step(2);
    expect(sim.world.read(hero, AutoState)).toMatchObject({ plan: "toTown", focus: exit });
    expect(sim.world.read(hero, Intent)).toMatchObject({ kind: "interact", target: exit });
    // Within reach: leaveRift.
    sim.world.update(hero, Pos, { x: tileCenter(11), y: tileCenter(5) });
    sim.step(25);
    expect(plain(sim).map((c) => c.op)).toContain("leaveRift");
    expect(plain(sim).map((c) => c.op)).not.toContain("townPortal");
  });

  it("does not retreat through a town portal inside a rift", () => {
    const sim = newSim();
    const depth = riftDepth(2, 5);
    useOpenMap(sim, depth);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth, life: 100 });
    sim.world.update(hero, Supplies, { tpScrolls: 5 });
    // Low life and no potion: outside a rift this is a retreat through a town portal.
    sim.world.update(hero, Life, { hp: 10 });
    sim.world.update(hero, Belt, {
      slots: [0, 1, 2, 3].map(() => ({ base: null, count: 0 })),
      readyAt: 0,
    });
    sim.world.setResource(RES.rift, riftState());
    setMode(sim, "auto");
    sim.step(1);
    expect(plain(sim).map((c) => c.op)).not.toContain("townPortal");
  });

  it("never takes the stairs down from depth 16", () => {
    const sim = newSim();
    const map = useOpenMap(sim, 16);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 16, level: 60 });
    // Stairs down exist on the test map: the controller still never takes them at 16.
    const stairs = spawnInteractable(sim, "stairsDown", 6, 5, 16);
    const d = sim.world.getResource<DungeonState>(RES.dungeon)!;
    d.deepest = 16;
    d.bossesKilled = [16];
    expect(map.width).toBeGreaterThan(0);
    expect(
      sim.dispatch("classic.setAutoConfig", { config: { explorePct: 0, autoRift: false } }, null)
        .ok,
    ).toBe(true);
    setMode(sim, "auto");
    sim.step(40);
    expect(plain(sim)).not.toContainEqual({ op: "stairs", target: stairs });
    expect(hero).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Talents (skill modifiers) and config
// ---------------------------------------------------------------------------

describe("auto skill costs and config", () => {
  it("uses the talent-reduced mana cost when choosing skills", () => {
    const sim = newSim();
    useOpenMap(sim, 1);
    const bolt = sim.loaded.registry.get<SkillProto>(KIND.skill, "test.skill.bolt")!;
    expect(bolt.manaCost).toBeGreaterThan(0);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1, mana: 100 });
    const before = barSkills(ctxOf(sim, hero)).find((o) => o.id === "test.skill.bolt")!;
    expect(before.cost).toBe(bolt.manaCost);
    sim.world.add(hero, BonusStats, {
      sources: [
        {
          source: "classic.talents",
          mods: [],
          skills: [{ skill: "test.skill.bolt", field: "manaCostPct", value: -50 }],
        },
      ],
    });
    const after = barSkills(ctxOf(sim, hero)).find((o) => o.id === "test.skill.bolt")!;
    expect(after.cost).toBe(effectiveManaCost(bolt, 1, { ...emptySkillMods(), manaCostPct: -50 }));
    expect(after.cost).toBeLessThan(before.cost);
  });

  it("setAutoConfig validates the wave A keys", () => {
    const sim = newSim();
    for (const key of ["autoRepair", "autoCraft", "autoGamble", "autoRift"]) {
      expect(sim.dispatch("classic.setAutoConfig", { config: { [key]: true } }, null).ok).toBe(
        true,
      );
      const bad = sim.dispatch("classic.setAutoConfig", { config: { [key]: 1 } }, null);
      expect(bad.ok).toBe(false);
      expect(bad.error?.code).toBe("bad_payload");
      const str = sim.dispatch("classic.setAutoConfig", { config: { [key]: "yes" } }, null);
      expect(str.ok).toBe(false);
    }
    const hash = sim.hash();
    expect(sim.dispatch("classic.setAutoConfig", { config: { autoRift: null } }, null).ok).toBe(
      false,
    );
    expect(sim.hash()).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** A fixed wave A script: town routine with every new step, then a dungeon telegraph. */
function scriptedA(): Sim {
  const { sim, hero } = town(20_000);
  spawnInteractable(sim, "stash", 9, 10, 0);
  equip(sim, hero, {
    weapon: item(1, "test.item.sword", "magic", { sockets: [null], dur: { cur: 10, max: 60 } }),
    helm: item(2, "test.item.cap", "rare", { dur: { cur: 0, max: 50 } }),
    ring1: item(3, "test.item.ring", "unique", { mods: [{ stat: "str", value: 99 }] }),
    ring2: item(4, "test.item.ring", "unique", { mods: [{ stat: "str", value: 99 }] }),
  });
  bag(sim, hero, [
    item(11, "test.item.gem_ruby_1", "normal"),
    item(12, "test.item.gem_ruby_2", "normal"),
    item(13, "test.item.gem_topaz_1", "normal"),
    item(14, "test.item.ring", "unique"),
  ]);
  setMode(sim, "idle");
  expect(sim.dispatch("classic.setSpeed", { speed: 8 }, null).ok).toBe(true);
  sim.step(40);
  return sim;
}

describe("auto wave A determinism", () => {
  it("replays the same script to the same hash and commands", () => {
    const a = scriptedA();
    const b = scriptedA();
    expect(a.hash()).toBe(b.hash());
    expect(plain(a)).toEqual(plain(b));
    const ops = plain(a).map((c) => c.op);
    for (const op of ["repair", "socketGem", "upgrade", "gamble", "stashPut"])
      expect(ops).toContain(op);
  });

  it("pins the hash after the fixed script", () => {
    expect(scriptedA().hash()).toBe("b8fe165ea3c6c8a9");
  });
});

describe("auto rift readiness (QA: rift level 1 was unwinnable for weak heroes)", () => {
  it("waits until level 1's monsters are within the margin of the hero", () => {
    // Rift level 1 monsters are level 20: a level 17 hero waits, level 18 goes.
    expect(riftReady(riftState(), 17, 17)).toBe(false);
    expect(riftReady(riftState(), 18, 18)).toBe(true);
  });

  it("pauses after failing level 1 twice in a row until the hero gains a level", () => {
    expect(RIFT_FAIL_STREAK).toBe(2);
    const twice = riftState({ history: [record(1, 100, false), record(1, 200, false)] });
    // record() stores hero level 30.
    expect(riftReady(twice, 30, 30)).toBe(false);
    expect(riftReady(twice, 31, 31)).toBe(true);
    // One failure, a failure at level 2, or a completion in the streak: no pause.
    expect(riftReady(riftState({ history: [record(1, 100, false)] }), 30, 30)).toBe(true);
    expect(
      riftReady(riftState({ history: [record(2, 100, false), record(1, 100, false)] }), 30, 30),
    ).toBe(true);
    expect(
      riftReady(riftState({ history: [record(1, 100, false), record(1, 100, true)] }), 30, 30),
    ).toBe(true);
  });
});
