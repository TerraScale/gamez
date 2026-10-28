/**
 * Module "classic.platform" (wave C, docs/design/wave-C.md §2): the bank
 * between the classic hero and the account (AccountDO wallet + vault).
 * OWNER: T-bridge. CONTRACT (architect): the module id, version, deps,
 * registry data, action name and event shape are fixed — they are part of
 * classic's contentHash, which every pinned hash test depends on. Implement
 * the action bodies only: NO setup(), NO systems, NO new registry entries, NO
 * version bump (ask the architect if you need one).
 *
 * Action "classic.bank" (server-only; listed in the policy's
 * serverOnlyActions, dispatched by the VerifiedHost with actor "server" and
 * replayed by the client with the same payload, protocol verified.ts "bank"):
 *
 *   payload ClassicBankPayload = { opId, op: BankOp, item? }
 *   - every op: hero exists, alive, in town (depth 0) else ActionError
 *     ERR.notInTown / ERR.noHero / ERR.dead; opId isOpId().
 *   - depositGold {gold}: 1 <= gold <= Wallet.gold; fee = bankFee(gold);
 *     Wallet.gold -= gold; credit coin = gold - fee (>= 0; nothing if 0 -> ERR.empty).
 *   - withdrawCoin {coin}: 1 <= coin <= BANK.maxWithdraw; Wallet.gold += coin.
 *     (The host debited the account first.)
 *   - depositItem {ref}: the ItemInstance with uid `ref` in the bag or the
 *     stash (not equipped, not the belt); removed; item = itemToVault(item).
 *   - withdrawItem {uid}: payload.item is the VaultItem the host took from the
 *     account (origin "classic" or universal); vaultToItem() recreates the
 *     ItemInstance with a fresh GameState.nextUid in the first free bag spot
 *     (ERR.bagFull when none — the host refunds the vault).
 *   On success emit exactly one ClassicBankEvent. Deterministic: no rng needed.
 */
import {
  ActionError,
  defineModule,
  type ActionDef,
  type Entity,
  type FrozenRegistry,
  type GameEvent,
  type World,
} from "@gamez/kernel";
import {
  isOpId,
  VAULT_ITEM_DATA_MAX,
  type BankOp,
  type VaultItem,
  type VaultItemInput,
} from "@gamez/protocol";
import { ERR, type OpResult } from "../actions.ts";
import { Inventory, Wallet } from "../components.ts";
import { MODULE } from "../ids.ts";
import { liveHero } from "../items/common.ts";
import { placeItem, removeItem } from "../items/inventory.ts";
import { withTab } from "../items/stash.ts";
import { townOnly } from "../items/vendor.ts";
import { nextUid, RES, type StashState } from "../resources.ts";
import type { ItemInstance } from "../types.ts";
import { itemToVault, vaultToItem } from "./vault-codec.ts";

/** Registry kind of the bank rules (one entry, BANK_ID). */
export const KIND_BANK = "classic.bank";
export const BANK_ID = "classic.bank.main";
export const BANK_ACTION = "classic.bank";
/** Event type of ClassicBankEvent. */
export const BANK_EVENT = "classic.bank.effect";

export interface BankProto {
  /** Fee on gold deposits, percent (sink). */
  feePct: number;
  /** Minimum fee per deposit, gold. */
  feeMin: number;
  /** Largest single deposit/withdraw, gold/coin. */
  maxAmount: number;
}

export const BANK_DEFAULTS: BankProto = { feePct: 5, feeMin: 1, maxAmount: 10_000_000 };

/** Deposit fee for `gold` (integer): max(feeMin, floor(gold * feePct / 100)), capped at gold. */
export function bankFee(gold: number, proto: BankProto = BANK_DEFAULTS): number {
  return Math.min(gold, Math.max(proto.feeMin, Math.floor((gold * proto.feePct) / 100)));
}

export interface ClassicBankPayload {
  opId: string;
  op: BankOp;
  /** withdrawItem only: the vault item the host took from the account. */
  item?: VaultItem;
}

/** The one event a successful classic.bank dispatch emits (PlatformHooks.bankEvent). */
export interface ClassicBankEvent {
  type: typeof BANK_EVENT;
  opId: string;
  /** depositGold: coin to credit to the account wallet. */
  credit: { coin: number } | null;
  /** depositItem: the vault item to put into the account vault. */
  item: VaultItemInput | null;
  /** Gold removed (deposit, positive) or added (withdraw, negative) — for BankResult.gold. */
  gold: number;
}

const BANK_OP_KINDS: ReadonlySet<string> = new Set([
  "depositGold",
  "withdrawCoin",
  "depositItem",
  "withdrawItem",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPositive(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 1;
}

function bad(message: string): never {
  throw new ActionError(ERR.badPayload, message);
}

/** Strict shape check of a BankOp (amount ranges are checked against BankProto in apply). */
function parseOp(v: unknown): BankOp {
  if (!isRecord(v) || typeof v.kind !== "string" || !BANK_OP_KINDS.has(v.kind)) {
    bad("op must be a bank operation");
  }
  switch (v.kind) {
    case "depositGold":
      if (!isPositive(v.gold)) bad("gold must be a positive integer");
      return { kind: "depositGold", gold: v.gold };
    case "withdrawCoin":
      if (!isPositive(v.coin)) bad("coin must be a positive integer");
      return { kind: "withdrawCoin", coin: v.coin };
    case "depositItem":
      if (!isPositive(v.ref)) bad("ref must be an item uid");
      return { kind: "depositItem", ref: v.ref };
    default:
      if (typeof v.uid !== "string" || v.uid.length === 0 || v.uid.length > 64) {
        bad("uid must be a vault item uid");
      }
      return { kind: "withdrawItem", uid: v.uid };
  }
}

function parseBankPayload(payload: unknown): ClassicBankPayload {
  if (!isRecord(payload)) bad("expected { opId, op }");
  if (!isOpId(payload.opId)) bad("opId must be 8..64 chars of [A-Za-z0-9_-]");
  const op = parseOp(payload.op);
  if (op.kind === "withdrawItem") {
    const item = payload.item;
    if (!isRecord(item) || item.uid !== op.uid) bad("withdrawItem needs the vault item taken");
    return { opId: payload.opId, op, item: item as unknown as VaultItem };
  }
  if (payload.item !== undefined) bad("item is only for withdrawItem");
  return { opId: payload.opId, op };
}

function protoOf(reg: FrozenRegistry): BankProto {
  return reg.get<BankProto>(KIND_BANK, BANK_ID) ?? BANK_DEFAULTS;
}

function check(r: OpResult | null): void {
  if (r && !r.ok) throw new ActionError(r.code, r.message);
}

/** The ClassicBankEvent of a successful op. */
function effect(
  opId: string,
  credit: number | null,
  item: VaultItemInput | null,
  gold: number,
): GameEvent {
  const ev: ClassicBankEvent = {
    type: BANK_EVENT,
    opId,
    credit: credit === null ? null : { coin: credit },
    item,
    gold,
  };
  return { ...ev };
}

/** Removes the item `uid` from the bag or the stash (never equipment or belt); null when absent. */
function takeHeroItem(world: World, hero: Entity, uid: number): ItemInstance | null {
  const bag = world.get(hero, Inventory);
  const fromBag = bag ? removeItem(bag, uid) : null;
  if (fromBag) {
    world.update(hero, Inventory, { items: fromBag.bag.items });
    return fromBag.item;
  }
  const stash = world.getResource<StashState>(RES.stash);
  const at = stash ? stash.items.findIndex((it) => it.uid === uid) : -1;
  if (!stash || at < 0) return null;
  const item = withTab(stash.items[at]!, 0);
  world.setResource(RES.stash, { ...stash, items: stash.items.filter((_, i) => i !== at) });
  return item;
}

const bankAction: ActionDef<ClassicBankPayload> = {
  name: BANK_ACTION,
  parse(_world, payload): ClassicBankPayload {
    return parseBankPayload(payload);
  },
  apply(world, p, ctx): void {
    const h = liveHero(world);
    if (!("hero" in h)) {
      check(h);
      return;
    }
    check(townOnly(world));
    const hero = h.hero;
    const proto = protoOf(ctx.registry);
    const op = p.op;
    switch (op.kind) {
      case "depositGold": {
        if (op.gold > proto.maxAmount) bad(`at most ${proto.maxAmount} gold per deposit`);
        const wallet = world.get(hero, Wallet);
        if (!wallet) throw new ActionError(ERR.noHero, "the hero has no wallet yet");
        if (op.gold > wallet.gold) throw new ActionError(ERR.noGold, "not enough gold");
        const credit = op.gold - bankFee(op.gold, proto);
        if (credit <= 0) throw new ActionError(ERR.empty, "the deposit does not cover the fee");
        world.update(hero, Wallet, { gold: wallet.gold - op.gold });
        ctx.emit(effect(p.opId, credit, null, op.gold));
        return;
      }
      case "withdrawCoin": {
        if (op.coin > proto.maxAmount) bad(`at most ${proto.maxAmount} coin per withdrawal`);
        const wallet = world.get(hero, Wallet);
        if (!wallet) throw new ActionError(ERR.noHero, "the hero has no wallet yet");
        if (wallet.gold + op.coin > Number.MAX_SAFE_INTEGER) bad("too much gold");
        world.update(hero, Wallet, { gold: wallet.gold + op.coin });
        ctx.emit(effect(p.opId, null, null, -op.coin));
        return;
      }
      case "depositItem": {
        const item = takeHeroItem(world, hero, op.ref);
        if (!item) {
          throw new ActionError(ERR.unknownId, `item ${op.ref} is not in the bag or the stash`);
        }
        const vault = itemToVault(item, ctx.registry);
        if (vault.data !== null && vault.data.length > VAULT_ITEM_DATA_MAX) {
          bad("the item is too large for the vault");
        }
        ctx.emit(effect(p.opId, null, vault, 0));
        return;
      }
      case "withdrawItem": {
        const bag = world.get(hero, Inventory);
        if (!bag) throw new ActionError(ERR.noHero, "the hero has no inventory yet");
        if (!p.item) bad("withdrawItem needs the vault item taken");
        const item = vaultToItem(p.item, ctx.registry, nextUid(world));
        if (!item) bad("this vault item cannot be restored in classic");
        const next = placeItem(ctx.registry, bag, item);
        if (!next) throw new ActionError(ERR.bagFull, "there is no room in the bag");
        world.update(hero, Inventory, { items: next.items });
        ctx.emit(effect(p.opId, null, null, 0));
        return;
      }
    }
  },
};

export const classicPlatform = defineModule({
  id: MODULE.platform,
  version: "1.0.0",
  deps: [MODULE.items, MODULE.progression],
  data(reg) {
    reg.define<BankProto>(KIND_BANK, BANK_ID, { ...BANK_DEFAULTS });
  },
  actions: [bankAction],
});
