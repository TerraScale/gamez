/**
 * Durable state of the wave C bank saga of a verified instance
 * (docs/design/wave-C.md §2.4), on the same DO SQLite as VerifiedStore so the
 * host can write a bank row and a new base in ONE transaction
 * (VerifiedStore.transaction joins both).
 *
 *   bank_op(op_id PK, account_id, state, op, effect, result, at)
 *     states: taking -> applied -> done            (withdrawals; refunding -> done on failure)
 *             crediting -> done                    (deposits, written with the new base)
 *   platform_kv(key PK, value)                     (last season report, …)
 *
 * Every method is synchronous.
 */
import type { BankOp, BankResult, VaultItem, VaultItemInput } from "@gamez/protocol";
import type { SqlStore } from "../contracts.ts";

export type BankOpState = "taking" | "applied" | "crediting" | "refunding" | "done";

/** What a bank op moved, persisted so a re-drive can finish or undo it. */
export interface BankEffect {
  /** Coin taken from (withdrawCoin) or to credit to (depositGold) the account. */
  coin: number;
  /** Gold moved on the hero (always >= 0). */
  gold: number;
  /** withdrawItem: the vault item taken. depositItem: the item to put. */
  item: VaultItem | VaultItemInput | null;
  /** Coin balance learned on the way (take result), when known. */
  balance: number | null;
}

export interface BankOpRow {
  opId: string;
  accountId: string;
  state: BankOpState;
  op: BankOp;
  effect: BankEffect | null;
  result: BankResult | null;
  /** Epoch ms of the first write. */
  at: number;
}

export interface BankStore {
  get(opId: string): BankOpRow | null;
  /** Inserts or replaces the row. */
  put(row: BankOpRow): void;
  /** Rows not done, oldest first. */
  pending(): BankOpRow[];
  /** Deletes done rows written before `before` (epoch ms). */
  prune(before: number): number;
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
}

interface Row extends Record<string, SqlStorageValue> {
  op_id: string;
  account_id: string;
  state: string;
  op: string;
  effect: string | null;
  result: string | null;
  at: number;
}

function parse<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function fromRow(r: Row): BankOpRow | null {
  const op = parse<BankOp>(r.op);
  if (!op) return null;
  return {
    opId: r.op_id,
    accountId: r.account_id,
    state: r.state as BankOpState,
    op,
    effect: parse<BankEffect>(r.effect),
    result: parse<BankResult>(r.result),
    at: r.at,
  };
}

export class SqlBankStore implements BankStore {
  readonly #db: SqlStore;

  constructor(db: SqlStore) {
    this.#db = db;
    db.sql.exec(`CREATE TABLE IF NOT EXISTS bank_op (
      op_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      state TEXT NOT NULL,
      op TEXT NOT NULL,
      effect TEXT,
      result TEXT,
      at INTEGER NOT NULL
    )`);
    db.sql.exec(`CREATE TABLE IF NOT EXISTS platform_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  }

  get(opId: string): BankOpRow | null {
    const r = this.#db.sql.exec<Row>("SELECT * FROM bank_op WHERE op_id = ?", opId).toArray()[0];
    return r ? fromRow(r) : null;
  }

  put(row: BankOpRow): void {
    this.#db.sql.exec(
      `INSERT INTO bank_op (op_id, account_id, state, op, effect, result, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (op_id) DO UPDATE SET account_id = excluded.account_id,
         state = excluded.state, op = excluded.op, effect = excluded.effect,
         result = excluded.result`,
      row.opId,
      row.accountId,
      row.state,
      JSON.stringify(row.op),
      row.effect === null ? null : JSON.stringify(row.effect),
      row.result === null ? null : JSON.stringify(row.result),
      row.at,
    );
  }

  pending(): BankOpRow[] {
    return this.#db.sql
      .exec<Row>("SELECT * FROM bank_op WHERE state != 'done' ORDER BY at, op_id")
      .toArray()
      .map(fromRow)
      .filter((r): r is BankOpRow => r !== null);
  }

  prune(before: number): number {
    const rows = this.#db.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM bank_op WHERE state = 'done' AND at < ?",
        before,
      )
      .toArray();
    const n = rows[0]?.n ?? 0;
    if (n > 0) this.#db.sql.exec("DELETE FROM bank_op WHERE state = 'done' AND at < ?", before);
    return n;
  }

  kvGet(key: string): string | null {
    const r = this.#db.sql
      .exec<{ value: string }>("SELECT value FROM platform_kv WHERE key = ?", key)
      .toArray()[0];
    return r ? r.value : null;
  }

  kvSet(key: string, value: string): void {
    this.#db.sql.exec(
      `INSERT INTO platform_kv (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }
}
