/**
 * Wave A HUD sections (docs/design/wave-A.md §5.6) — OWNER: T-items-hud.
 * Smith services, gambler offers, loot filter preview and stash tabs. Pure:
 * they read the world and the registry, never mutate them, and return null
 * (or an empty list) when the section does not apply.
 */
import { AreaTag, Equipment, Inventory, Level, Loot, Npc, Wallet } from "../../components.ts";
import { lootFilterOf, currentDepth, RES, type StashState } from "../../resources.ts";
import { lootVisible } from "../../loot.ts";
import {
  gamblePrice,
  maxDurabilityOf,
  repairCost,
  rerollCost,
  socketCost,
  socketGroup,
  stashTabCount,
  upgradeCost,
} from "../../rules.ts";
import {
  BALANCE_ID,
  ECONOMY_ID,
  KIND,
  type BalanceProto,
  type EconomyProto,
  type EquipSlot,
  type ItemBaseProto,
  type ItemCategory,
  type ItemInstance,
  type NpcProto,
} from "../../types.ts";
import type {
  CraftItemView,
  CraftView,
  GambleView,
  LootFilterView,
  StashTabView,
} from "../contract.ts";
import type { ModelContext } from "./context.ts";

/** Equipment slots in display order (one entry per slot, rings included). */
const SLOT_ORDER: EquipSlot[] = [
  "weapon",
  "offhand",
  "helm",
  "armor",
  "gloves",
  "boots",
  "amulet",
  "ring1",
  "ring2",
];

/** Player text of an item category in gambler offers ("Random weapon"). */
const GAMBLE_NAME: Record<ItemCategory, string> = {
  weapon: "weapon",
  shield: "shield",
  helm: "helm",
  armor: "armor",
  gloves: "gloves",
  boots: "boots",
  ring: "ring",
  amulet: "amulet",
  potion: "potion",
  gem: "gem",
};

/** Durability the item has for pricing: stored, or full when it never wore; null when indestructible. */
function durabilityFor(item: ItemInstance, base: ItemBaseProto | undefined) {
  if (item.dur) return item.dur.max > 0 ? item.dur : null;
  const max = base ? maxDurabilityOf(base) : 0;
  return max > 0 ? { cur: max, max } : null;
}

/** Gold to repair the item fully (0 when nothing to repair). */
export function repairPriceOf(
  econ: EconomyProto,
  item: ItemInstance,
  base: ItemBaseProto | undefined,
): number {
  const dur = durabilityFor(item, base);
  if (!dur) return 0;
  return repairCost(econ, { ...item, dur });
}

/** The smith works on equipment that has a socket group (weapons, armor, shields, jewelry). */
function isSmithable(base: ItemBaseProto | undefined): boolean {
  return base !== undefined && socketGroup(base) !== null;
}

/** Per-item price block (null where the service is impossible). */
function craftItemView(
  c: ModelContext,
  econ: EconomyProto,
  item: ItemInstance,
  where: "bag" | "equipped",
  gemsInBag: number,
): CraftItemView {
  const base = c.registry.get<ItemBaseProto>(KIND.itemBase, item.base);
  const smith = isSmithable(base);
  const repair = repairPriceOf(econ, item, base);
  const upgrade = smith ? upgradeCost(econ, item) : null;
  const level = item.upgrade ?? 0;
  const socketed = item.sockets?.some((g) => g !== null) ?? false;
  return {
    item: c.itemView(item),
    where,
    repairCost: repair > 0 ? repair : null,
    upgradeCost: upgrade,
    upgradeChance: upgrade === null ? null : (econ.upgrade.chancePct[level] ?? null),
    rerollCost: smith ? rerollCost(econ, item) : null,
    socketCost: base && smith ? socketCost(econ, base, item) : null,
    canSocket: smith && gemsInBag > 0 && (item.sockets?.includes(null) ?? false),
    unsocketCost: smith && socketed ? econ.sockets.unsocketCost : null,
  };
}

/** Smith services for every bag and equipped item; null unless c.vendor is a crafting NPC. */
export function buildCraftView(c: ModelContext): CraftView | null {
  const { world, registry, hero, vendor } = c;
  if (vendor === 0 || !world.exists(vendor) || hero === 0 || !world.exists(hero)) return null;
  const npc = world.get(vendor, Npc);
  const proto = npc ? registry.get<NpcProto>(KIND.npc, npc.proto) : undefined;
  if (!proto || !proto.crafts) return null;
  const econ = registry.get<EconomyProto>(KIND.economy, ECONOMY_ID);
  if (!econ) return null;

  const bag = (world.get(hero, Inventory)?.items ?? []).map((e) => e.item);
  const worn = world.get(hero, Equipment);
  const equipped: ItemInstance[] = [];
  for (const slot of SLOT_ORDER) {
    const it = worn?.[slot];
    if (it) equipped.push(it);
  }

  let gemsInBag = 0;
  for (const it of bag) {
    if (registry.get<ItemBaseProto>(KIND.itemBase, it.base)?.gem) gemsInBag += 1;
  }

  const items: CraftItemView[] = [
    ...bag.map((it) => craftItemView(c, econ, it, "bag", gemsInBag)),
    ...equipped.map((it) => craftItemView(c, econ, it, "equipped", gemsInBag)),
  ];

  // Bag gems grouped by base (sorted by base id: kind, then tier).
  const groups = new Map<string, { base: string; name: string; tier: number; uids: number[] }>();
  for (const it of bag) {
    const base = registry.get<ItemBaseProto>(KIND.itemBase, it.base);
    if (!base?.gem) continue;
    const g = groups.get(it.base) ?? {
      base: it.base,
      name: base.name,
      tier: base.gem.tier,
      uids: [],
    };
    g.uids.push(it.uid);
    groups.set(it.base, g);
  }
  const gems = [...groups.keys()].sort().map((id) => {
    const g = groups.get(id)!;
    const count = g.uids.length;
    const combine =
      count >= 3 && g.tier < 5 ? (econ.sockets.combineCost[g.tier - 1] ?? null) : null;
    return {
      base: g.base,
      name: g.name,
      tier: g.tier,
      count,
      uids: g.uids,
      combineCost: combine,
    };
  });

  let repairAllCost = 0;
  for (const it of [...bag, ...equipped]) {
    repairAllCost += repairPriceOf(econ, it, registry.get<ItemBaseProto>(KIND.itemBase, it.base));
  }

  return { npc: vendor, items, gems, repairAllCost };
}

/** Gambler offers with prices; null unless c.vendor is a gambler NPC. */
export function buildGambleView(c: ModelContext): GambleView | null {
  const { world, registry, hero, vendor } = c;
  if (vendor === 0 || !world.exists(vendor)) return null;
  const npc = world.get(vendor, Npc);
  const proto = npc ? registry.get<NpcProto>(KIND.npc, npc.proto) : undefined;
  if (!proto || proto.role !== "gambler") return null;
  const econ = registry.get<EconomyProto>(KIND.economy, ECONOMY_ID);
  const level = (hero !== 0 ? world.get(hero, Level)?.level : undefined) ?? 1;
  const gold = (hero !== 0 ? world.get(hero, Wallet)?.gold : undefined) ?? 0;
  const offers: GambleView["offers"] = [];
  for (const category of proto.gamble?.categories ?? []) {
    const price = econ ? gamblePrice(econ, category, level) : null;
    if (price === null) continue;
    offers.push({
      category,
      label: `Random ${GAMBLE_NAME[category]}`,
      price,
      affordable: gold >= price,
    });
  }
  return { npc: vendor, name: proto.name, greeting: proto.greeting, offers };
}

/** The loot filter (lootFilterOf) and how many ground items it hides in this area. */
export function buildLootFilterView(c: ModelContext): LootFilterView | null {
  const { world, registry } = c;
  const filter = lootFilterOf(world);
  const depth = currentDepth(world);
  let hiddenOnGround = 0;
  for (const e of world.query(Loot, AreaTag)) {
    if (world.read(e, AreaTag).depth !== depth) continue;
    const loot = world.read(e, Loot);
    if (!lootVisible(filter, registry, loot)) hiddenOnGround += 1;
  }
  return { filter, hiddenOnGround };
}

/** Stash tabs with counts (rules.stashTabCount tabs of stashSize). */
export function buildStashTabs(c: ModelContext): StashTabView[] {
  const bal = c.registry.get<BalanceProto>(KIND.balance, BALANCE_ID);
  if (!bal) return [];
  const stash = c.world.getResource<StashState>(RES.stash);
  const items = stash?.items ?? [];
  const names = stash?.tabNames ?? [];
  const out: StashTabView[] = [];
  for (let i = 0; i < stashTabCount(bal); i++) {
    out.push({
      index: i,
      name: names[i]?.trim() || `Tab ${i + 1}`,
      count: items.filter((it) => (it.tab ?? 0) === i).length,
      size: bal.stashSize,
    });
  }
  return out;
}
