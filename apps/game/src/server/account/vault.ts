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
 * Waiting deliveries: a put with { waiting: true } (venues and the bank, through
 * economy/gateway.ts) that meets a full vault is listed in vault_waiting
 * (txId, first and last refusal). The caller holds the item and retries the
 * same txId; a successful put of that txId removes it. Rows not retried for
 * WAITING_STALE_MS are dropped (every caller retries at most hourly). When the
 * list goes from empty to non-empty, onWaitStarted fires once (AccountDO sends
 * the "vault.full" notice), so a full spell tells the player once.
 *
 * ADR 0007 R2: a txId is bound to its parameters. A known "vault.take" txId
 * replays only for the same uid; a known "vault.put" txId only for the same
 * item (itemId, origin, count, universal, tradable, summary, data: compared
 * as the canonical cleanInput JSON of the stored item). Anything else
 * answers { ok: false, code: "conflict" } and writes nothing; a stored result
 * that cannot be proven equal is a conflict too.
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
  type VaultWaiting,
  type NoticeInput,
} from "@gamez/protocol";
import type { Outbox } from "@gamez/sync";
import type {
  AccountWalletPayload,
  EconomyLedgerPayload,
  SqlStore,
  VaultPutOptions,
  VaultPutResult,
  VaultTakeResult,
  WalletTxC,
  WalletTxResult,
} from "../contracts.ts";
import type { AccountEconomy, AppliedWalletTx } from "./economy.ts";

const TX_VAULT_PUT = "vault.put";
const TX_VAULT_TAKE = "vault.take";
const MAX_TX_ID = 128;
/** A waiting delivery not retried for this long is no longer listed (callers retry at most hourly). */
export const WAITING_STALE_MS = 24 * 60 * 60_000;
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

/** Canonical form of a valid input: equal items give equal strings (key order fixed by cleanInput). */
function canonicalInput(i: VaultItemInput): string {
  return JSON.stringify(cleanInput(i));
}

/** The stored item of a tx result, or null when the row is unreadable. */
function storedItem(result: string): VaultItem | null {
  try {
    const v: unknown = JSON.parse(result);
    if (!v || typeof v !== "object" || typeof (v as { uid?: unknown }).uid !== "string")
      return null;
    return v as VaultItem;
  } catch {
    return null;
  }
}

/** True when the stored put result is exactly `input` (plus its uid). */
function samePut(stored: VaultItem, input: VaultItemInput): boolean {
  const { uid: _uid, ...rest } = stored;
  return vaultItemProblem(rest) === null && canonicalInput(rest) === canonicalInput(input);
}

function isTxId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_TX_ID;
}

export class AccountVault {
  /** Fires after a put, when the waiting list went from empty to `count` (1). */
  onWaitStarted: ((txId: string, count: number) => void) | null = null;

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
    this.store.sql.exec(`CREATE TABLE IF NOT EXISTS vault_waiting (
      tx_id TEXT PRIMARY KEY,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL
    )`);
  }

  /** Deliveries waiting for space (stale rows dropped first). */
  waiting(): VaultWaiting {
    return this.store.transactionSync(() => {
      this.#pruneWaiting();
      const row = this.store.sql
        .exec<{ n: number; since: number | null }>(
          "SELECT COUNT(*) AS n, MIN(first_at) AS since FROM vault_waiting",
        )
        .one();
      return { count: row.n, since: row.n > 0 ? row.since : null };
    });
  }

  #pruneWaiting(): void {
    this.store.sql.exec(
      "DELETE FROM vault_waiting WHERE last_at < ?",
      this.now() - WAITING_STALE_MS,
    );
  }

  /** Lists txId as waiting; true when the list was empty before. Inside a transaction. */
  #wait(txId: string): boolean {
    this.#pruneWaiting();
    const sql = this.store.sql;
    const t = this.now();
    const before = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM vault_waiting").one().n;
    sql.exec(
      `INSERT INTO vault_waiting (tx_id, first_at, last_at) VALUES (?, ?, ?)
       ON CONFLICT (tx_id) DO UPDATE SET last_at = excluded.last_at`,
      txId,
      t,
      t,
    );
    return before === 0;
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

  vaultPut(txId: string, item: VaultItemInput, opts: VaultPutOptions = {}): VaultPutResult {
    if (!isTxId(txId) || vaultItemProblem(item) !== null) return { ok: false, code: "bad_item" };
    const input = cleanInput(item);
    let started = false;
    const result = this.store.transactionSync((): VaultPutResult => {
      const prior = this.#findTx(TX_VAULT_PUT, txId);
      if (prior) {
        const first = storedItem(prior.result);
        if (!first || !samePut(first, input)) return { ok: false, code: "conflict" };
        this.store.sql.exec("DELETE FROM vault_waiting WHERE tx_id = ?", txId);
        return { ok: true, item: first, replayed: true };
      }
      if (this.size() >= VAULT_MAX_ITEMS) {
        // Only the waiting list is written: the put itself stays retryable.
        if (opts.waiting === true) started = this.#wait(txId);
        return { ok: false, code: "vault_full" };
      }
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
      this.store.sql.exec("DELETE FROM vault_waiting WHERE tx_id = ?", txId);
      return { ok: true, item: stored, replayed: false };
    });
    if (started) this.onWaitStarted?.(txId, 1);
    return result;
  }

  vaultTake(txId: string, uid: string): VaultTakeResult {
    if (!isTxId(txId) || typeof uid !== "string" || uid.length === 0)
      return { ok: false, code: "not_found" };
    return this.store.transactionSync((): VaultTakeResult => {
      const prior = this.#findTx(TX_VAULT_TAKE, txId);
      if (prior) {
        const first = storedItem(prior.result);
        if (!first || first.uid !== uid) return { ok: false, code: "conflict" };
        return { ok: true, item: first, replayed: true };
      }
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

/** The inbox notice of a full spell (one per spell: its id comes from the first waiting txId). */
export function vaultFullNotice(txId: string): NoticeInput {
  return {
    id: `vault.full:${txId}`.slice(0, 160),
    kind: "vault.full",
    text: "Your vault is full. A delivery is waiting: free a slot (withdraw or sell an item) and it arrives on its own.",
    data: {},
  };
}
