/**
 * Account side of the wave C bank saga (docs/design/wave-C.md §2.4): the
 * idempotent AccountDO calls a verified instance makes for a bank op, kept
 * apart from VerifiedHost (which owns the sim, the queue and the commits).
 *
 * txIds: "bank:<instance>:<opId>:take" | ":refund" | ":credit" (<= 128 chars:
 * instance names are "<mode>:<accountId>", opIds <= 64 chars).
 *
 * ADR 0007 R2: the AccountDO binds every txId to its parameters and answers
 * "conflict" when a txId comes back with other ones (an opId reused after the
 * bank_op row was lost). A conflicting take fails the op with "conflict" and
 * takes nothing, so it is never refunded (TakeOutcome ok:false carries no
 * effect). A conflicting refund or credit is terminal: it is logged at error
 * level and the op finishes (no endless re-drive), never retried as new value.
 */
import type { GameEvent } from "@gamez/kernel";
import type { BankResult, EconomyErrorCode, VaultItem, VaultItemInput } from "@gamez/protocol";
import type { AccountGateway } from "../contracts.ts";
import type { BucketSpec } from "../rate-limit.ts";
import type { BankEffect, BankOpRow } from "./bank-store.ts";

/** Per-socket bank op limit (wave-C.md §2.4 rule 1). */
export const BANK_LIMIT: BucketSpec = { burst: 5, perSecond: 1 };
/** Finished bank rows are kept this long (idempotent retries), then pruned. */
export const BANK_KEEP_MS = 7 * 24 * 3600 * 1000;
/** platform_kv key of the last successful season report ({key,total} JSON). */
export const SEASON_KV = "season.reported";
/** Wallet reasons (telemetry groups "bank.withdraw" / "bank.deposit"). */
export const REASON_WITHDRAW = "bank.withdraw";
export const REASON_DEPOSIT = "bank.deposit";

/** The account operations the bank needs (economy/gateway.ts over env.ACCOUNT). */
export type BankAccount = Pick<
  AccountGateway,
  "wallet" | "walletTx" | "vaultGet" | "vaultTake" | "vaultPut"
>;

export function bankTxId(instance: string, opId: string, step: "take" | "refund" | "credit") {
  return `bank:${instance}:${opId}:${step}`;
}

export function failure(code: EconomyErrorCode, message: string): BankResult {
  return { ok: false, code, message };
}

/** ActionError codes of the mode's bank action -> wire codes. */
const ACTION_CODES: Record<string, EconomyErrorCode> = {
  not_in_town: "not_in_town",
  no_hero: "not_eligible",
  dead: "not_eligible",
  bag_full: "no_room",
  no_gold: "insufficient_funds",
  unknown_id: "not_found",
  bad_payload: "bad_request",
  empty: "too_low",
};

export function actionCode(code: string | undefined): EconomyErrorCode {
  return (code !== undefined ? ACTION_CODES[code] : undefined) ?? "bad_request";
}

/** The mode's bank event (PlatformHooks.bankEvent shape), or null when the action emitted none. */
export function bankEventOf(
  events: readonly GameEvent[],
  type: string,
): { credit: { coin: number } | null; item: VaultItemInput | null; gold: number } | null {
  const ev = events.find((e) => e.type === type);
  if (!ev) return null;
  const credit = ev.credit as { coin?: unknown } | null | undefined;
  const coin = credit && Number.isSafeInteger(credit.coin) ? (credit.coin as number) : null;
  return {
    credit: coin !== null ? { coin } : null,
    item: (ev.item as VaultItemInput | null | undefined) ?? null,
    gold: Number.isSafeInteger(ev.gold) ? (ev.gold as number) : 0,
  };
}

export type TakeOutcome = { ok: true; effect: BankEffect } | { ok: false; result: BankResult };

/** Error log of the saga's terminal anomalies (a conflicting refund or credit). */
export type BankSagaLog = (message: string, data?: unknown) => void;
const DEFAULT_LOG: BankSagaLog = (message, data) => console.error(message, data);

const CONFLICT_MESSAGE = "this operation id was already used for something else";

/**
 * Withdrawals take from the account first. `redrive`: a re-drive after a
 * crash: skip the checks and just replay the take (same txId), which tells
 * whether it happened (replay) or does it now (then the caller refunds).
 * Throws when the account cannot be reached.
 */
export async function takeFromAccount(
  account: BankAccount,
  instance: string,
  mode: string,
  row: BankOpRow,
  redrive = false,
): Promise<TakeOutcome> {
  const txId = bankTxId(instance, row.opId, "take");
  const op = row.op;
  if (op.kind === "withdrawCoin") {
    const r = await account.walletTx(row.accountId, {
      txId,
      currency: "coin",
      amount: -op.coin,
      reason: `${REASON_WITHDRAW}:${mode}`,
      flow: "sink",
    });
    if (!r.ok) {
      return {
        ok: false,
        result:
          r.code === "insufficient_funds"
            ? failure("insufficient_funds", "not enough coin on the account")
            : r.code === "conflict"
              ? failure("conflict", CONFLICT_MESSAGE)
              : failure("bad_request", "the withdrawal was refused"),
      };
    }
    return { ok: true, effect: { coin: op.coin, gold: op.coin, item: null, balance: r.balance } };
  }
  if (op.kind !== "withdrawItem")
    throw new Error(`takeFromAccount: ${op.kind} is not a withdrawal`);
  if (!redrive) {
    const v = await account.vaultGet(row.accountId, op.uid);
    if (!v) return { ok: false, result: failure("not_found", "that item is not in the vault") };
    if (!(v.universal || v.origin === mode)) {
      return {
        ok: false,
        result: failure("wrong_origin", `that item belongs to ${v.origin || "another mode"}`),
      };
    }
  }
  const r = await account.vaultTake(row.accountId, txId, op.uid);
  if (!r.ok) {
    return {
      ok: false,
      result:
        r.code === "conflict"
          ? failure("conflict", CONFLICT_MESSAGE)
          : failure("not_found", "that item is not in the vault"),
    };
  }
  return { ok: true, effect: { coin: 0, gold: 0, item: r.item, balance: null } };
}

function vaultInput(item: VaultItem | VaultItemInput): VaultItemInput {
  const { uid: _uid, ...rest } = item as VaultItem;
  return rest;
}

/**
 * Gives back what a withdrawal took. Idempotent (txId ":refund"); throws when
 * unreachable or refused for now (the caller re-drives). Only an op whose take
 * succeeded has an effect: a failed take (conflict included) refunds nothing.
 * A "conflict" (the refund txId already holds another change) is terminal:
 * logged at error level, then the caller finishes the op without a refund.
 */
export async function refundToAccount(
  account: BankAccount,
  instance: string,
  mode: string,
  row: BankOpRow,
  log: BankSagaLog = DEFAULT_LOG,
): Promise<void> {
  const e = row.effect;
  if (!e) return;
  const txId = bankTxId(instance, row.opId, "refund");
  const conflict = (what: unknown): void =>
    log(`bank ${instance}: refund ${txId} conflicts with an earlier tx, NOT refunded`, {
      accountId: row.accountId,
      op: row.op,
      refund: what,
    });
  if (e.coin > 0 && row.op.kind === "withdrawCoin") {
    // Same flow and reason as the take, opposite sign: the sink nets out.
    const r = await account.walletTx(row.accountId, {
      txId,
      currency: "coin",
      amount: e.coin,
      reason: `${REASON_WITHDRAW}:${mode}`,
      flow: "sink",
    });
    if (!r.ok && r.code === "conflict") return conflict({ coin: e.coin });
    if (!r.ok) throw new Error(`refund refused: ${r.code}`);
    return;
  }
  if (e.item && row.op.kind === "withdrawItem") {
    const r = await account.vaultPut(row.accountId, txId, vaultInput(e.item));
    if (!r.ok && r.code === "conflict") return conflict({ item: e.item });
    if (!r.ok) throw new Error(`refund refused: ${r.code}`);
  }
}

/**
 * Credits a committed deposit to the account (txId ":credit"). The final
 * result, or null when the account refused for now (vault full: kept and
 * retried). Throws when unreachable. A "conflict" (the credit txId already
 * holds another change) is a final failure, logged at error level: retrying
 * could never succeed, and the deposit must not be credited under a new txId.
 */
export async function creditAccount(
  account: BankAccount,
  instance: string,
  mode: string,
  row: BankOpRow,
  log: BankSagaLog = DEFAULT_LOG,
): Promise<BankResult | null> {
  const e = row.effect;
  if (!e) return failure("internal", "the deposit lost its effect");
  const txId = bankTxId(instance, row.opId, "credit");
  const conflict = (what: unknown): BankResult => {
    log(`bank ${instance}: credit ${txId} conflicts with an earlier tx, NOT credited`, {
      accountId: row.accountId,
      op: row.op,
      credit: what,
    });
    return failure("conflict", CONFLICT_MESSAGE);
  };
  if (e.item) {
    const r = await account.vaultPut(row.accountId, txId, vaultInput(e.item));
    if (!r.ok && r.code === "conflict") return conflict({ item: e.item });
    if (!r.ok) return null;
    const balance = await balanceOf(account, row.accountId);
    return { ok: true, item: r.item, balance };
  }
  const r = await account.walletTx(row.accountId, {
    txId,
    currency: "coin",
    amount: e.coin,
    reason: `${REASON_DEPOSIT}:${mode}`,
    flow: "faucet",
  });
  if (!r.ok && r.code === "conflict") return conflict({ coin: e.coin, gold: e.gold });
  if (!r.ok) return null;
  return { ok: true, coin: e.coin, gold: e.gold, balance: r.balance };
}

/** Coin balance, best effort (0 when the account cannot be read). */
export async function balanceOf(account: BankAccount, accountId: string): Promise<number> {
  try {
    const w = await account.wallet(accountId);
    return w.balances.coin ?? 0;
  } catch {
    return 0;
  }
}
