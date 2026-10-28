/**
 * AccountDO: shared economy — wallet ledger, universal stash, cosmetics and
 * entitlements (wave-B.md §3.4). OWNER: T-economy.
 *
 * Rules: every mutation is idempotent by txId (a `tx` table remembers the
 * first result and a replay returns it with replayed=true); balances never go
 * negative; integers only; cosmetics can only be equipped when owned
 * (owned = granted entitlements with a "cosmetic." sku).
 *
 * ADR 0007 R2: a wallet txId is bound to its currency and amount. A known
 * txId with other parameters answers { ok: false, code: "conflict" } and
 * writes nothing, so a reused txId can never pass as a replay of a different
 * change (a 1-coin debit replayed "ok" for 1e9 coin).
 *
 * Every mutation runs in one transactionSync: a throw (or a rejected input)
 * leaves no partial write behind. Insufficient funds are returned, not thrown,
 * and write nothing, so the same txId can be retried later.
 *
 * Wave C (T-escrow, wave-C.md §3.1): the stash table is the account vault.
 * Its primary key is the uid (two vault items may share itemId + origin);
 * a wave B table keyed by (item_id, origin) is rebuilt once in init(), and
 * missing wave C columns are added with guarded ALTER TABLE ADD COLUMN.
 * Every applied (non-replayed) wallet change calls `onWalletApplied` inside
 * the same transaction (account/vault.ts writes the telemetry outbox rows).
 */
import type {
  CosmeticSlot,
  CosmeticsView,
  Currency,
  EntitlementView,
  UniversalItem,
  WalletView,
} from "@gamez/protocol";
import type {
  EconomyFlow,
  EntitlementGrant,
  SqlStore,
  WalletTx,
  WalletTxC,
  WalletTxResult,
} from "../contracts.ts";

/** Invalid input or a violated economy rule. `code` is stable; `message` is for humans. */
export class EconomyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EconomyError";
    this.code = code;
  }
}

export const CURRENCIES: readonly Currency[] = ["coin", "gem"];
export const COSMETIC_SLOTS: readonly CosmeticSlot[] = ["title", "nameplate", "chatColor"];
const COSMETIC_PREFIX = "cosmetic.";
const MAX_TX_ID = 128;
const MAX_REASON = 200;
const MAX_ITEM_ID = 100;
const MAX_ORIGIN = 64;
const MAX_STACK_COUNT = 1_000_000_000;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// Row shapes (SqlStorage.exec requires Record<string, SqlStorageValue>: use type aliases).
type BalanceRow = { currency: string; amount: number };
type TxRow = { result: string };
type WalletTxRow = { result: string; currency: string | null; amount: number | null };
type StashRow = { uid: string; item_id: string; origin: string; count: number };
type EntitlementRow = { tx_id: string; sku: string; source: string; granted_at: number };
type EquippedRow = { slot: string; cosmetic_id: string };

/** Kinds of the tx table; each has its own txId namespace. */
const TX_WALLET = "wallet";
const TX_STASH_ADD = "stash.add";
const TX_STASH_REMOVE = "stash.remove";

/** Columns the wave C vault adds to the stash table (all nullable: legacy rows read as defaults). */
const VAULT_COLUMNS: readonly [string, string][] = [
  ["universal", "INTEGER"],
  ["tradable", "INTEGER"],
  ["summary", "TEXT"],
  ["data", "TEXT"],
  ["seq", "INTEGER NOT NULL DEFAULT 0"],
];

const STASH_SCHEMA = `CREATE TABLE IF NOT EXISTS stash (
      uid TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      count INTEGER NOT NULL,
      universal INTEGER,
      tradable INTEGER,
      summary TEXT,
      data TEXT,
      seq INTEGER NOT NULL DEFAULT 0
    )`;

/** What an applied wallet change reports to the telemetry hook. */
export interface AppliedWalletTx {
  txId: string;
  currency: Currency;
  amount: number;
  reason: string;
  flow: EconomyFlow;
  /** Balance of `currency` after the change. */
  balance: number;
  at: number;
}

/** Flow of a wave B applyWalletTx caller that names none: "dev*" reasons are faucets. */
export function defaultFlow(reason: string): EconomyFlow {
  return reason.startsWith("dev") ? "faucet" : "transfer";
}

const FLOWS: readonly EconomyFlow[] = ["faucet", "sink", "transfer"];

function isTxId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_TX_ID;
}

function isCurrency(v: unknown): v is Currency {
  return typeof v === "string" && (CURRENCIES as readonly string[]).includes(v);
}

function isCount(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max;
}

export class AccountEconomy {
  /** Runs inside the transaction of every applied (non-replayed) wallet change. */
  onWalletApplied: ((tx: AppliedWalletTx) => void) | null = null;

  constructor(
    readonly store: SqlStore,
    readonly now: () => number = Date.now,
  ) {}

  init(): void {
    const sql = this.store.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS balances (
      currency TEXT PRIMARY KEY,
      amount INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS tx (
      kind TEXT NOT NULL,
      tx_id TEXT NOT NULL,
      result TEXT NOT NULL,
      currency TEXT,
      amount INTEGER,
      reason TEXT,
      at INTEGER NOT NULL,
      PRIMARY KEY (kind, tx_id)
    )`);
    this.#initStash();
    sql.exec(`CREATE TABLE IF NOT EXISTS entitlements (
      tx_id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      source TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`);
    // Wave C: a refund (account/purchases.ts) sets revoked_at; revoked grants are
    // not owned. Tables created before wave C get the column once (sqlite_master,
    // because PRAGMA is restricted in DOs).
    const entitlementsSql =
      sql
        .exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entitlements'",
        )
        .toArray()[0]?.sql ?? "";
    if (!/\brevoked_at\b/.test(entitlementsSql))
      sql.exec("ALTER TABLE entitlements ADD COLUMN revoked_at INTEGER");
    sql.exec(`CREATE TABLE IF NOT EXISTS equipped (
      slot TEXT PRIMARY KEY,
      cosmetic_id TEXT NOT NULL
    )`);
  }

  /**
   * Creates the stash (vault) table, or upgrades a wave B one: a table keyed by
   * (item_id, origin) is rebuilt keyed by uid (rows kept, wave C columns NULL);
   * then any missing wave C column is added. Idempotent.
   */
  #initStash(): void {
    const sql = this.store.sql;
    const tableSql = (): string =>
      sql
        .exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stash'",
        )
        .toArray()[0]?.sql ?? "";
    const existing = tableSql();
    if (existing === "") {
      sql.exec(STASH_SCHEMA);
    } else if (/PRIMARY KEY\s*\(\s*item_id/i.test(existing)) {
      this.store.transactionSync(() => {
        sql.exec("ALTER TABLE stash RENAME TO stash_wave_b");
        sql.exec(STASH_SCHEMA);
        sql.exec(
          "INSERT INTO stash (uid, item_id, origin, count) SELECT uid, item_id, origin, count FROM stash_wave_b",
        );
        sql.exec("DROP TABLE stash_wave_b");
      });
    } else {
      for (const [name, type] of VAULT_COLUMNS) {
        if (!new RegExp(`\\b${name}\\b`).test(tableSql()))
          sql.exec(`ALTER TABLE stash ADD COLUMN ${name} ${type}`);
      }
    }
    sql.exec("CREATE INDEX IF NOT EXISTS stash_item ON stash (item_id, origin)");
  }

  // ---- wallet -------------------------------------------------------------

  wallet(): WalletView {
    return { balances: { coin: this.balanceOf("coin"), gem: this.balanceOf("gem") } };
  }

  /**
   * Applies a wallet change once per txId. `tx.flow` (wave C) tags the
   * telemetry row; absent = defaultFlow(reason).
   */
  applyWalletTx(tx: WalletTx | WalletTxC): WalletTxResult {
    const flow = "flow" in tx && tx.flow !== undefined ? tx.flow : defaultFlow(String(tx.reason));
    const currentOf = (): number => (isCurrency(tx.currency) ? this.balanceOf(tx.currency) : 0);
    if (
      !isTxId(tx.txId) ||
      !isCurrency(tx.currency) ||
      typeof tx.amount !== "number" ||
      !Number.isSafeInteger(tx.amount) ||
      tx.amount === 0 ||
      typeof tx.reason !== "string" ||
      tx.reason.length > MAX_REASON ||
      !FLOWS.includes(flow)
    ) {
      return { ok: false, code: "bad_tx", balance: currentOf() };
    }
    const currency = tx.currency;
    return this.store.transactionSync((): WalletTxResult => {
      const prior = this.#findWalletTx(tx.txId);
      if (prior) {
        // Strict replay: only the same change replays (rows without the columns can't prove it).
        const first = parseBalance(prior.result);
        if (prior.currency !== currency || prior.amount !== tx.amount || first === null) {
          return { ok: false, code: "conflict", balance: this.balanceOf(currency) };
        }
        return { ok: true, balance: first, replayed: true };
      }
      const current = this.balanceOf(currency);
      const next = current + tx.amount;
      if (next < 0) return { ok: false, code: "insufficient_funds", balance: current };
      if (!Number.isSafeInteger(next)) return { ok: false, code: "bad_tx", balance: current };
      this.#setBalance(currency, next);
      const at = this.now();
      this.store.sql.exec(
        "INSERT INTO tx (kind, tx_id, result, currency, amount, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        TX_WALLET,
        tx.txId,
        JSON.stringify({ balance: next }),
        currency,
        tx.amount,
        tx.reason,
        at,
      );
      this.onWalletApplied?.({
        txId: tx.txId,
        currency,
        amount: tx.amount,
        reason: tx.reason,
        flow,
        balance: next,
        at,
      });
      return { ok: true, balance: next, replayed: false };
    });
  }

  // ---- universal stash ----------------------------------------------------

  stash(): UniversalItem[] {
    return this.store.sql
      .exec<StashRow>(
        "SELECT uid, item_id, origin, count FROM stash ORDER BY item_id, origin, seq, uid",
      )
      .toArray()
      .map((r) => ({ uid: r.uid, itemId: r.item_id, count: r.count, origin: r.origin }));
  }

  /**
   * Adds `item.count` to the stack of (itemId, origin), creating it when
   * missing. A new stack's uid is derived from the txId, so it is stable.
   */
  stashAdd(txId: string, item: Omit<UniversalItem, "uid">): UniversalItem[] {
    if (!isTxId(txId)) throw new EconomyError("bad_tx", "txId required");
    if (
      typeof item.itemId !== "string" ||
      item.itemId.length === 0 ||
      item.itemId.length > MAX_ITEM_ID
    )
      throw new EconomyError("bad_item", "itemId required");
    if (typeof item.origin !== "string" || item.origin.length > MAX_ORIGIN)
      throw new EconomyError("bad_item", "origin must be a short string");
    if (!isCount(item.count, MAX_STACK_COUNT))
      throw new EconomyError("bad_item", "count must be a positive integer");
    return this.store.transactionSync(() => {
      const prior = this.#findTx(TX_STASH_ADD, txId);
      if (prior) return JSON.parse(prior.result) as UniversalItem[];
      const existing = this.store.sql
        .exec<StashRow>(
          "SELECT uid, item_id, origin, count FROM stash WHERE item_id = ? AND origin = ? AND data IS NULL ORDER BY seq, uid LIMIT 1",
          item.itemId,
          item.origin,
        )
        .toArray()[0];
      if (existing) {
        const total = existing.count + item.count;
        if (!Number.isSafeInteger(total) || total > MAX_STACK_COUNT)
          throw new EconomyError("stack_full", "stack would exceed the maximum count");
        this.store.sql.exec("UPDATE stash SET count = ? WHERE uid = ?", total, existing.uid);
      } else {
        this.store.sql.exec(
          "INSERT INTO stash (item_id, origin, uid, count, seq) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM stash))",
          item.itemId,
          item.origin,
          `stk:${txId}`,
          item.count,
        );
      }
      const after = this.stash();
      this.#recordTx(TX_STASH_ADD, txId, after);
      return after;
    });
  }

  /** Removes `count` from the stack `uid`; the stack disappears at zero. */
  stashRemove(txId: string, uid: string, count: number): UniversalItem[] {
    if (!isTxId(txId)) throw new EconomyError("bad_tx", "txId required");
    if (typeof uid !== "string" || uid.length === 0)
      throw new EconomyError("bad_item", "uid required");
    if (!isCount(count, MAX_STACK_COUNT))
      throw new EconomyError("bad_item", "count must be a positive integer");
    return this.store.transactionSync(() => {
      const prior = this.#findTx(TX_STASH_REMOVE, txId);
      if (prior) return JSON.parse(prior.result) as UniversalItem[];
      const row = this.store.sql
        .exec<StashRow>("SELECT uid, item_id, origin, count FROM stash WHERE uid = ?", uid)
        .toArray()[0];
      if (!row) throw new EconomyError("not_found", "no such stack");
      if (count > row.count)
        throw new EconomyError("insufficient_items", "stack holds fewer items than requested");
      if (count === row.count) {
        this.store.sql.exec("DELETE FROM stash WHERE uid = ?", uid);
      } else {
        this.store.sql.exec("UPDATE stash SET count = ? WHERE uid = ?", row.count - count, uid);
      }
      const after = this.stash();
      this.#recordTx(TX_STASH_REMOVE, txId, after);
      return after;
    });
  }

  // ---- entitlements and cosmetics ----------------------------------------

  /** Owned cosmetics: the skus of granted entitlements starting with "cosmetic.", sorted. */
  cosmetics(): CosmeticsView {
    const owned = this.#ownedCosmetics();
    const equipped: Partial<Record<CosmeticSlot, string>> = {};
    for (const row of this.store.sql
      .exec<EquippedRow>("SELECT slot, cosmetic_id FROM equipped ORDER BY slot")
      .toArray()) {
      // A refunded (revoked) cosmetic is no longer owned, so it is not shown equipped.
      if (isSlot(row.slot) && owned.includes(row.cosmetic_id)) equipped[row.slot] = row.cosmetic_id;
    }
    return { owned, equipped };
  }

  /** Equips an owned cosmetic in `slot`; `id` null unequips. */
  equipCosmetic(slot: CosmeticSlot, id: string | null): CosmeticsView {
    if (!isSlot(slot)) throw new EconomyError("bad_slot", `unknown cosmetic slot: ${String(slot)}`);
    if (id === null) {
      this.store.sql.exec("DELETE FROM equipped WHERE slot = ?", slot);
      return this.cosmetics();
    }
    if (typeof id !== "string" || !id.startsWith(COSMETIC_PREFIX))
      throw new EconomyError("bad_cosmetic", 'cosmetic id must start with "cosmetic."');
    const owned = this.#ownedCosmetics();
    if (!owned.includes(id)) throw new EconomyError("not_owned", `cosmetic not owned: ${id}`);
    this.store.sql.exec(
      "INSERT INTO equipped (slot, cosmetic_id) VALUES (?, ?) ON CONFLICT(slot) DO UPDATE SET cosmetic_id = excluded.cosmetic_id",
      slot,
      id,
    );
    return this.cosmetics();
  }

  /**
   * Grants an entitlement once per txId. A replay returns the stored
   * entitlement with granted=false and writes nothing.
   */
  grantEntitlement(grant: EntitlementGrant): { granted: boolean; entitlement: EntitlementView } {
    if (!isTxId(grant.txId)) throw new EconomyError("bad_tx", "txId required");
    if (typeof grant.sku !== "string" || !SKU_RE.test(grant.sku))
      throw new EconomyError("bad_sku", "sku must be a short identifier");
    if (
      typeof grant.source !== "string" ||
      grant.source.length === 0 ||
      grant.source.length > MAX_ORIGIN
    )
      throw new EconomyError("bad_source", "source must be a short string");
    return this.store.transactionSync(() => {
      const existing = this.#entitlementRow(grant.txId);
      if (existing) return { granted: false, entitlement: toEntitlementView(existing) };
      const at = this.now();
      this.store.sql.exec(
        "INSERT INTO entitlements (tx_id, sku, source, granted_at) VALUES (?, ?, ?, ?)",
        grant.txId,
        grant.sku,
        grant.source,
        at,
      );
      const row: EntitlementRow = {
        tx_id: grant.txId,
        sku: grant.sku,
        source: grant.source,
        granted_at: at,
      };
      return { granted: true, entitlement: toEntitlementView(row) };
    });
  }

  entitlements(): EntitlementView[] {
    return this.store.sql
      .exec<EntitlementRow>(
        "SELECT tx_id, sku, source, granted_at FROM entitlements WHERE revoked_at IS NULL ORDER BY granted_at, tx_id",
      )
      .toArray()
      .map(toEntitlementView);
  }

  // ---- helpers ------------------------------------------------------------

  balanceOf(currency: Currency): number {
    const row = this.store.sql
      .exec<BalanceRow>("SELECT currency, amount FROM balances WHERE currency = ?", currency)
      .toArray()[0];
    return row?.amount ?? 0;
  }

  #setBalance(currency: Currency, amount: number): void {
    this.store.sql.exec(
      "INSERT INTO balances (currency, amount) VALUES (?, ?) ON CONFLICT(currency) DO UPDATE SET amount = excluded.amount",
      currency,
      amount,
    );
  }

  #findTx(kind: string, txId: string): TxRow | null {
    return (
      this.store.sql
        .exec<TxRow>("SELECT result FROM tx WHERE kind = ? AND tx_id = ?", kind, txId)
        .toArray()[0] ?? null
    );
  }

  #findWalletTx(txId: string): WalletTxRow | null {
    return (
      this.store.sql
        .exec<WalletTxRow>(
          "SELECT result, currency, amount FROM tx WHERE kind = ? AND tx_id = ?",
          TX_WALLET,
          txId,
        )
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

  #entitlementRow(txId: string): EntitlementRow | null {
    return (
      this.store.sql
        .exec<EntitlementRow>(
          "SELECT tx_id, sku, source, granted_at FROM entitlements WHERE tx_id = ?",
          txId,
        )
        .toArray()[0] ?? null
    );
  }

  #ownedCosmetics(): string[] {
    return this.store.sql
      .exec<{ sku: string }>(
        "SELECT DISTINCT sku FROM entitlements WHERE substr(sku, 1, 9) = 'cosmetic.' AND revoked_at IS NULL ORDER BY sku",
      )
      .toArray()
      .map((r) => r.sku);
  }
}

/** The balance stored in a wallet tx result, or null when the row is unreadable. */
function parseBalance(result: string): number | null {
  try {
    const v = (JSON.parse(result) as { balance?: unknown } | null)?.balance;
    return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
  } catch {
    return null;
  }
}

function isSlot(v: unknown): v is CosmeticSlot {
  return typeof v === "string" && (COSMETIC_SLOTS as readonly string[]).includes(v);
}

function toEntitlementView(row: EntitlementRow): EntitlementView {
  return { id: row.tx_id, sku: row.sku, grantedAt: row.granted_at, source: row.source };
}
