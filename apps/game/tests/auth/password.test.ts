import { describe, expect, it } from "vite-plus/test";
import {
  constantTimeEqual,
  hashPassword,
  needsRehash,
  parsePasswordHash,
  passwordProblem,
  PBKDF2_ITERATIONS,
  verifyPassword,
} from "../../src/server/auth/password.ts";
import { IdentityStore, LOCKOUT, lockoutMs } from "../../src/server/auth/identity-store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";
import { Clock } from "./fakes.ts";

const FAST = 1000;

describe("PBKDF2 passwords", () => {
  it("defaults to 100k iterations (workerd max) and round-trips", async () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    const stored = await hashPassword("correct-horse-battery-9", FAST);
    expect(stored).toMatch(/^pbkdf2-sha256\$1000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword("correct-horse-battery-9", stored)).toBe(true);
    expect(await verifyPassword("correct-horse-battery-8", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    const a = await hashPassword("same password!", FAST);
    const b = await hashPassword("same password!", FAST);
    expect(a).not.toBe(b);
  });

  it("hashes with the real cost and reports the time", async () => {
    const t = performance.now();
    const stored = await hashPassword("correct-horse-battery-9");
    const ms = performance.now() - t;
    expect(parsePasswordHash(stored)?.iterations).toBe(100_000);
    expect(await verifyPassword("correct-horse-battery-9", stored)).toBe(true);
    console.log(`PBKDF2-SHA256 100k (node): ${ms.toFixed(1)} ms/hash`);
  });

  it("rejects malformed and out-of-range hashes", async () => {
    for (const bad of [
      "",
      "plain",
      "pbkdf2-sha256$0$AAAAAAAAAAAAAAAAAAAAAA$AAAA",
      "pbkdf2-sha256$100001$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "bcrypt$10$xx$yy",
      "pbkdf2-sha256$1000$!!$??",
    ]) {
      expect(parsePasswordHash(bad)).toBeNull();
      expect(await verifyPassword("whatever", bad)).toBe(false);
    }
    await expect(hashPassword("x", 0)).rejects.toThrow(RangeError);
    await expect(hashPassword("x", 100_001)).rejects.toThrow(RangeError);
  });

  it("flags weaker hashes for rehash", async () => {
    const stored = await hashPassword("abcdefghijk", FAST);
    expect(needsRehash(stored)).toBe(true);
    expect(needsRehash(stored, FAST)).toBe(false);
  });

  it("compares bytes in constant time (whole length, any position)", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(constantTimeEqual(a, new Uint8Array([0, 2, 3, 4]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3, 5]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3, 4, 0]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });

  it("enforces the password policy", () => {
    expect(passwordProblem("short")).toBe("weak_password");
    expect(passwordProblem(" ".repeat(12))).toBe("weak_password");
    expect(passwordProblem("x".repeat(129))).toBe("weak_password");
    expect(passwordProblem(12345678901)).toBe("weak_password");
    expect(passwordProblem("ten chars!")).toBeNull();
    expect(passwordProblem("x".repeat(128))).toBeNull();
  });
});

describe("IdentityStore", () => {
  async function claimed(clock = new Clock()) {
    const store = new IdentityStore(fakeSqlStore(), { now: clock.now, rehashIterations: FAST });
    const passwordHash = await hashPassword("correct-horse-battery-9", FAST);
    store.claim({
      provider: "email",
      subject: "a@example.test",
      accountId: "acc-1",
      email: "a@example.test",
      passwordHash,
    });
    return { store, clock };
  }

  it("is empty and read-only until claimed", async () => {
    const sql = fakeSqlStore();
    const store = new IdentityStore(sql);
    expect(store.get()).toBeNull();
    expect(await store.checkPassword("anything at all")).toEqual({
      ok: false,
      reason: "no_identity",
    });
    // Probing an unknown login never creates tables.
    const tables = sql.fake.db.prepare("SELECT name FROM sqlite_master").all();
    expect(tables).toHaveLength(0);
  });

  it("first claim wins; later claims return the owner", () => {
    const store = new IdentityStore(fakeSqlStore());
    const first = store.claim({
      provider: "google",
      subject: "g-1",
      accountId: "acc-1",
      email: null,
      passwordHash: null,
    });
    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({ provider: "google", subject: "g-1", accountId: "acc-1" });
    const second = store.claim({
      provider: "google",
      subject: "g-1",
      accountId: "acc-2",
      email: null,
      passwordHash: null,
    });
    expect(second.created).toBe(false);
    expect(second.record.accountId).toBe("acc-1");
    expect(store.get()?.accountId).toBe("acc-1");
  });

  it("refuses a password on a non-email login", () => {
    const store = new IdentityStore(fakeSqlStore());
    expect(() =>
      store.claim({
        provider: "discord",
        subject: "d-1",
        accountId: "acc-1",
        email: null,
        passwordHash: "x",
      }),
    ).toThrow();
  });

  it("checks the password", async () => {
    const { store } = await claimed();
    expect(await store.checkPassword("correct-horse-battery-9")).toEqual({
      ok: true,
      accountId: "acc-1",
    });
    expect(await store.checkPassword("wrong-password-1")).toEqual({
      ok: false,
      reason: "bad_password",
    });
  });

  it("locks after 5 failures for 1 min, doubling up to 1 h; success resets", async () => {
    expect(lockoutMs(4)).toBe(0);
    expect(lockoutMs(5)).toBe(60_000);
    expect(lockoutMs(6)).toBe(120_000);
    expect(lockoutMs(11)).toBe(3_600_000);
    expect(lockoutMs(99)).toBe(LOCKOUT.maxMs);

    const { store, clock } = await claimed();
    for (let i = 0; i < 4; i++) {
      expect((await store.checkPassword("nope-nope-nope")).ok).toBe(false);
    }
    expect(await store.checkPassword("nope-nope-nope")).toEqual({
      ok: false,
      reason: "locked",
      retryAfterMs: 60_000,
    });
    // While locked even the right password is refused, without hashing.
    clock.advance(30_000);
    expect(await store.checkPassword("correct-horse-battery-9")).toEqual({
      ok: false,
      reason: "locked",
      retryAfterMs: 30_000,
    });
    clock.advance(30_000);
    // Lock over; one more failure doubles it.
    expect(await store.checkPassword("nope-nope-nope")).toEqual({
      ok: false,
      reason: "locked",
      retryAfterMs: 120_000,
    });
    clock.advance(120_000);
    expect((await store.checkPassword("correct-horse-battery-9")).ok).toBe(true);
    expect(store.lockState()).toEqual({ failures: 0, lockedUntil: 0 });
    expect(await store.checkPassword("nope-nope-nope")).toEqual({
      ok: false,
      reason: "bad_password",
    });
  });

  it("serialises concurrent checks so parallel guesses cannot skip the lockout", async () => {
    const { store } = await claimed();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.checkPassword("parallel-guess")),
    );
    expect(results.filter((r) => !r.ok && r.reason === "bad_password")).toHaveLength(4);
    expect(results.filter((r) => !r.ok && r.reason === "locked")).toHaveLength(8);
    expect(store.lockState()?.failures).toBe(5);
  });

  it("rehashes a weaker stored hash after a successful login", async () => {
    const clock = new Clock();
    const store = new IdentityStore(fakeSqlStore(), { now: clock.now, rehashIterations: 2000 });
    store.claim({
      provider: "email",
      subject: "b@example.test",
      accountId: "acc-b",
      email: "b@example.test",
      passwordHash: await hashPassword("correct-horse-battery-9", FAST),
    });
    expect((await store.checkPassword("correct-horse-battery-9")).ok).toBe(true);
    expect((await store.checkPassword("correct-horse-battery-9")).ok).toBe(true);
  });
});
