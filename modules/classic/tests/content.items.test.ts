/**
 * Integrity tests of wave A item content (sets, gems, uniques, late bases,
 * affixes) against the REAL classic content (loadMode over src/index.ts).
 * OWNER: T-itemcontent. Data only: no systems are exercised here.
 */
import { defineMode, loadMode, type FrozenRegistry } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";
import {
  GEM_KINDS,
  KIND,
  type AffixProto,
  type GemKind,
  type ItemBaseProto,
  type SetItemProto,
  type SetProto,
  type UniqueProto,
} from "../src/types.ts";

const realMode = defineMode({ ...mode, modules: [...mode.modules] });
const loaded = loadMode(realMode, modules);
const reg: FrozenRegistry = loaded.registry;

function table<T extends object>(kind: string): Record<string, Readonly<T>> {
  return Object.fromEntries(reg.all<T>(kind)) as Record<string, Readonly<T>>;
}

const items = table<ItemBaseProto>(KIND.itemBase);
const affixes = table<AffixProto>(KIND.affix);
const uniques = table<UniqueProto>(KIND.unique);
const sets = table<SetProto>(KIND.set);
const setItems = table<SetItemProto>(KIND.setItem);

/** Ids of the fixed (pre-wave-A) bases; late bases are everything else with ilvl >= 25. */
const GEM_ID = /^classic\.item\.gem_(ruby|sapphire|topaz|emerald|amethyst|diamond)_([1-5])$/;

describe("sets", () => {
  it("has at least 7 sets, two per class and at least one generic", () => {
    const list = Object.values(sets);
    expect(list.length).toBeGreaterThanOrEqual(7);
    for (const classId of ["classic.warrior", "classic.rogue", "classic.sorcerer"]) {
      expect(list.filter((s) => s.classId === classId).length, classId).toBeGreaterThanOrEqual(2);
    }
    expect(list.some((s) => s.classId === null)).toBe(true);
  });

  it("has an early and a late set for each class", () => {
    for (const classId of ["classic.warrior", "classic.rogue", "classic.sorcerer"]) {
      const ilvls = Object.values(sets)
        .filter((s) => s.classId === classId)
        .map((s) => Math.min(...s.pieces.map((p) => setItems[p]!.ilvl)));
      expect(Math.min(...ilvls), classId).toBeLessThanOrEqual(15);
      expect(Math.max(...ilvls), classId).toBeGreaterThanOrEqual(30);
    }
  });

  it("ids follow classic.set.<name> and every set has 3-5 pieces", () => {
    for (const [id, s] of Object.entries(sets)) {
      expect(id.startsWith("classic.set."), id).toBe(true);
      expect(s.pieces.length, id).toBeGreaterThanOrEqual(3);
      expect(s.pieces.length, id).toBeLessThanOrEqual(5);
      expect(new Set(s.pieces).size, id).toBe(s.pieces.length);
    }
  });

  it("every piece exists, lists its set, and its base exists", () => {
    for (const [id, s] of Object.entries(sets)) {
      for (const p of s.pieces) {
        const piece = setItems[p];
        expect(piece, `${id} -> ${p}`).toBeDefined();
        expect(piece!.set, p).toBe(id);
        expect(items[piece!.base], `${p}.base`).toBeDefined();
      }
    }
  });

  it("every set item is listed by its set (no orphan pieces)", () => {
    for (const [id, piece] of Object.entries(setItems)) {
      expect(id.startsWith("classic.setItem."), id).toBe(true);
      expect(sets[piece.set], `${id}.set`).toBeDefined();
      expect(sets[piece.set]!.pieces, id).toContain(id);
    }
  });

  it("pieces of one set use different slots", () => {
    for (const [id, s] of Object.entries(sets)) {
      const categories = s.pieces.map((p) => items[setItems[p]!.base]!.category);
      expect(new Set(categories).size, id).toBe(categories.length);
      const slots = s.pieces.flatMap((p) => items[setItems[p]!.base]!.slots);
      expect(new Set(slots).size, id).toBe(slots.length);
    }
  });

  it("piece ilvl is at least the base ilvl and mods are ranged integers", () => {
    for (const [id, piece] of Object.entries(setItems)) {
      const base = items[piece.base]!;
      expect(piece.ilvl, id).toBeGreaterThanOrEqual(base.ilvl);
      expect(piece.weight, id).toBeGreaterThan(0);
      expect(piece.mods.length, id).toBeGreaterThan(0);
      for (const m of piece.mods) {
        expect(Number.isInteger(m.min) && Number.isInteger(m.max), id).toBe(true);
        expect(m.min, id).toBeLessThanOrEqual(m.max);
      }
    }
  });

  it("bonuses: counts ascending, at least 2, at most the number of pieces, integer mods", () => {
    for (const [id, s] of Object.entries(sets)) {
      expect(s.bonuses.length, id).toBeGreaterThan(0);
      let prev = 1;
      for (const b of s.bonuses) {
        expect(b.count, id).toBeGreaterThanOrEqual(2);
        expect(b.count, id).toBeGreaterThan(prev);
        expect(b.count, id).toBeLessThanOrEqual(s.pieces.length);
        prev = b.count;
        expect(b.mods.length, id).toBeGreaterThan(0);
        for (const m of b.mods) expect(Number.isInteger(m.value), `${id} ${m.stat}`).toBe(true);
      }
    }
  });
});

describe("gems", () => {
  const gems = Object.entries(items).filter(([, b]) => b.category === "gem");

  it("has 6 kinds x 5 tiers = 30 gem bases", () => {
    expect(gems.length).toBe(GEM_KINDS.length * 5);
  });

  it("ids are classic.item.gem_<kind>_<tier> and chain tiers 1..5 per kind", () => {
    for (const kind of GEM_KINDS as readonly GemKind[]) {
      const tiers = gems
        .filter(([id]) => id.startsWith(`classic.item.gem_${kind}_`))
        .map(([id]) => Number(GEM_ID.exec(id)?.[2]))
        .sort((a, b) => a - b);
      expect(tiers, kind).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it("every gem has a gem block matching its id, category gem and no slots", () => {
    for (const [id, b] of gems) {
      const m = GEM_ID.exec(id);
      expect(m, id).not.toBeNull();
      expect(b.gem, id).toBeDefined();
      expect(b.gem!.kind, id).toBe(m![1]);
      expect(b.gem!.tier, id).toBe(Number(m![2]));
      expect(b.slots, id).toEqual([]);
      expect(b.size, id).toEqual({ w: 1, h: 1 });
      expect(b.icon, id).toBe("icon.item.gem");
      expect(b.implicit, id).toEqual([]);
    }
  });

  it("rises by tier: ilvl, value and every mod value (integers)", () => {
    for (const kind of GEM_KINDS as readonly GemKind[]) {
      const byTier = gems
        .filter(([id]) => id.startsWith(`classic.item.gem_${kind}_`))
        .sort((a, b) => a[1].gem!.tier - b[1].gem!.tier)
        .map(([, b]) => b);
      for (let i = 1; i < byTier.length; i++) {
        const prev = byTier[i - 1]!;
        const cur = byTier[i]!;
        expect(cur.ilvl, kind).toBeGreaterThan(prev.ilvl);
        expect(cur.value, kind).toBeGreaterThan(prev.value);
        for (const group of ["weapon", "armor", "jewelry"] as const) {
          expect(cur.gem![group].length, `${kind} ${group}`).toBeGreaterThan(0);
          cur.gem![group].forEach((m, j) => {
            expect(Number.isInteger(m.value), `${kind} ${group}`).toBe(true);
            expect(m.stat, `${kind} ${group}`).toBe(prev.gem![group][j]!.stat);
            expect(m.value, `${kind} ${group}`).toBeGreaterThan(prev.gem![group][j]!.value);
          });
        }
      }
    }
  });

  it("gems never enter the generic gear pool (dropWeight 0)", () => {
    for (const [id, b] of gems) expect(b.dropWeight, id).toBe(0);
  });
});

describe("uniques", () => {
  const list = Object.entries(uniques);

  it("has at least 30 uniques", () => {
    expect(list.length).toBeGreaterThanOrEqual(30);
  });

  it("bases exist, ilvl is at least the base ilvl, flavour is present", () => {
    for (const [id, u] of list) {
      expect(items[u.base], `${id}.base`).toBeDefined();
      expect(u.ilvl, id).toBeGreaterThanOrEqual(items[u.base]!.ilvl);
      expect(u.flavor.length, id).toBeGreaterThan(0);
      expect(u.weight, id).toBeGreaterThan(0);
      for (const m of u.mods) {
        expect(Number.isInteger(m.min) && Number.isInteger(m.max), id).toBe(true);
        expect(m.min, id).toBeLessThanOrEqual(m.max);
      }
    }
  });

  it("covers every equipment category and item levels from 1 to 45", () => {
    const cats = new Set(list.map(([, u]) => items[u.base]!.category));
    for (const c of [
      "weapon",
      "shield",
      "helm",
      "armor",
      "gloves",
      "boots",
      "ring",
      "amulet",
    ] as const) {
      expect(cats.has(c), c).toBe(true);
    }
    const ilvls = list.map(([, u]) => u.ilvl);
    expect(Math.min(...ilvls)).toBeLessThanOrEqual(3);
    expect(Math.max(...ilvls)).toBeGreaterThanOrEqual(40);
    expect(Math.max(...ilvls)).toBeLessThanOrEqual(45);
  });

  it("names are unique across uniques and set pieces", () => {
    const names = [...list.map(([, u]) => u.name), ...Object.values(setItems).map((p) => p.name)];
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("late item bases (rift drops, ilvl 25-45)", () => {
  it("adds at least 10 bases in weapon, armour and jewellery at ilvl 25-45", () => {
    const late = Object.entries(items).filter(
      ([, b]) => b.ilvl >= 25 && b.ilvl <= 45 && b.category !== "potion" && b.category !== "gem",
    );
    expect(late.length).toBeGreaterThanOrEqual(10);
    const cats = new Set(late.map(([, b]) => b.category));
    for (const c of ["weapon", "armor", "ring", "amulet"] as const)
      expect(cats.has(c), c).toBe(true);
  });

  it("every equipment base has integer, positive value and a non-negative dropWeight", () => {
    for (const [id, b] of Object.entries(items)) {
      expect(Number.isInteger(b.value) && b.value > 0, id).toBe(true);
      expect(Number.isInteger(b.dropWeight) && b.dropWeight >= 0, id).toBe(true);
      expect(Number.isInteger(b.ilvl) && b.ilvl >= 1, id).toBe(true);
    }
  });

  it("weapons have a damage range and an attack time", () => {
    for (const [id, b] of Object.entries(items)) {
      if (b.category !== "weapon") continue;
      expect(b.dmgMin!, id).toBeLessThanOrEqual(b.dmgMax!);
      expect(b.attackTicks!, id).toBeGreaterThan(0);
      expect(b.range!, id).toBeGreaterThan(0);
    }
  });
});

describe("affixes", () => {
  const list = Object.entries(affixes);

  it("every affix has min <= max and integer values", () => {
    for (const [id, a] of list) {
      expect(a.min, id).toBeLessThanOrEqual(a.max);
      expect(Number.isInteger(a.min) && Number.isInteger(a.max), id).toBe(true);
    }
  });

  it("tiers ascend per group: ilvl non-decreasing, tier numbers unique", () => {
    const byGroup = new Map<string, [number, number, string][]>();
    for (const [id, a] of list) {
      const tier = Number(id.split(".").pop());
      const arr = byGroup.get(a.group) ?? [];
      arr.push([tier, a.ilvl, id]);
      byGroup.set(a.group, arr);
    }
    for (const [group, rows] of byGroup) {
      rows.sort((x, y) => x[0] - y[0]);
      expect(new Set(rows.map((r) => r[0])).size, group).toBe(rows.length);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]![1], `${group} ${rows[i]![2]}`).toBeGreaterThanOrEqual(rows[i - 1]![1]);
      }
    }
  });

  it("has at least 15 new tiers at ilvl 30-40", () => {
    const late = list.filter(([, a]) => a.ilvl >= 30 && a.ilvl <= 45);
    expect(late.length).toBeGreaterThanOrEqual(15);
  });

  it("the stats of gems and sets all have an affix", () => {
    const stats = new Set(list.map(([, a]) => a.stat));
    const needed = new Set<string>();
    for (const b of Object.values(items)) {
      if (b.gem)
        for (const g of [b.gem.weapon, b.gem.armor, b.gem.jewelry])
          for (const m of g) needed.add(m.stat);
    }
    for (const s of needed) expect(stats.has(s as AffixProto["stat"]), s).toBe(true);
  });
});
