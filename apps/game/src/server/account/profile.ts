/**
 * AccountDO: profile, identities and sessions (wave-B.md §3.3). OWNER: T-auth.
 * The method set is fixed by AccountApi (contracts.ts); do/account.ts
 * adapts it. Tables are created in init() (idempotent). Every profile change
 * appends an "account_summary" outbox record (AccountSummaryPayload) in the
 * same transaction; the DO schedules the flush.
 */
import type { AccountKind, AuthProvider } from "@gamez/protocol";
import type { Outbox } from "@gamez/sync";
import { TOKEN_MAX_AGE_MS, randomId } from "../auth.ts";
import { normaliseDisplayName, suggestDisplayName, validDisplayName } from "../auth/names.ts";
import type { AccountProfile, AccountSummaryPayload, SessionInfo, SqlStore } from "../contracts.ts";

/** lastSeenAt is written at most this often per session. */
export const SESSION_TOUCH_MS = 60_000;
/** Sessions older than this are dead (the token expired with them). */
export const SESSION_MAX_AGE_MS = TOKEN_MAX_AGE_MS;
/** Oldest sessions beyond this count are closed when a new one opens. */
export const MAX_SESSIONS = 20;
const USER_AGENT_MAX = 200;

interface ProfileRow {
  kind: string;
  display_name: string;
  created_at: number;
}

interface SessionRow {
  sid: string;
  created_at: number;
  last_seen_at: number;
  user_agent: string;
}

export class AccountProfileStore {
  constructor(
    readonly store: SqlStore,
    readonly accountId: string,
    readonly outbox: Outbox,
    readonly now: () => number = Date.now,
  ) {}

  /** Creates the tables (called once from the DO constructor). */
  init(): void {
    const sql = this.store.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS account_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS account_identity (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        email TEXT,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (provider, subject)
      )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS account_session (
        sid TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        user_agent TEXT NOT NULL
      )`,
    );
  }

  #profileRow(): ProfileRow | null {
    const rows = this.store.sql
      .exec("SELECT kind, display_name, created_at FROM account_profile WHERE id = 1")
      .toArray();
    return (rows[0] as unknown as ProfileRow | undefined) ?? null;
  }

  #summary(): void {
    const p = this.#profileRow();
    if (!p) return;
    const payload: AccountSummaryPayload = {
      accountId: this.accountId,
      displayName: p.display_name,
      kind: p.kind as AccountKind,
      createdAt: p.created_at,
    };
    this.outbox.append("account_summary", this.accountId, "upsert", payload);
  }

  #require(): AccountProfile {
    const p = this.profile();
    if (!p) throw new Error("no_profile: call ensure() first");
    return p;
  }

  /** Creates the profile on first call (any account, old guests too); otherwise returns it unchanged. */
  ensure(input: { kind: AccountKind; displayName: string }): AccountProfile {
    const existing = this.profile();
    if (existing) return existing;
    const kind: AccountKind = input.kind === "registered" ? "registered" : "guest";
    const name =
      validDisplayName(input.displayName, kind) ??
      (kind === "guest"
        ? (validDisplayName(input.displayName, "registered") ?? "Guest-0000")
        : suggestDisplayName(input.displayName));
    this.store.transactionSync(() => {
      this.store.sql.exec(
        `INSERT OR IGNORE INTO account_profile (id, kind, display_name, created_at)
         VALUES (1, ?, ?, ?)`,
        kind,
        name,
        this.now(),
      );
      this.#summary();
    });
    return this.#require();
  }

  profile(): AccountProfile | null {
    const p = this.#profileRow();
    if (!p) return null;
    const identities = this.store.sql
      .exec(
        "SELECT provider, subject, email FROM account_identity ORDER BY added_at, provider, subject",
      )
      .toArray() as unknown as { provider: AuthProvider; subject: string; email: string | null }[];
    return {
      accountId: this.accountId,
      kind: p.kind as AccountKind,
      displayName: p.display_name,
      createdAt: p.created_at,
      identities: identities.map((i) => ({
        provider: i.provider,
        subject: i.subject,
        email: i.email,
      })),
    };
  }

  /** Throws "bad_name" when the name breaks the rules for the account's kind. */
  setDisplayName(name: string): AccountProfile {
    const current = this.#require();
    const valid = validDisplayName(name, current.kind);
    if (!valid) throw new Error("bad_name: invalid display name");
    if (valid === current.displayName) return current;
    this.store.transactionSync(() => {
      this.store.sql.exec("UPDATE account_profile SET display_name = ? WHERE id = 1", valid);
      this.#summary();
    });
    return this.#require();
  }

  /** Adds a login (idempotent) and marks the account registered. */
  addIdentity(identity: {
    provider: AuthProvider;
    subject: string;
    email: string | null;
  }): AccountProfile {
    const current = this.#require();
    const known = current.identities.some(
      (i) => i.provider === identity.provider && i.subject === identity.subject,
    );
    if (known && current.kind === "registered") return current;
    this.store.transactionSync(() => {
      this.store.sql.exec(
        `INSERT OR IGNORE INTO account_identity (provider, subject, email, added_at)
         VALUES (?, ?, ?, ?)`,
        identity.provider,
        identity.subject,
        identity.email,
        this.now(),
      );
      // A guest name is not allowed on a registered account: keep the profile valid.
      const name = validDisplayName(current.displayName, "registered")
        ? current.displayName
        : suggestDisplayName(identity.email?.split("@")[0] ?? null);
      this.store.sql.exec(
        "UPDATE account_profile SET kind = 'registered', display_name = ? WHERE id = 1",
        normaliseDisplayName(name),
      );
      this.#summary();
    });
    return this.#require();
  }

  openSession(userAgent: string): SessionInfo {
    const now = this.now();
    const info: SessionInfo = {
      sid: randomId(16),
      createdAt: now,
      lastSeenAt: now,
      userAgent: String(userAgent ?? "").slice(0, USER_AGENT_MAX),
    };
    this.store.transactionSync(() => {
      const sql = this.store.sql;
      sql.exec("DELETE FROM account_session WHERE created_at < ?", now - SESSION_MAX_AGE_MS);
      sql.exec(
        `INSERT INTO account_session (sid, created_at, last_seen_at, user_agent)
         VALUES (?, ?, ?, ?)`,
        info.sid,
        info.createdAt,
        info.lastSeenAt,
        info.userAgent,
      );
      sql.exec(
        `DELETE FROM account_session WHERE sid NOT IN (
           SELECT sid FROM account_session ORDER BY last_seen_at DESC, created_at DESC LIMIT ?
         )`,
        MAX_SESSIONS,
      );
    });
    return info;
  }

  /** True when `sid` is open and young enough; touches lastSeenAt at most once a minute. */
  checkSession(sid: string): boolean {
    if (typeof sid !== "string" || sid.length === 0) return false;
    const rows = this.store.sql
      .exec(
        "SELECT sid, created_at, last_seen_at, user_agent FROM account_session WHERE sid = ?",
        sid,
      )
      .toArray() as unknown as SessionRow[];
    const s = rows[0];
    if (!s) return false;
    const now = this.now();
    if (now - s.created_at > SESSION_MAX_AGE_MS) {
      this.store.sql.exec("DELETE FROM account_session WHERE sid = ?", sid);
      return false;
    }
    if (now - s.last_seen_at >= SESSION_TOUCH_MS) {
      this.store.sql.exec("UPDATE account_session SET last_seen_at = ? WHERE sid = ?", now, sid);
    }
    return true;
  }

  closeSession(sid: string): void {
    if (typeof sid !== "string") return;
    this.store.sql.exec("DELETE FROM account_session WHERE sid = ?", sid);
  }

  /** Open sessions, newest first (account settings, tests). */
  sessions(): SessionInfo[] {
    const rows = this.store.sql
      .exec(
        "SELECT sid, created_at, last_seen_at, user_agent FROM account_session ORDER BY last_seen_at DESC, created_at DESC",
      )
      .toArray() as unknown as SessionRow[];
    return rows.map((r) => ({
      sid: r.sid,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      userAgent: r.user_agent,
    }));
  }
}
