/**
 * Tiny SQL helpers shared by the shop logic classes (SqlStore, wave-C.md §1.1 rule 8).
 * Column names in `patchRow` always come from our own code, never from a request.
 */
import type { SqlStore } from "../contracts.ts";

export type SqlValue = string | number | null;

/** Runs a read and returns every row. */
export function queryRows<T extends Record<string, SqlValue>>(
  store: SqlStore,
  query: string,
  ...bindings: SqlValue[]
): T[] {
  return store.sql.exec<T>(query, ...bindings).toArray();
}

/** Runs a write (no rows wanted). */
export function execSql(store: SqlStore, query: string, ...bindings: SqlValue[]): void {
  store.sql.exec(query, ...bindings);
}

/** UPDATE <table> SET k = ?, ... WHERE <keyCol> = ?  (no-op for an empty patch). */
export function patchRow(
  store: SqlStore,
  table: string,
  keyCol: string,
  keyVal: SqlValue,
  patch: Record<string, SqlValue>,
): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] ?? null);
  store.sql.exec(`UPDATE ${table} SET ${sets} WHERE ${keyCol} = ?`, ...values, keyVal);
}
