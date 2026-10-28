/**
 * AccountDO activity (admin dashboard §6): one "account_activity" outbox row per
 * account per UTC day. The last active day lives in DO SQLite; a touch on a day
 * that is not newer than it writes nothing, a touch on a new day writes the
 * outbox row in the same transaction. Owner: T-projections.
 *
 * Called from AccountDO.touchActivity (RPC, also used by the telemetry route for
 * guests) and from AccountDO.checkSession (a valid session counts as activity).
 */
import type { AccountKind } from "@gamez/protocol";
import type { Outbox } from "@gamez/sync";
import type { AccountActivityPayload, SqlStore } from "../contracts.ts";
import type { AccountProfileStore } from "./profile.ts";

export const DAY_MS = 86_400_000;

/** floor(epoch ms / 86_400_000): the UTC day number used in account_activity.day. */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export class AccountActivityStore {
  constructor(
    readonly store: SqlStore,
    readonly profile: AccountProfileStore,
    readonly outbox: Outbox,
    readonly accountId: string,
  ) {}

  /** Creates the table (called once from the DO constructor). */
  init(): void {
    this.store.sql.exec(
      `CREATE TABLE IF NOT EXISTS account_activity_last (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        day INTEGER NOT NULL
      )`,
    );
  }

  /** The last UTC day this account was touched, or null. */
  lastDay(): number | null {
    const row = this.store.sql
      .exec<{ day: number }>("SELECT day FROM account_activity_last WHERE id = 1")
      .toArray()[0];
    return row?.day ?? null;
  }

  /**
   * Records activity at `now`. Returns true when a new day was written to the
   * outbox. Nothing is written without a profile (the kind is unknown), and a
   * day that is not newer than the last one is ignored.
   */
  touch(now: number): boolean {
    const day = utcDay(now);
    if (!Number.isSafeInteger(day)) return false;
    const kind: AccountKind | null = this.profile.kind();
    if (kind === null) return false;
    const last = this.lastDay();
    if (last !== null && day <= last) return false;
    this.store.transactionSync(() => {
      this.store.sql.exec(
        `INSERT INTO account_activity_last (id, day) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET day = excluded.day`,
        day,
      );
      const payload: AccountActivityPayload = {
        accountId: this.accountId,
        day,
        kind,
        firstAt: now,
      };
      this.outbox.append("account_activity", `${this.accountId}/${day}`, "upsert", payload);
    });
    return true;
  }

  /**
   * Session check with activity: true when the session is valid (same rules as
   * AccountProfileStore.checkSession), and a valid session counts as activity.
   */
  checkSession(sid: string, now: number): boolean {
    const ok = this.profile.checkSession(sid);
    if (ok) this.touch(now);
    return ok;
  }
}
