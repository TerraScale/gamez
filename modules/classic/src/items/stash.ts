/**
 * The town stash (OWNER: T5 / T-items, design §11.4, wave-A.md §5.5): one
 * StashState list for every tab; ItemInstance.tab says which tab (absent =
 * 0; the field is only stored for tabs > 0). rules.stashTabCount(bal) tabs
 * of BalanceProto.stashSize items each. Put / take / move need the town and
 * the stash chest within INTERACT_RANGE.
 */
import type { FrozenRegistry, SimContext, World } from "@gamez/kernel";
import { ERR, fail, OK, type OpResult } from "../actions.ts";
import { Inventory } from "../components.ts";
import { emit } from "../events.ts";
import { RES, stashOf, type StashState } from "../resources.ts";
import { stashTabCount } from "../rules.ts";
import type { ItemInstance } from "../types.ts";
import { balanceOf, liveHero } from "./common.ts";
import { placeItem, removeItem, type GridBag } from "./inventory.ts";
import { stashInReach, townOnly } from "./vendor.ts";

/** Stash tab of an item (0 when absent). */
export function tabOf(item: ItemInstance): number {
  return item.tab ?? 0;
}

/** `item` stored in `tab` (no `tab` field for tab 0). Does not mutate `item`. */
export function withTab(item: ItemInstance, tab: number): ItemInstance {
  const out: ItemInstance = { ...item };
  delete out.tab;
  if (tab > 0) out.tab = tab;
  return out;
}

/** Items per tab (index = tab, length = tab count; items in tabs beyond the count are ignored). */
export function tabCounts(stash: StashState, tabs: number): number[] {
  const counts = Array.from({ length: tabs }, () => 0);
  for (const it of stash.items) {
    const t = tabOf(it);
    if (t >= 0 && t < tabs) counts[t]!++;
  }
  return counts;
}

/** The first tab with room, or -1 when every tab is full. */
export function firstTabWithRoom(reg: FrozenRegistry, stash: StashState): number {
  const bal = balanceOf(reg);
  const counts = tabCounts(stash, stashTabCount(bal));
  return counts.findIndex((n) => n < bal.stashSize);
}

/** Validates an explicit tab (or picks the first with room): the tab index, or the failure. */
function targetTab(
  reg: FrozenRegistry,
  stash: StashState,
  tab: number | undefined,
): number | OpResult {
  const bal = balanceOf(reg);
  const tabs = stashTabCount(bal);
  if (tab === undefined) {
    const t = firstTabWithRoom(reg, stash);
    return t >= 0 ? t : fail(ERR.stashFull, "the stash is full");
  }
  if (!Number.isSafeInteger(tab) || tab < 0 || tab >= tabs) {
    return fail(ERR.badTab, `tab must be 0..${tabs - 1}`);
  }
  if (tabCounts(stash, tabs)[tab]! >= bal.stashSize) {
    return fail(ERR.stashFull, `stash tab ${tab + 1} is full`);
  }
  return tab;
}

/** Adds an item to the stash without any reach checks (grants). False when every tab is full. */
export function stashAdd(world: World, reg: FrozenRegistry, item: ItemInstance): boolean {
  const stash = stashOf(world);
  const tab = firstTabWithRoom(reg, stash);
  if (tab < 0) return false;
  world.setResource(RES.stash, { ...stash, items: [...stash.items, withTab(item, tab)] });
  return true;
}

/** Stores a bag item in the town stash: in `tab`, or the first tab with room when absent. */
export function execStashPut(world: World, ctx: SimContext, uid: number, tab?: number): OpResult {
  const town = townOnly(world);
  if (town) return town;
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  const hero = h.hero;
  if (stashInReach(world, hero) === 0) return fail(ERR.tooFar, "stand next to the stash");
  const bag = world.get(hero, Inventory);
  if (!bag) return fail(ERR.noHero, "the hero has no inventory yet");
  const stash = stashOf(world);
  const t = targetTab(ctx.registry, stash, tab);
  if (typeof t !== "number") return t;
  const removed = removeItem(bag, uid);
  if (!removed) return fail(ERR.unknownId, `item ${uid} is not in the bag`);
  world.update(hero, Inventory, { items: removed.bag.items });
  world.setResource(RES.stash, { ...stash, items: [...stash.items, withTab(removed.item, t)] });
  return OK;
}

/** Takes an item out of the town stash into the bag (its `tab` field is cleared). */
export function execStashTake(world: World, ctx: SimContext, uid: number): OpResult {
  const town = townOnly(world);
  if (town) return town;
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  const hero = h.hero;
  if (stashInReach(world, hero) === 0) return fail(ERR.tooFar, "stand next to the stash");
  const bag: GridBag | undefined = world.get(hero, Inventory);
  if (!bag) return fail(ERR.noHero, "the hero has no inventory yet");
  const stash = stashOf(world);
  const at = stash.items.findIndex((it) => it.uid === uid);
  if (at < 0) return fail(ERR.unknownId, `item ${uid} is not in the stash`);
  const item = withTab(stash.items[at]!, 0);
  const next = placeItem(ctx.registry, bag, item);
  if (!next) return fail(ERR.bagFull, "there is no room in the bag");
  world.update(hero, Inventory, { items: next.items });
  world.setResource(RES.stash, { ...stash, items: stash.items.filter((_, i) => i !== at) });
  return OK;
}

/** Moves a stash item to another tab (ERR.badTab for a bad or the same tab, ERR.stashFull). */
export function execStashMove(world: World, ctx: SimContext, uid: number, tab: number): OpResult {
  const town = townOnly(world);
  if (town) return town;
  const h = liveHero(world);
  if (!("hero" in h)) return h;
  if (stashInReach(world, h.hero) === 0) return fail(ERR.tooFar, "stand next to the stash");
  const stash = stashOf(world);
  const at = stash.items.findIndex((it) => it.uid === uid);
  if (at < 0) return fail(ERR.unknownId, `item ${uid} is not in the stash`);
  const tabs = stashTabCount(balanceOf(ctx.registry));
  if (!Number.isSafeInteger(tab) || tab < 0 || tab >= tabs) {
    return fail(ERR.badTab, `tab must be 0..${tabs - 1}`);
  }
  if (tabOf(stash.items[at]!) === tab) return fail(ERR.badTab, "the item is already in that tab");
  const t = targetTab(ctx.registry, stash, tab);
  if (typeof t !== "number") return t;
  world.setResource(RES.stash, {
    ...stash,
    items: stash.items.map((it, i) => (i === at ? withTab(it, t) : it)),
  });
  emit(ctx, { type: "classic.stash.moved", uid, tab: t });
  return OK;
}
