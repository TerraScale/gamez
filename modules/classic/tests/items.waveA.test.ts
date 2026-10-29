/**
 * classic.items, wave A (docs/design/wave-A.md §5): set pieces, gems and
 * dropped sockets, durability on generated equipment, set bonus events,
 * classic.items.wear (kills and hero deaths), broken items in
 * classic.progression.stats, the gambler, stash tabs, the loot filter,
 * RunStats counters, determinism and a pinned hash.
 *
 * Uses its own content on top of the minimal test content (sets and gems of
 * the real content are written in parallel): see `waveContent`.
 */
import {
  createRng,
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type Entity,
  type LoadedMode,
  type Sim,
  type World,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { busOf, pushCommand, type DeathRecord } from "../src/bus.ts";
import {
  AreaTag,
  Body,
  CombatStats,
  Equipment,
  HeroStats,
  Interactable,
  Inventory,
  Loot,
  Npc,
  Pos,
  Wallet,
} from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { modules as classicModules } from "../src/index.ts";
import { rollItem, rollRarity, WEAR_RES, type RollItemOptions } from "../src/items/index.ts";
import { DEFAULT_LOOT_FILTER, heroOf, lootFilterOf } from "../src/resources.ts";
import {
  nextUid,
  RES,
  stashOf,
  type LootFilter,
  type RunStats,
  type StashState,
} from "../src/resources.ts";
import { gamblePrice, itemValue } from "../src/rules.ts";
import {
  BALANCE_ID,
  ECONOMY_ID,
  KIND,
  type BalanceProto,
  type EconomyProto,
  type EquipSlot,
  type ItemBaseProto,
  type ItemInstance,
  type ItemRarity,
  type NpcProto,
  type SetItemProto,
  type SetProto,
} from "../src/types.ts";
import { TEST_BALANCE, testContent } from "./support/content.ts";
import { ensureResources, spawnTestHero, useOpenMap } from "./support/harness.ts";

// ---------------------------------------------------------------------------
// Test content (this file only)
// ---------------------------------------------------------------------------

const base = (
  p: Partial<ItemBaseProto> & Pick<ItemBaseProto, "name" | "category" | "slots">,
): ItemBaseProto => ({
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

const TIERS = ["Chipped", "Flawed", "Clear", "Flawless", "Radiant"];

function gem(kind: "ruby" | "sapphire", tier: number): ItemBaseProto {
  const name = kind === "ruby" ? "Ruby" : "Sapphire";
  return base({
    name: `${TIERS[tier - 1]} ${name}`,
    category: "gem",
    slots: [],
    dropWeight: 0,
    value: 20 * tier,
    gem: {
      kind,
      tier,
      weapon: [{ stat: kind === "ruby" ? "fireDmg" : "coldDmg", value: 2 * tier }],
      armor: [{ stat: kind === "ruby" ? "life" : "mana", value: 5 * tier }],
      jewelry: [{ stat: kind === "ruby" ? "resFire" : "resCold", value: 4 * tier }],
    },
  });
}

export const WAVE_BASES: Record<string, ItemBaseProto> = {
  "test.wa.boots": base({
    name: "Test Boots",
    category: "boots",
    slots: ["boots"],
    size: { w: 2, h: 2 },
    armor: 3,
  }),
  "test.wa.plate": base({
    name: "Test Plate",
    category: "armor",
    slots: ["armor"],
    size: { w: 2, h: 3 },
    armor: 20,
    value: 80,
  }),
  "test.wa.amulet": base({
    name: "Test Amulet",
    category: "amulet",
    slots: ["amulet"],
    value: 40,
  }),
  "test.wa.bigsword": base({
    name: "Test Big Sword",
    category: "weapon",
    slots: ["weapon"],
    weaponClass: "sword",
    size: { w: 1, h: 3 },
    ilvl: 3,
    dmgMin: 4,
    dmgMax: 9,
    attackTicks: 12,
    range: 400,
    value: 50,
  }),
  "test.wa.lategreat": base({
    name: "Test Late Sword",
    category: "weapon",
    slots: ["weapon"],
    weaponClass: "sword",
    size: { w: 1, h: 3 },
    ilvl: 4,
    value: 90,
  }),
};
for (const k of ["ruby", "sapphire"] as const) {
  for (let t = 1; t <= (k === "ruby" ? 5 : 2); t++)
    WAVE_BASES[`test.item.gem_${k}_${t}`] = gem(k, t);
}

export const WAVE_SETS: Record<string, SetProto> = {
  "test.set.wolf": {
    name: "Wolf's Pack",
    classId: null,
    pieces: ["test.setItem.wolf_cap", "test.setItem.wolf_band", "test.setItem.wolf_fang"],
    bonuses: [
      { count: 2, mods: [{ stat: "life", value: 10 }] },
      { count: 3, mods: [{ stat: "str", value: 5 }] },
    ],
  },
};

export const WAVE_SET_ITEMS: Record<string, SetItemProto> = {
  "test.setItem.wolf_cap": {
    name: "Wolf's Brow",
    set: "test.set.wolf",
    base: "test.item.cap",
    ilvl: 1,
    mods: [{ stat: "life", min: 3, max: 6 }],
    weight: 10,
  },
  "test.setItem.wolf_band": {
    name: "Wolf's Band",
    set: "test.set.wolf",
    base: "test.item.ring",
    ilvl: 1,
    mods: [{ stat: "str", min: 1, max: 2 }],
    weight: 10,
  },
  "test.setItem.wolf_fang": {
    name: "Wolf's Fang",
    set: "test.set.wolf",
    base: "test.item.sword",
    ilvl: 5,
    mods: [{ stat: "dmgPct", min: 5, max: 10 }],
    weight: 10,
  },
};

/** A frozen copy of the phase-A economy (independent of content/economy.ts tuning). */
export const WAVE_ECONOMY: EconomyProto = {
  repair: { fullPct: 25, everyKills: 8, deathLossPct: 10 },
  upgrade: { maxLevel: 5, costPct: [40, 70, 110, 160, 240], chancePct: [100, 85, 70, 55, 40] },
  reroll: { basePct: 60 },
  sockets: { addCost: [150, 600, 2000], unsocketCost: 250, combineCost: [50, 150, 450, 1300] },
  gamble: {
    base: { weapon: 220, helm: 160, ring: 300, armor: 240, boots: 140 },
    perLevelPct: 12,
    weights: { normal: 0, magic: 700, rare: 250, set: 30, unique: 20 },
  },
  talentResetPerLevel: 60,
};

const GAMBLER: NpcProto = {
  name: "Test Gambler",
  title: "Gambler",
  role: "gambler",
  appearance: "unit.npc.gambler",
  fallbackAppearance: "unit.hero",
  tint: 0xffffff,
  buyPct: 0,
  greeting: "Hello.",
  gamble: { categories: ["weapon", "helm", "ring", "armor"] },
};

interface RollPayload extends RollItemOptions {
  count: number;
}

const rollAction = {
  name: "test.wa.roll",
  parse(_world: World, payload: unknown): RollPayload {
    return payload as RollPayload;
  },
  apply(world: World, p: RollPayload, ctx: Parameters<typeof rollItem>[1]): void {
    const out: ItemInstance[] = [];
    for (let i = 0; i < p.count; i++) {
      const { count: _c, ...o } = p;
      const item = rollItem(world, ctx, o);
      if (item) out.push(item);
    }
    world.setResource("test.rolled", out);
  },
};

export const waveContent = defineModule({
  id: "test.wa.items",
  version: "0.0.1",
  deps: ["test.content"],
  data(reg) {
    for (const id of Object.keys(WAVE_BASES).sort()) reg.define(KIND.itemBase, id, WAVE_BASES[id]!);
    for (const id of Object.keys(WAVE_SETS).sort()) reg.define(KIND.set, id, WAVE_SETS[id]!);
    for (const id of Object.keys(WAVE_SET_ITEMS).sort())
      reg.define(KIND.setItem, id, WAVE_SET_ITEMS[id]!);
    reg.define(KIND.economy, ECONOMY_ID, WAVE_ECONOMY);
    reg.define(KIND.npc, "test.npc.gambler", GAMBLER);
  },
  dataUpdates(reg) {
    reg.patch<BalanceProto>(KIND.balance, BALANCE_ID, (b) => {
      b.stashTabs = 3;
      b.stashSize = 2;
      b.gemDrops = { champion: 100, unique: 50 };
      b.socketedDropPct = 50;
      b.rarityWeights.set = 40;
    });
    reg.patch<NpcProto>(KIND.npc, "test.npc.smith", (n) => {
      n.crafts = true;
    });
  },
  actions: [rollAction],
});

const loadedCache = new Map<string, LoadedMode>();

function waveLoaded(extra: string[]): LoadedMode {
  const key = extra.join(",");
  const hit = loadedCache.get(key);
  if (hit) return hit;
  const mode = defineMode({
    id: "classic",
    name: "Classic (wave A items test)",
    description: "test",
    world: null,
    modules: ["classic.core", "classic.items", "test.content", "test.wa.items", ...extra],
    tick: { kind: "fixed", hz: 20 },
  });
  const loaded = loadMode(mode, [...classicModules, testContent, waveContent]);
  loadedCache.set(key, loaded);
  return loaded;
}

const RUN_STATS: RunStats = {
  kills: 0,
  championKills: 0,
  uniqueKills: 0,
  bossKills: 0,
  deaths: 0,
  goldEarned: 0,
  itemsFound: 0,
  potionsUsed: 0,
  ticksPlayed: 0,
  offlineMs: 0,
};

function waveSim(seed = 1, extra: string[] = []): Sim {
  const sim = createSim(waveLoaded(extra), { seed });
  ensureResources(sim.world);
  if (!sim.world.getResource(RES.stats)) sim.world.setResource(RES.stats, RUN_STATS);
  if (!sim.world.getResource(RES.stash)) sim.world.setResource(RES.stash, { items: [] });
  if (!sim.world.getResource(RES.vendors)) sim.world.setResource(RES.vendors, { stocks: [] });
  return sim;
}

const reg = (sim: Sim) => sim.loaded.registry;
const bal = (sim: Sim) => reg(sim).require<BalanceProto>(KIND.balance, BALANCE_ID);
const stats = (sim: Sim) => sim.world.getResource<RunStats>(RES.stats)!;

function roll(sim: Sim, p: RollPayload): ItemInstance[] {
  const r = sim.dispatch("test.wa.roll", p, null);
  expect(r.ok).toBe(true);
  return sim.world.getResource<ItemInstance[]>("test.rolled") ?? [];
}

function makeItem(
  sim: Sim,
  baseId: string,
  rarity: ItemRarity = "normal",
  extra: Partial<ItemInstance> = {},
): ItemInstance {
  const b = reg(sim).require<ItemBaseProto>(KIND.itemBase, baseId);
  return {
    uid: nextUid(sim.world),
    base: baseId,
    rarity,
    ilvl: 1,
    name: b.name,
    mods: [],
    affixes: [],
    value: itemValue(b, rarity, 1),
    ...extra,
  };
}

function setPiece(sim: Sim, piece: string, extra: Partial<ItemInstance> = {}): ItemInstance {
  const p = WAVE_SET_ITEMS[piece]!;
  return makeItem(sim, p.base, "set", { name: p.name, set: piece, ...extra });
}

function putInBag(sim: Sim, hero: Entity, item: ItemInstance, x: number, y: number): void {
  const bag = sim.world.read(hero, Inventory);
  sim.world.update(hero, Inventory, { items: [...bag.items, { item, x, y }] });
}

function equipDirect(sim: Sim, hero: Entity, slot: EquipSlot, item: ItemInstance): void {
  sim.world.update(hero, Equipment, { [slot]: item });
}

function spawnNpc(sim: Sim, proto: string, x: number, y: number, depth = 0): Entity {
  const e = sim.world.create();
  sim.world.add(e, Npc, { proto });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth });
  sim.world.add(e, Body, { radius: 80, solid: true });
  return e;
}

function spawnStash(sim: Sim, x: number, y: number): Entity {
  const e = sim.world.create();
  sim.world.add(e, Interactable, { kind: "stash", toDepth: 0 });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth: 0 });
  return e;
}

function death(over: Partial<DeathRecord> = {}): DeathRecord {
  return {
    entity: 0,
    killer: 0,
    creditTeam: "hero",
    team: "monster",
    isHero: false,
    x: tileCenter(8),
    y: tileCenter(8),
    depth: 1,
    monster: "test.monster.dummy",
    rarity: "normal",
    level: 1,
    xp: 10,
    pack: 0,
    ...over,
  };
}

function kill(sim: Sim, records: DeathRecord[]) {
  busOf(sim.world).deaths.push(...records);
  return sim.step(1);
}

const ofType = <T extends string>(events: { type: string }[], type: T) =>
  events.filter((e) => e.type === type) as ({ type: T } & Record<string, unknown>)[];

/** A dungeon hero (depth 1, open map) for drops and wear. */
function dungeon(seed = 1, extra: string[] = []) {
  const sim = waveSim(seed, extra);
  useOpenMap(sim, 1);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
  return { sim, hero };
}

/** A town hero at (5, 5) next to the smith, the gambler, the junk buyer and the stash. */
function town(seed = 1, gold = 5000, level = 1) {
  const sim = waveSim(seed);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0, gold, level });
  const smith = spawnNpc(sim, "test.npc.smith", 7, 5);
  const gambler = spawnNpc(sim, "test.npc.gambler", 7, 6);
  const junk = spawnNpc(sim, "test.npc.junk", 7, 7);
  const stash = spawnStash(sim, 6, 5);
  return { sim, hero, smith, gambler, junk, stash };
}

/** Dispatch that must succeed; returns its events. */
function act(sim: Sim, name: string, payload: unknown): { type: string }[] {
  const r = sim.dispatch(name, payload, null);
  expect(r.error?.code ?? "ok").toBe("ok");
  return r.events;
}

/** Dispatch that must fail with `code` and leave the world unchanged. */
function rejects(sim: Sim, name: string, payload: unknown, code: string): void {
  const before = sim.hash();
  const r = sim.dispatch(name, payload, null);
  expect(r.ok).toBe(false);
  expect(r.ok ? "" : r.error?.code).toBe(code);
  expect(sim.hash()).toBe(before);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

describe("generation: sets, gems, sockets, durability", () => {
  it("rolls set pieces with the piece name, id and ranged mods; falls back to rare", () => {
    const sim = waveSim(5);
    const items = roll(sim, { count: 40, ilvl: 10, rarity: "set", magicFind: 0 });
    expect(items.length).toBe(40);
    const pieces = new Set<string>();
    for (const it of items) {
      expect(it.rarity).toBe("set");
      const piece = WAVE_SET_ITEMS[it.set!]!;
      expect(piece).toBeDefined();
      pieces.add(it.set!);
      expect(it.name).toBe(piece.name);
      expect(it.base).toBe(piece.base);
      expect(it.mods.length).toBe(piece.mods.length);
      expect(it.mods[0]!.stat).toBe(piece.mods[0]!.stat);
      expect(it.mods[0]!.value).toBeGreaterThanOrEqual(piece.mods[0]!.min);
      expect(it.mods[0]!.value).toBeLessThanOrEqual(piece.mods[0]!.max);
    }
    expect([...pieces].sort()).toEqual(Object.keys(WAVE_SET_ITEMS).sort());

    // ilvl gate: the fang is ilvl 5.
    const low = roll(sim, { count: 30, ilvl: 3, rarity: "set", magicFind: 0 });
    expect(low.some((i) => i.set === "test.setItem.wolf_fang")).toBe(false);
    // category filter, and a category without pieces falls back to rare.
    const rings = roll(sim, { count: 5, ilvl: 3, rarity: "set", magicFind: 0, category: "ring" });
    expect(rings.every((i) => i.set === "test.setItem.wolf_band")).toBe(true);
    const boots = roll(sim, { count: 5, ilvl: 3, rarity: "set", magicFind: 0, category: "boots" });
    for (const b of boots) {
      expect(b.rarity).toBe("rare");
      expect(b.set).toBeUndefined();
    }
  });

  it("rolls the set rarity with its weight, scaled by magic find like uniques", () => {
    const sim = waveSim(9);
    const count = (mf: number) =>
      roll(sim, { count: 600, ilvl: 10, rarity: null, magicFind: mf }).filter(
        (i) => i.rarity === "set",
      ).length;
    const plain = count(0);
    const lucky = count(400);
    // 40 / (600+300+90+40+10) ~ 3.8 %
    expect(plain).toBeGreaterThan(8);
    expect(plain).toBeLessThan(45);
    expect(lucky).toBeGreaterThan(plain);
    // minRarity "set" only gives sets and uniques.
    const high = roll(sim, { count: 40, ilvl: 10, rarity: null, magicFind: 0, minRarity: "set" });
    expect(high.every((i) => i.rarity === "set" || i.rarity === "unique")).toBe(true);
  });

  it("rollRarity with set weight 0 is the old distribution", () => {
    const a = createRng(3);
    const b = createRng(3);
    const w0 = { ...TEST_BALANCE, rarityWeights: { ...TEST_BALANCE.rarityWeights, set: 0 } };
    const r1: string[] = [];
    const r2: string[] = [];
    for (let i = 0; i < 50; i++) r1.push(rollRarity(a, w0, 0));
    const noSet = { ...w0.rarityWeights } as Record<string, number>;
    delete noSet.set;
    for (let i = 0; i < 50; i++)
      r2.push(rollRarity(b, { ...w0, rarityWeights: noSet as never }, 0));
    expect(r1).toEqual(r2);
    expect(r1.includes("set")).toBe(false);
  });

  it("gives every generated equippable item that wears full durability", () => {
    const sim = waveSim(2);
    const items = roll(sim, { count: 60, ilvl: 10, rarity: null, magicFind: 0 });
    for (const it of items) {
      const b = reg(sim).require<ItemBaseProto>(KIND.itemBase, it.base);
      if (b.category === "ring" || b.category === "amulet") {
        expect(it.dur).toBeUndefined();
      } else {
        expect(it.dur).toBeDefined();
        expect(it.dur!.cur).toBe(it.dur!.max);
      }
    }
    const [sword] = roll(sim, {
      count: 1,
      ilvl: 1,
      rarity: "normal",
      magicFind: 0,
      base: "test.item.sword",
    });
    expect(sword!.dur).toEqual({ cur: 60, max: 60 });
    const [cap] = roll(sim, {
      count: 1,
      ilvl: 1,
      rarity: "normal",
      magicFind: 0,
      base: "test.item.cap",
    });
    expect(cap!.dur).toEqual({ cur: 50, max: 50 });
  });

  it("never rolls gems as loot unless asked; gem rolls are plain normal gems", () => {
    const sim = waveSim(4);
    const any = roll(sim, { count: 200, ilvl: 60, rarity: null, magicFind: 0 });
    expect(any.some((i) => i.base.includes("gem"))).toBe(false);
    // Gems have dropWeight 0 in this content, so a "gem" category roll finds no base...
    expect(roll(sim, { count: 3, ilvl: 60, rarity: null, magicFind: 0, category: "gem" })).toEqual(
      [],
    );
    // ...but an exact gem base is always normal, without affixes or durability.
    const [g] = roll(sim, {
      count: 1,
      ilvl: 60,
      rarity: "rare",
      magicFind: 0,
      base: "test.item.gem_ruby_3",
    });
    expect(g!.rarity).toBe("normal");
    expect(g!.mods).toEqual([]);
    expect(g!.dur).toBeUndefined();
  });

  it("supports fixed rarity weights and a separate base ilvl gate (gambling)", () => {
    const sim = waveSim(6);
    const rares = roll(sim, {
      count: 20,
      ilvl: 1,
      rarity: null,
      magicFind: 999,
      category: "weapon",
      rarityWeights: { rare: 1 },
      maxBaseIlvl: 3,
    });
    expect(rares.every((i) => i.rarity === "rare")).toBe(true);
    expect(rares.every((i) => i.ilvl === 1)).toBe(true);
    expect(rares.some((i) => i.base === "test.wa.bigsword")).toBe(true);
    expect(rares.some((i) => i.base === "test.wa.lategreat")).toBe(false);
  });
});

describe("drops: gems and sockets", () => {
  it("drops a gem per champion kill, tier 1 + floor(level / 10) capped at 5", () => {
    for (const [level, tier] of [
      [1, 1],
      [25, 3],
      [49, 5],
      [80, 5],
    ] as const) {
      const { sim } = dungeon(level);
      kill(sim, [death({ rarity: "champion", level })]);
      const gems = sim.world
        .query(Loot)
        .map((e) => sim.world.read(e, Loot).item)
        .filter((i): i is ItemInstance => i !== null && i.base.includes("gem"));
      expect(gems.length).toBe(1);
      const g = reg(sim).require<ItemBaseProto>(KIND.itemBase, gems[0]!.base).gem!;
      // Sapphires stop at tier 2: tier 3+ drops are rubies (the only kind with that tier).
      expect(g.tier).toBe(tier);
    }
  });

  it("drops no gems from normal monsters here (gemDrops normal is absent) or hero-team deaths", () => {
    const { sim } = dungeon(3);
    for (let i = 0; i < 30; i++) kill(sim, [death({ rarity: "normal" })]);
    kill(sim, [death({ rarity: "champion", creditTeam: "monster" })]);
    const gems = sim.world
      .query(Loot)
      .filter((e) => sim.world.read(e, Loot).item?.base.includes("gem"));
    expect(gems.length).toBe(0);
  });

  it("socketed drops: only normal/magic weapons and armor, 1..maxSockets empty sockets", () => {
    const { sim } = dungeon(11);
    for (let i = 0; i < 120; i++) kill(sim, [death({ rarity: "unique", level: 5 })]);
    const items = sim.world
      .query(Loot)
      .map((e) => sim.world.read(e, Loot).item)
      .filter((i): i is ItemInstance => i !== null && !i.base.includes("gem"));
    let socketed = 0;
    for (const it of items) {
      if (!it.sockets) continue;
      socketed++;
      const b = reg(sim).require<ItemBaseProto>(KIND.itemBase, it.base);
      expect(["normal", "magic"]).toContain(it.rarity);
      expect(["ring", "amulet"]).not.toContain(b.category);
      expect(it.sockets.length).toBeGreaterThanOrEqual(1);
      expect(it.sockets.every((s) => s === null)).toBe(true);
      const max = b.category === "weapon" ? 2 : b.category === "armor" ? 3 : 2;
      expect(it.sockets.length).toBeLessThanOrEqual(max);
    }
    expect(socketed).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

describe("set bonus events", () => {
  it("emits classic.set.bonus when equipping or unequipping crosses a threshold", () => {
    const { sim, hero } = town(1);
    const cap = setPiece(sim, "test.setItem.wolf_cap");
    const band = setPiece(sim, "test.setItem.wolf_band");
    const band2 = setPiece(sim, "test.setItem.wolf_band");
    const fang = setPiece(sim, "test.setItem.wolf_fang");
    putInBag(sim, hero, cap, 0, 0);
    putInBag(sim, hero, band, 2, 0);
    putInBag(sim, hero, band2, 3, 0);
    putInBag(sim, hero, fang, 4, 0);

    let ev = act(sim, ACTION.equip, { uid: cap.uid, slot: null });
    expect(ofType(ev, "classic.set.bonus")).toEqual([]);

    ev = act(sim, ACTION.equip, { uid: band.uid, slot: "ring1" });
    expect(ofType(ev, "classic.set.bonus")).toEqual([
      {
        type: "classic.set.bonus",
        set: "test.set.wolf",
        name: "Wolf's Pack",
        pieces: 2,
        active: 1,
      },
    ]);

    // The same piece twice counts once.
    expect(
      ofType(act(sim, ACTION.equip, { uid: band2.uid, slot: "ring2" }), "classic.set.bonus"),
    ).toEqual([]);

    ev = act(sim, ACTION.equip, { uid: fang.uid, slot: null });
    expect(ofType(ev, "classic.set.bonus").map((e) => [e.pieces, e.active])).toEqual([[3, 2]]);

    ev = act(sim, ACTION.unequip, { slot: "helm" });
    expect(ofType(ev, "classic.set.bonus").map((e) => [e.pieces, e.active])).toEqual([[2, 1]]);
  });
});

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

describe("classic.items.wear", () => {
  it("every 8 hero kills: the weapon and one worn armor piece lose 1 (dur initialised)", () => {
    const { sim, hero } = dungeon(3);
    const sword = makeItem(sim, "test.item.sword", "normal", { dur: { cur: 60, max: 60 } });
    const cap = makeItem(sim, "test.item.cap"); // no dur yet: counts as full
    const boots = makeItem(sim, "test.wa.boots", "normal", { dur: { cur: 40, max: 40 } });
    const ring = makeItem(sim, "test.item.ring");
    equipDirect(sim, hero, "weapon", sword);
    equipDirect(sim, hero, "helm", cap);
    equipDirect(sim, hero, "boots", boots);
    equipDirect(sim, hero, "ring1", ring);

    for (let i = 0; i < 7; i++) kill(sim, [death()]);
    // Summons and monster-credited deaths do not count.
    kill(sim, [death({ rarity: "summon" }), death({ creditTeam: "monster" })]);
    let eq = sim.world.read(hero, Equipment);
    expect(eq.weapon!.dur).toEqual({ cur: 60, max: 60 });
    expect(eq.helm!.dur).toBeUndefined();
    expect(sim.world.getResource<{ kills: number }>(WEAR_RES)!.kills).toBe(7);

    kill(sim, [death()]);
    eq = sim.world.read(hero, Equipment);
    expect(eq.weapon!.dur).toEqual({ cur: 59, max: 60 });
    const helmLost = eq.helm!.dur ? 50 - eq.helm!.dur.cur : 0;
    const bootsLost = 40 - eq.boots!.dur!.cur;
    expect(helmLost + bootsLost).toBe(1);
    if (helmLost === 1) expect(eq.helm!.dur).toEqual({ cur: 49, max: 50 });
    expect(eq.ring1!.dur).toBeUndefined();
    expect(sim.world.getResource<{ kills: number }>(WEAR_RES)!.kills).toBe(0);

    // 16 kills in one tick = two wear steps.
    kill(
      sim,
      Array.from({ length: 16 }, () => death()),
    );
    expect(sim.world.read(hero, Equipment).weapon!.dur!.cur).toBe(57);
  });

  it("a hero death costs every equipped item 10 % of its max (min 1)", () => {
    const { sim, hero } = dungeon(4);
    equipDirect(
      sim,
      hero,
      "weapon",
      makeItem(sim, "test.item.sword", "normal", { dur: { cur: 60, max: 60 } }),
    );
    equipDirect(
      sim,
      hero,
      "boots",
      makeItem(sim, "test.wa.boots", "normal", { dur: { cur: 5, max: 5 } }),
    );
    equipDirect(sim, hero, "ring1", makeItem(sim, "test.item.ring"));
    kill(sim, [
      death({ entity: hero, isHero: true, team: "hero", creditTeam: "monster", rarity: "hero" }),
    ]);
    const eq = sim.world.read(hero, Equipment);
    expect(eq.weapon!.dur).toEqual({ cur: 54, max: 60 });
    expect(eq.boots!.dur).toEqual({ cur: 4, max: 5 });
    expect(eq.ring1!.dur).toBeUndefined();
  });

  it("warns once at <= 10 % and breaks at 0; broken items keep their slot", () => {
    const { sim, hero } = dungeon(5);
    const sword = makeItem(sim, "test.item.sword", "normal", { dur: { cur: 8, max: 60 } });
    equipDirect(sim, hero, "weapon", sword);
    const heroDeath = death({
      entity: hero,
      isHero: true,
      team: "hero",
      creditTeam: "monster",
      rarity: "hero",
    });

    let ev = kill(sim, [heroDeath]); // 8 -> 2 (<= 6): worn
    expect(ofType(ev, "classic.item.worn")).toEqual([
      { type: "classic.item.worn", uid: sword.uid, slot: "weapon", name: "Test Sword" },
    ]);
    ev = kill(
      sim,
      Array.from({ length: 8 }, () => death()),
    ); // 2 -> 1: no second warning
    expect(ofType(ev, "classic.item.worn")).toEqual([]);
    expect(sim.world.read(hero, Equipment).weapon!.dur!.cur).toBe(1);
    ev = kill(sim, [heroDeath]); // 1 -> 0: broken
    expect(ofType(ev, "classic.item.broken")).toEqual([
      { type: "classic.item.broken", uid: sword.uid, slot: "weapon", name: "Test Sword" },
    ]);
    const eq = sim.world.read(hero, Equipment);
    expect(eq.weapon!.uid).toBe(sword.uid);
    expect(eq.weapon!.dur!.cur).toBe(0);
    // Broken items do not wear further and emit nothing more.
    ev = kill(sim, [heroDeath, ...Array.from({ length: 8 }, () => death())]);
    expect(ofType(ev, "classic.item.broken")).toEqual([]);
  });

  it("a breaking set piece drops the set bonus (event)", () => {
    const { sim, hero } = dungeon(6);
    equipDirect(
      sim,
      hero,
      "helm",
      setPiece(sim, "test.setItem.wolf_cap", { dur: { cur: 1, max: 50 } }),
    );
    equipDirect(sim, hero, "ring1", setPiece(sim, "test.setItem.wolf_band"));
    const ev = kill(sim, [
      death({ entity: hero, isHero: true, team: "hero", creditTeam: "monster", rarity: "hero" }),
    ]);
    expect(ofType(ev, "classic.set.bonus").map((e) => [e.pieces, e.active])).toEqual([[1, 0]]);
  });

  it("does nothing without an economy, a hero or deaths", () => {
    const { sim } = dungeon(7);
    const before = sim.hash();
    sim.step(0);
    expect(sim.hash()).toBe(before);
    expect(sim.world.getResource(WEAR_RES)).toBeUndefined();
  });

  it("broken items give no stats in classic.progression.stats", () => {
    const { sim, hero } = dungeon(8, ["classic.progression"]);
    const plate = makeItem(sim, "test.wa.plate", "normal", {
      dur: { cur: 1, max: 70 },
      mods: [{ stat: "life", value: 30 }],
    });
    equipDirect(sim, hero, "armor", plate);
    sim.step(1);
    const armorWith = sim.world.read(hero, CombatStats).armor;
    const lifeWith = sim.world.read(hero, HeroStats).lifeMax;
    equipDirect(sim, hero, "armor", { ...plate, dur: { cur: 0, max: 70 } });
    sim.step(1);
    const armorBroken = sim.world.read(hero, CombatStats).armor;
    expect(armorWith - armorBroken).toBeGreaterThanOrEqual(20);
    expect(lifeWith - sim.world.read(hero, HeroStats).lifeMax).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Gambling
// ---------------------------------------------------------------------------

describe("classic.gamble", () => {
  it("buys a random item of the category at the hero level into the bag", () => {
    const { sim, hero, gambler } = town(1, 5000, 2);
    const price = gamblePrice(WAVE_ECONOMY, "weapon", 2)!;
    expect(price).toBe(Math.floor((220 * 124) / 100));
    const ev = act(sim, ACTION.gamble, { npc: gambler, category: "weapon" });
    expect(sim.world.read(hero, Wallet).gold).toBe(5000 - price);
    const bag = sim.world.read(hero, Inventory).items;
    expect(bag.length).toBe(1);
    const it = bag[0]!.item;
    expect(reg(sim).require<ItemBaseProto>(KIND.itemBase, it.base).category).toBe("weapon");
    expect(it.ilvl).toBe(2);
    expect(it.rarity).not.toBe("normal");
    const g = ofType(ev, "classic.gambled");
    expect(g.length).toBe(1);
    expect(g[0]).toMatchObject({
      npc: "test.npc.gambler",
      category: "weapon",
      price,
      name: it.name,
    });
    expect(stats(sim).gambles).toBe(1);
    expect(stats(sim).goldSpent).toBe(price);
  });

  it("rarity follows EconomyProto.gamble.weights (seeded)", () => {
    const { sim, hero, gambler } = town(21, 10_000_000, 30);
    const counts: Record<string, number> = { normal: 0, magic: 0, rare: 0, set: 0, unique: 0 };
    for (let i = 0; i < 300; i++) {
      expect(sim.dispatch(ACTION.gamble, { npc: gambler, category: "ring" }, null).ok).toBe(true);
      const item = sim.world.read(hero, Inventory).items[0]!.item;
      counts[item.rarity]!++;
      sim.world.update(hero, Inventory, { items: [] });
    }
    expect(counts.normal).toBe(0);
    // weights 700 / 250 / 30 / 20: unique and set rings exist (test band, wolf band).
    expect(counts.magic!).toBeGreaterThan(170);
    expect(counts.rare!).toBeGreaterThan(45);
    expect(counts.rare!).toBeLessThan(110);
    expect(counts.set! + counts.unique!).toBeGreaterThan(3);
    expect(stats(sim).gambles).toBe(300);
    expect(stats(sim).uniquesFound ?? 0).toBe(counts.unique);
    expect(stats(sim).setItemsFound ?? 0).toBe(counts.set);
  });

  it("rejects bad npcs, categories, distance, town, gold and a full bag without paying", () => {
    const { sim, hero, gambler, smith } = town(2, 5000, 1);
    rejects(sim, ACTION.gamble, { npc: smith, category: "weapon" }, "not_gambler");
    rejects(sim, ACTION.gamble, { npc: gambler, category: "shield" }, "not_gambler");
    rejects(sim, ACTION.gamble, { npc: gambler, category: "boots" }, "not_gambler"); // priced, not offered
    rejects(sim, ACTION.gamble, { npc: gambler, category: "sword" }, "bad_payload");
    rejects(sim, ACTION.gamble, { npc: 999999, category: "weapon" }, "bad_target");
    rejects(sim, ACTION.gamble, { npc: gambler }, "bad_payload");

    sim.world.update(hero, Wallet, { gold: 10 });
    rejects(sim, ACTION.gamble, { npc: gambler, category: "ring" }, "no_gold");
    sim.world.update(hero, Wallet, { gold: 5000 });

    // A bag with a single 1x1 hole: rings fit, swords (1x3) do not.
    const bag = sim.world.read(hero, Inventory);
    const items = [];
    for (let y = 0; y < bag.rows; y++)
      for (let x = 0; x < bag.cols; x++)
        if (x !== 0 || y !== 0) items.push({ item: makeItem(sim, "test.item.ring"), x, y });
    sim.world.update(hero, Inventory, { items });
    rejects(sim, ACTION.gamble, { npc: gambler, category: "weapon" }, "bag_full");
    expect(sim.dispatch(ACTION.gamble, { npc: gambler, category: "ring" }, null).ok).toBe(true);

    const far = sim.world.read(gambler, Pos);
    sim.world.update(gambler, Pos, { x: far.x + tileCenter(10), y: far.y });
    rejects(sim, ACTION.gamble, { npc: gambler, category: "ring" }, "too_far");
  });

  it("is town only and runs as a command (failures reported)", () => {
    const { sim, hero, gambler } = town(3, 5000, 1);
    pushCommand(sim.world, { op: "gamble", npc: gambler, category: "helm" });
    pushCommand(sim.world, { op: "gamble", npc: gambler, category: "shield" });
    const ev = sim.step(1);
    expect(ofType(ev, "classic.gambled").length).toBe(1);
    expect(ofType(ev, "classic.command.failed")).toMatchObject([
      { op: "gamble", code: "not_gambler" },
    ]);
    expect(sim.world.read(hero, Inventory).items.length).toBe(1);
    useOpenMap(sim, 1);
    rejects(sim, ACTION.gamble, { npc: gambler, category: "helm" }, "not_in_town");
  });
});

// ---------------------------------------------------------------------------
// Stash tabs
// ---------------------------------------------------------------------------

describe("stash tabs", () => {
  it("puts into the first tab with room, or an explicit tab; full tabs and bad tabs fail", () => {
    const { sim, hero } = town(4);
    // 3 tabs x 2 items in this content.
    const rings = Array.from({ length: 7 }, (_, i) => {
      const r = makeItem(sim, "test.item.ring");
      putInBag(sim, hero, r, i, 0);
      return r;
    });
    const put = (uid: number, tab?: number) =>
      sim.dispatch(ACTION.stashPut, tab === undefined ? { uid } : { uid, tab }, null);
    expect(put(rings[0]!.uid).ok).toBe(true);
    expect(put(rings[1]!.uid, 2).ok).toBe(true);
    expect(put(rings[2]!.uid).ok).toBe(true);
    expect(put(rings[3]!.uid).ok).toBe(true); // tab 0 full -> tab 1
    rejects(sim, ACTION.stashPut, { uid: rings[4]!.uid, tab: 0 }, "stash_full");
    rejects(sim, ACTION.stashPut, { uid: rings[4]!.uid, tab: 3 }, "bad_tab");
    rejects(sim, ACTION.stashPut, { uid: rings[4]!.uid, tab: -1 }, "bad_payload");
    expect(put(rings[4]!.uid).ok).toBe(true); // tab 1
    expect(put(rings[5]!.uid).ok).toBe(true); // tab 2
    rejects(sim, ACTION.stashPut, { uid: rings[6]!.uid }, "stash_full");

    const tabs = stashOf(sim.world).items.map((i) => [i.uid, i.tab ?? 0]);
    expect(tabs).toEqual([
      [rings[0]!.uid, 0],
      [rings[1]!.uid, 2],
      [rings[2]!.uid, 0],
      [rings[3]!.uid, 1],
      [rings[4]!.uid, 1],
      [rings[5]!.uid, 2],
    ]);
    // Tab 0 is stored without a `tab` field.
    expect("tab" in stashOf(sim.world).items[0]!).toBe(false);
  });

  it("moves items between tabs and takes them out without their tab", () => {
    const { sim, hero } = town(5);
    const a = makeItem(sim, "test.item.ring");
    const b = makeItem(sim, "test.item.ring");
    const c = makeItem(sim, "test.item.ring");
    for (const [i, it] of [a, b, c].entries()) putInBag(sim, hero, it, i, 0);
    for (const it of [a, b, c])
      expect(sim.dispatch(ACTION.stashPut, { uid: it.uid }, null).ok).toBe(true);
    // a, b in tab 0; c in tab 1.
    const ev = act(sim, ACTION.stashMove, { uid: a.uid, tab: 2 });
    expect(ofType(ev, "classic.stash.moved")).toEqual([
      { type: "classic.stash.moved", uid: a.uid, tab: 2 },
    ]);
    expect(stashOf(sim.world).items.find((i) => i.uid === a.uid)!.tab).toBe(2);
    rejects(sim, ACTION.stashMove, { uid: a.uid, tab: 2 }, "bad_tab"); // same tab
    rejects(sim, ACTION.stashMove, { uid: a.uid, tab: 9 }, "bad_tab");
    rejects(sim, ACTION.stashMove, { uid: 424242, tab: 1 }, "unknown_id");
    expect(sim.dispatch(ACTION.stashMove, { uid: b.uid, tab: 1 }, null).ok).toBe(true);
    rejects(sim, ACTION.stashMove, { uid: a.uid, tab: 1 }, "stash_full");

    expect(sim.dispatch(ACTION.stashTake, { uid: a.uid }, null).ok).toBe(true);
    const back = sim.world.read(hero, Inventory).items.find((e) => e.item.uid === a.uid)!;
    expect(back.item.tab).toBeUndefined();
    expect("tab" in back.item).toBe(false);

    // Command path.
    pushCommand(sim.world, { op: "stashMove", uid: b.uid, tab: 0 });
    pushCommand(sim.world, { op: "stashMove", uid: b.uid, tab: 7 });
    const ev2 = sim.step(1);
    expect(ofType(ev2, "classic.stash.moved").length).toBe(1);
    expect(ofType(ev2, "classic.command.failed")).toMatchObject([
      { op: "stashMove", code: "bad_tab" },
    ]);
  });

  it("needs the stash in reach and the town", () => {
    const { sim, hero, stash } = town(6);
    const a = makeItem(sim, "test.item.ring");
    putInBag(sim, hero, a, 0, 0);
    expect(sim.dispatch(ACTION.stashPut, { uid: a.uid }, null).ok).toBe(true);
    const p = sim.world.read(stash, Pos);
    sim.world.update(stash, Pos, { x: p.x + tileCenter(10), y: p.y });
    rejects(sim, ACTION.stashMove, { uid: a.uid, tab: 1 }, "too_far");
  });

  it("grants to the stash fill the first tab with room and sell the overflow", () => {
    const { sim, hero } = town(7, 0);
    pushCommand(sim.world, {
      op: "grantItems",
      count: 8,
      ilvl: 3,
      minRarity: "set",
      category: "ring",
      toStash: true,
      reason: "test",
    });
    const ev = sim.step(1);
    const items = stashOf(sim.world).items;
    expect(items.length).toBe(6);
    expect(items.map((i) => i.tab ?? 0)).toEqual([0, 0, 1, 1, 2, 2]);
    for (const it of items) {
      expect(["set", "unique"]).toContain(it.rarity);
      expect(reg(sim).require<ItemBaseProto>(KIND.itemBase, it.base).category).toBe("ring");
    }
    const found = (stats(sim).uniquesFound ?? 0) + (stats(sim).setItemsFound ?? 0);
    expect(found).toBe(6);
    expect(ofType(ev, "classic.gold").length).toBe(2);
    expect(sim.world.read(hero, Wallet).gold).toBeGreaterThan(0);
  });

  it("an old single-list stash keeps working (items without tab are tab 0)", () => {
    const { sim, hero } = town(8);
    const old = makeItem(sim, "test.item.ring");
    sim.world.setResource<StashState>(RES.stash, { items: [old, makeItem(sim, "test.item.ring")] });
    const a = makeItem(sim, "test.item.ring");
    putInBag(sim, hero, a, 0, 0);
    expect(sim.dispatch(ACTION.stashPut, { uid: a.uid }, null).ok).toBe(true);
    expect(stashOf(sim.world).items.find((i) => i.uid === a.uid)!.tab).toBe(1);
    expect(sim.dispatch(ACTION.stashTake, { uid: old.uid }, null).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Loot filter
// ---------------------------------------------------------------------------

describe("classic.setLootFilter", () => {
  it("creates the filter lazily, merges partial patches and emits the change", () => {
    const sim = waveSim(1);
    expect(sim.world.getResource(RES.lootFilter)).toBeUndefined();
    expect(lootFilterOf(sim.world)).toEqual(DEFAULT_LOOT_FILTER);
    const r = sim.dispatch(
      ACTION.setLootFilter,
      { filter: { minRarity: { ring: "rare", weapon: "none" }, minGold: 25 } },
      null,
    );
    expect(r.ok).toBe(true);
    expect(ofType(r.events, "classic.lootFilter.changed").length).toBe(1);
    const f = sim.world.getResource<LootFilter>(RES.lootFilter)!;
    expect(f.minRarity.ring).toBe("rare");
    expect(f.minRarity.weapon).toBe("none");
    expect(f.minRarity.helm).toBe("normal");
    expect(f.minGold).toBe(25);
    expect(f.showGold).toBe(true);
    expect(
      sim.dispatch(
        ACTION.setLootFilter,
        { filter: { showPotions: false, minRarity: { ring: "set" } } },
        null,
      ).ok,
    ).toBe(true);
    const g = sim.world.getResource<LootFilter>(RES.lootFilter)!;
    expect(g.minRarity.ring).toBe("set");
    expect(g.minRarity.weapon).toBe("none");
    expect(g.showPotions).toBe(false);
    expect(g.minGold).toBe(25);
    // The default object is never mutated.
    expect(DEFAULT_LOOT_FILTER.minRarity.ring).toBe("normal");
  });

  it("rejects unknown keys, categories and bad values with an unchanged world", () => {
    const sim = waveSim(2);
    const bad = [
      null,
      [],
      { filter: null },
      { filter: [] },
      { filter: {}, extra: 1 },
      { filter: { colour: "red" } },
      { filter: { minRarity: { sword: "rare" } } },
      { filter: { minRarity: { ring: "epic" } } },
      { filter: { minRarity: { ring: 2 } } },
      { filter: { minRarity: "rare" } },
      { filter: { minGold: -1 } },
      { filter: { minGold: 1.5 } },
      { filter: { minGold: 1_000_001 } },
      { filter: { minGold: "5" } },
      { filter: { showGold: 1 } },
      { filter: { showPotions: "no" } },
    ];
    for (const p of bad) rejects(sim, ACTION.setLootFilter, p, "bad_payload");
    expect(sim.dispatch(ACTION.setLootFilter, { filter: { minGold: 1_000_000 } }, null).ok).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// RunStats counters
// ---------------------------------------------------------------------------

describe("RunStats counters", () => {
  it("counts uniques and set items picked up and gold spent at vendors", () => {
    const { sim, hero } = dungeon(9);
    const put = (item: ItemInstance) => {
      const e = sim.world.create();
      sim.world.add(e, Loot, { kind: "item", item, gold: 0, potion: "", droppedAt: 0 });
      sim.world.add(e, Pos, { x: tileCenter(5), y: tileCenter(5) });
      sim.world.add(e, AreaTag, { depth: 1 });
      return e;
    };
    const u = put(makeItem(sim, "test.item.ring", "unique", { unique: "test.unique.band" }));
    const s = put(setPiece(sim, "test.setItem.wolf_band"));
    const n = put(makeItem(sim, "test.item.ring", "rare"));
    for (const t of [u, s, n]) pushCommand(sim.world, { op: "pickup", target: t });
    sim.step(1);
    expect(stats(sim).uniquesFound).toBe(1);
    expect(stats(sim).setItemsFound).toBe(1);
    expect(stats(sim).itemsFound).toBe(3);
    expect(sim.world.read(hero, Inventory).items.length).toBe(3);
  });

  it("adds vendor purchases to goldSpent", () => {
    const { sim, hero } = town(10, 1000);
    const alch = spawnNpc(sim, "test.npc.alchemist", 6, 6);
    expect(sim.dispatch(ACTION.buy, { npc: alch, index: 0, potion: "tp", count: 2 }, null).ok).toBe(
      true,
    );
    expect(stats(sim).goldSpent).toBe(2 * TEST_BALANCE.tpScrollPrice);
    expect(sim.world.read(hero, Wallet).gold).toBe(1000 - 2 * TEST_BALANCE.tpScrollPrice);
    expect(bal(sim).stashTabs).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism (wave A items)", () => {
  function script(seed: number): Sim & { results: boolean[] } {
    const { sim, hero, gambler } = town(seed, 20_000, 3);
    const results: boolean[] = [];
    useOpenMap(sim, 1);
    sim.world.update(hero, AreaTag, { depth: 1 });
    equipDirect(
      sim,
      hero,
      "weapon",
      makeItem(sim, "test.item.sword", "normal", { dur: { cur: 60, max: 60 } }),
    );
    equipDirect(sim, hero, "helm", setPiece(sim, "test.setItem.wolf_cap"));
    for (let i = 0; i < 6; i++) {
      kill(sim, [
        death({ rarity: "champion", level: 5 + i }),
        ...Array.from({ length: 5 }, () => death({ level: 3 })),
      ]);
    }
    kill(sim, [
      death({ entity: hero, isHero: true, team: "hero", creditTeam: "monster", rarity: "hero" }),
    ]);
    // Back to town: gamble and stash.
    const area = sim.world.getResource<{ depth: number }>(RES.area)!;
    area.depth = 0;
    sim.world.update(hero, AreaTag, { depth: 0 });
    const run = (name: string, payload: unknown) =>
      results.push(sim.dispatch(name, payload, null).ok);
    for (const c of ["weapon", "ring", "helm", "armor", "shield"] as const) {
      run(ACTION.gamble, { npc: gambler, category: c });
    }
    const first = sim.world.read(hero, Inventory).items[0]!.item.uid;
    run(ACTION.stashPut, { uid: first, tab: 1 });
    run(ACTION.stashMove, { uid: first, tab: 2 });
    run(ACTION.setLootFilter, { filter: { minRarity: { helm: "magic" } } });
    sim.step(10);
    return Object.assign(sim, { results });
  }

  it("the fixed script behaves as scripted", () => {
    const sim = script(7);
    expect(sim.results).toEqual([true, true, true, true, false, true, true, true]);
    const w = sim.world.read(heroOf(sim.world), Equipment).weapon!;
    expect(w.dur!.cur).toBeLessThan(60);
    expect(sim.world.read(heroOf(sim.world), Inventory).items.length).toBe(3);
  });

  it("the same seed and script give the same hash; another seed differs", () => {
    expect(script(7).hash()).toBe(script(7).hash());
    expect(script(7).hash()).not.toBe(script(8).hash());
  });

  it("pins the hash of the fixed script", () => {
    expect(script(7).hash()).toBe("4cc378b41e49a0f5");
  });
});
