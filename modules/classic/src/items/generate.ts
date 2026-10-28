/**
 * Item generation (OWNER: T5 / T-items, design §11.2 and wave-A.md §5).
 * rollItem() is the only way items are created: drops, vendor stock, starter
 * kits, grants and gambling all use it. Every random choice goes through
 * ctx.rng, every uid through nextUid().
 *
 * Wave A: rarity "set" (a SetItemProto whose base and ilvl fit, else rare),
 * durability on every equippable item that wears (rules.maxDurabilityOf),
 * gems (never rolled as normal loot; see gemBaseFor), dropped sockets
 * (rollDropSockets), gambling rarity weights and a separate base ilvl gate.
 */
import type { FrozenRegistry, Rng, SimContext, World } from "@gamez/kernel";
import { pct } from "../fixed.ts";
import { nextUid } from "../resources.ts";
import { itemValue, maxDurabilityOf, maxSocketsOf, rarityRank, socketGroup } from "../rules.ts";
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
  type SetItemProto,
  type StatMod,
  type UniqueProto,
} from "../types.ts";
import { balanceOf, percentRoll, pickWeighted, type Entry } from "./common.ts";

export interface RollItemOptions {
  /** Item level: gates affix tiers, uniques and set pieces (and bases unless maxBaseIlvl is set). */
  ilvl: number;
  /** Fixed rarity, or null to roll it with magic find (see rollRarity) or `rarityWeights`. */
  rarity: ItemRarity | null;
  magicFind: number;
  /** Restrict the base to one category (potions are never rolled; gems only when asked for). */
  category?: ItemCategory;
  /** Exact base id (starter kit, scripted grants). Skips the drop weights and the base's ilvl gate. */
  base?: string;
  /** Lowest rarity when `rarity` is null (boss drops, stash grants). Default "normal". */
  minRarity?: ItemRarity;
  /**
   * Wave A (gambling): fixed rarity weights used instead of the balance
   * weights and magic find when `rarity` is null. Missing rarities weigh 0.
   */
  rarityWeights?: Partial<Record<ItemRarity, number>>;
  /** Wave A (gambling): base ilvl gate (default `ilvl`). */
  maxBaseIlvl?: number;
}

/** Order of the rarity weights (rank order). */
const RARITY_ORDER: readonly ItemRarity[] = ["normal", "magic", "rare", "set", "unique"];

/**
 * Rarity roll (§11.2): normal 600 / magic 300 / rare 90 / set 8 / unique 10 with
 * magic find on the magic weight (100 + mf)%, rare (100 + 0.6 mf)%, set and
 * unique (100 + 0.4 mf)%. Only rarities at or above `minRarity` are eligible.
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
    ["set", pct(w.set ?? 0, 100 + Math.floor((mf * 4) / 10))],
    ["unique", pct(w.unique, 100 + Math.floor((mf * 4) / 10))],
  ];
  return pickRarity(rng, weights, minRarity);
}

/** Rarity roll from fixed weights (gambling); falls back to `minRarity` when nothing weighs. */
export function rollRarityFrom(
  rng: Rng,
  weights: Partial<Record<ItemRarity, number>>,
  minRarity: ItemRarity = "normal",
): ItemRarity {
  return pickRarity(
    rng,
    RARITY_ORDER.map((r): [ItemRarity, number] => [r, weights[r] ?? 0]),
    minRarity,
  );
}

function pickRarity(
  rng: Rng,
  weights: readonly [ItemRarity, number][],
  minRarity: ItemRarity,
): ItemRarity {
  const minRank = rarityRank(minRarity);
  const eligible = weights.filter(([r]) => rarityRank(r) >= minRank);
  const picked = pickWeighted(rng, eligible, (e) => e[1]);
  return picked ? picked[0] : minRarity;
}

/**
 * Bases that can be rolled at or below `ilvl` (and in `category`), with their
 * drop weight. Potions never; gems only when `category` is "gem".
 */
export function baseCandidates(
  reg: FrozenRegistry,
  ilvl: number,
  category: ItemCategory | undefined,
): Entry<ItemBaseProto>[] {
  return reg
    .all<ItemBaseProto>(KIND.itemBase)
    .filter(
      ([, b]) =>
        b.category !== "potion" &&
        (b.category !== "gem" || category === "gem") &&
        b.ilvl <= ilvl &&
        b.dropWeight > 0 &&
        (category === undefined || b.category === category),
    );
}

/** Uniques whose base and ilvl fit (optionally one base / category). */
function uniqueCandidates(
  reg: FrozenRegistry,
  ilvl: number,
  category: ItemCategory | undefined,
  baseId: string | undefined,
): Entry<UniqueProto>[] {
  const out: Entry<UniqueProto>[] = [];
  for (const entry of reg.all<UniqueProto>(KIND.unique)) {
    const [, u] = entry;
    if (u.ilvl > ilvl) continue;
    if (baseId !== undefined && u.base !== baseId) continue;
    const b = reg.get<ItemBaseProto>(KIND.itemBase, u.base);
    if (!b || b.category === "potion" || b.category === "gem") continue;
    if (category !== undefined && b.category !== category) continue;
    out.push(entry);
  }
  return out;
}

/** Set pieces whose base and ilvl fit (optionally one base / category). */
function setItemCandidates(
  reg: FrozenRegistry,
  ilvl: number,
  category: ItemCategory | undefined,
  baseId: string | undefined,
): Entry<SetItemProto>[] {
  const out: Entry<SetItemProto>[] = [];
  for (const entry of reg.all<SetItemProto>(KIND.setItem)) {
    const [, s] = entry;
    if (s.ilvl > ilvl || s.weight <= 0) continue;
    if (baseId !== undefined && s.base !== baseId) continue;
    const b = reg.get<ItemBaseProto>(KIND.itemBase, s.base);
    if (!b || b.category === "potion" || b.category === "gem") continue;
    if (category !== undefined && b.category !== category) continue;
    out.push(entry);
  }
  return out;
}

/** Affixes of a category at or below `ilvl` (sorted by id). */
function affixPool(reg: FrozenRegistry, category: ItemCategory, ilvl: number): Entry<AffixProto>[] {
  return reg
    .all<AffixProto>(KIND.affix)
    .filter(([, a]) => a.ilvl <= ilvl && a.categories.includes(category) && a.weight > 0);
}

/** Rolls one affix value (uniform between min and max) into a mod. */
function rollMod(rng: Rng, a: AffixProto): StatMod {
  return { stat: a.stat, value: rng.int(a.min, a.max) };
}

export interface RolledAffixes {
  mods: StatMod[];
  affixes: string[];
  name: string;
}

/**
 * Affixes and name of a magic or rare item of `base` at `ilvl` (the item
 * generator's affix step; the smith's reroll uses it too). Other rarities
 * get no affixes and the base name.
 */
export function rollAffixes(
  ctx: SimContext,
  base: Readonly<ItemBaseProto>,
  rarity: ItemRarity,
  ilvl: number,
): RolledAffixes {
  const reg = ctx.registry;
  const rng = ctx.rng;
  const mods: StatMod[] = [];
  const affixes: string[] = [];
  let name = base.name;
  if (rarity === "magic") {
    const pool = affixPool(reg, base.category, ilvl);
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
    name = [prefix?.[1].name, base.name, suffix?.[1].name]
      .filter((s): s is string => s !== undefined)
      .join(" ");
  } else if (rarity === "rare") {
    const pool = affixPool(reg, base.category, ilvl);
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
  return { mods, affixes, name };
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
  const minRarity = o.minRarity ?? "normal";
  let rarity: ItemRarity =
    o.rarity ??
    (o.rarityWeights
      ? rollRarityFrom(rng, o.rarityWeights, minRarity)
      : rollRarity(rng, bal, o.magicFind, minRarity));

  let base: Entry<ItemBaseProto> | undefined;
  if (o.base !== undefined) {
    const proto = reg.get<ItemBaseProto>(KIND.itemBase, o.base);
    if (!proto) return null;
    base = [o.base, proto];
    if (proto.category === "gem" || proto.category === "potion") rarity = "normal";
  }

  // Uniques: a unique whose base fits, else fall back to rare.
  let unique: Entry<UniqueProto> | undefined;
  if (rarity === "unique") {
    const cands = uniqueCandidates(reg, ilvl, o.category, base?.[0]);
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

  // Set pieces: a piece whose base and ilvl fit, else fall back to rare.
  let piece: Entry<SetItemProto> | undefined;
  if (rarity === "set") {
    const cands = setItemCandidates(reg, ilvl, o.category, base?.[0]);
    const picked = pickWeighted(rng, cands, (e) => e[1].weight);
    if (picked) {
      const sb = reg.get<ItemBaseProto>(KIND.itemBase, picked[1].base);
      if (sb) {
        piece = picked;
        base = [picked[1].base, sb];
      }
    }
    if (!piece) rarity = "rare";
  }

  if (!base) {
    const cands = baseCandidates(reg, Math.max(1, Math.floor(o.maxBaseIlvl ?? ilvl)), o.category);
    const picked = pickWeighted(rng, cands, (e) => e[1].dropWeight);
    if (!picked) return null;
    base = picked;
    if (picked[1].category === "gem") rarity = "normal";
  }
  const [baseId, proto] = base;

  let mods: StatMod[] = [];
  let affixes: string[] = [];
  let name = proto.name;

  if (unique) {
    mods = unique[1].mods.map((m) => ({ stat: m.stat, value: rng.int(m.min, m.max) }));
    name = unique[1].name;
  } else if (piece) {
    mods = piece[1].mods.map((m) => ({ stat: m.stat, value: rng.int(m.min, m.max) }));
    name = piece[1].name;
  } else if (rarity === "magic" || rarity === "rare") {
    const rolled = rollAffixes(ctx, proto, rarity, ilvl);
    mods = rolled.mods;
    affixes = rolled.affixes;
    name = rolled.name;
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
  if (piece) item.set = piece[0];
  const maxDur = proto.slots.length > 0 ? maxDurabilityOf(proto) : 0;
  if (maxDur > 0) item.dur = { cur: maxDur, max: maxDur };
  return item;
}

/**
 * Dropped sockets (wave A §5.2): a normal or magic weapon or armor piece
 * rolls 1..maxSockets empty sockets at BalanceProto.socketedDropPct %.
 * Draws nothing from the rng when the chance is 0 or the item cannot have
 * sockets. Mutates `item` (fresh from rollItem, not yet in the world).
 */
export function rollDropSockets(
  rng: Rng,
  reg: FrozenRegistry,
  bal: BalanceProto,
  item: ItemInstance,
): void {
  const chance = bal.socketedDropPct ?? 0;
  if (chance <= 0) return;
  if (item.rarity !== "normal" && item.rarity !== "magic") return;
  const base = reg.get<ItemBaseProto>(KIND.itemBase, item.base);
  if (!base) return;
  const group = socketGroup(base);
  if (group !== "weapon" && group !== "armor") return;
  const max = maxSocketsOf(base);
  if (max <= 0) return;
  if (!percentRoll(rng, chance)) return;
  const n = rng.int(1, max);
  item.sockets = Array.from({ length: n }, () => null);
}

/** Gem tier dropped by a monster of `level`: 1 + floor(level / 10), 1..5. */
export function gemTierFor(level: number): number {
  return Math.max(1, Math.min(5, 1 + Math.floor(Math.max(0, level) / 10)));
}

/**
 * A gem base id for a drop of `tier`: uniform over the gem bases of that tier
 * (sorted by id); when the content has none of that tier, the highest lower
 * tier that exists. undefined when the content has no gems. Draws from the
 * rng only when there is a choice.
 */
export function gemBaseFor(rng: Rng, reg: FrozenRegistry, tier: number): string | undefined {
  const gems = reg.all<ItemBaseProto>(KIND.itemBase).filter(([, b]) => b.gem !== undefined);
  if (gems.length === 0) return undefined;
  for (let t = tier; t >= 1; t--) {
    const at = gems.filter(([, b]) => b.gem!.tier === t);
    if (at.length === 0) continue;
    return at.length === 1 ? at[0]![0] : rng.pick(at)[0];
  }
  return undefined;
}

/** The gem base of `kind` at `tier`, if the content defines it. */
export function gemBaseOf(reg: FrozenRegistry, kind: string, tier: number): string | undefined {
  for (const [id, b] of reg.all<ItemBaseProto>(KIND.itemBase)) {
    if (b.gem && b.gem.kind === kind && b.gem.tier === tier) return id;
  }
  return undefined;
}

/** A plain gem item of `baseId` (normal, no mods), with a fresh uid. Draws nothing from the rng. */
export function makeGemItem(world: World, reg: FrozenRegistry, baseId: string): ItemInstance {
  const proto = reg.require<ItemBaseProto>(KIND.itemBase, baseId);
  return {
    uid: nextUid(world),
    base: baseId,
    rarity: "normal",
    ilvl: Math.max(1, proto.ilvl),
    name: proto.name,
    mods: [],
    affixes: [],
    value: itemValue(proto, "normal", Math.max(1, proto.ilvl)),
  };
}
