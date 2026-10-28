/**
 * IdentityDO logic (wave-B.md §3.2), over a SqlStore so tests run it on
 * node:sqlite. One instance = one login (`identityKey(provider, subject)`):
 * who owns it, its password hash (email logins) and the failed-attempt
 * lockout. The DO adapter is do/identity.ts.
 *
 * Tables are created lazily on the first claim, so probing an unknown login
 * (login with a wrong email) never writes storage.
 */
import type { IdentityApi, IdentityRecord, PasswordCheck, SqlStore } from "../contracts.ts";
import { hashPassword, needsRehash, PBKDF2_ITERATIONS, verifyPassword } from "./password.ts";

/** 5 failures lock the login for 1 min; each further failure doubles it, up to 1 h. */
export const LOCKOUT = { freeFailures: 5, baseMs: 60_000, maxMs: 60 * 60_000 } as const;

/** Lock duration after `failures` consecutive failures (0 below the threshold). */
export function lockoutMs(failures: number): number {
  if (failures < LOCKOUT.freeFailures) return 0;
  const doublings = Math.min(failures - LOCKOUT.freeFailures, 30);
  return Math.min(LOCKOUT.baseMs * 2 ** doublings, LOCKOUT.maxMs);
}

type ClaimInput = Parameters<IdentityApi["claim"]>[0];

interface Row {
  provider: string;
  subject: string;
  account_id: string;
  email: string | null;
  password_hash: string | null;
  created_at: number;
  failures: number;
  locked_until: number;
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
  }

  #row(): Row | null {
    if (!this.#exists()) return null;
    const rows = this.#store.sql.exec("SELECT * FROM identity WHERE id = 1").toArray();
    return (rows[0] as unknown as Row | undefined) ?? null;
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

  /** Verifies the password with lockout. Checks run one at a time. */
  checkPassword(password: string): Promise<PasswordCheck> {
    const run = this.#chain.then(() => this.#check(password));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #check(password: string): Promise<PasswordCheck> {
    const before = this.#row();
    if (!before || before.password_hash === null) return { ok: false, reason: "no_identity" };
    const now = this.#now();
    if (before.locked_until > now) {
      return { ok: false, reason: "locked", retryAfterMs: before.locked_until - now };
    }
    const ok = await verifyPassword(password, before.password_hash);
    const at = this.#now();
    if (ok) {
      let rehash: string | null = null;
      if (needsRehash(before.password_hash, this.#rehashIterations)) {
        rehash = await hashPassword(password, this.#rehashIterations);
      }
      this.#store.sql.exec(
        "UPDATE identity SET failures = 0, locked_until = 0, password_hash = COALESCE(?, password_hash) WHERE id = 1",
        rehash,
      );
      return { ok: true, accountId: before.account_id };
    }
    const failures = before.failures + 1;
    const lock = lockoutMs(failures);
    this.#store.sql.exec(
      "UPDATE identity SET failures = ?, locked_until = ? WHERE id = 1",
      failures,
      lock > 0 ? at + lock : 0,
    );
    return lock > 0
      ? { ok: false, reason: "locked", retryAfterMs: lock }
      : { ok: false, reason: "bad_password" };
  }

  /** Test/admin view of the lockout counters. */
  lockState(): { failures: number; lockedUntil: number } | null {
    const r = this.#row();
    return r ? { failures: r.failures, lockedUntil: r.locked_until } : null;
  }
}
