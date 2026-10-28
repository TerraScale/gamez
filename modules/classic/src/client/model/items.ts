/**
 * Wave A item view fields (docs/design/wave-A.md §5.6) — OWNER: T-items-hud.
 * Adds set, socket, durability, broken, upgrade, tab and loot-filter data to
 * every ItemView. Pure: reads the registry and the item only. Optional keys
 * are added only when they apply, so items without wave A data keep their
 * old shape (and text).
 */
import type { FrozenRegistry } from "@gamez/kernel";
import { itemVisible } from "../../loot.ts";
import type { LootFilter } from "../../resources.ts";
import { isBroken, maxDurabilityOf, setPieceCounts, socketGroup } from "../../rules.ts";
import {
  KIND,
  type EquipSlot,
  type ItemBaseProto,
  type ItemInstance,
  type SetItemProto,
  type SetProto,
} from "../../types.ts";
import { statDiffs, statTotals, gemLines, setBonusLines, upgradeLines } from "../describe.ts";
import type { ItemCompare, ItemView } from "../contract.ts";

export interface ItemExtraContext {
  registry: FrozenRegistry;
  equipped: Record<EquipSlot, ItemInstance | null> | null;
  lootFilter: LootFilter | null;
}

/** The set block of a set piece: its pieces (worn or not) and the bonuses with their activity. */
function setBlockOf(item: ItemInstance, c: ItemExtraContext): ItemView["set"] {
  if (!item.set) return null;
  const piece = c.registry.get<SetItemProto>(KIND.setItem, item.set);
  if (!piece) return null;
  const proto = c.registry.get<SetProto>(KIND.set, piece.set);
  if (!proto) return null;
  const equipped = c.equipped ? Object.values(c.equipped) : [];
  const worn = new Set<string>();
  for (const it of equipped) if (it && it.set) worn.add(it.set);
  const count = setPieceCounts(c.registry, equipped).find((s) => s.set === piece.set)?.pieces ?? 0;
  return {
    id: piece.set,
    name: proto.name,
    pieces: proto.pieces.map((id) => ({
      name: c.registry.get<SetItemProto>(KIND.setItem, id)?.name ?? id,
      worn: worn.has(id),
    })),
    bonuses: proto.bonuses.map((b) => ({
      count: b.count,
      lines: setBonusLines(b.mods),
      active: count >= b.count,
    })),
  };
}

/** Sockets: one entry per socket; a filled one carries the gem's name and its lines for this item's group. */
function socketsOf(
  item: ItemInstance,
  base: ItemBaseProto | undefined,
  c: ItemExtraContext,
): ItemView["sockets"] {
  const group = base ? socketGroup(base) : null;
  return (item.sockets ?? []).map((gemId) => {
    if (!gemId) return { gem: null, name: "Empty socket", lines: [] };
    const gemBase = c.registry.get<ItemBaseProto>(KIND.itemBase, gemId);
    return {
      gem: gemId,
      name: gemBase?.name ?? gemId,
      lines: gemLines(gemBase?.gem, group),
    };
  });
}

/** Durability: the stored value, or full when the item never wore; null when indestructible. */
function durabilityOf(item: ItemInstance, base: ItemBaseProto | undefined): ItemView["durability"] {
  if (item.dur) return item.dur.max > 0 ? { cur: item.dur.cur, max: item.dur.max } : null;
  const max = base ? maxDurabilityOf(base) : 0;
  return max > 0 ? { cur: max, max } : null;
}

/**
 * Adds the wave A item fields (set, sockets, durability, broken,
 * upgradeLevel, tab, filtered) to a base item view. Called by
 * hudModel.itemView for every item view. Also appends the smith upgrade
 * lines to `lines` and recomputes the stat comparison with gems, upgrades
 * and broken items counted (statTotals with the registry).
 */
export function extendItemView(view: ItemView, item: ItemInstance, c: ItemExtraContext): ItemView {
  const base = c.registry.get<ItemBaseProto>(KIND.itemBase, item.base);
  const out: ItemView = { ...view };
  if (item.set) out.set = setBlockOf(item, c);
  if (item.sockets) out.sockets = socketsOf(item, base, c);
  const dur = durabilityOf(item, base);
  if (dur) out.durability = dur;
  if (isBroken(item)) out.broken = true;
  const level = item.upgrade ?? 0;
  if (level > 0) {
    out.upgradeLevel = level;
    if (base) out.lines = [...view.lines, ...upgradeLines(base, level)];
  }
  if (item.tab !== undefined) out.tab = item.tab;
  if (c.lootFilter) out.filtered = !itemVisible(c.lootFilter, c.registry, item);
  if (view.compare && base) {
    const cmp: ItemCompare = view.compare;
    const cur = cmp.slot && c.equipped ? (c.equipped[cmp.slot] ?? null) : null;
    const curBase = cur ? c.registry.get<ItemBaseProto>(KIND.itemBase, cur.base) : undefined;
    out.compare = {
      ...cmp,
      stats: statDiffs(
        statTotals(item, base, c.registry),
        cur ? statTotals(cur, curBase, c.registry) : {},
      ),
    };
  }
  return out;
}
