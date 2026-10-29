/**
 * The gambler (OWNER: T-items, wave-A.md §5.5): classic.gamble {npc,
 * category} buys a random item of that category into the bag. Town only, an
 * NPC with role "gambler" whose gamble.categories include the category, in
 * INTERACT_RANGE. Price rules.gamblePrice (EconomyProto.gamble); rarity by
 * EconomyProto.gamble.weights; a base of the category with ilvl <= hero
 * level + 2; item level = hero level. Fails before paying when the bag
 * cannot take every possible base footprint (ERR.bagFull).
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { ERR, fail, OK, type OpResult } from "../actions.ts";
import { Inventory, Level } from "../components.ts";
import { emit } from "../events.ts";
import { gamblePrice } from "../rules.ts";
import type { ItemCategory, ItemInstance } from "../types.ts";
import {
  addRunStat,
  economyOf,
  heroTag,
  liveHero,
  noteFound,
  purseWallet,
  setPurseGold,
} from "./common.ts";
import { baseCandidates, rollItem } from "./generate.ts";
import { findSpace, placeItem } from "./inventory.ts";
import { npcInReach, townOnly } from "./vendor.ts";

/** Base ilvl allowance above the hero level for gambled items. */
export const GAMBLE_BASE_ILVL_BONUS = 2;

/** `hero` gambles an item of `category` into its bag (its level), paid from the party purse. */
export function execGamble(
  world: World,
  ctx: SimContext,
  hero: Entity,
  npcEntity: Entity,
  category: ItemCategory,
): OpResult {
  const town = townOnly(world);
  if (town) return town;
  const h = liveHero(world, hero);
  if (!("hero" in h)) return h;
  const npc = npcInReach(world, ctx, hero, npcEntity);
  if (!("proto" in npc)) return npc;
  if (npc.proto.role !== "gambler" || !npc.proto.gamble) {
    return fail(ERR.notGambler, "this npc does not gamble");
  }
  if (!npc.proto.gamble.categories.includes(category)) {
    return fail(ERR.notGambler, `this npc does not offer ${category}`);
  }
  const reg = ctx.registry;
  const econ = economyOf(reg);
  if (!econ) return fail(ERR.notGambler, "gambling is not available");
  const level = world.get(hero, Level)?.level ?? 1;
  const price = gamblePrice(econ, category, level);
  if (price === null) return fail(ERR.notGambler, `this npc does not offer ${category}`);
  const wallet = purseWallet(world);
  const bag = world.get(hero, Inventory);
  if (!wallet || !bag) return fail(ERR.noHero, "the hero has no inventory yet");
  if (wallet.gold < price) return fail(ERR.noGold, `need ${price} gold`);

  // Room for every footprint the roll could produce, before any rng is drawn.
  const maxBaseIlvl = level + GAMBLE_BASE_ILVL_BONUS;
  const cands = baseCandidates(reg, maxBaseIlvl, category);
  if (cands.length === 0) return fail(ERR.notGambler, `nothing to gamble in ${category}`);
  const sizes = new Set<string>();
  for (const [id, b] of cands) {
    const key = `${b.size.w}x${b.size.h}`;
    if (sizes.has(key)) continue;
    sizes.add(key);
    const probe: ItemInstance = {
      uid: -1,
      base: id,
      rarity: "normal",
      ilvl: 1,
      name: "",
      mods: [],
      affixes: [],
      value: 0,
    };
    if (!findSpace(reg, bag, probe)) return fail(ERR.bagFull, "there is no room in the bag");
  }

  const item = rollItem(world, ctx, {
    ilvl: level,
    rarity: null,
    magicFind: 0,
    category,
    rarityWeights: econ.gamble.weights,
    maxBaseIlvl,
  });
  if (!item) return fail(ERR.notGambler, `nothing to gamble in ${category}`);
  const next = placeItem(reg, bag, item);
  if (!next) return fail(ERR.bagFull, "there is no room in the bag");
  setPurseGold(world, wallet.purse, wallet.gold - price);
  world.update(hero, Inventory, { items: next.items });
  addRunStat(world, "goldSpent", price);
  addRunStat(world, "gambles", 1);
  noteFound(world, item);
  emit(ctx, {
    type: "classic.gambled",
    npc: npc.id,
    category,
    name: item.name,
    rarity: item.rarity,
    price,
    ...heroTag(world, hero),
  });
  return OK;
}
