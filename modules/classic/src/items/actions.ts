/**
 * Item actions (OWNER: T5): classic.equip, unequip, moveItem, dropItem,
 * drinkPotion, buy, sell, stashPut, stashTake; wave A: gamble, stashMove,
 * setLootFilter. parse() validates the payload
 * shape; apply() notes the manual command (auto pause) and runs the shared
 * execX operation for the CONTROLLED hero (heroOf; docs/design/party.md
 * §4.1), throwing ActionError when it fails (the kernel rolls back).
 */
import {
  ActionError,
  type ActionDef,
  type Entity,
  type SimContext,
  type World,
} from "@gamez/kernel";
import { ACTION, ERR, type ActionPayloads, type OpResult } from "../actions.ts";
import { noteManual } from "../control.ts";
import { heroOf } from "../resources.ts";
import { EQUIP_SLOTS, ITEM_CATEGORIES, type EquipSlot, type ItemCategory } from "../types.ts";
import { execDrink } from "./belt.ts";
import { execEquip, execUnequip } from "./equip.ts";
import { execDrop, execMoveItem } from "./ground.ts";
import { execBuy, execSell } from "./vendor.ts";
import { execStashMove, execStashPut, execStashTake } from "./stash.ts";
import { execGamble } from "./gamble.ts";
import { execSetLootFilter, parseLootFilterPatch, type LootFilterPatch } from "./lootFilter.ts";

const MAX_ID = 2_147_483_647;

function obj(payload: unknown, what: string): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ActionError(ERR.badPayload, `${what}: expected an object`);
  }
  return payload as Record<string, unknown>;
}

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new ActionError(ERR.badPayload, `${field} must be an integer ${min}..${max}`);
  }
  return v;
}

function slotOf(v: unknown): EquipSlot {
  if (typeof v !== "string" || !(EQUIP_SLOTS as readonly string[]).includes(v)) {
    throw new ActionError(ERR.badPayload, "slot must be a valid equipment slot");
  }
  return v as EquipSlot;
}

function requireHero(world: World): void {
  if (heroOf(world) === 0) throw new ActionError(ERR.noHero, "there is no hero yet");
}

function requireNpcLike(world: World, e: Entity, field: string): void {
  if (!world.exists(e)) throw new ActionError(ERR.badTarget, `${field} is not an entity`);
}

/** Applies a shared op as a manual command: a failure rejects the whole action. */
function commit(world: World, ctx: SimContext, r: OpResult): void {
  noteManual(world, ctx);
  if (!r.ok) throw new ActionError(r.code, r.message);
}

export const equipAction: ActionDef<ActionPayloads["classic.equip"]> = {
  name: ACTION.equip,
  parse(world, payload) {
    const p = obj(payload, "equip");
    requireHero(world);
    const uid = int(p.uid, "uid", 1, MAX_ID);
    const slot = p.slot === null || p.slot === undefined ? null : slotOf(p.slot);
    return { uid, slot };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execEquip(world, ctx, heroOf(world), p.uid, p.slot));
  },
};

export const unequipAction: ActionDef<ActionPayloads["classic.unequip"]> = {
  name: ACTION.unequip,
  parse(world, payload) {
    const p = obj(payload, "unequip");
    requireHero(world);
    return { slot: slotOf(p.slot) };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execUnequip(world, ctx, heroOf(world), p.slot));
  },
};

export const moveItemAction: ActionDef<ActionPayloads["classic.moveItem"]> = {
  name: ACTION.moveItem,
  parse(world, payload) {
    const p = obj(payload, "moveItem");
    requireHero(world);
    return {
      uid: int(p.uid, "uid", 1, MAX_ID),
      x: int(p.x, "x", 0, 255),
      y: int(p.y, "y", 0, 255),
    };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execMoveItem(world, ctx, heroOf(world), p.uid, p.x, p.y));
  },
};

export const dropItemAction: ActionDef<ActionPayloads["classic.dropItem"]> = {
  name: ACTION.dropItem,
  parse(world, payload) {
    const p = obj(payload, "dropItem");
    requireHero(world);
    return { uid: int(p.uid, "uid", 1, MAX_ID) };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execDrop(world, ctx, heroOf(world), p.uid));
  },
};

export const drinkPotionAction: ActionDef<ActionPayloads["classic.drinkPotion"]> = {
  name: ACTION.drinkPotion,
  parse(world, payload) {
    const p = obj(payload, "drinkPotion");
    requireHero(world);
    return { slot: int(p.slot, "slot", 0, 63) };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execDrink(world, ctx, heroOf(world), p.slot));
  },
};

export const buyAction: ActionDef<ActionPayloads["classic.buy"]> = {
  name: ACTION.buy,
  parse(world, payload) {
    const p = obj(payload, "buy");
    requireHero(world);
    const npc = int(p.npc, "npc", 1, MAX_ID);
    requireNpcLike(world, npc, "npc");
    let potion: string | null = null;
    if (p.potion !== null && p.potion !== undefined) {
      if (typeof p.potion !== "string" || p.potion.length === 0 || p.potion.length > 64) {
        throw new ActionError(ERR.badPayload, "potion must be a base id or null");
      }
      potion = p.potion;
    }
    return {
      npc,
      index: int(p.index ?? 0, "index", 0, 9999),
      potion,
      count: int(p.count ?? 1, "count", 1, 20),
    };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execBuy(world, ctx, heroOf(world), p));
  },
};

export const sellAction: ActionDef<ActionPayloads["classic.sell"]> = {
  name: ACTION.sell,
  parse(world, payload) {
    const p = obj(payload, "sell");
    requireHero(world);
    const npc = int(p.npc, "npc", 1, MAX_ID);
    requireNpcLike(world, npc, "npc");
    return { npc, uid: int(p.uid, "uid", 1, MAX_ID) };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execSell(world, ctx, heroOf(world), p.npc, p.uid));
  },
};

export const stashPutAction: ActionDef<ActionPayloads["classic.stashPut"]> = {
  name: ACTION.stashPut,
  parse(world, payload) {
    const p = obj(payload, "stashPut");
    requireHero(world);
    const uid = int(p.uid, "uid", 1, MAX_ID);
    if (p.tab === undefined || p.tab === null) return { uid };
    return { uid, tab: int(p.tab, "tab", 0, 63) };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execStashPut(world, ctx, heroOf(world), p.uid, p.tab));
  },
};

export const stashTakeAction: ActionDef<ActionPayloads["classic.stashTake"]> = {
  name: ACTION.stashTake,
  parse(world, payload) {
    const p = obj(payload, "stashTake");
    requireHero(world);
    return { uid: int(p.uid, "uid", 1, MAX_ID) };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execStashTake(world, ctx, heroOf(world), p.uid));
  },
};

// ---- wave A

function categoryOf(v: unknown): ItemCategory {
  if (typeof v !== "string" || !(ITEM_CATEGORIES as readonly string[]).includes(v)) {
    throw new ActionError(ERR.badPayload, "category must be an item category");
  }
  return v as ItemCategory;
}

export const gambleAction: ActionDef<ActionPayloads["classic.gamble"]> = {
  name: ACTION.gamble,
  parse(world, payload) {
    const p = obj(payload, "gamble");
    requireHero(world);
    const npc = int(p.npc, "npc", 1, MAX_ID);
    requireNpcLike(world, npc, "npc");
    return { npc, category: categoryOf(p.category) };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execGamble(world, ctx, heroOf(world), p.npc, p.category));
  },
};

export const stashMoveAction: ActionDef<ActionPayloads["classic.stashMove"]> = {
  name: ACTION.stashMove,
  parse(world, payload) {
    const p = obj(payload, "stashMove");
    requireHero(world);
    return { uid: int(p.uid, "uid", 1, MAX_ID), tab: int(p.tab, "tab", 0, 63) };
  },
  apply(world, p, ctx) {
    commit(world, ctx, execStashMove(world, ctx, heroOf(world), p.uid, p.tab));
  },
};

/** Settings, not play: no hero needed and no manual override of auto/idle. */
export const setLootFilterAction: ActionDef<{ filter: LootFilterPatch }> = {
  name: ACTION.setLootFilter,
  parse(_world, payload) {
    const p = obj(payload, "setLootFilter");
    for (const key of Object.keys(p)) {
      if (key !== "filter") throw new ActionError(ERR.badPayload, `unknown key "${key}"`);
    }
    return { filter: parseLootFilterPatch(p.filter) };
  },
  apply(world, p, ctx) {
    execSetLootFilter(world, ctx, p.filter);
  },
};

export const itemActions: ActionDef<any>[] = [
  equipAction,
  unequipAction,
  moveItemAction,
  dropItemAction,
  drinkPotionAction,
  buyAction,
  sellAction,
  stashPutAction,
  stashTakeAction,
  gambleAction,
  stashMoveAction,
  setLootFilterAction,
];
