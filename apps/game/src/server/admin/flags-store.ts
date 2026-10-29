/**
 * ConfigDO storage logic (wave-C.md §9.2, admin-dashboard.md §8). OWNER: T-admin
 * (flags) and T-api-tech (tunables). Pure over a SqlStore so tests run it on
 * node:sqlite (tests/support/fake-sql.ts).
 *
 * Tables: config_flag (current value per flag), config_flag_audit (every
 * write: flag, value, by, at), config_dev_admin (accounts granted dev admin),
 * config_tunable (current value per numeric tunable) and config_tunable_audit
 * (every change of an effective tunable value). A flag or tunable with no row
 * is at its default (DEFAULT_FLAGS, TUNABLES[].default).
 */
import { currentSeason } from "@gamez/economy";
import {
  FEATURE_FLAGS,
  TUNABLES,
  type ConfigResponse,
  type FeatureFlag,
  type TunableSpec,
} from "@gamez/protocol";
import { DEFAULT_FLAGS } from "../config/flags.ts";
import type { SqlStore } from "../contracts.ts";

export const AUDIT_KEEP = 1000;

export function isFeatureFlag(name: string): name is FeatureFlag {
  return (FEATURE_FLAGS as readonly string[]).includes(name);
}

/** The spec of a tunable key, or undefined for an unknown key. */
export function tunableSpec(key: string): TunableSpec | undefined {
  return TUNABLES.find((t) => t.key === key);
}

/**
 * A tunable value as it is stored and served: clamped to [min, max] and
 * rounded to the spec's step (counted from min). Non-finite input is the
 * caller's job to reject.
 */
export function normalizeTunable(spec: TunableSpec, raw: number): number {
  const clamp = (v: number) => Math.min(spec.max, Math.max(spec.min, v));
  const steps = Math.round((clamp(raw) - spec.min) / spec.step);
  // toFixed strips float noise (0.1 * 3 style) before the final clamp.
  return clamp(Number((spec.min + steps * spec.step).toFixed(9)));
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
    sql.exec(
      `CREATE TABLE IF NOT EXISTS config_tunable (
        key TEXT PRIMARY KEY,
        value REAL NOT NULL,
        by TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS config_tunable_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value REAL NOT NULL,
        by TEXT NOT NULL,
        at INTEGER NOT NULL
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

  /**
   * Every tunable (TUNABLES): the stored value (normalised), or the spec
   * default when none was written. Stored rows for unknown keys are ignored.
   */
  tunables(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const spec of TUNABLES) out[spec.key] = spec.default;
    const rows = this.#store.sql.exec("SELECT key, value FROM config_tunable").toArray() as {
      key: string;
      value: number;
    }[];
    for (const row of rows) {
      const spec = tunableSpec(row.key);
      if (spec && typeof row.value === "number" && Number.isFinite(row.value)) {
        out[spec.key] = normalizeTunable(spec, row.value);
      }
    }
    return out;
  }

  /**
   * Writes the known, finite entries of `patch`, clamped and rounded to the
   * spec. Unknown keys and non-finite values are ignored. Each write upserts
   * the row; a change of the effective value (old !== new) is audited.
   * Returns every tunable after the write.
   */
  setTunables(patch: Record<string, number>, by: string): Record<string, number> {
    const at = this.#now();
    const before = this.tunables();
    this.#store.transactionSync(() => {
      for (const [key, raw] of Object.entries(patch)) {
        const spec = tunableSpec(key);
        if (!spec || typeof raw !== "number" || !Number.isFinite(raw)) continue;
        const value = normalizeTunable(spec, raw);
        this.#store.sql.exec(
          `INSERT INTO config_tunable (key, value, by, at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             by = excluded.by, at = excluded.at`,
          key,
          value,
          by,
          at,
        );
        if (value !== before[key]) {
          this.#store.sql.exec(
            "INSERT INTO config_tunable_audit (key, value, by, at) VALUES (?, ?, ?, ?)",
            key,
            value,
            by,
            at,
          );
        }
      }
      this.#store.sql.exec(
        "DELETE FROM config_tunable_audit WHERE id <= (SELECT MAX(id) FROM config_tunable_audit) - ?",
        AUDIT_KEEP,
      );
    });
    return this.tunables();
  }

  /** The tunable audit trail, newest first. */
  tunableAudit(limit = 100): { key: string; value: number; by: string; at: number }[] {
    const rows = this.#store.sql
      .exec("SELECT key, value, by, at FROM config_tunable_audit ORDER BY id DESC LIMIT ?", limit)
      .toArray() as { key: string; value: number; by: string; at: number }[];
    return rows.map((r) => ({ key: r.key, value: r.value, by: r.by, at: r.at }));
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

  /** The public config document (flags, tunables, current season, server time). */
  config(): ConfigResponse {
    const now = this.#now();
    return {
      flags: this.flags(),
      seasonId: currentSeason(now).id,
      serverTime: now,
      tunables: this.tunables(),
    };
  }
}
