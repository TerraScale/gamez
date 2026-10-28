/**
 * Item generation (OWNER: T5, design §11.2). rollItem() is the only way items
 * are created: drops, vendor stock, starter kits and grants all use it. Every
 * random choice goes through ctx.rng, every uid through nextUid().
 */
import type { Rng, SimContext, World } from "@gamez/kernel";
import { pct } from "../fixed.ts";
import { nextUid } from "../resources.ts";
import { itemValue, rarityRank } from "../rules.ts";
import {
  KIND,
  NAMES_RARE_ITEM,
  type AffixProto,
  type BalanceProto,
  type ItemBaseProto,
  type ItemCategory,
  type ItemInstance,
  type ItemRarity,
  type NameTableProto,
  type StatMod,
  type UniqueProto,
} from "../types.ts";
import { balanceOf, pickWeighted, type Entry } from "./common.ts";

export interface RollItemOptions {
  /** Item level: gates bases, affix tiers and uniques. */
  ilvl: number;
  /** Fixed rarity, or null to roll it with magic find (see rollRarity). */
  rarity: ItemRarity | null;
  magicFind: number;
  /** Restrict the base to one category (potions are never rolled). */
  category?: ItemCategory;
  /** Exact base id (starter kit, scripted grants). Skips the drop weights and the base's ilvl gate. */
  base?: string;
  /** Lowest rarity when `rarity` is null (boss drops, stash grants). Default "normal". */
  minRarity?: ItemRarity;
}

/**
 * Rarity roll (§11.2): normal 600 / magic 300 / rare 90 / unique 10 with magic find
 * on the magic weight (100 + mf)%, rare (100 + 0.6 mf)%, unique (100 + 0.4 mf)%.
 * Only rarities at or above `minRarity` are eligible.
 */
export function rollRarity(
  rng: Rng,
  bal: BalanceProto,
  magicFind: number,
  minRarity: ItemRarity = "normal",
): ItemRarity {
  const mf = Math.max(0, Math.floor(magicFind));
  const w = bal.rarityWeights;
  const weights: [ItemRarity, number][] = [
    ["normal", w.normal],
    ["magic", pct(w.magic, 100 + mf)],
    ["rare", pct(w.rare, 100 + Math.floor((mf * 6) / 10))],
    ["unique", pct(w.unique, 100 + Math.floor((mf * 4) / 10))],
  ];
  const minRank = rarityRank(minRarity);
  const eligible = weights.filter(([r]) => rarityRank(r) >= minRank);
  const picked = pickWeighted(rng, eligible, (e) => e[1]);
  return picked ? picked[0] : minRarity;
}

/** Non-potion bases at or below `ilvl` (and in `category`), with their drop weight. */
function baseCandidates(
  ctx: SimContext,
  ilvl: number,
  category: ItemCategory | undefined,
): Entry<ItemBaseProto>[] {
  return ctx.registry
    .all<ItemBaseProto>(KIND.itemBase)
    .filter(
      ([, b]) =>
        b.category !== "potion" &&
        b.ilvl <= ilvl &&
        b.dropWeight > 0 &&
        (category === undefined || b.category === category),
    );
}

/** Uniques whose base and ilvl fit (optionally one base / category). */
function uniqueCandidates(
  ctx: SimContext,
  ilvl: number,
  category: ItemCategory | undefined,
  baseId: string | undefined,
): Entry<UniqueProto>[] {
  const out: Entry<UniqueProto>[] = [];
  for (const entry of ctx.registry.all<UniqueProto>(KIND.unique)) {
    const [, u] = entry;
    if (u.ilvl > ilvl) continue;
    if (baseId !== undefined && u.base !== baseId) continue;
    const b = ctx.registry.get<ItemBaseProto>(KIND.itemBase, u.base);
    if (!b || b.category === "potion") continue;
    if (category !== undefined && b.category !== category) continue;
    out.push(entry);
  }
  return out;
}

/** Affixes of a category at or below `ilvl` (sorted by id). */
function affixPool(ctx: SimContext, category: ItemCategory, ilvl: number): Entry<AffixProto>[] {
  return ctx.registry
    .all<AffixProto>(KIND.affix)
    .filter(([, a]) => a.ilvl <= ilvl && a.categories.includes(category) && a.weight > 0);
}

/** Rolls one affix value (uniform between min and max) into a mod. */
function rollMod(rng: Rng, a: AffixProto): StatMod {
  return { stat: a.stat, value: rng.int(a.min, a.max) };
}

/**
 * Creates one item instance, or null when no base fits. Consumes a uid only
 * when it returns an item.
 */
export function rollItem(world: World, ctx: SimContext, o: RollItemOptions): ItemInstance | null {
  const reg = ctx.registry;
  const rng = ctx.rng;
  const bal = balanceOf(reg);
  const ilvl = Math.max(1, Math.floor(o.ilvl));
  let rarity: ItemRarity = o.rarity ?? rollRarity(rng, bal, o.magicFind, o.minRarity ?? "normal");

  let base: Entry<ItemBaseProto> | undefined;
  if (o.base !== undefined) {
    const proto = reg.get<ItemBaseProto>(KIND.itemBase, o.base);
    if (!proto) return null;
    base = [o.base, proto];
  }

  // Uniques: a unique whose base fits, else fall back to rare.
  let unique: Entry<UniqueProto> | undefined;
  if (rarity === "unique") {
    const cands = uniqueCandidates(ctx, ilvl, o.category, base?.[0]);
    const picked = pickWeighted(rng, cands, (e) => e[1].weight);
    if (picked) {
      const ub = reg.get<ItemBaseProto>(KIND.itemBase, picked[1].base);
      if (ub) {
        unique = picked;
        base = [picked[1].base, ub];
      }
    }
    if (!unique) rarity = "rare";
  }

  if (!base) {
    const cands = baseCandidates(ctx, ilvl, o.category);
    const picked = pickWeighted(rng, cands, (e) => e[1].dropWeight);
    if (!picked) return null;
    base = picked;
  }
  const [baseId, proto] = base;

  let mods: StatMod[] = [];
  const affixes: string[] = [];
  let name = proto.name;

  if (unique) {
    mods = unique[1].mods.map((m) => ({ stat: m.stat, value: rng.int(m.min, m.max) }));
    name = unique[1].name;
  } else if (rarity === "magic") {
    const pool = affixPool(ctx, proto.category, ilvl);
    const prefixes = pool.filter(([, a]) => a.kind === "prefix");
    let wantPrefix = rng.chance(0.5);
    let wantSuffix = rng.chance(0.5);
    if (!wantPrefix && !wantSuffix) {
      if (rng.chance(0.5)) wantPrefix = true;
      else wantSuffix = true;
    }
    const prefix = wantPrefix ? pickWeighted(rng, prefixes, (e) => e[1].weight) : undefined;
    const suffixes = pool.filter(
      ([, a]) => a.kind === "suffix" && (prefix === undefined || a.group !== prefix[1].group),
    );
    const suffix = wantSuffix ? pickWeighted(rng, suffixes, (e) => e[1].weight) : undefined;
    const chosen = [prefix, suffix].filter((e): e is Entry<AffixProto> => e !== undefined);
    for (const [id, a] of chosen) {
      affixes.push(id);
      mods.push(rollMod(rng, a));
    }
    name = [prefix?.[1].name, proto.name, suffix?.[1].name]
      .filter((s): s is string => s !== undefined)
      .join(" ");
  } else if (rarity === "rare") {
    const pool = affixPool(ctx, proto.category, ilvl);
    const target = rng.int(3, 5);
    const groups: string[] = [];
    const kinds = { prefix: 0, suffix: 0 };
    const chosen: Entry<AffixProto>[] = [];
    while (chosen.length < target) {
      const cands = pool.filter(([, a]) => !groups.includes(a.group) && kinds[a.kind] < 3);
      const picked = pickWeighted(rng, cands, (e) => e[1].weight);
      if (!picked) break;
      chosen.push(picked);
      groups.push(picked[1].group);
      kinds[picked[1].kind]++;
    }
    for (const [id, a] of chosen) {
      affixes.push(id);
      mods.push(rollMod(rng, a));
    }
    const names = reg.get<NameTableProto>(KIND.names, NAMES_RARE_ITEM);
    if (names && names.first.length > 0 && names.second.length > 0) {
      name = `${rng.pick(names.first)} ${rng.pick(names.second)}`;
    }
  }

  const item: ItemInstance = {
    uid: nextUid(world),
    base: baseId,
    rarity,
    ilvl,
    name,
    mods,
    affixes,
    value: itemValue(proto, rarity, ilvl),
  };
  if (unique) item.unique = unique[0];
  return item;
}
