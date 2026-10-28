/**
 * classic.items: item generation, grid placement, equipment rules, belt and
 * potions, pickup/drop, town vendors and stash, grants, the hero kit, and
 * determinism. Drops from monster deaths live in items.drops.test.ts.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type Entity,
  type Sim,
  type World,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { pushCommand } from "../src/bus.ts";
import {
  AreaTag,
  Belt,
  Body,
  Equipment,
  Interactable,
  Inventory,
  Life,
  Loot,
  Npc,
  Pos,
  Supplies,
  Wallet,
  Dead,
  HeroStats,
  Level,
} from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { modules as classicModules } from "../src/index.ts";
import { itemValue } from "../src/rules.ts";
import { nextUid, RES, stashOf, vendorsOf, type AreaState } from "../src/resources.ts";
import {
  KIND,
  type AffixProto,
  type ItemBaseProto,
  type ItemInstance,
  type ItemRarity,
  type UniqueProto,
} from "../src/types.ts";
import { placeItem, rollItem, type RollItemOptions } from "../src/items/index.ts";
import { ACTION, type ActionPayloads } from "../src/actions.ts";
import { TEST_BALANCE } from "./support/content.ts";
import { testContent } from "./support/content.ts";
import { ensureResources, spawnTestHero, testSim, useOpenMap } from "./support/harness.ts";

// ---------------------------------------------------------------------------
// Extra test content (this file only): more bases, affixes and uniques, and
// a roll action that exposes rollItem() to tests through ctx.
// ---------------------------------------------------------------------------

const CATS = ["weapon", "shield", "helm", "armor", "gloves", "boots", "ring", "amulet"] as const;

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

const affix = (
  name: string,
  kind: "prefix" | "suffix",
  group: string,
  stat: AffixProto["stat"],
  min: number,
  max: number,
  ilvl = 1,
): AffixProto => ({ name, kind, group, stat, min, max, ilvl, categories: [...CATS], weight: 10 });

export const EXTRA_BASES: Record<string, ItemBaseProto> = {
  "test.item.axe2h": base({
    name: "Test Axe",
    category: "weapon",
    slots: ["weapon"],
    weaponClass: "axe",
    twoHanded: true,
    size: { w: 2, h: 3 },
    dmgMin: 5,
    dmgMax: 13,
    attackTicks: 14,
    range: 400,
    value: 60,
  }),
  "test.item.kite": base({
    name: "Test Kite Shield",
    category: "shield",
    slots: ["offhand"],
    size: { w: 2, h: 2 },
    block: 20,
    value: 40,
  }),
  "test.item.buckler": base({
    name: "Test Buckler",
    category: "shield",
    slots: ["offhand"],
    size: { w: 1, h: 1 },
    block: 15,
    value: 20,
  }),
  "test.item.heavy": base({
    name: "Test Heavy Helm",
    category: "helm",
    slots: ["helm"],
    size: { w: 2, h: 2 },
    reqLevel: 5,
    armor: 9,
    value: 80,
  }),
  "test.item.plate": base({
    name: "Test Plate",
    category: "armor",
    slots: ["armor"],
    size: { w: 2, h: 3 },
    reqStr: 200,
    armor: 28,
    value: 300,
  }),
  "test.item.greatsword": base({
    name: "Test Greatsword",
    category: "weapon",
    slots: ["weapon"],
    size: { w: 1, h: 3 },
    ilvl: 10,
    dropWeight: 100,
    value: 500,
  }),
  "test.item.potion.rejuv": base({
    name: "Test Rejuvenation",
    category: "potion",
    slots: [],
    value: 60,
    potion: { kind: "rejuv", amount: 0, pct: 35, tier: 2 },
  }),
  "test.item.potion.life.greater": base({
    name: "Test Greater Life Potion",
    category: "potion",
    slots: [],
    value: 80,
    potion: { kind: "life", amount: 120, pct: 0, tier: 2 },
  }),
};

export const EXTRA_AFFIXES: Record<string, AffixProto> = {
  "test.affix.armor.1": affix("Heavy", "prefix", "armor", "armor", 2, 6),
  "test.affix.crit.1": affix("Keen", "prefix", "crit", "critPct", 1, 4),
  "test.affix.fire.1": affix("Burning", "prefix", "fire", "fireDmg", 1, 3),
  "test.affix.mf.1": affix("Lucky", "prefix", "mf", "magicFind", 5, 15),
  "test.affix.dex.1": affix("of Haste", "suffix", "dex", "dex", 1, 3),
  "test.affix.res.1": affix("of Warding", "suffix", "res", "resFire", 5, 10),
  "test.affix.vit.1": affix("of the Bear", "suffix", "vit", "vit", 1, 3),
  "test.affix.speed.1": affix("of Swiftness", "suffix", "speed", "moveSpeed", 5, 10),
};

const EXTRA_UNIQUES: Record<string, UniqueProto> = {
  "test.unique.blade": {
    name: "Bloodreaver",
    base: "test.item.axe2h",
    ilvl: 1,
    mods: [{ stat: "dmgPct", min: 10, max: 20 }],
    weight: 1,
    flavor: "For tests.",
  },
};

interface RollPayload extends RollItemOptions {
  count: number;
}

const rollAction = {
  name: "test.items.roll",
  parse(_world: World, payload: unknown): RollPayload {
    const p = payload as RollPayload;
    return p;
  },
  apply(world: World, p: RollPayload, ctx: Parameters<typeof rollItem>[1]): void {
    const out: ItemInstance[] = [];
    for (let i = 0; i < p.count; i++) {
      const item = rollItem(world, ctx, {
        ilvl: p.ilvl,
        rarity: p.rarity,
        magicFind: p.magicFind,
        category: p.category,
        base: p.base,
        minRarity: p.minRarity,
      });
      if (item) out.push(item);
    }
    world.setResource("test.rolled", out);
  },
};

const extra = defineModule({
  id: "test.items.extra",
  version: "0.0.1",
  data(reg) {
    for (const id of Object.keys(EXTRA_BASES).sort())
      reg.define(KIND.itemBase, id, EXTRA_BASES[id]!);
    for (const id of Object.keys(EXTRA_AFFIXES).sort())
      reg.define(KIND.affix, id, EXTRA_AFFIXES[id]!);
    for (const id of Object.keys(EXTRA_UNIQUES).sort())
      reg.define(KIND.unique, id, EXTRA_UNIQUES[id]!);
  },
  actions: [rollAction],
});

const richModes = (seed: number): Sim => {
  const mode = defineMode({
    id: "classic",
    name: "Classic (items test)",
    description: "test",
    world: null,
    modules: ["classic.core", "classic.items", "test.content", "test.items.extra"],
    tick: { kind: "fixed", hz: 20 },
  });
  const sim = createSim(loadMode(mode, [...classicModules, testContent, extra]), { seed });
  ensureResources(sim.world);
  return sim;
};

function rich(seed = 1): Sim {
  const sim = richModes(seed);
  useOpenMap(sim, 1);
  return sim;
}

/** Rolls items through the test action (ctx.rng and nextUid apply). */
function roll(sim: Sim, p: RollPayload): ItemInstance[] {
  const r = sim.dispatch("test.items.roll", p, null);
  expect(r.ok).toBe(true);
  return sim.world.getResource<ItemInstance[]>("test.rolled") ?? [];
}

const reg = (sim: Sim) => sim.loaded.registry;

function baseOfItem(sim: Sim, it: ItemInstance): ItemBaseProto {
  return reg(sim).require<ItemBaseProto>(KIND.itemBase, it.base) as ItemBaseProto;
}

/** A plain item instance for placing directly (uid from the world). */
function makeItem(sim: Sim, baseId: string, rarity: ItemRarity = "normal"): ItemInstance {
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
  };
}

/** Puts an item straight into the hero's bag (test setup only). */
function putInBag(sim: Sim, hero: Entity, item: ItemInstance): void {
  const bag = sim.world.read(hero, Inventory);
  const next = placeItem(reg(sim), { cols: bag.cols, rows: bag.rows, items: bag.items }, item);
  if (!next) throw new Error("test setup: bag full");
  sim.world.update(hero, Inventory, { items: next.items });
}

function bagUids(sim: Sim, hero: Entity): number[] {
  return sim.world.read(hero, Inventory).items.map((e) => e.item.uid);
}

function equipOf(sim: Sim, hero: Entity) {
  return sim.world.read(hero, Equipment);
}

function act<N extends keyof ActionPayloads>(sim: Sim, name: N, payload: ActionPayloads[N]) {
  return sim.dispatch(name, payload, null);
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

function spawnLoot(
  sim: Sim,
  o: {
    x: number;
    y: number;
    depth?: number;
    kind: "item" | "gold" | "potion";
    item?: ItemInstance;
    gold?: number;
    potion?: string;
  },
): Entity {
  const e = sim.world.create();
  sim.world.add(e, Loot, {
    kind: o.kind,
    item: o.item ?? null,
    gold: o.gold ?? 0,
    potion: o.potion ?? "",
    droppedAt: sim.tick,
  });
  sim.world.add(e, Pos, { x: tileCenter(o.x), y: tileCenter(o.y) });
  sim.world.add(e, AreaTag, { depth: o.depth ?? 1 });
  return e;
}

/** A town with the test vendors next to the hero at (5, 5). */
function townSim(seed = 3, gold = 1000) {
  const sim = testSim(["classic.core", "classic.items"], { seed });
  const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0, gold });
  const smith = spawnNpc(sim, "test.npc.smith", 7, 5);
  const alch = spawnNpc(sim, "test.npc.alchemist", 7, 6);
  const junk = spawnNpc(sim, "test.npc.junk", 7, 7);
  const stash = spawnStash(sim, 6, 5);
  return { sim, hero, smith, alch, junk, stash };
}

// ---------------------------------------------------------------------------

describe("rollItem", () => {
  it("normal items have no mods and the base name and value", () => {
    const sim = rich(11);
    const [it] = roll(sim, {
      count: 1,
      ilvl: 1,
      rarity: "normal",
      magicFind: 0,
      base: "test.item.sword",
    });
    expect(it).toBeDefined();
    expect(it!.rarity).toBe("normal");
    expect(it!.mods).toEqual([]);
    expect(it!.affixes).toEqual([]);
    expect(it!.name).toBe("Test Sword");
    expect(it!.value).toBe(itemValue(baseOfItem(sim, it!), "normal", 1));
    expect(it!.uid).toBeGreaterThan(0);
  });

  it("magic items carry one or two affixes, one prefix and/or one suffix", () => {
    const sim = rich(12);
    const items = roll(sim, { count: 120, ilvl: 10, rarity: "magic", magicFind: 0 });
    expect(items.length).toBe(120);
    for (const it of items) {
      expect(it.mods.length).toBeGreaterThanOrEqual(1);
      expect(it.mods.length).toBeLessThanOrEqual(2);
      const kinds = it.affixes.map((id) => reg(sim).require<AffixProto>(KIND.affix, id).kind);
      expect(kinds.filter((k) => k === "prefix").length).toBeLessThanOrEqual(1);
      expect(kinds.filter((k) => k === "suffix").length).toBeLessThanOrEqual(1);
      expect(it.name).toContain(baseOfItem(sim, it).name);
      expect(it.value).toBe(itemValue(baseOfItem(sim, it), "magic", 10));
    }
  });

  it("rare items carry three to five affixes with unique groups and at most three per kind", () => {
    const sim = rich(13);
    const items = roll(sim, {
      count: 80,
      ilvl: 20,
      rarity: "rare",
      magicFind: 0,
      category: "helm",
    });
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.mods.length).toBeGreaterThanOrEqual(3);
      expect(it.mods.length).toBeLessThanOrEqual(5);
      const affixes = it.affixes.map((id) => reg(sim).require<AffixProto>(KIND.affix, id));
      expect(new Set(affixes.map((a) => a.group)).size).toBe(affixes.length);
      expect(affixes.filter((a) => a.kind === "prefix").length).toBeLessThanOrEqual(3);
      expect(affixes.filter((a) => a.kind === "suffix").length).toBeLessThanOrEqual(3);
      expect(it.name.split(" ").length).toBeGreaterThanOrEqual(2);
      expect(it.unique).toBeUndefined();
    }
  });

  it("affix values stay inside the affix range and tier gates", () => {
    const sim = rich(14);
    const items = roll(sim, { count: 60, ilvl: 3, rarity: "rare", magicFind: 0 });
    for (const it of items) {
      it.affixes.forEach((id, i) => {
        const a = reg(sim).require<AffixProto>(KIND.affix, id);
        expect(a.ilvl).toBeLessThanOrEqual(3);
        const v = it.mods[i]!.value;
        expect(v).toBeGreaterThanOrEqual(a.min);
        expect(v).toBeLessThanOrEqual(a.max);
      });
    }
  });

  it("uniques come from UniqueProto with their rolled mods, and fall back to rare", () => {
    const sim = rich(15);
    const [blade] = roll(sim, {
      count: 1,
      ilvl: 5,
      rarity: "unique",
      magicFind: 0,
      category: "weapon",
    });
    expect(blade!.rarity).toBe("unique");
    expect(blade!.unique).toBe("test.unique.blade");
    expect(blade!.name).toBe("Bloodreaver");
    expect(blade!.base).toBe("test.item.axe2h");
    expect(blade!.mods).toHaveLength(1);
    expect(blade!.mods[0]!.stat).toBe("dmgPct");
    expect(blade!.mods[0]!.value).toBeGreaterThanOrEqual(10);
    expect(blade!.mods[0]!.value).toBeLessThanOrEqual(20);

    const [band] = roll(sim, {
      count: 1,
      ilvl: 1,
      rarity: "unique",
      magicFind: 0,
      category: "ring",
    });
    expect(band!.unique).toBe("test.unique.band");
    expect(band!.mods[0]!.stat).toBe("allAttrs");

    const [fallback] = roll(sim, {
      count: 1,
      ilvl: 5,
      rarity: "unique",
      magicFind: 0,
      category: "helm",
    });
    expect(fallback!.rarity).toBe("rare");
    expect(fallback!.unique).toBeUndefined();
  });

  it("respects item level gates on bases", () => {
    const sim = rich(16);
    const low = roll(sim, {
      count: 60,
      ilvl: 1,
      rarity: "normal",
      magicFind: 0,
      category: "weapon",
    });
    expect(low.some((it) => it.base === "test.item.greatsword")).toBe(false);
    const high = roll(sim, {
      count: 60,
      ilvl: 10,
      rarity: "normal",
      magicFind: 0,
      category: "weapon",
    });
    expect(high.some((it) => it.base === "test.item.greatsword")).toBe(true);
  });

  it("never rolls potions and respects the minimum rarity", () => {
    const sim = rich(17);
    const any = roll(sim, { count: 80, ilvl: 20, rarity: null, magicFind: 0 });
    for (const it of any) expect(baseOfItem(sim, it).category).not.toBe("potion");
    const boss = roll(sim, { count: 40, ilvl: 5, rarity: null, magicFind: 0, minRarity: "rare" });
    expect(boss.length).toBe(40);
    for (const it of boss) expect(["rare", "unique"]).toContain(it.rarity);
  });

  it("is deterministic for the same seed and differs for another seed", () => {
    const payload: RollPayload = { count: 30, ilvl: 12, rarity: null, magicFind: 40 };
    const a = JSON.stringify(roll(rich(21), payload));
    const b = JSON.stringify(roll(rich(21), payload));
    const c = JSON.stringify(roll(rich(22), payload));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

// ---------------------------------------------------------------------------

describe("bag grid", () => {
  it("places first fit by rows then columns and reports a full bag", () => {
    const sim = testSim(["classic.core", "classic.items"]);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0 });
    const r = sim.world.read(hero, Inventory);
    const grid = { cols: r.cols, rows: r.rows, items: [] as typeof r.items };
    let cur: typeof grid | null = grid;
    const placed: { x: number; y: number }[] = [];
    // Sword is 1x3: a 10x4 bag holds exactly ten of them (rows 0-2, one per column).
    for (let i = 0; i < 11; i++) {
      const item = makeItem(sim, "test.item.sword");
      const next = placeItem(reg(sim), cur!, item);
      if (!next) break;
      cur = next;
      const at = next.items.find((e) => e.item.uid === item.uid)!;
      placed.push({ x: at.x, y: at.y });
    }
    expect(placed.length).toBe(10);
    expect(placed[0]).toEqual({ x: 0, y: 0 });
    expect(placed[1]).toEqual({ x: 1, y: 0 });
    expect(placed[9]).toEqual({ x: 9, y: 0 });
    // Items stay sorted by (y, x).
    const ys = cur!.items.map((e) => e.y * 100 + e.x);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it("a bag item can be moved to a free cell and not onto another item", () => {
    const sim = rich(31);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const cap = makeItem(sim, "test.item.cap");
    const ring = makeItem(sim, "test.item.ring");
    putInBag(sim, hero, cap);
    putInBag(sim, hero, ring);
    const capAt = sim.world.read(hero, Inventory).items.find((e) => e.item.uid === cap.uid)!;
    // Ring onto the cap's cell: rejected, nothing changes.
    const before = sim.hash();
    const bad = act(sim, ACTION.moveItem, { uid: ring.uid, x: capAt.x, y: capAt.y });
    expect(bad.ok).toBe(false);
    expect(sim.hash()).toBe(before);
    // Ring to a free corner: accepted.
    const ok = act(sim, ACTION.moveItem, { uid: ring.uid, x: 9, y: 3 });
    expect(ok.ok).toBe(true);
    const ringAt = sim.world.read(hero, Inventory).items.find((e) => e.item.uid === ring.uid)!;
    expect([ringAt.x, ringAt.y]).toEqual([9, 3]);
  });
});

// ---------------------------------------------------------------------------

describe("equipment", () => {
  it("equips into the allowed slot and sends the old item back to the bag", () => {
    const sim = rich(41);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const first = makeItem(sim, "test.item.sword");
    const second = makeItem(sim, "test.item.sword");
    putInBag(sim, hero, first);
    putInBag(sim, hero, second);
    expect(act(sim, ACTION.equip, { uid: first.uid, slot: null }).ok).toBe(true);
    expect(equipOf(sim, hero).weapon?.uid).toBe(first.uid);
    expect(act(sim, ACTION.equip, { uid: second.uid, slot: "weapon" }).ok).toBe(true);
    expect(equipOf(sim, hero).weapon?.uid).toBe(second.uid);
    expect(bagUids(sim, hero)).toEqual([first.uid]);
  });

  it("rejects items in slots they do not fit and items with no slot", () => {
    const sim = rich(42);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const sword = makeItem(sim, "test.item.sword");
    const pot = makeItem(sim, "test.item.potion.life");
    putInBag(sim, hero, sword);
    putInBag(sim, hero, pot);
    const before = sim.hash();
    expect(act(sim, ACTION.equip, { uid: sword.uid, slot: "helm" }).ok).toBe(false);
    expect(act(sim, ACTION.equip, { uid: pot.uid, slot: null }).ok).toBe(false);
    expect(act(sim, ACTION.equip, { uid: 99999, slot: null }).ok).toBe(false);
    expect(sim.hash()).toBe(before);
  });

  it("puts rings in ring1 then ring2 and replaces ring1 when both are used", () => {
    const sim = rich(43);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const rings = [1, 2, 3].map(() => makeItem(sim, "test.item.ring"));
    for (const r of rings) putInBag(sim, hero, r);
    expect(act(sim, ACTION.equip, { uid: rings[0]!.uid, slot: null }).ok).toBe(true);
    expect(equipOf(sim, hero).ring1?.uid).toBe(rings[0]!.uid);
    expect(act(sim, ACTION.equip, { uid: rings[1]!.uid, slot: null }).ok).toBe(true);
    expect(equipOf(sim, hero).ring2?.uid).toBe(rings[1]!.uid);
    expect(act(sim, ACTION.equip, { uid: rings[2]!.uid, slot: null }).ok).toBe(true);
    expect(equipOf(sim, hero).ring1?.uid).toBe(rings[2]!.uid);
    expect(equipOf(sim, hero).ring2?.uid).toBe(rings[1]!.uid);
    expect(bagUids(sim, hero)).toEqual([rings[0]!.uid]);
  });

  it("two-handed weapons clear the offhand into the bag and block shields while equipped", () => {
    const sim = rich(44);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const sword = makeItem(sim, "test.item.sword");
    const kite = makeItem(sim, "test.item.kite");
    const axe = makeItem(sim, "test.item.axe2h");
    const buckler = makeItem(sim, "test.item.buckler");
    for (const it of [sword, kite, axe, buckler]) putInBag(sim, hero, it);
    expect(act(sim, ACTION.equip, { uid: sword.uid, slot: null }).ok).toBe(true);
    expect(act(sim, ACTION.equip, { uid: kite.uid, slot: null }).ok).toBe(true);
    expect(equipOf(sim, hero).offhand?.uid).toBe(kite.uid);

    expect(act(sim, ACTION.equip, { uid: axe.uid, slot: null }).ok).toBe(true);
    expect(equipOf(sim, hero).weapon?.uid).toBe(axe.uid);
    expect(equipOf(sim, hero).offhand).toBeNull();
    expect(bagUids(sim, hero).sort((a, b) => a - b)).toEqual(
      [sword.uid, kite.uid, buckler.uid].sort((a, b) => a - b),
    );

    // A shield cannot go in while the two-handed axe is equipped.
    const blocked = act(sim, ACTION.equip, { uid: buckler.uid, slot: "offhand" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error?.code).toBe("blocked");
  });

  it("refuses a two-handed weapon when the bag cannot take the displaced items", () => {
    const sim = rich(45);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    // Bag 2x3 holds only the axe; a sword (1x3) and a kite shield (2x2) are equipped.
    sim.world.update(hero, Inventory, { cols: 2, rows: 3, items: [] });
    const axe = makeItem(sim, "test.item.axe2h");
    const sword = makeItem(sim, "test.item.sword");
    const kite = makeItem(sim, "test.item.kite");
    putInBag(sim, hero, axe);
    sim.world.update(hero, Equipment, { ...equipOf(sim, hero), weapon: sword, offhand: kite });
    const before = sim.hash();
    const r = act(sim, ACTION.equip, { uid: axe.uid, slot: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.code).toBe("bag_full");
    expect(sim.hash()).toBe(before);
  });

  it("checks reqLevel and reqStr against the hero", () => {
    const sim = rich(46);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const heavy = makeItem(sim, "test.item.heavy");
    const plate = makeItem(sim, "test.item.plate");
    putInBag(sim, hero, heavy);
    putInBag(sim, hero, plate);
    const before = sim.hash();
    const a = act(sim, ACTION.equip, { uid: heavy.uid, slot: null });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error?.code).toBe("requirements");
    const b = act(sim, ACTION.equip, { uid: plate.uid, slot: null });
    expect(b.ok).toBe(false);
    expect(sim.hash()).toBe(before);
    // Level 5 with enough strength: accepted.
    sim.world.update(hero, Level, { level: 5 });
    sim.world.update(hero, HeroStats, { attrs: { str: 20, dex: 20, mag: 20, vit: 20 } });
    expect(act(sim, ACTION.equip, { uid: heavy.uid, slot: null }).ok).toBe(true);
  });

  it("unequips into the bag, and fails for an empty slot or a full bag", () => {
    const sim = rich(47);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const sword = makeItem(sim, "test.item.sword");
    putInBag(sim, hero, sword);
    expect(act(sim, ACTION.equip, { uid: sword.uid, slot: null }).ok).toBe(true);
    expect(act(sim, ACTION.unequip, { slot: "helm" }).ok).toBe(false);
    expect(act(sim, ACTION.unequip, { slot: "weapon" }).ok).toBe(true);
    expect(equipOf(sim, hero).weapon).toBeNull();
    expect(bagUids(sim, hero)).toEqual([sword.uid]);

    // Equip again, then remove every bag cell: unequip fails and the sword stays equipped.
    expect(act(sim, ACTION.equip, { uid: sword.uid, slot: null }).ok).toBe(true);
    sim.world.update(hero, Inventory, { cols: 0, rows: 0, items: [] });
    expect(act(sim, ACTION.unequip, { slot: "weapon" }).ok).toBe(false);
    expect(equipOf(sim, hero).weapon?.uid).toBe(sword.uid);
  });
});

// ---------------------------------------------------------------------------

describe("belt and potions", () => {
  it("picks potions up into a matching stack, then an empty slot, else refuses", () => {
    const sim = rich(51);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const belt = () => sim.world.read(hero, Belt).slots;
    // Belt from spawnTestHero: slot 0 holds 3 life potions.
    const p1 = spawnLoot(sim, { x: 5, y: 5, kind: "potion", potion: "test.item.potion.life" });
    pushCommand(sim.world, { op: "pickup", target: p1 });
    sim.step(1);
    expect(sim.world.exists(p1)).toBe(false);
    expect(belt()[0]).toEqual({ base: "test.item.potion.life", count: 4 });

    // Fill every slot to the stack limit, then a new potion has nowhere to go.
    sim.world.update(hero, Belt, {
      slots: [
        { base: "test.item.potion.life", count: 5 },
        { base: "test.item.potion.mana", count: 5 },
        { base: "test.item.potion.mana", count: 5 },
        { base: "test.item.potion.mana", count: 5 },
      ],
    });
    const p2 = spawnLoot(sim, { x: 5, y: 5, kind: "potion", potion: "test.item.potion.life" });
    pushCommand(sim.world, { op: "pickup", target: p2 });
    const events = sim.step(1);
    const failed = events.find((e) => e.type === "classic.command.failed");
    expect(failed?.code).toBe("belt_full");
    expect(sim.world.exists(p2)).toBe(true);
  });

  it("drinks a potion: heals, uses a charge, starts the shared cooldown", () => {
    const sim = rich(52);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1, life: 100 });
    sim.world.update(hero, Life, { hp: 40 });
    const r = act(sim, ACTION.drinkPotion, { slot: 0 });
    expect(r.ok).toBe(true);
    expect(sim.world.read(hero, Life).hp).toBe(90);
    expect(sim.world.read(hero, Belt).slots[0]).toEqual({
      base: "test.item.potion.life",
      count: 2,
    });
    expect(sim.world.read(hero, Belt).readyAt).toBe(sim.tick + TEST_BALANCE.potionCooldown);

    const again = act(sim, ACTION.drinkPotion, { slot: 0 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error?.code).toBe("cooldown");

    sim.step(TEST_BALANCE.potionCooldown);
    expect(act(sim, ACTION.drinkPotion, { slot: 0 }).ok).toBe(true);
    // Healing never exceeds the maximum.
    expect(sim.world.read(hero, Life).hp).toBe(100);
  });

  it("drinks mana and rejuvenation potions and rejects empty slots", () => {
    const sim = rich(53);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1, life: 100, mana: 50 });
    sim.world.update(hero, Life, { hp: 10 });
    sim.world.update(hero, Belt, {
      slots: [
        { base: "test.item.potion.rejuv", count: 1 },
        { base: "test.item.potion.mana", count: 1 },
        { base: null, count: 0 },
        { base: null, count: 0 },
      ],
    });
    expect(act(sim, ACTION.drinkPotion, { slot: 2 }).ok).toBe(false);
    expect(act(sim, ACTION.drinkPotion, { slot: 0 }).ok).toBe(true);
    // Rejuvenation: 35% of max life (35) on top of life 10 = 45.
    expect(sim.world.read(hero, Life).hp).toBe(45);
    sim.step(TEST_BALANCE.potionCooldown);
    sim.world.update(hero, Belt, { readyAt: 0 });
    expect(act(sim, ACTION.drinkPotion, { slot: 1 }).ok).toBe(true);
    expect(sim.world.read(hero, Belt).slots[1]).toEqual({ base: null, count: 0 });
  });

  it("refuses to drink while dead", () => {
    const sim = rich(54);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    sim.world.add(hero, Dead, { at: 0, killer: 0 });
    const before = sim.hash();
    expect(act(sim, ACTION.drinkPotion, { slot: 0 }).ok).toBe(false);
    expect(sim.hash()).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe("pickup and drop", () => {
  it("picks up gold into the wallet and emits classic.gold", () => {
    const sim = rich(61);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1, gold: 10 });
    const g = spawnLoot(sim, { x: 6, y: 5, kind: "gold", gold: 42 });
    pushCommand(sim.world, { op: "pickup", target: g });
    const events = sim.step(1);
    expect(sim.world.read(hero, Wallet).gold).toBe(52);
    expect(events.some((e) => e.type === "classic.gold" && e.amount === 42)).toBe(true);
    expect(events.some((e) => e.type === "classic.loot.picked" && e.kind === "gold")).toBe(true);
    expect(sim.world.exists(g)).toBe(false);
  });

  it("picks up items into the bag and counts them", () => {
    const sim = rich(62);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const item = makeItem(sim, "test.item.cap", "magic");
    const loot = spawnLoot(sim, { x: 5, y: 6, kind: "item", item });
    pushCommand(sim.world, { op: "pickup", target: loot });
    const events = sim.step(1);
    expect(events.some((e) => e.type === "classic.loot.picked" && e.name === item.name)).toBe(true);
    expect(bagUids(sim, hero)).toEqual([item.uid]);
    expect(sim.world.exists(loot)).toBe(false);
  });

  it("refuses pickups that are far, in another area or when the bag is full", () => {
    const sim = rich(63);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const far = spawnLoot(sim, { x: 20, y: 20, kind: "gold", gold: 5 });
    pushCommand(sim.world, { op: "pickup", target: far });
    expect(sim.step(1).find((e) => e.type === "classic.command.failed")?.code).toBe("too_far");
    expect(sim.world.exists(far)).toBe(true);

    const other = spawnLoot(sim, { x: 5, y: 5, depth: 2, kind: "gold", gold: 5 });
    pushCommand(sim.world, { op: "pickup", target: other });
    expect(sim.step(1).find((e) => e.type === "classic.command.failed")?.code).toBe("bad_target");
    expect(sim.world.exists(other)).toBe(true);

    sim.world.update(hero, Inventory, { cols: 0, rows: 0, items: [] });
    const item = makeItem(sim, "test.item.ring");
    const loot = spawnLoot(sim, { x: 5, y: 5, kind: "item", item });
    pushCommand(sim.world, { op: "pickup", target: loot });
    const events = sim.step(1);
    expect(events.some((e) => e.type === "classic.bag.full")).toBe(true);
    expect(events.find((e) => e.type === "classic.command.failed")?.code).toBe("bag_full");
    expect(sim.world.exists(loot)).toBe(true);
  });

  it("drops a bag item at the hero's feet as a Loot entity", () => {
    const sim = rich(64);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const item = makeItem(sim, "test.item.ring");
    putInBag(sim, hero, item);
    pushCommand(sim.world, { op: "drop", uid: item.uid });
    const events = sim.step(1);
    expect(bagUids(sim, hero)).toEqual([]);
    const dropped = events.find((e) => e.type === "classic.loot.dropped");
    expect(dropped).toBeDefined();
    const e = dropped!.entity as Entity;
    expect(sim.world.read(e, Loot).item?.uid).toBe(item.uid);
    expect(sim.world.read(e, AreaTag).depth).toBe(1);
  });

  it("rejects dropping an unknown uid and changes nothing", () => {
    const sim = rich(65);
    spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    const before = sim.hash();
    expect(act(sim, ACTION.dropItem, { uid: 123456 }).ok).toBe(false);
    expect(sim.hash()).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe("town: vendors, buy, sell, stash", () => {
  it("restocks the smith on the first town step and again only when entering town", () => {
    const { sim } = townSim();
    expect(vendorsOf(sim.world).stocks).toEqual([]);
    sim.step(1);
    const first = vendorsOf(sim.world).stocks;
    expect(first.map((s) => s.npc)).toEqual(["test.npc.smith"]);
    expect(first[0]!.items.length).toBe(4);
    const uids = first[0]!.items.map((i) => i.uid);

    sim.step(1);
    expect(vendorsOf(sim.world).stocks[0]!.items.map((i) => i.uid)).toEqual(uids);

    // Entering the town again (area entered this tick) rolls a new stock.
    const area = sim.world.getResource<AreaState>(RES.area)!;
    sim.world.setResource(RES.area, { ...area, enteredAt: sim.tick });
    sim.step(1);
    expect(vendorsOf(sim.world).stocks[0]!.items.map((i) => i.uid)).not.toEqual(uids);
  });

  it("buys a smith item by index and removes it from the stock", () => {
    const { sim, hero, smith } = townSim(4, 1000);
    sim.step(1);
    const stock = vendorsOf(sim.world).stocks[0]!.items;
    const want = stock[1]!;
    const gold = sim.world.read(hero, Wallet).gold;
    const r = act(sim, ACTION.buy, { npc: smith, index: 1, potion: null, count: 1 });
    expect(r.ok).toBe(true);
    expect(sim.world.read(hero, Wallet).gold).toBe(gold - want.value);
    expect(bagUids(sim, hero)).toEqual([want.uid]);
    expect(vendorsOf(sim.world).stocks[0]!.items.map((i) => i.uid)).not.toContain(want.uid);
  });

  it("buys alchemist potions into the belt and town portal scrolls", () => {
    const { sim, hero, alch } = townSim(5, 1000);
    const gold = sim.world.read(hero, Wallet).gold;
    expect(
      act(sim, ACTION.buy, { npc: alch, index: 0, potion: "test.item.potion.life", count: 3 }).ok,
    ).toBe(true);
    // Life potion base value 25, three of them. Belt slot 0 had 3, so 5 fill it and 1 goes to slot 1.
    expect(sim.world.read(hero, Wallet).gold).toBe(gold - 75);
    expect(sim.world.read(hero, Belt).slots[0]).toEqual({
      base: "test.item.potion.life",
      count: 5,
    });
    expect(sim.world.read(hero, Belt).slots[1]).toEqual({
      base: "test.item.potion.life",
      count: 1,
    });

    expect(act(sim, ACTION.buy, { npc: alch, index: 0, potion: "tp", count: 2 }).ok).toBe(true);
    expect(sim.world.read(hero, Supplies).tpScrolls).toBe(4);
    expect(sim.world.read(hero, Wallet).gold).toBe(gold - 75 - 100);
  });

  it("rejects buying when broke, too far, outside town, or with bad counts", () => {
    const { sim, hero, smith, alch } = townSim(6, 0);
    sim.step(1);
    const before = sim.hash();
    const broke = act(sim, ACTION.buy, { npc: smith, index: 0, potion: null, count: 1 });
    expect(broke.ok).toBe(false);
    if (!broke.ok) expect(broke.error?.code).toBe("no_gold");
    expect(
      act(sim, ACTION.buy, { npc: alch, index: 0, potion: "test.item.potion.life", count: 0 }).ok,
    ).toBe(false);
    expect(
      act(sim, ACTION.buy, { npc: alch, index: 0, potion: "test.item.potion.life", count: 21 }).ok,
    ).toBe(false);
    expect(act(sim, ACTION.buy, { npc: smith, index: 0, potion: null, count: 2 }).ok).toBe(false);
    expect(sim.hash()).toBe(before);

    // Far from the NPC.
    sim.world.update(hero, Wallet, { gold: 500 });
    sim.world.update(hero, Pos, { x: tileCenter(1), y: tileCenter(1) });
    const far = act(sim, ACTION.buy, { npc: smith, index: 0, potion: null, count: 1 });
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.error?.code).toBe("too_far");
  });

  it("is town only", () => {
    const { sim, hero, smith } = townSim(7, 1000);
    sim.step(1);
    useOpenMap(sim, 1);
    sim.world.update(hero, Pos, { x: tileCenter(5), y: tileCenter(5) });
    const before = sim.hash();
    const r = act(sim, ACTION.buy, { npc: smith, index: 0, potion: null, count: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.code).toBe("not_in_town");
    expect(act(sim, ACTION.sell, { npc: smith, uid: 1 }).ok).toBe(false);
    expect(act(sim, ACTION.stashPut, { uid: 1 }).ok).toBe(false);
    expect(sim.hash()).toBe(before);
  });

  it("sells to the junk buyer for buyPct of the value", () => {
    const { sim, hero, junk, smith } = townSim(8, 0);
    const sword = makeItem(sim, "test.item.sword");
    putInBag(sim, hero, sword);
    // Smith does not buy.
    expect(act(sim, ACTION.sell, { npc: smith, uid: sword.uid }).ok).toBe(false);
    expect(act(sim, ACTION.sell, { npc: junk, uid: sword.uid }).ok).toBe(true);
    // Junk buyer pays 10% of 30 = 3.
    expect(sim.world.read(hero, Wallet).gold).toBe(3);
    expect(bagUids(sim, hero)).toEqual([]);
  });

  it("stores items in the stash and takes them back, within reach and capacity", () => {
    const { sim, hero, stash } = townSim(9, 0);
    const item = makeItem(sim, "test.item.ring");
    putInBag(sim, hero, item);
    expect(act(sim, ACTION.stashPut, { uid: item.uid }).ok).toBe(true);
    expect(stashOf(sim.world).items.map((i) => i.uid)).toEqual([item.uid]);
    expect(bagUids(sim, hero)).toEqual([]);

    expect(act(sim, ACTION.stashTake, { uid: item.uid }).ok).toBe(true);
    expect(bagUids(sim, hero)).toEqual([item.uid]);
    expect(stashOf(sim.world).items).toEqual([]);

    // Out of reach.
    sim.world.update(hero, Pos, { x: tileCenter(1), y: tileCenter(1) });
    expect(act(sim, ACTION.stashPut, { uid: item.uid }).ok).toBe(false);
    expect(sim.world.read(stash, Pos).x).toBe(tileCenter(6));
  });

  it("refuses a stash put when the stash is full", () => {
    const { sim, hero } = townSim(10, 0);
    const full = Array.from({ length: TEST_BALANCE.stashSize }, () =>
      makeItem(sim, "test.item.ring"),
    );
    sim.world.setResource(RES.stash, { items: full });
    const item = makeItem(sim, "test.item.ring");
    putInBag(sim, hero, item);
    const r = act(sim, ACTION.stashPut, { uid: item.uid });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.code).toBe("stash_full");
  });
});

// ---------------------------------------------------------------------------

describe("grants and commands", () => {
  it("grants gold with a clamp at zero", () => {
    const sim = testSim(["classic.core", "classic.items"]);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0, gold: 20 });
    pushCommand(sim.world, { op: "grantGold", amount: 30, reason: "quest" });
    const ev = sim.step(1);
    expect(sim.world.read(hero, Wallet).gold).toBe(50);
    expect(ev.some((e) => e.type === "classic.gold" && e.amount === 30 && e.total === 50)).toBe(
      true,
    );
    pushCommand(sim.world, { op: "grantGold", amount: -500, reason: "fine" });
    sim.step(1);
    expect(sim.world.read(hero, Wallet).gold).toBe(0);
  });

  it("grants items into the stash, and sells overflow at 10% when there is no room", () => {
    const sim = rich(71);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0, gold: 0 });
    pushCommand(sim.world, {
      op: "grantItems",
      count: 3,
      ilvl: 5,
      minRarity: "normal",
      toStash: true,
      reason: "test",
    });
    sim.step(1);
    expect(stashOf(sim.world).items.length).toBe(3);

    // No bag cells: the grants sell instead.
    sim.world.update(hero, Inventory, { cols: 0, rows: 0, items: [] });
    pushCommand(sim.world, {
      op: "grantItems",
      count: 3,
      ilvl: 5,
      minRarity: "rare",
      toStash: false,
      reason: "test",
    });
    const ev = sim.step(1);
    expect(sim.world.read(hero, Wallet).gold).toBeGreaterThanOrEqual(3);
    expect(ev.filter((e) => e.type === "classic.gold").length).toBe(3);
    expect(sim.world.read(hero, Inventory).items).toEqual([]);
  });

  it("reports a failed command with its code and keeps the rest", () => {
    const sim = rich(72);
    spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    pushCommand(sim.world, { op: "equip", uid: 999999, slot: null });
    pushCommand(sim.world, { op: "drink", slot: 0 });
    const ev = sim.step(1);
    const failed = ev.filter((e) => e.type === "classic.command.failed");
    expect(failed.map((e) => [e.op, e.code])).toEqual([["equip", "unknown_id"]]);
    // The drink went through (potion charge used).
    const hero = sim.world.getResource("classic.game") as { hero: Entity };
    expect(sim.world.read(hero.hero, Belt).slots[0]!.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe("hero kit (classic.items.heroInit)", () => {
  it("gives a hero without items the class starter kit", () => {
    const sim = testSim(["classic.core", "classic.items"]);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0 });
    sim.world.remove(hero, Inventory);
    sim.world.remove(hero, Equipment);
    sim.world.remove(hero, Belt);
    sim.world.remove(hero, Wallet);
    sim.world.remove(hero, Supplies);
    sim.step(1);

    const eq = equipOf(sim, hero);
    expect(eq.weapon?.base).toBe("test.item.sword");
    expect(eq.weapon?.rarity).toBe("normal");
    expect(eq.weapon?.ilvl).toBe(1);
    expect(eq.weapon?.mods).toEqual([]);
    expect(sim.world.read(hero, Inventory)).toMatchObject({ cols: 10, rows: 4, items: [] });
    expect(sim.world.read(hero, Belt).slots).toEqual([
      { base: "test.item.potion.life", count: 3 },
      { base: null, count: 0 },
      { base: null, count: 0 },
      { base: null, count: 0 },
    ]);
    expect(sim.world.read(hero, Wallet).gold).toBe(50);
    expect(sim.world.read(hero, Supplies).tpScrolls).toBe(2);

    // The kit is given once: a second step changes nothing about the sword.
    const uid = eq.weapon!.uid;
    sim.step(1);
    expect(equipOf(sim, hero).weapon?.uid).toBe(uid);
  });
});

// ---------------------------------------------------------------------------

describe("determinism", () => {
  /** A fixed script: town purchases, potions, pickups, grants and rejections. */
  function script(seed: number): { sim: Sim; results: boolean[] } {
    const sim = testSim(["classic.core", "classic.items"], { seed });
    spawnTestHero(sim.world, { x: 5, y: 5, depth: 0, gold: 300, life: 60 });
    const smith = spawnNpc(sim, "test.npc.smith", 7, 5);
    const alch = spawnNpc(sim, "test.npc.alchemist", 7, 6);
    spawnNpc(sim, "test.npc.junk", 7, 7);
    spawnStash(sim, 6, 5);
    const results: boolean[] = [];
    const run = (name: string, payload: unknown): void => {
      results.push(sim.dispatch(name, payload, null).ok);
    };
    sim.step(1);
    run(ACTION.buy, { npc: smith, index: 0, potion: null, count: 1 });
    run(ACTION.buy, { npc: alch, index: 0, potion: "test.item.potion.mana", count: 2 });
    run(ACTION.drinkPotion, { slot: 0 });
    run(ACTION.drinkPotion, { slot: 0 }); // cooldown: rejected
    const g = spawnLoot(sim, { x: 5, y: 5, kind: "gold", gold: 17 });
    pushCommand(sim.world, { op: "pickup", target: g });
    pushCommand(sim.world, {
      op: "grantItems",
      count: 4,
      ilvl: 3,
      minRarity: "normal",
      toStash: false,
      reason: "script",
    });
    pushCommand(sim.world, { op: "grantGold", amount: 12, reason: "script" });
    sim.step(30);
    run(ACTION.stashPut, { uid: 1 });
    run(ACTION.stashTake, { uid: 1 });
    sim.step(5);
    return { sim, results };
  }

  it("the same seed and script give the same hash", () => {
    expect(script(7).sim.hash()).toBe(script(7).sim.hash());
  });

  it("another seed gives a different hash", () => {
    expect(script(7).sim.hash()).not.toBe(script(8).sim.hash());
  });

  it("the fixed script behaves as scripted", () => {
    const { results } = script(7);
    expect(results).toEqual([true, true, true, false, true, true]);
  });

  it("pins the hash of the fixed script", () => {
    expect(script(7).sim.hash()).toBe("ea8ea83b76998111");
  });
});

// ---------------------------------------------------------------------------

describe("rejections leave the world unchanged", () => {
  it("rejects malformed and invalid payloads with ok:false and an unchanged hash", () => {
    const { sim, hero, smith } = townSim(90, 1000);
    sim.step(1);
    const cases: [string, unknown][] = [
      [ACTION.equip, { uid: "one", slot: null }],
      [ACTION.equip, { uid: 1, slot: "nope" }],
      [ACTION.unequip, { slot: "weapon" }],
      [ACTION.moveItem, { uid: 1, x: -1, y: 0 }],
      [ACTION.drinkPotion, { slot: 9 }],
      [ACTION.drinkPotion, { slot: 3 }],
      [ACTION.buy, { npc: smith, index: 99, potion: null, count: 1 }],
      [ACTION.buy, { npc: 0, index: 0, potion: null, count: 1 }],
      [ACTION.sell, { npc: smith, uid: 404 }],
      [ACTION.stashTake, { uid: 404 }],
      [ACTION.stashPut, { uid: 404 }],
      [ACTION.dropItem, { uid: 404 }],
    ];
    for (const [name, payload] of cases) {
      const before = sim.hash();
      const r = sim.dispatch(name, payload, null);
      expect(r.ok, `${name} ${JSON.stringify(payload)}`).toBe(false);
      expect(sim.hash(), name).toBe(before);
    }
    expect(sim.world.read(hero, Wallet).gold).toBe(1000);
  });
});
