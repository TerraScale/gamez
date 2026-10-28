/**
 * ConfigDO storage logic (wave-C.md §9.2). OWNER: T-admin. Pure over a
 * SqlStore so tests run it on node:sqlite (tests/support/fake-sql.ts).
 *
 * Tables: config_flag (current value per flag), config_flag_audit (every
 * write: flag, value, by, at), config_dev_admin (accounts granted dev admin).
 * A flag with no row is on (DEFAULT_FLAGS).
 */
import { currentSeason } from "@gamez/economy";
import { FEATURE_FLAGS, type ConfigResponse, type FeatureFlag } from "@gamez/protocol";
import { DEFAULT_FLAGS } from "../config/flags.ts";
import type { SqlStore } from "../contracts.ts";

export const AUDIT_KEEP = 1000;

export function isFeatureFlag(name: string): name is FeatureFlag {
  return (FEATURE_FLAGS as readonly string[]).includes(name);
}

export class FlagsStore {
  readonly #store: SqlStore;
  readonly #now: () => number;

  constructor(store: SqlStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
    this.migrate();
  }

  /** Idempotent schema creation. */
  migrate(): void {
    const sql = this.#store.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS config_flag (
        flag TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL
      )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS config_flag_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flag TEXT NOT NULL,
        value INTEGER NOT NULL,
        by TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS config_dev_admin (
        account_id TEXT PRIMARY KEY,
        granted_at INTEGER NOT NULL
      )`,
    );
  }

  /** Every flag: the stored value, or DEFAULT_FLAGS when none was ever written. */
  flags(): Record<FeatureFlag, boolean> {
    const out: Record<FeatureFlag, boolean> = { ...DEFAULT_FLAGS };
    const rows = this.#store.sql.exec("SELECT flag, enabled FROM config_flag").toArray() as {
      flag: string;
      enabled: number;
    }[];
    for (const row of rows) {
      if (isFeatureFlag(row.flag)) out[row.flag] = row.enabled !== 0;
    }
    return out;
  }

  /**
   * Writes the known boolean entries of `patch` and audits each one. Unknown
   * flags and non-boolean values are ignored (the route rejects them first).
   * Returns the flags after the write.
   */
  setFlags(patch: Partial<Record<FeatureFlag, boolean>>, by: string): Record<FeatureFlag, boolean> {
    const at = this.#now();
    this.#store.transactionSync(() => {
      for (const [flag, value] of Object.entries(patch)) {
        if (!isFeatureFlag(flag) || typeof value !== "boolean") continue;
        this.#store.sql.exec(
          `INSERT INTO config_flag (flag, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(flag) DO UPDATE SET enabled = excluded.enabled,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          flag,
          value ? 1 : 0,
          at,
          by,
        );
        this.#store.sql.exec(
          "INSERT INTO config_flag_audit (flag, value, by, at) VALUES (?, ?, ?, ?)",
          flag,
          value ? 1 : 0,
          by,
          at,
        );
      }
      this.#store.sql.exec(
        "DELETE FROM config_flag_audit WHERE id <= (SELECT MAX(id) FROM config_flag_audit) - ?",
        AUDIT_KEEP,
      );
    });
    return this.flags();
  }

  /** The audit trail, newest first (for tests and future admin views). */
  audit(limit = 100): { flag: string; value: boolean; by: string; at: number }[] {
    const rows = this.#store.sql
      .exec("SELECT flag, value, by, at FROM config_flag_audit ORDER BY id DESC LIMIT ?", limit)
      .toArray() as { flag: string; value: number; by: string; at: number }[];
    return rows.map((r) => ({ flag: r.flag, value: r.value !== 0, by: r.by, at: r.at }));
  }

  grantDevAdmin(accountId: string): void {
    this.#store.sql.exec(
      `INSERT INTO config_dev_admin (account_id, granted_at) VALUES (?, ?)
       ON CONFLICT(account_id) DO NOTHING`,
      accountId,
      this.#now(),
    );
  }

  isDevAdmin(accountId: string): boolean {
    return (
      this.#store.sql
        .exec("SELECT 1 AS ok FROM config_dev_admin WHERE account_id = ?", accountId)
        .toArray().length > 0
    );
  }

  /** The public config document (flags, current season, server time). */
  config(): ConfigResponse {
    const now = this.#now();
    return { flags: this.flags(), seasonId: currentSeason(now).id, serverTime: now };
  }
}
