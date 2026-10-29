/**
 * Party operations (docs/design/party.md §4.1, §4.2): the shared execX
 * functions behind the classic.party actions and the `give` HeroCommand.
 * Every function returns an OpResult. The actions turn a failure into an
 * ActionError (the kernel rolls the world back), the command system emits
 * classic.command.failed. Each one calls ensureParty() first (the lazy
 * migration) and changes nothing when it fails.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { ERR, fail, OK, type OpResult } from "../actions.ts";
import { Equipment, Hero, Inventory, Summoned, Wallet } from "../components.ts";
import { emit } from "../events.ts";
import {
  currentDepth,
  gameOf,
  RES,
  stashOf,
  type ControlState,
  type PartyConfig,
} from "../resources.ts";
import { tabCounts, withTab } from "../items/stash.ts";
import { placeItem, removeItem } from "../items/inventory.ts";
import { nextSlotPrice, stashTabCount } from "../rules.ts";
import { partyProtoOf } from "../rules.ts";
import { BALANCE_ID, EQUIP_SLOTS, KIND, type BalanceProto, type ItemInstance } from "../types.ts";
import { cancelRevivesOf } from "./revive.ts";
import { ensureParty, isPartyHero, partyMembers, purseOf, slotsOf } from "./shared.ts";

/** The purse's gold, or the failure to spend `cost` from it (the purse is returned on success). */
function payFrom(world: World, cost: number): OpResult {
  const purse = purseOf(world);
  const gold = world.get(purse, Wallet)?.gold ?? 0;
  if (cost > gold) return fail(ERR.noGold, `this costs ${cost} gold`);
  if (cost > 0) world.update(purse, Wallet, { gold: gold - cost });
  return OK;
}

/** Dismiss: the member's gear goes to the stash; the member leaves the party. */
export function execDismiss(world: World, ctx: SimContext, hero: Entity): OpResult {
  const party = ensureParty(world, ctx);
  if (!party) return fail(ERR.noHero, "there is no hero yet");
  if (!isPartyHero(world, hero)) return fail(ERR.notMember, "not a party member");
  if (hero === party.founder) return fail(ERR.founder, "the founder cannot be dismissed");
  if (currentDepth(world) !== 0) return fail(ERR.notInTown, "dismiss members in town");

  // Gear: equipped pieces (slot order), then the bag (grid order). Belt potions are lost.
  const gear: ItemInstance[] = [];
  const eq = world.get(hero, Equipment);
  if (eq) for (const s of EQUIP_SLOTS) if (eq[s]) gear.push(eq[s]!);
  const bag = world.get(hero, Inventory);
  if (bag) {
    const sorted = bag.items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    for (const en of sorted) gear.push(en.item);
  }

  const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
  const stash = stashOf(world);
  const counts = tabCounts(stash, stashTabCount(bal));
  const placed: ItemInstance[] = [];
  for (const it of gear) {
    const tab = counts.findIndex((n) => n < bal.stashSize);
    if (tab < 0) return fail(ERR.stashFull, "the shared stash has no room for this gear");
    counts[tab]!++;
    placed.push(withTab(it, tab));
  }
  world.setResource(RES.stash, { ...stash, items: [...stash.items, ...placed] });

  const name = world.get(hero, Hero)?.name ?? "";
  for (const e of world.query(Summoned)) {
    if (world.read(e, Summoned).owner === hero) world.destroy(e);
  }
  cancelRevivesOf(world, ctx, hero);

  const remaining = party.members.filter((e) => e !== hero && world.exists(e));
  world.setResource(RES.party, { ...party, members: remaining });

  const game = gameOf(world);
  if (game.hero === hero) {
    const next = remaining[0] ?? 0;
    game.hero = next;
    world.setResource(RES.game, game);
    const c = world.getResource<ControlState>(RES.control);
    if (c) {
      c.overrideUntil = 0;
      world.setResource(RES.control, c);
    }
    emit(ctx, { type: "classic.party.control", hero: next, previous: hero, reason: "dismiss" });
  }
  world.destroy(hero);
  emit(ctx, { type: "classic.party.dismissed", hero, name, stashed: placed.length });
  return OK;
}

/** Rename a member (the name is already clean). */
export function execRename(world: World, ctx: SimContext, hero: Entity, name: string): OpResult {
  if (!ensureParty(world, ctx)) return fail(ERR.noHero, "there is no hero yet");
  if (!isPartyHero(world, hero)) return fail(ERR.notMember, "not a party member");
  world.update(hero, Hero, { name });
  emit(ctx, { type: "classic.party.renamed", hero, name });
  return OK;
}

/** Slot order: `order` must be an exact permutation of the members. */
export function execReorder(world: World, ctx: SimContext, order: readonly Entity[]): OpResult {
  const party = ensureParty(world, ctx);
  if (!party) return fail(ERR.noHero, "there is no hero yet");
  const cur = partyMembers(world);
  const exact =
    order.length === cur.length &&
    new Set(order).size === order.length &&
    order.every((e) => cur.includes(e));
  if (!exact) return fail(ERR.badOrder, "order must list every member exactly once");
  const members = [...order];
  world.setResource(RES.party, { ...party, members });
  emit(ctx, { type: "classic.party.reordered", members });
  return OK;
}

/** Merges a validated partial party config. */
export function execConfig(world: World, ctx: SimContext, patch: Partial<PartyConfig>): OpResult {
  const party = ensureParty(world, ctx);
  if (!party) return fail(ERR.noHero, "there is no hero yet");
  world.setResource(RES.party, { ...party, config: { ...party.config, ...patch } });
  emit(ctx, { type: "classic.party.config" });
  return OK;
}

/** Buys the next locked slot with gold (town). */
export function execBuySlot(world: World, ctx: SimContext): OpResult {
  const party = ensureParty(world, ctx);
  if (!party) return fail(ERR.noHero, "there is no hero yet");
  if (currentDepth(world) !== 0) return fail(ERR.notInTown, "buy slots in town");
  const slots = slotsOf(world, ctx.registry);
  const price = nextSlotPrice(partyProtoOf(ctx.registry), slots);
  if (price === null) return fail(ERR.partyFull, "every slot is already unlocked");
  const paid = payFrom(world, price);
  if (!paid.ok) return paid;
  world.setResource(RES.party, { ...party, slotsBought: slots });
  emit(ctx, { type: "classic.party.slots", slots: slots + 1, via: "gold", cost: price });
  return OK;
}

/**
 * Moves bag item `uid` of member `from` into member `to`'s bag (any distance).
 * Used by the action (from = the controlled hero) and the `give` command
 * (from = the commanding hero).
 */
export function execGive(
  world: World,
  ctx: SimContext,
  from: Entity,
  uid: number,
  to: Entity,
): OpResult {
  if (!ensureParty(world, ctx)) return fail(ERR.noHero, "there is no hero yet");
  if (!isPartyHero(world, from)) return fail(ERR.notMember, "not a party member");
  if (!isPartyHero(world, to) || to === from) {
    return fail(ERR.notMember, "items go to another party member");
  }
  const bag = world.get(from, Inventory);
  if (!bag) return fail(ERR.noHero, "the hero has no inventory yet");
  const removed = removeItem(bag, uid);
  if (!removed) return fail(ERR.unknownId, `item ${uid} is not in the bag`);
  const toBag = world.get(to, Inventory);
  const placed = toBag ? placeItem(ctx.registry, toBag, removed.item) : null;
  if (!toBag || !placed) return fail(ERR.bagFull, "that member's bag is full");
  world.update(from, Inventory, { items: removed.bag.items });
  world.update(to, Inventory, { items: placed.items });
  emit(ctx, {
    type: "classic.party.itemGiven",
    uid,
    from,
    to,
    name: removed.item.name,
  });
  return OK;
}
