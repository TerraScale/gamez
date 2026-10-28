/**
 * IdentityDO logic (wave-B.md §3.2), over a SqlStore so tests run it on
 * node:sqlite. One instance = one login (`identityKey(provider, subject)`):
 * who owns it, its password hash (email logins) and the failed-attempt
 * lockout. The DO adapter is do/identity.ts.
 *
 * The lockout is per (login, client) (ADR 0007 R5): the `attempt` table holds
 * one row per client, keyed by a SHA-256 prefix of the client identity, so a
 * failing client can never lock out another one and raw IPs are never stored.
 *
 * Tables are created lazily on the first claim, so probing an unknown login
 * (login with a wrong email) never writes storage.
 */
import type { IdentityApi, IdentityRecord, PasswordCheck, SqlStore } from "../contracts.ts";
import { hashPassword, needsRehash, PBKDF2_ITERATIONS, verifyPassword } from "./password.ts";

/** 5 failures lock the login for 1 min; each further failure doubles it, up to 1 h. */
export const LOCKOUT = { freeFailures: 5, baseMs: 60_000, maxMs: 60 * 60_000 } as const;

/** Most client rows kept per login; the least recently failing client is evicted first. */
export const ATTEMPT_CAP = 1000;

/** Lock duration after `failures` consecutive failures (0 below the threshold). */
export function lockoutMs(failures: number): number {
  if (failures < LOCKOUT.freeFailures) return 0;
  const doublings = Math.min(failures - LOCKOUT.freeFailures, 30);
  return Math.min(LOCKOUT.baseMs * 2 ** doublings, LOCKOUT.maxMs);
}

/** Attempt-table key: the first 16 hex chars of SHA-256(client). Raw IPs are never stored. */
export async function clientKey(client: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(client));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

type ClaimInput = Parameters<IdentityApi["claim"]>[0];

interface Row {
  provider: string;
  subject: string;
  account_id: string;
  email: string | null;
  password_hash: string | null;
  created_at: number;
}

interface AttemptRow {
  failures: number;
  locked_until: number;
  last_at: number;
}

export interface IdentityStoreOptions {
  now?: () => number;
  /** Iterations for a transparent rehash of an old, weaker hash after a successful login. */
  rehashIterations?: number;
}

export class IdentityStore {
  readonly #store: SqlStore;
  readonly #now: () => number;
  readonly #rehashIterations: number;
  #ready = false;
  #attemptReady = false;
  /** Serialises password checks: WebCrypto awaits let concurrent requests interleave in a DO. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(store: SqlStore, opts: IdentityStoreOptions = {}) {
    this.#store = store;
    this.#now = opts.now ?? Date.now;
    this.#rehashIterations = opts.rehashIterations ?? PBKDF2_ITERATIONS;
  }

  #exists(): boolean {
    if (this.#ready) return true;
    const found = this.#store.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'identity'")
      .toArray();
    this.#ready = found.length > 0;
    return this.#ready;
  }

  #createAttemptTable(): void {
    this.#store.sql.exec(
      `CREATE TABLE IF NOT EXISTS attempt (
        client_hash TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        locked_until INTEGER NOT NULL,
        last_at INTEGER NOT NULL
      )`,
    );
    this.#attemptReady = true;
  }

  /** Creates the attempt table for logins claimed before it existed (called only on a real login). */
  #ensureAttempt(): void {
    if (!this.#attemptReady) this.#createAttemptTable();
  }

  #hasAttempt(): boolean {
    if (this.#attemptReady) return true;
    const found = this.#store.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attempt'")
      .toArray();
    this.#attemptReady = found.length > 0;
    return this.#attemptReady;
  }

  #createTables(): void {
    this.#store.sql.exec(
      `CREATE TABLE IF NOT EXISTS identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        account_id TEXT NOT NULL,
        email TEXT,
        password_hash TEXT,
        created_at INTEGER NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0
      )`,
    );
    this.#ready = true;
    this.#createAttemptTable();
  }

  #row(): Row | null {
    if (!this.#exists()) return null;
    const rows = this.#store.sql.exec("SELECT * FROM identity WHERE id = 1").toArray();
    return (rows[0] as unknown as Row | undefined) ?? null;
  }

  /** One client's counters; `null` when that client has no row. */
  #attempt(key: string): AttemptRow | null {
    if (!this.#hasAttempt()) return null;
    const rows = this.#store.sql
      .exec("SELECT failures, locked_until, last_at FROM attempt WHERE client_hash = ?", key)
      .toArray();
    return (rows[0] as unknown as AttemptRow | undefined) ?? null;
  }

  /** Writes one client's counters, evicting the oldest client first when a new row would exceed the cap. */
  #recordAttempt(
    key: string,
    known: boolean,
    failures: number,
    lockedUntil: number,
    at: number,
  ): void {
    if (!known) {
      const count = Number(
        (this.#store.sql.exec("SELECT COUNT(*) AS n FROM attempt").toArray()[0] as { n: number }).n,
      );
      if (count >= ATTEMPT_CAP) {
        this.#store.sql.exec(
          "DELETE FROM attempt WHERE client_hash IN (SELECT client_hash FROM attempt ORDER BY last_at ASC, client_hash ASC LIMIT ?)",
          count - ATTEMPT_CAP + 1,
        );
      }
    }
    this.#store.sql.exec(
      `INSERT INTO attempt (client_hash, failures, locked_until, last_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (client_hash) DO UPDATE SET
         failures = excluded.failures, locked_until = excluded.locked_until, last_at = excluded.last_at`,
      key,
      failures,
      lockedUntil,
      at,
    );
  }

  static #record(r: Row): IdentityRecord {
    return {
      provider: r.provider as IdentityRecord["provider"],
      subject: r.subject,
      accountId: r.account_id,
      email: r.email,
      createdAt: r.created_at,
    };
  }

  get(): IdentityRecord | null {
    const r = this.#row();
    return r ? IdentityStore.#record(r) : null;
  }

  /** First writer wins; returns the owner either way. */
  claim(input: ClaimInput): { record: IdentityRecord; created: boolean } {
    if (typeof input.accountId !== "string" || input.accountId.length === 0) {
      throw new Error("claim: accountId required");
    }
    if (input.provider !== "email" && input.passwordHash !== null) {
      throw new Error("claim: only email logins carry a password");
    }
    return this.#store.transactionSync(() => {
      this.#createTables();
      const existing = this.#row();
      if (existing) return { record: IdentityStore.#record(existing), created: false };
      this.#store.sql.exec(
        `INSERT INTO identity (id, provider, subject, account_id, email, password_hash, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
        input.provider,
        input.subject,
        input.accountId,
        input.email,
        input.passwordHash,
        this.#now(),
      );
      return { record: IdentityStore.#record(this.#row()!), created: true };
    });
  }

  /**
   * Verifies the password with lockout, per (login, client). `client` is the
   * caller's network identity; absent means "unknown". Checks run one at a time.
   */
  checkPassword(password: string, client = "unknown"): Promise<PasswordCheck> {
    const run = this.#chain.then(() => this.#check(password, client));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #check(password: string, client: string): Promise<PasswordCheck> {
    const before = this.#row();
    if (!before || before.password_hash === null) return { ok: false, reason: "no_identity" };
    this.#ensureAttempt();
    const key = await clientKey(client);
    const attempt = this.#attempt(key);
    const now = this.#now();
    if (attempt && attempt.locked_until > now) {
      return { ok: false, reason: "locked", retryAfterMs: attempt.locked_until - now };
    }
    const ok = await verifyPassword(password, before.password_hash);
    const at = this.#now();
    if (ok) {
      this.#store.sql.exec("DELETE FROM attempt WHERE client_hash = ?", key);
      let rehash: string | null = null;
      if (needsRehash(before.password_hash, this.#rehashIterations)) {
        rehash = await hashPassword(password, this.#rehashIterations);
      }
      this.#store.sql.exec(
        "UPDATE identity SET password_hash = COALESCE(?, password_hash) WHERE id = 1",
        rehash,
      );
      return { ok: true, accountId: before.account_id };
    }
    const failures = (attempt?.failures ?? 0) + 1;
    const lock = lockoutMs(failures);
    this.#recordAttempt(key, attempt !== null, failures, lock > 0 ? at + lock : 0, at);
    return lock > 0
      ? { ok: false, reason: "locked", retryAfterMs: lock }
      : { ok: false, reason: "bad_password" };
  }

  /**
   * Test/admin view of the lockout counters. With a client: that client's row
   * (zeros when it has none). Without: the worst case over all clients.
   */
  async lockState(client?: string): Promise<{ failures: number; lockedUntil: number } | null> {
    if (!this.#row()) return null;
    if (!this.#hasAttempt()) return { failures: 0, lockedUntil: 0 };
    if (client !== undefined) {
      const attempt = this.#attempt(await clientKey(client));
      return attempt
        ? { failures: attempt.failures, lockedUntil: attempt.locked_until }
        : { failures: 0, lockedUntil: 0 };
    }
    const r = this.#store.sql
      .exec("SELECT MAX(failures) AS failures, MAX(locked_until) AS locked_until FROM attempt")
      .toArray()[0] as { failures: number | null; locked_until: number | null } | undefined;
    return { failures: Number(r?.failures ?? 0), lockedUntil: Number(r?.locked_until ?? 0) };
  }
}
