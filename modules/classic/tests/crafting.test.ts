/**
 * classic.crafting (docs/design/wave-A.md §5.2-5.4): repair, upgrade,
 * reroll, add socket, socket gem, unsocket, combine gems at the smith, as
 * actions and as commands; every rejection leaves the world unchanged; gold
 * deltas, events, RunStats counters, stats after classic.progression.stats,
 * determinism and a pinned hash.
 *
 * Own content (copy of the items.waveA.test.ts fixture: sets and gems of the
 * real content are written in parallel).
 */
import {
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
  Inventory,
  Npc,
  Pos,
  Wallet,
} from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { modules as classicModules } from "../src/index.ts";
import { rollItem, WEAR_RES, type RollItemOptions } from "../src/items/index.ts";
import { nextUid, RES, type RunStats } from "../src/resources.ts";
import { itemValue, repairCost, rerollCost, upgradeCost } from "../src/rules.ts";
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
import { testContent } from "./support/content.ts";
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

const WAVE_BASES: Record<string, ItemBaseProto> = {
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

const WAVE_SETS: Record<string, SetProto> = {
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

const WAVE_SET_ITEMS: Record<string, SetItemProto> = {
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
const WAVE_ECONOMY: EconomyProto = {
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
  name: "test.wa.croll",
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

const waveContent = defineModule({
  id: "test.wa.craft",
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
    name: "Classic (crafting test)",
    description: "test",
    world: null,
    modules: [
      "classic.core",
      "classic.items",
      "test.content",
      "test.wa.craft",
      "classic.crafting",
      ...extra,
    ],
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
const stats = (sim: Sim) => sim.world.getResource<RunStats>(RES.stats)!;

function roll(sim: Sim, p: RollPayload): ItemInstance[] {
  const r = sim.dispatch("test.wa.croll", p, null);
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

const econ = WAVE_ECONOMY;
const heroDeath = (hero: Entity) =>
  death({ entity: hero, isHero: true, team: "hero", creditTeam: "monster", rarity: "hero" });

/** A smith town; the hero has a lot of gold unless told otherwise. */
function smithTown(seed = 1, gold = 100_000, extra: string[] = []) {
  const sim = waveSim(seed, extra);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0, gold });
  const smith = spawnNpc(sim, "test.npc.smith", 7, 5);
  const junk = spawnNpc(sim, "test.npc.junk", 7, 7);
  return { sim, hero, smith, junk };
}

const gold = (sim: Sim, hero: Entity) => sim.world.read(hero, Wallet).gold;
const bagItem = (sim: Sim, hero: Entity, uid: number) =>
  sim.world.read(hero, Inventory).items.find((e) => e.item.uid === uid)?.item;
const bagBases = (sim: Sim, hero: Entity) =>
  sim.world
    .read(hero, Inventory)
    .items.map((e) => e.item.base)
    .sort();

describe("smith checks shared by every op", () => {
  it("needs the town, a crafting npc in reach and a carried item", () => {
    const { sim, hero, smith, junk } = smithTown(1);
    const sword = makeItem(sim, "test.item.sword", "normal", { dur: { cur: 10, max: 60 } });
    putInBag(sim, hero, sword, 0, 0);
    rejects(sim, ACTION.repair, { npc: junk, uid: sword.uid }, "not_smith");
    rejects(sim, ACTION.upgradeItem, { npc: junk, uid: sword.uid }, "not_smith");
    rejects(sim, ACTION.repair, { npc: smith, uid: 777777 }, "unknown_id");
    rejects(sim, ACTION.repair, { npc: 999999, uid: sword.uid }, "bad_target");
    const floor = sim.world.create();
    sim.world.add(floor, Pos, { x: tileCenter(6), y: tileCenter(6) });
    rejects(sim, ACTION.repair, { npc: floor, uid: sword.uid }, "bad_target");
    rejects(sim, ACTION.repair, { npc: smith, uid: -1 }, "bad_payload");
    rejects(sim, ACTION.repair, { npc: smith }, "bad_payload");
    rejects(sim, ACTION.repair, null, "bad_payload");
    rejects(sim, ACTION.socketGem, { npc: smith, uid: sword.uid, gem: "x" }, "bad_payload");
    rejects(sim, ACTION.combineGems, { npc: smith, base: 3 }, "bad_payload");

    const p = sim.world.read(smith, Pos);
    sim.world.update(smith, Pos, { x: p.x + tileCenter(10), y: p.y });
    rejects(sim, ACTION.repair, { npc: smith, uid: sword.uid }, "too_far");
    sim.world.update(smith, Pos, p);

    useOpenMap(sim, 1);
    rejects(sim, ACTION.repair, { npc: smith, uid: sword.uid }, "not_in_town");
  });
});

describe("repair", () => {
  it("repairs one item for rules.repairCost, pro rata of the missing durability", () => {
    const { sim, hero, smith } = smithTown(2);
    const sword = makeItem(sim, "test.item.sword", "normal", { dur: { cur: 30, max: 60 } });
    putInBag(sim, hero, sword, 0, 0);
    const cost = repairCost(econ, sword);
    expect(cost).toBe(Math.ceil((sword.value * 25 * 30) / (100 * 60)));
    const g0 = gold(sim, hero);
    const ev = act(sim, ACTION.repair, { npc: smith, uid: sword.uid });
    expect(gold(sim, hero)).toBe(g0 - cost);
    expect(bagItem(sim, hero, sword.uid)!.dur).toEqual({ cur: 60, max: 60 });
    expect(ofType(ev, "classic.repaired")).toEqual([
      { type: "classic.repaired", uids: [sword.uid], cost },
    ]);
    expect(stats(sim).goldSpent).toBe(cost);
    expect(stats(sim).itemsCrafted ?? 0).toBe(0);
    rejects(sim, ACTION.repair, { npc: smith, uid: sword.uid }, "no_repair_needed");
  });

  it("uid 0 repairs everything worn and carried; rejects when nothing needs it", () => {
    const { sim, hero, smith } = smithTown(3);
    const sword = makeItem(sim, "test.item.sword", "normal", { dur: { cur: 59, max: 60 } });
    const cap = makeItem(sim, "test.item.cap", "normal", { dur: { cur: 0, max: 50 } });
    const boots = makeItem(sim, "test.wa.boots", "normal", { dur: { cur: 10, max: 40 } });
    const fresh = makeItem(sim, "test.wa.boots");
    equipDirect(sim, hero, "weapon", sword);
    equipDirect(sim, hero, "helm", cap);
    equipDirect(sim, hero, "ring1", makeItem(sim, "test.item.ring"));
    putInBag(sim, hero, boots, 0, 0);
    putInBag(sim, hero, fresh, 2, 0);
    const total = repairCost(econ, sword) + repairCost(econ, cap) + repairCost(econ, boots);
    const g0 = gold(sim, hero);
    const ev = act(sim, ACTION.repair, { npc: smith, uid: 0 });
    expect(ofType(ev, "classic.repaired")).toEqual([
      { type: "classic.repaired", uids: [sword.uid, cap.uid, boots.uid], cost: total },
    ]);
    expect(gold(sim, hero)).toBe(g0 - total);
    const eq = sim.world.read(hero, Equipment);
    expect(eq.weapon!.dur!.cur).toBe(60);
    expect(eq.helm!.dur!.cur).toBe(50);
    expect(eq.helm!.uid).toBe(cap.uid);
    expect(bagItem(sim, hero, boots.uid)!.dur!.cur).toBe(40);
    rejects(sim, ACTION.repair, { npc: smith, uid: 0 }, "no_repair_needed");
  });

  it("rejects indestructible items and too little gold", () => {
    const { sim, hero, smith } = smithTown(4, 1);
    const ring = makeItem(sim, "test.item.ring");
    const sword = makeItem(sim, "test.item.sword", "normal", { dur: { cur: 0, max: 60 } });
    putInBag(sim, hero, ring, 0, 0);
    putInBag(sim, hero, sword, 1, 0);
    rejects(sim, ACTION.repair, { npc: smith, uid: ring.uid }, "indestructible");
    rejects(sim, ACTION.repair, { npc: smith, uid: sword.uid }, "no_gold");
    rejects(sim, ACTION.repair, { npc: smith, uid: 0 }, "no_gold");
  });

  it("repair restores stats and set bonuses, and re-arms the worn warning", () => {
    const { sim, hero, smith } = smithTown(5, 100_000, ["classic.progression"]);
    useOpenMap(sim, 1);
    sim.world.update(hero, AreaTag, { depth: 1 });
    const cap = setPiece(sim, "test.setItem.wolf_cap", { dur: { cur: 5, max: 50 } });
    equipDirect(sim, hero, "helm", cap);
    equipDirect(sim, hero, "ring1", setPiece(sim, "test.setItem.wolf_band"));
    sim.step(1);
    const lifeFull = sim.world.read(hero, HeroStats).lifeMax;
    // A death: 5 -> 0, broken: the cap and the 2-piece bonus (+10 life) are gone.
    let ev = kill(sim, [heroDeath(hero)]);
    expect(ofType(ev, "classic.item.broken").length).toBe(1);
    expect(ofType(ev, "classic.set.bonus").map((e) => e.active)).toEqual([0]);
    sim.step(1);
    expect(sim.world.read(hero, HeroStats).lifeMax).toBe(lifeFull - 10);

    const area = sim.world.getResource<{ depth: number }>(RES.area)!;
    area.depth = 0;
    sim.world.update(hero, AreaTag, { depth: 0 });
    ev = act(sim, ACTION.repair, { npc: smith, uid: cap.uid });
    expect(ofType(ev, "classic.set.bonus").map((e) => [e.pieces, e.active])).toEqual([[2, 1]]);
    sim.step(1);
    expect(sim.world.read(hero, HeroStats).lifeMax).toBe(lifeFull);

    // Worn again later: the warning fires again because repair cleared it.
    sim.world.update(hero, Equipment, { helm: { ...cap, dur: { cur: 6, max: 50 } } });
    ev = kill(sim, [heroDeath(hero)]);
    expect(ofType(ev, "classic.item.worn").length).toBe(1);
    expect(sim.world.getResource<{ warned: number[] }>(WEAR_RES)!.warned).toEqual([cap.uid]);
    sim.world.update(hero, Equipment, { helm: { ...cap, dur: { cur: 1, max: 50 } } });
    act(sim, ACTION.repair, { npc: smith, uid: 0 });
    expect(sim.world.getResource<{ warned: number[] }>(WEAR_RES)!.warned).toEqual([]);
  });
});

describe("upgrade", () => {
  it("upgrades +1 for upgradeCost at 100 % from level 0, renames, keeps the slot", () => {
    const { sim, hero, smith } = smithTown(6, 100_000, ["classic.progression"]);
    const plate = makeItem(sim, "test.wa.plate");
    equipDirect(sim, hero, "armor", plate);
    sim.step(1);
    const armor0 = sim.world.read(hero, CombatStats).armor;
    const cost = upgradeCost(econ, plate)!;
    expect(cost).toBe(Math.floor((plate.value * 40) / 100));
    const g0 = gold(sim, hero);
    const ev = act(sim, ACTION.upgradeItem, { npc: smith, uid: plate.uid });
    expect(gold(sim, hero)).toBe(g0 - cost);
    const up = sim.world.read(hero, Equipment).armor!;
    expect(up.uid).toBe(plate.uid);
    expect(up.upgrade).toBe(1);
    expect(up.name).toBe("Test Plate +1");
    expect(ofType(ev, "classic.upgraded")).toEqual([
      {
        type: "classic.upgraded",
        uid: plate.uid,
        name: "Test Plate +1",
        level: 1,
        success: true,
        cost,
      },
    ]);
    expect(stats(sim).itemsCrafted).toBe(1);
    expect(stats(sim).goldSpent).toBe(cost);
    sim.step(1);
    // +12 % of 20 base armor = 3 (rules.upgradeMods).
    expect(sim.world.read(hero, CombatStats).armor).toBeGreaterThan(armor0);
  });

  it("failures spend the gold and keep the item; names track the level; max level rejects", () => {
    const { sim, hero, smith } = smithTown(7, 10_000_000);
    const sword = makeItem(sim, "test.item.sword");
    putInBag(sim, hero, sword, 0, 0);
    let tries = 0;
    let fails = 0;
    while ((bagItem(sim, hero, sword.uid)!.upgrade ?? 0) < 5) {
      const before = bagItem(sim, hero, sword.uid)!;
      const cost = upgradeCost(econ, before)!;
      const g0 = gold(sim, hero);
      const ev = act(sim, ACTION.upgradeItem, { npc: smith, uid: sword.uid });
      expect(gold(sim, hero)).toBe(g0 - cost);
      const after = bagItem(sim, hero, sword.uid)!;
      const u = ofType(ev, "classic.upgraded")[0]!;
      if (u.success) {
        expect(after.upgrade).toBe((before.upgrade ?? 0) + 1);
      } else {
        fails++;
        expect(after).toEqual(before);
      }
      expect(after.name).toBe(
        (after.upgrade ?? 0) > 0 ? `Test Sword +${after.upgrade}` : "Test Sword",
      );
      tries++;
      expect(tries).toBeLessThan(200);
    }
    expect(stats(sim).itemsCrafted).toBe(5);
    expect(tries).toBe(5 + fails);
    rejects(sim, ACTION.upgradeItem, { npc: smith, uid: sword.uid }, "max_upgrade");
  });

  it("succeeds with chancePct[L] (seeded) and rejects gems and too little gold", () => {
    const { sim, hero, smith } = smithTown(8, 100_000_000);
    let ok = 0;
    for (let i = 0; i < 200; i++) {
      const sword = makeItem(sim, "test.item.sword", "normal", { upgrade: 4 });
      sim.world.update(hero, Inventory, { items: [{ item: sword, x: 0, y: 0 }] });
      const ev = act(sim, ACTION.upgradeItem, { npc: smith, uid: sword.uid });
      if (ofType(ev, "classic.upgraded")[0]!.success) ok++;
    }
    expect(ok).toBeGreaterThan(55); // 40 % of 200 = 80
    expect(ok).toBeLessThan(105);

    const gemItem = makeItem(sim, "test.item.gem_ruby_1");
    putInBag(sim, hero, gemItem, 3, 0);
    rejects(sim, ACTION.upgradeItem, { npc: smith, uid: gemItem.uid }, "bad_target");
    sim.world.update(hero, Wallet, { gold: 0 });
    const s2 = makeItem(sim, "test.item.sword");
    putInBag(sim, hero, s2, 5, 0);
    rejects(sim, ACTION.upgradeItem, { npc: smith, uid: s2.uid }, "no_gold");
  });
});

describe("reroll", () => {
  it("rerolls magic and rare affixes for the same base and ilvl; the price grows", () => {
    const { sim, hero, smith } = smithTown(9);
    const [magic] = roll(sim, {
      count: 1,
      ilvl: 5,
      rarity: "magic",
      magicFind: 0,
      base: "test.item.cap",
    });
    putInBag(sim, hero, magic!, 0, 0);
    const c1 = rerollCost(econ, magic!)!;
    expect(c1).toBe(Math.floor((magic!.value * 60) / 100));
    const g0 = gold(sim, hero);
    const ev = act(sim, ACTION.rerollItem, { npc: smith, uid: magic!.uid });
    expect(gold(sim, hero)).toBe(g0 - c1);
    const r1 = bagItem(sim, hero, magic!.uid)!;
    expect(r1.rerolls).toBe(1);
    expect(r1.base).toBe(magic!.base);
    expect(r1.ilvl).toBe(magic!.ilvl);
    expect(r1.rarity).toBe("magic");
    expect(r1.affixes.length).toBeGreaterThanOrEqual(1);
    expect(r1.affixes.length).toBeLessThanOrEqual(2);
    expect(ofType(ev, "classic.rerolled")).toEqual([
      { type: "classic.rerolled", uid: magic!.uid, name: r1.name, cost: c1 },
    ]);
    const c2 = rerollCost(econ, r1)!;
    expect(c2).toBe(2 * c1);
    act(sim, ACTION.rerollItem, { npc: smith, uid: magic!.uid });
    expect(gold(sim, hero)).toBe(g0 - c1 - c2);
    expect(stats(sim).itemsCrafted).toBe(2);
    expect(stats(sim).goldSpent).toBe(c1 + c2);
  });

  it("rares get a new rare name and keep their upgrade suffix and sockets", () => {
    const { sim, hero, smith } = smithTown(10);
    const [rare] = roll(sim, {
      count: 1,
      ilvl: 5,
      rarity: "rare",
      magicFind: 0,
      base: "test.item.sword",
    });
    const item = {
      ...rare!,
      upgrade: 2,
      name: `${rare!.name} +2`,
      sockets: ["test.item.gem_ruby_1", null],
    };
    equipDirect(sim, hero, "weapon", item);
    act(sim, ACTION.rerollItem, { npc: smith, uid: item.uid });
    const after = sim.world.read(hero, Equipment).weapon!;
    expect(after.name).toMatch(/^(Grim|Pale) (Fang|Shade) \+2$/);
    expect(after.upgrade).toBe(2);
    expect(after.sockets).toEqual(["test.item.gem_ruby_1", null]);
    expect(after.affixes.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects normal, set and unique items", () => {
    const { sim, hero, smith } = smithTown(11);
    const n = makeItem(sim, "test.item.sword");
    const s = setPiece(sim, "test.setItem.wolf_band");
    const u = makeItem(sim, "test.item.ring", "unique", { unique: "test.unique.band" });
    putInBag(sim, hero, n, 0, 0);
    putInBag(sim, hero, s, 1, 0);
    putInBag(sim, hero, u, 2, 0);
    for (const it of [n, s, u]) {
      rejects(sim, ACTION.rerollItem, { npc: smith, uid: it.uid }, "not_rerollable");
    }
  });
});

describe("sockets and gems", () => {
  it("adds sockets for addCost[n] up to rules.maxSocketsOf", () => {
    const { sim, hero, smith } = smithTown(12);
    const sword = makeItem(sim, "test.item.sword");
    const ring = makeItem(sim, "test.item.ring");
    const gemItem = makeItem(sim, "test.item.gem_ruby_1");
    putInBag(sim, hero, sword, 0, 0);
    putInBag(sim, hero, ring, 1, 0);
    putInBag(sim, hero, gemItem, 2, 0);
    const g0 = gold(sim, hero);
    let ev = act(sim, ACTION.addSocket, { npc: smith, uid: sword.uid });
    expect(ofType(ev, "classic.socket.added")).toEqual([
      { type: "classic.socket.added", uid: sword.uid, sockets: 1, cost: 150 },
    ]);
    ev = act(sim, ACTION.addSocket, { npc: smith, uid: sword.uid });
    expect(ofType(ev, "classic.socket.added")[0]!.cost).toBe(600);
    expect(bagItem(sim, hero, sword.uid)!.sockets).toEqual([null, null]);
    expect(gold(sim, hero)).toBe(g0 - 750);
    rejects(sim, ACTION.addSocket, { npc: smith, uid: sword.uid }, "max_sockets");
    act(sim, ACTION.addSocket, { npc: smith, uid: ring.uid });
    rejects(sim, ACTION.addSocket, { npc: smith, uid: ring.uid }, "max_sockets");
    rejects(sim, ACTION.addSocket, { npc: smith, uid: gemItem.uid }, "max_sockets");
    expect(stats(sim).itemsCrafted).toBe(3);
    sim.world.update(hero, Wallet, { gold: 10 });
    const cap = makeItem(sim, "test.item.cap");
    putInBag(sim, hero, cap, 4, 0);
    rejects(sim, ACTION.addSocket, { npc: smith, uid: cap.uid }, "no_gold");
  });

  it("socket gems into the first empty socket for free; gem stats apply when equipped", () => {
    const { sim, hero, smith } = smithTown(13, 1000, ["classic.progression"]);
    const cap = makeItem(sim, "test.item.cap", "normal", { sockets: [null, null] });
    const plain = makeItem(sim, "test.wa.boots");
    const r2 = makeItem(sim, "test.item.gem_ruby_2");
    const s1 = makeItem(sim, "test.item.gem_sapphire_1");
    const r1 = makeItem(sim, "test.item.gem_ruby_1");
    equipDirect(sim, hero, "helm", cap);
    putInBag(sim, hero, plain, 0, 0);
    putInBag(sim, hero, r2, 2, 0);
    putInBag(sim, hero, s1, 3, 0);
    putInBag(sim, hero, r1, 4, 0);
    sim.step(1);
    const life0 = sim.world.read(hero, HeroStats).lifeMax;
    const g0 = gold(sim, hero);

    let ev = act(sim, ACTION.socketGem, { npc: smith, uid: cap.uid, gem: r2.uid });
    expect(ofType(ev, "classic.gem.socketed")).toEqual([
      { type: "classic.gem.socketed", uid: cap.uid, gem: "test.item.gem_ruby_2", slot: 0 },
    ]);
    expect(bagItem(sim, hero, r2.uid)).toBeUndefined();
    ev = act(sim, ACTION.socketGem, { npc: smith, uid: cap.uid, gem: s1.uid });
    expect(ofType(ev, "classic.gem.socketed")[0]!.slot).toBe(1);
    expect(sim.world.read(hero, Equipment).helm!.sockets).toEqual([
      "test.item.gem_ruby_2",
      "test.item.gem_sapphire_1",
    ]);
    expect(gold(sim, hero)).toBe(g0);
    expect(stats(sim).gemsSocketed).toBe(2);
    sim.step(1);
    // Ruby tier 2 in armor: +10 life.
    expect(sim.world.read(hero, HeroStats).lifeMax).toBe(life0 + 10);

    rejects(sim, ACTION.socketGem, { npc: smith, uid: cap.uid, gem: r1.uid }, "sockets_full");
    rejects(sim, ACTION.socketGem, { npc: smith, uid: plain.uid, gem: r1.uid }, "no_sockets");
    rejects(sim, ACTION.socketGem, { npc: smith, uid: cap.uid, gem: plain.uid }, "not_gem");
    rejects(sim, ACTION.socketGem, { npc: smith, uid: r1.uid, gem: r1.uid }, "not_gem");
    rejects(sim, ACTION.socketGem, { npc: smith, uid: cap.uid, gem: 555555 }, "not_gem");
  });

  it("unsockets every gem into the bag for unsocketCost, all or nothing", () => {
    const { sim, hero, smith } = smithTown(14);
    const sword = makeItem(sim, "test.item.sword", "normal", {
      sockets: ["test.item.gem_ruby_3", null],
    });
    const cap = makeItem(sim, "test.item.cap", "normal", {
      sockets: ["test.item.gem_ruby_1", "test.item.gem_sapphire_2"],
    });
    const bare = makeItem(sim, "test.wa.boots");
    const empty = makeItem(sim, "test.wa.boots", "normal", { sockets: [null] });
    equipDirect(sim, hero, "weapon", sword);
    putInBag(sim, hero, cap, 0, 0);
    putInBag(sim, hero, bare, 2, 0);
    putInBag(sim, hero, empty, 4, 0);
    const g0 = gold(sim, hero);
    const ev = act(sim, ACTION.unsocketGems, { npc: smith, uid: sword.uid });
    expect(ofType(ev, "classic.gems.removed")).toEqual([
      { type: "classic.gems.removed", uid: sword.uid, gems: ["test.item.gem_ruby_3"], cost: 250 },
    ]);
    expect(gold(sim, hero)).toBe(g0 - 250);
    expect(sim.world.read(hero, Equipment).weapon!.sockets).toEqual([null, null]);
    expect(bagBases(sim, hero).filter((b) => b.includes("gem"))).toEqual(["test.item.gem_ruby_3"]);
    rejects(sim, ACTION.unsocketGems, { npc: smith, uid: sword.uid }, "empty");
    rejects(sim, ACTION.unsocketGems, { npc: smith, uid: bare.uid }, "no_sockets");
    rejects(
      sim,
      ACTION.unsocketGems,
      { npc: smith, uid: empty.uid },
      "no_sockets".replace("no_sockets", "empty"),
    );

    // Fill the bag except one cell: two gems do not fit -> nothing happens.
    const bag = sim.world.read(hero, Inventory);
    const filled = [...bag.items];
    const taken = new Set<string>();
    for (const e of filled) {
      const b = reg(sim).require<ItemBaseProto>(KIND.itemBase, e.item.base);
      for (let dy = 0; dy < b.size.h; dy++)
        for (let dx = 0; dx < b.size.w; dx++) taken.add(`${e.x + dx},${e.y + dy}`);
    }
    let hole = false;
    for (let y = 0; y < bag.rows; y++)
      for (let x = 0; x < bag.cols; x++) {
        if (taken.has(`${x},${y}`)) continue;
        if (!hole) {
          hole = true;
          continue;
        }
        filled.push({ item: makeItem(sim, "test.item.ring"), x, y });
      }
    sim.world.update(hero, Inventory, { items: filled });
    rejects(sim, ACTION.unsocketGems, { npc: smith, uid: cap.uid }, "bag_full");
  });

  it("combines three gems into the next tier of the same kind", () => {
    const { sim, hero, smith } = smithTown(15);
    const rubies = Array.from({ length: 4 }, () => makeItem(sim, "test.item.gem_ruby_1"));
    rubies.forEach((g, i) => putInBag(sim, hero, g, i, 0));
    const g0 = gold(sim, hero);
    const ev = act(sim, ACTION.combineGems, { npc: smith, base: "test.item.gem_ruby_1" });
    expect(ofType(ev, "classic.gems.combined")).toEqual([
      {
        type: "classic.gems.combined",
        from: "test.item.gem_ruby_1",
        to: "test.item.gem_ruby_2",
        cost: 50,
      },
    ]);
    expect(gold(sim, hero)).toBe(g0 - 50);
    // The three lowest uids are used.
    const left = sim.world.read(hero, Inventory).items.map((e) => e.item);
    expect(left.map((i) => i.base).sort()).toEqual([
      "test.item.gem_ruby_1",
      "test.item.gem_ruby_2",
    ]);
    expect(left.find((i) => i.base === "test.item.gem_ruby_1")!.uid).toBe(rubies[3]!.uid);
    expect(left.find((i) => i.base === "test.item.gem_ruby_2")!.name).toBe("Flawed Ruby");
    expect(stats(sim).itemsCrafted).toBe(1);

    rejects(sim, ACTION.combineGems, { npc: smith, base: "test.item.gem_ruby_1" }, "need_three");
    for (let i = 0; i < 3; i++) putInBag(sim, hero, makeItem(sim, "test.item.gem_ruby_5"), i, 2);
    rejects(sim, ACTION.combineGems, { npc: smith, base: "test.item.gem_ruby_5" }, "max_tier");
    for (let i = 0; i < 3; i++)
      putInBag(sim, hero, makeItem(sim, "test.item.gem_sapphire_2"), i, 3);
    rejects(sim, ACTION.combineGems, { npc: smith, base: "test.item.gem_sapphire_2" }, "max_tier");
    rejects(sim, ACTION.combineGems, { npc: smith, base: "test.item.ring" }, "not_gem");
    rejects(sim, ACTION.combineGems, { npc: smith, base: "nope" }, "not_gem");
    for (let i = 0; i < 3; i++)
      putInBag(sim, hero, makeItem(sim, "test.item.gem_ruby_3"), 4 + i, 3);
    sim.world.update(hero, Wallet, { gold: 449 });
    rejects(sim, ACTION.combineGems, { npc: smith, base: "test.item.gem_ruby_3" }, "no_gold");
  });
});

describe("crafting commands", () => {
  it("runs queued ops in order and reports failures as classic.command.failed", () => {
    const { sim, hero, smith, junk } = smithTown(16);
    const sword = makeItem(sim, "test.item.sword", "normal", { dur: { cur: 1, max: 60 } });
    putInBag(sim, hero, sword, 0, 0);
    for (let i = 0; i < 3; i++)
      putInBag(sim, hero, makeItem(sim, "test.item.gem_ruby_1"), 1 + i, 0);
    pushCommand(sim.world, { op: "repair", npc: smith, uid: sword.uid });
    pushCommand(sim.world, { op: "addSocket", npc: smith, uid: sword.uid });
    pushCommand(sim.world, { op: "upgrade", npc: smith, uid: sword.uid });
    pushCommand(sim.world, { op: "combineGems", npc: smith, base: "test.item.gem_ruby_1" });
    pushCommand(sim.world, { op: "reroll", npc: smith, uid: sword.uid });
    pushCommand(sim.world, { op: "socketGem", npc: junk, uid: sword.uid, gem: 1 });
    pushCommand(sim.world, { op: "unsocket", npc: smith, uid: sword.uid });
    const ev = sim.step(1);
    expect(ofType(ev, "classic.repaired").length).toBe(1);
    expect(ofType(ev, "classic.socket.added").length).toBe(1);
    expect(ofType(ev, "classic.upgraded").length).toBe(1);
    expect(ofType(ev, "classic.gems.combined").length).toBe(1);
    expect(ofType(ev, "classic.command.failed").map((e) => [e.op, e.code])).toEqual([
      ["reroll", "not_rerollable"],
      ["socketGem", "not_smith"],
      ["unsocket", "empty"],
    ]);
    expect(busOf(sim.world).commands.length).toBe(0);
  });
});

describe("determinism (crafting)", () => {
  function script(seed: number): Sim & { results: boolean[] } {
    const { sim, hero, smith } = smithTown(seed, 50_000);
    const results: boolean[] = [];
    const run = (name: string, payload: unknown) =>
      results.push(sim.dispatch(name, payload, null).ok);
    const [rare] = roll(sim, {
      count: 1,
      ilvl: 8,
      rarity: "rare",
      magicFind: 0,
      base: "test.item.sword",
    });
    const worn = { ...rare!, dur: { cur: 12, max: 60 } };
    equipDirect(sim, hero, "weapon", worn);
    for (let i = 0; i < 6; i++) putInBag(sim, hero, makeItem(sim, "test.item.gem_ruby_1"), i, 0);
    run(ACTION.repair, { npc: smith, uid: 0 });
    for (let i = 0; i < 4; i++) run(ACTION.upgradeItem, { npc: smith, uid: worn.uid });
    run(ACTION.rerollItem, { npc: smith, uid: worn.uid });
    run(ACTION.addSocket, { npc: smith, uid: worn.uid });
    run(ACTION.addSocket, { npc: smith, uid: worn.uid });
    run(ACTION.combineGems, { npc: smith, base: "test.item.gem_ruby_1" });
    run(ACTION.combineGems, { npc: smith, base: "test.item.gem_ruby_1" });
    run(ACTION.combineGems, { npc: smith, base: "test.item.gem_ruby_2" });
    const gems = sim.world.read(hero, Inventory).items.filter((e) => e.item.base.includes("gem"));
    run(ACTION.socketGem, { npc: smith, uid: worn.uid, gem: gems[0]!.item.uid });
    run(ACTION.socketGem, { npc: smith, uid: worn.uid, gem: gems[1]?.item.uid ?? 1 });
    run(ACTION.unsocketGems, { npc: smith, uid: worn.uid });
    sim.step(5);
    return Object.assign(sim, { results });
  }

  it("the same seed and script give the same hash; another seed differs", () => {
    expect(script(7).hash()).toBe(script(7).hash());
    expect(script(7).hash()).not.toBe(script(8).hash());
  });

  it("the fixed script behaves as scripted", () => {
    expect(script(7).results).toEqual([...Array(10).fill(true), false, true, true, true]);
  });

  it("pins the hash of the fixed script", () => {
    expect(script(7).hash()).toBe("76e7253db5ed836f");
  });
});
