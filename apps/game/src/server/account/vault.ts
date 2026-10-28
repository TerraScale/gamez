/**
 * AccountDO vault (wave-C.md §3.1): the wave B stash table with the wave C
 * columns (universal, tradable, summary JSON, data; economy.ts init() adds
 * them). Legacy rows read as universal/tradable with a summary derived from
 * itemId. Every mutation is idempotent by txId (economy.ts `tx` table, own
 * kinds "vault.put" / "vault.take") and runs in one transactionSync.
 *
 * vaultPut never merges stacks: every put is one row with a fresh uid ("v<n>"),
 * so a uid always names exactly what was put. Rejections (vault_full,
 * not_found, bad_item) write nothing, so the same txId can be retried later.
 *
 * walletTx = economy.applyWalletTx with a flow. Telemetry: every applied
 * (non-replayed) wallet change — through walletTx or the wave B
 * applyWalletTx — appends "economy_ledger" (signed delta, flow, reasonGroup)
 * and "account_wallet" (both balances) to the outbox in the SAME transaction
 * (the hook is installed on the economy in the constructor).
 * OWNER: T-escrow.
 */
import { flowGroup } from "@gamez/economy";
import {
  ITEM_CATEGORIES,
  VAULT_ITEM_DATA_MAX,
  VAULT_MAX_ITEMS,
  type ItemCategory,
  type ItemSummary,
  type VaultItem,
  type VaultItemInput,
} from "@gamez/protocol";
import type { Outbox } from "@gamez/sync";
import type {
  AccountWalletPayload,
  EconomyLedgerPayload,
  SqlStore,
  VaultPutResult,
  VaultTakeResult,
  WalletTxC,
  WalletTxResult,
} from "../contracts.ts";
import type { AccountEconomy, AppliedWalletTx } from "./economy.ts";

const TX_VAULT_PUT = "vault.put";
const TX_VAULT_TAKE = "vault.take";
const MAX_TX_ID = 128;
const MAX_ITEM_ID = 100;
const MAX_ORIGIN = 64;
const MAX_STACK_COUNT = 1_000_000_000;
const MAX_NAME = 60;
const MAX_RARITY = 32;
const MAX_SLOT = 32;
const MAX_ICON = 100;
const MAX_LINES = 8;
const MAX_LINE = 60;
const MAX_LEVEL = 100_000;

type VaultRow = {
  uid: string;
  item_id: string;
  origin: string;
  count: number;
  universal: number | null;
  tradable: number | null;
  summary: string | null;
  data: string | null;
};
type TxRow = { result: string };

const VAULT_COLUMNS = "uid, item_id, origin, count, universal, tradable, summary, data";

/** Display summary of a legacy (wave B) stash row: derived from its logical itemId. */
export function legacySummary(itemId: string): ItemSummary {
  const parts = itemId.split(".").filter((p) => p.length > 0);
  const last = parts[parts.length - 1] ?? itemId;
  const words = last.replace(/[_-]+/g, " ").trim();
  const name = (words.length > 0 ? words : itemId)
    .split(" ")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ")
    .slice(0, MAX_NAME);
  const category: ItemCategory =
    parts.find((p): p is ItemCategory => (ITEM_CATEGORIES as readonly string[]).includes(p)) ??
    "other";
  return { name, rarity: "common", level: 0, category, slot: null, icon: itemId, lines: [] };
}

/** Why `item` is not a valid VaultItemInput, or null when it is. */
export function vaultItemProblem(item: unknown): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "item must be an object";
  const i = item as Partial<VaultItemInput>;
  if (typeof i.itemId !== "string" || i.itemId.length === 0 || i.itemId.length > MAX_ITEM_ID)
    return "itemId: 1..100 chars";
  if (typeof i.origin !== "string" || i.origin.length > MAX_ORIGIN) return "origin: <= 64 chars";
  if (
    typeof i.count !== "number" ||
    !Number.isSafeInteger(i.count) ||
    i.count <= 0 ||
    i.count > MAX_STACK_COUNT
  )
    return "count: positive integer";
  if (typeof i.universal !== "boolean") return "universal: boolean";
  if (typeof i.tradable !== "boolean") return "tradable: boolean";
  if (i.data !== null && (typeof i.data !== "string" || i.data.length > VAULT_ITEM_DATA_MAX))
    return `data: null or a string <= ${VAULT_ITEM_DATA_MAX} chars`;
  return summaryProblem(i.summary);
}

function summaryProblem(s: unknown): string | null {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "summary must be an object";
  const v = s as Partial<ItemSummary>;
  if (typeof v.name !== "string" || v.name.length === 0 || v.name.length > MAX_NAME)
    return "summary.name: 1..60 chars";
  if (typeof v.rarity !== "string" || v.rarity.length === 0 || v.rarity.length > MAX_RARITY)
    return "summary.rarity: 1..32 chars";
  if (
    typeof v.level !== "number" ||
    !Number.isSafeInteger(v.level) ||
    v.level < 0 ||
    v.level > MAX_LEVEL
  )
    return "summary.level: integer >= 0";
  if (
    typeof v.category !== "string" ||
    !(ITEM_CATEGORIES as readonly string[]).includes(v.category)
  )
    return "summary.category: unknown";
  if (
    v.slot !== null &&
    (typeof v.slot !== "string" || v.slot.length === 0 || v.slot.length > MAX_SLOT)
  )
    return "summary.slot: null or 1..32 chars";
  if (typeof v.icon !== "string" || v.icon.length === 0 || v.icon.length > MAX_ICON)
    return "summary.icon: 1..100 chars";
  if (
    !Array.isArray(v.lines) ||
    v.lines.length > MAX_LINES ||
    !v.lines.every((l) => typeof l === "string" && l.length <= MAX_LINE)
  )
    return "summary.lines: <= 8 strings of <= 60 chars";
  return null;
}

/** A clean copy of a valid input (drops unknown fields). */
function cleanInput(i: VaultItemInput): VaultItemInput {
  const s = i.summary;
  return {
    itemId: i.itemId,
    origin: i.origin,
    count: i.count,
    universal: i.universal,
    tradable: i.tradable,
    summary: {
      name: s.name,
      rarity: s.rarity,
      level: s.level,
      category: s.category,
      slot: s.slot,
      icon: s.icon,
      lines: [...s.lines],
    },
    data: i.data,
  };
}

function toItem(r: VaultRow): VaultItem {
  let summary: ItemSummary | null = null;
  if (r.summary !== null) {
    try {
      const parsed: unknown = JSON.parse(r.summary);
      if (summaryProblem(parsed) === null) summary = parsed as ItemSummary;
    } catch {
      summary = null;
    }
  }
  return {
    uid: r.uid,
    itemId: r.item_id,
    count: r.count,
    origin: r.origin,
    universal: r.universal === null ? true : r.universal !== 0,
    tradable: r.tradable === null ? true : r.tradable !== 0,
    summary: summary ?? legacySummary(r.item_id),
    data: r.data,
  };
}

function isTxId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_TX_ID;
}

export class AccountVault {
  constructor(
    readonly store: SqlStore,
    readonly economy: AccountEconomy,
    readonly outbox: Outbox,
    readonly accountId: string,
    readonly now: () => number = Date.now,
  ) {
    economy.onWalletApplied = (tx) => this.#telemetry(tx);
  }

  /**
   * The stash table and its wave C columns are created by AccountEconomy.init();
   * vault_seq is the uid counter (uids are never reused, even after a take).
   */
  init(): void {
    this.store.sql.exec(`CREATE TABLE IF NOT EXISTS vault_seq (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      n INTEGER NOT NULL
    )`);
  }

  vault(): VaultItem[] {
    return this.store.sql
      .exec<VaultRow>(`SELECT ${VAULT_COLUMNS} FROM stash ORDER BY seq, uid`)
      .toArray()
      .map(toItem);
  }

  vaultGet(uid: string): VaultItem | null {
    if (typeof uid !== "string" || uid.length === 0) return null;
    const row = this.store.sql
      .exec<VaultRow>(`SELECT ${VAULT_COLUMNS} FROM stash WHERE uid = ?`, uid)
      .toArray()[0];
    return row ? toItem(row) : null;
  }

  /** Number of rows (stacks) in the vault. */
  size(): number {
    return this.store.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM stash").one().n;
  }

  vaultPut(txId: string, item: VaultItemInput): VaultPutResult {
    if (!isTxId(txId) || vaultItemProblem(item) !== null) return { ok: false, code: "bad_item" };
    const input = cleanInput(item);
    return this.store.transactionSync((): VaultPutResult => {
      const prior = this.#findTx(TX_VAULT_PUT, txId);
      if (prior) return { ok: true, item: JSON.parse(prior.result) as VaultItem, replayed: true };
      if (this.size() >= VAULT_MAX_ITEMS) return { ok: false, code: "vault_full" };
      const seq = this.#nextSeq();
      const uid = `v${seq}`;
      this.store.sql.exec(
        `INSERT INTO stash (uid, item_id, origin, count, universal, tradable, summary, data, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid,
        input.itemId,
        input.origin,
        input.count,
        input.universal ? 1 : 0,
        input.tradable ? 1 : 0,
        JSON.stringify(input.summary),
        input.data,
        seq,
      );
      const stored: VaultItem = { uid, ...input };
      this.#recordTx(TX_VAULT_PUT, txId, stored);
      return { ok: true, item: stored, replayed: false };
    });
  }

  vaultTake(txId: string, uid: string): VaultTakeResult {
    if (!isTxId(txId) || typeof uid !== "string" || uid.length === 0)
      return { ok: false, code: "not_found" };
    return this.store.transactionSync((): VaultTakeResult => {
      const prior = this.#findTx(TX_VAULT_TAKE, txId);
      if (prior) return { ok: true, item: JSON.parse(prior.result) as VaultItem, replayed: true };
      const item = this.vaultGet(uid);
      if (!item) return { ok: false, code: "not_found" };
      this.store.sql.exec("DELETE FROM stash WHERE uid = ?", uid);
      this.#recordTx(TX_VAULT_TAKE, txId, item);
      return { ok: true, item, replayed: false };
    });
  }

  walletTx(tx: WalletTxC): WalletTxResult {
    return this.economy.applyWalletTx({ ...tx, flow: tx.flow ?? "transfer" });
  }

  // ---- helpers ------------------------------------------------------------

  #telemetry(tx: AppliedWalletTx): void {
    const ledger: EconomyLedgerPayload = {
      accountId: this.accountId,
      txId: tx.txId,
      currency: tx.currency,
      amount: tx.amount,
      flow: tx.flow,
      reasonGroup: flowGroup(tx.reason),
      reason: tx.reason,
      at: tx.at,
    };
    this.outbox.append("economy_ledger", `${this.accountId}/${tx.txId}`, "upsert", ledger);
    const balances = this.economy.wallet().balances;
    const wallet: AccountWalletPayload = {
      accountId: this.accountId,
      coin: balances.coin,
      gem: balances.gem,
      updatedAt: tx.at,
    };
    this.outbox.append("account_wallet", this.accountId, "upsert", wallet);
  }

  #nextSeq(): number {
    return this.store.sql
      .exec<{ n: number }>(
        `INSERT INTO vault_seq (id, n) VALUES (1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM stash))
         ON CONFLICT (id) DO UPDATE SET n = n + 1 RETURNING n`,
      )
      .one().n;
  }

  #findTx(kind: string, txId: string): TxRow | null {
    return (
      this.store.sql
        .exec<TxRow>("SELECT result FROM tx WHERE kind = ? AND tx_id = ?", kind, txId)
        .toArray()[0] ?? null
    );
  }

  #recordTx(kind: string, txId: string, result: unknown): void {
    this.store.sql.exec(
      "INSERT INTO tx (kind, tx_id, result, at) VALUES (?, ?, ?, ?)",
      kind,
      txId,
      JSON.stringify(result),
      this.now(),
    );
  }
}
