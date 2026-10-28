/**
 * ADR 0007 R5: the password lockout is per (login, client). One client's
 * failures must never lock another client out, and the raw client identity
 * (an IP) must never reach storage.
 */
import { describe, expect, it } from "vite-plus/test";
import { hashPassword } from "../../src/server/auth/password.ts";
import { IdentityStore } from "../../src/server/auth/identity-store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";
import { Clock } from "./fakes.ts";

const FAST = 1000;
const RIGHT = "correct-horse-battery-9";
const WRONG = "nope-nope-nope";

async function setup(clock = new Clock()) {
  const sql = fakeSqlStore();
  const store = new IdentityStore(sql, { now: clock.now, rehashIterations: FAST });
  store.claim({
    provider: "email",
    subject: "victim@example.test",
    accountId: "acc-victim",
    email: "victim@example.test",
    passwordHash: await hashPassword(RIGHT, FAST),
  });
  return { sql, store, clock };
}

/** The attempt-table key: first 16 hex chars of SHA-256(client). */
async function clientHash(client: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(client));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function attemptRows(sql: ReturnType<typeof fakeSqlStore>) {
  return sql.fake.db
    .prepare("SELECT client_hash, failures, locked_until, last_at FROM attempt ORDER BY last_at")
    .all() as { client_hash: string; failures: number; locked_until: number; last_at: number }[];
}

describe("per-client lockout (ADR 0007 R5)", () => {
  it("an attacker's lock does not stop a victim client with the right password", async () => {
    const { store } = await setup();
    for (let i = 0; i < 5; i++) {
      await store.checkPassword(WRONG, "A");
    }
    // A is now locked; further guesses from A are refused.
    expect((await store.checkPassword(WRONG, "A")).ok).toBe(false);
    expect(await store.checkPassword(RIGHT, "A")).toEqual({
      ok: false,
      reason: "locked",
      retryAfterMs: 60_000,
    });
    // The victim's client never failed, so it gets straight in.
    expect(await store.checkPassword(RIGHT, "V")).toEqual({ ok: true, accountId: "acc-victim" });
  });

  it("a wrong password from another client is bad_password, not locked", async () => {
    const { store } = await setup();
    for (let i = 0; i < 5; i++) {
      await store.checkPassword(WRONG, "A");
    }
    expect(await store.checkPassword(WRONG, "V")).toEqual({
      ok: false,
      reason: "bad_password",
    });
  });

  it("the attacker stays locked with retryAfterMs and the schedule doubles as before", async () => {
    const { store, clock } = await setup();
    for (let i = 0; i < 5; i++) {
      await store.checkPassword(WRONG, "A");
    }
    expect(await store.checkPassword(WRONG, "A")).toEqual({
      ok: false,
      reason: "locked",
      retryAfterMs: 60_000,
    });
    clock.advance(30_000);
    expect(await store.checkPassword(RIGHT, "A")).toEqual({
      ok: false,
      reason: "locked",
      retryAfterMs: 30_000,
    });
    clock.advance(30_000);
    // Lock over; A's next failure doubles its lock.
    expect(await store.checkPassword(WRONG, "A")).toEqual({
      ok: false,
      reason: "locked",
      retryAfterMs: 120_000,
    });
  });

  it("a success after the lock expires clears only that client's row", async () => {
    const { store, sql, clock } = await setup();
    for (let i = 0; i < 5; i++) {
      await store.checkPassword(WRONG, "A");
    }
    await store.checkPassword(WRONG, "V");
    clock.advance(60_000);

    expect((await store.checkPassword(RIGHT, "A")).ok).toBe(true);

    const rows = attemptRows(sql);
    const hashA = await clientHash("A");
    const hashV = await clientHash("V");
    expect(rows.map((r) => r.client_hash)).toEqual([hashV]);
    expect(rows[0]!.failures).toBe(1);
    expect(await store.lockState("V")).toEqual({ failures: 1, lockedUntil: 0 });
    expect(await store.lockState("A")).toEqual({ failures: 0, lockedUntil: 0 });
    expect(hashA).not.toBe(hashV);
  });

  it("the attempt table is capped at 1000 rows and evicts the oldest last_at", async () => {
    const clock = new Clock();
    const { store, sql } = await setup(clock);
    for (let i = 0; i < 1000; i++) {
      await store.checkPassword(WRONG, `c-${i}`);
      clock.advance(1);
    }
    expect(attemptRows(sql)).toHaveLength(1000);

    // c-0 fails again, so it is no longer the oldest row.
    await store.checkPassword(WRONG, "c-0");
    clock.advance(1);
    // A new client on a full table evicts the oldest (c-1), not c-0.
    await store.checkPassword(WRONG, "c-1000");

    const rows = attemptRows(sql);
    expect(rows).toHaveLength(1000);
    const hashes = new Set(rows.map((r) => r.client_hash));
    expect(hashes.has(await clientHash("c-0"))).toBe(true);
    expect(hashes.has(await clientHash("c-1"))).toBe(false);
    expect(hashes.has(await clientHash("c-1000"))).toBe(true);
  });

  it("the raw client string never appears in storage", async () => {
    const { store, sql } = await setup();
    const raw = "203.0.113.7";
    await store.checkPassword(WRONG, raw);
    await store.checkPassword(RIGHT, raw);
    await store.checkPassword(WRONG, "198.51.100.9");

    const tables = sql.fake.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const dump = tables
      .map((t) => JSON.stringify(sql.fake.db.prepare(`SELECT * FROM ${t.name}`).all()))
      .join("\n");
    expect(dump).not.toContain(raw);
    expect(dump).not.toContain("198.51.100.9");
    for (const r of attemptRows(sql)) {
      expect(r.client_hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("probing an unknown login with a client writes no storage", async () => {
    const sql = fakeSqlStore();
    const store = new IdentityStore(sql);
    expect(await store.checkPassword(WRONG, "203.0.113.7")).toEqual({
      ok: false,
      reason: "no_identity",
    });
    const tables = sql.fake.db.prepare("SELECT name FROM sqlite_master").all();
    expect(tables).toHaveLength(0);
  });

  it("legacy identity.failures / locked_until no longer lock anyone", async () => {
    const clock = new Clock();
    const { store, sql } = await setup(clock);
    // A lock written by the pre-R5 code (row-level columns).
    sql.fake.db
      .prepare("UPDATE identity SET failures = 99, locked_until = ? WHERE id = 1")
      .run(clock.now() + 3_600_000);
    expect((await store.checkPassword(RIGHT, "V")).ok).toBe(true);
  });
});
