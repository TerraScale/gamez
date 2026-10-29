/**
 * Wave A town steps of the auto routine (docs/design/wave-A.md §8):
 *  - repair (AutoConfig.autoRepair): worn (< 60 %) or broken gear at the
 *    crafting smith, everything at once ({op:"repair", uid: 0}) when the gold
 *    covers it, else the most important pieces first;
 *  - craft (autoCraft): socket bag gems into equipped items, add a socket
 *    when a spare gem would fill it, upgrade the weapon and armor, combine
 *    three gems of a base into the next tier;
 *  - gamble (autoGamble): rings and amulets with the gold above a reserve
 *    that grows with the level.
 * Every op is queued once per visit in one batch (the owners check gold and
 * reach themselves, so a refused op costs nothing and is retried next visit).
 */
import { Equipment, Inventory, Npc } from "../components.ts";
import { gamblePrice, maxSocketsOf, repairCost, socketCost, upgradeCost } from "../rules.ts";
import {
  KIND,
  type EconomyProto,
  type EquipSlot,
  type ItemBaseProto,
  type ItemCategory,
  type ItemInstance,
  type NpcProto,
} from "../types.ts";
import {
  craftingSmith,
  CRAFT_SHARE_PCT,
  craftReserve,
  econOf,
  gambleReserve,
  gambler,
  goldOf,
  heroLevel,
  MAX_GAMBLES_PER_VISIT,
} from "./econ.ts";
import { primaryOf } from "./gear.ts";
import { itemScore } from "./score.ts";
import { bagFits, pushCmd, type AutoCtx } from "./util.ts";
import { at, type StepResult } from "./visit.ts";

/** Gear below this durability (% of max) is repaired on a town visit. */
export const REPAIR_BELOW_PCT = 60;

/** Equipped slots by importance (repairs, sockets and upgrades go in this order). */
export const SLOT_PRIORITY: readonly EquipSlot[] = [
  "weapon",
  "armor",
  "helm",
  "offhand",
  "gloves",
  "boots",
  "amulet",
  "ring1",
  "ring2",
];

function cfgFlag(v: boolean | undefined): boolean {
  return v ?? true;
}

function equipped(c: AutoCtx): { slot: EquipSlot; item: ItemInstance }[] {
  const eq = c.world.get(c.hero, Equipment);
  if (!eq) return [];
  const out: { slot: EquipSlot; item: ItemInstance }[] = [];
  for (const slot of SLOT_PRIORITY) {
    const it = eq[slot];
    if (it) out.push({ slot, item: it });
  }
  return out;
}

/** Durability in percent of max (100 for items that never wear or have not worn yet). */
export function durPct(item: ItemInstance): number {
  const d = item.dur;
  if (!d || d.max <= 0) return 100;
  return Math.floor((Math.max(0, d.cur) * 100) / d.max);
}

/** Equipped items that need the smith: broken or below REPAIR_BELOW_PCT. */
export function wornGear(c: AutoCtx): ItemInstance[] {
  return equipped(c)
    .map((e) => e.item)
    .filter((it) => durPct(it) < REPAIR_BELOW_PCT);
}

/** True when an equipped item is broken (no stats until repaired). */
export function brokenGear(c: AutoCtx): boolean {
  return equipped(c).some((e) => e.item.dur !== undefined && e.item.dur.cur <= 0);
}

/** The repair ops a visit queues with `gold` (uid 0 when it covers everything). */
export function planRepairs(c: AutoCtx, econ: EconomyProto, gold: number): number[] {
  const worn = wornGear(c);
  if (worn.length === 0) return [];
  let all = 0;
  for (const e of equipped(c)) all += repairCost(econ, e.item);
  for (const en of c.world.get(c.hero, Inventory)?.items ?? []) all += repairCost(econ, en.item);
  if (all > 0 && all <= gold) return [0];
  // Not enough for everything: broken pieces first, then the most worn, slot order on ties.
  const order = [...worn].sort((a, b) => durPct(a) - durPct(b));
  const out: number[] = [];
  let left = gold;
  for (const it of order) {
    const cost = repairCost(econ, it);
    if (cost <= 0 || cost > left) continue;
    out.push(it.uid);
    left -= cost;
  }
  return out;
}

export function repairStep(c: AutoCtx): StepResult {
  if (!cfgFlag(c.cfg.autoRepair)) return "skip";
  const econ = econOf(c.reg);
  const npc = craftingSmith(c);
  if (!econ || npc === 0) return "skip";
  const uids = planRepairs(c, econ, goldOf(c));
  if (uids.length === 0) return "skip";
  return at(c, npc, () => {
    for (const uid of uids) pushCmd(c, { op: "repair", npc, uid });
  });
}

// ---------------------------------------------------------------------------
// Crafting: gems, sockets, upgrades
// ---------------------------------------------------------------------------

interface BagGem {
  uid: number;
  base: string;
  tier: number;
}

function bagGems(c: AutoCtx): BagGem[] {
  const out: BagGem[] = [];
  for (const en of c.world.get(c.hero, Inventory)?.items ?? []) {
    const b = c.reg.get<ItemBaseProto>(KIND.itemBase, en.item.base);
    if (b?.gem) out.push({ uid: en.item.uid, base: en.item.base, tier: b.gem.tier });
  }
  // Best first: tier, then base id, then uid (deterministic).
  out.sort((a, b) =>
    b.tier !== a.tier
      ? b.tier - a.tier
      : a.base !== b.base
        ? a.base < b.base
          ? -1
          : 1
        : a.uid - b.uid,
  );
  return out;
}

/** Score gain of putting gem `base` into the first empty socket of `item` (<= 0 = useless). */
function gemGain(c: AutoCtx, item: ItemInstance, base: string): number {
  const sockets = item.sockets ?? [];
  const i = sockets.indexOf(null);
  const filled = [...sockets];
  if (i >= 0) filled[i] = base;
  else filled.push(base);
  const primary = primaryOf(c);
  return itemScore(c.reg, { ...item, sockets: filled }, primary) - itemScore(c.reg, item, primary);
}

/** Best remaining gem for `item` (highest gain > 0), or -1. */
function bestGem(c: AutoCtx, item: ItemInstance, gems: readonly BagGem[]): number {
  let best = -1;
  let bestGain = 0;
  gems.forEach((g, i) => {
    const gain = gemGain(c, item, g.base);
    if (gain > bestGain) {
      best = i;
      bestGain = gain;
    }
  });
  return best;
}

export type CraftOp =
  | { op: "socketGem"; uid: number; gem: number }
  | { op: "addSocket"; uid: number }
  | { op: "upgrade"; uid: number }
  | { op: "combineGems"; base: string };

/**
 * The crafting ops one visit queues with `budget` gold (above the reserve):
 * fill empty sockets with the best bag gems, add a socket where a spare gem
 * would go, upgrade gear (weapon first), then combine leftover triples.
 */
export function planCrafts(c: AutoCtx, econ: EconomyProto, budget: number): CraftOp[] {
  const out: CraftOp[] = [];
  const gems = bagGems(c);
  const gear = equipped(c).filter((e) => !(e.item.dur !== undefined && e.item.dur.cur <= 0));
  let left = budget;
  // 1. Empty sockets (free). `gear` items are replaced by their socketed versions.
  for (let i = 0; i < gear.length; i++) {
    let cur = gear[i]!.item;
    const empty = (cur.sockets ?? []).filter((s) => s === null).length;
    for (let k = 0; k < empty && gems.length > 0; k++) {
      const gi = bestGem(c, cur, gems);
      if (gi < 0) break;
      const g = gems.splice(gi, 1)[0]!;
      out.push({ op: "socketGem", uid: cur.uid, gem: g.uid });
      const s = [...(cur.sockets ?? [])];
      s[s.indexOf(null)] = g.base;
      cur = { ...cur, sockets: s };
    }
    gear[i] = { ...gear[i]!, item: cur };
  }
  // 2. A new socket for a spare gem (one per item per visit).
  for (const { item } of gear) {
    if (gems.length === 0) break;
    const base = c.reg.get<ItemBaseProto>(KIND.itemBase, item.base);
    if (!base || (item.sockets ?? []).includes(null)) continue;
    if ((item.sockets?.length ?? 0) >= maxSocketsOf(base)) continue;
    const cost = socketCost(econ, base, item);
    if (cost === null || cost > left) continue;
    const gi = bestGem(c, item, gems);
    if (gi < 0) continue;
    const g = gems.splice(gi, 1)[0]!;
    out.push({ op: "addSocket", uid: item.uid }, { op: "socketGem", uid: item.uid, gem: g.uid });
    left -= cost;
  }
  // 3. Smith upgrades of the weapon, body armor and shield, one level each per visit
  //    (what is left above the gamble reserve goes to the gambler).
  for (const { slot, item } of gear) {
    if (!UPGRADE_SLOTS.includes(slot)) continue;
    const base = c.reg.get<ItemBaseProto>(KIND.itemBase, item.base);
    if (!base || base.category === "potion" || base.category === "gem") continue;
    const cost = upgradeCost(econ, item);
    if (cost === null || cost > left) continue;
    out.push({ op: "upgrade", uid: item.uid });
    left -= cost;
  }
  // 4. Combine leftover triples (needs a free bag cell for the result: the three leave first).
  const counts = new Map<string, number>();
  for (const g of gems) counts.set(g.base, (counts.get(g.base) ?? 0) + 1);
  for (const base of [...counts.keys()].sort()) {
    const tier = c.reg.get<ItemBaseProto>(KIND.itemBase, base)?.gem?.tier ?? 0;
    const cost = econ.sockets.combineCost[tier - 1];
    let n = counts.get(base)!;
    while (n >= 3 && cost !== undefined && cost <= left && tier < GEM_MAX_TIER) {
      out.push({ op: "combineGems", base });
      left -= cost;
      n -= 3;
    }
  }
  return out;
}
const GEM_MAX_TIER = 5;
/** Slots the auto upgrades at the smith (wave-A.md §8: weapon and armor). */
export const UPGRADE_SLOTS: readonly EquipSlot[] = ["weapon", "armor", "offhand"];

export function craftStep(c: AutoCtx, potionReserve: number): StepResult {
  if (!cfgFlag(c.cfg.autoCraft)) return "skip";
  const econ = econOf(c.reg);
  const npc = craftingSmith(c);
  if (!econ || npc === 0) return "skip";
  const surplus = goldOf(c) - craftReserve(c, potionReserve);
  const ops = planCrafts(c, econ, Math.max(0, Math.floor((surplus * CRAFT_SHARE_PCT) / 100)));
  if (ops.length === 0) return "skip";
  return at(c, npc, () => {
    for (const o of ops) pushCmd(c, { ...o, npc });
  });
}

// ---------------------------------------------------------------------------
// Gambling
// ---------------------------------------------------------------------------

/** Categories the auto gambles for (jewelry: no weapon style or requirements to get wrong). */
export const GAMBLE_CATEGORIES: readonly ItemCategory[] = ["ring", "amulet"];

/** Gamble ops (categories) for one visit with `budget` gold. */
export function planGambles(
  c: AutoCtx,
  econ: EconomyProto,
  offered: readonly ItemCategory[],
  budget: number,
): ItemCategory[] {
  const level = heroLevel(c);
  const cats = GAMBLE_CATEGORIES.filter((k) => offered.includes(k));
  const out: ItemCategory[] = [];
  let left = budget;
  // One 1x1 cell per gamble; leave room for loot (two free 2x3 spots are checked by the trip logic).
  const free = freeCells(c);
  for (let i = 0; i < MAX_GAMBLES_PER_VISIT && cats.length > 0; i++) {
    const cat = cats[i % cats.length]!;
    const price = gamblePrice(econ, cat, level);
    if (price === null || price > left || out.length + 1 > free - BAG_CELLS_KEPT) break;
    out.push(cat);
    left -= price;
  }
  return out;
}
/** Bag cells left free after gambling. */
const BAG_CELLS_KEPT = 8;

function freeCells(c: AutoCtx): number {
  const inv = c.world.get(c.hero, Inventory);
  if (!inv) return 0;
  let used = 0;
  for (const en of inv.items) {
    const s = c.reg.get<ItemBaseProto>(KIND.itemBase, en.item.base)?.size ?? { w: 1, h: 1 };
    used += s.w * s.h;
  }
  return inv.cols * inv.rows - used;
}

export function gambleStep(c: AutoCtx, potionReserve: number): StepResult {
  if (!cfgFlag(c.cfg.autoGamble)) return "skip";
  const econ = econOf(c.reg);
  const npc = gambler(c);
  if (!econ || npc === 0 || !bagFits(c, 1, 1)) return "skip";
  const offered = c.reg.get<NpcProto>(KIND.npc, c.world.read(npc, Npc).proto)?.gamble?.categories;
  if (!offered) return "skip";
  const budget = goldOf(c) - gambleReserve(c, potionReserve);
  const cats = planGambles(c, econ, offered, budget);
  if (cats.length === 0) return "skip";
  return at(c, npc, () => {
    for (const category of cats) pushCmd(c, { op: "gamble", npc, category });
  });
}
