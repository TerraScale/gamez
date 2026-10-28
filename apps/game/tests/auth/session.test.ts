import { describe, expect, it } from "vite-plus/test";
import {
  signToken,
  signValue,
  TOKEN_MAX_AGE_MS,
  verifyToken,
  verifyValue,
} from "../../src/server/auth.ts";
import { authenticateRequest, authenticateToken } from "../../src/server/auth/session.ts";
import { fakeWorld, SECRET } from "./fakes.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("tokens v1/v2", () => {
  it("v1 guest tokens (phase 0) still verify and read as guests", async () => {
    const { env } = fakeWorld();
    const v1 = await signToken(SECRET, {
      accountId: "old",
      name: "Guest-0001",
      issuedAt: Date.now(),
    });
    expect(await verifyToken(SECRET, v1)).toEqual({
      accountId: "old",
      name: "Guest-0001",
      issuedAt: expect.any(Number),
    });
    const who = await authenticateToken(env, v1);
    expect(who).toMatchObject({ accountId: "old", kind: "guest", sid: null });
  });

  it("v2 tokens carry kind and sid", async () => {
    const t = await signToken(SECRET, {
      accountId: "a",
      name: "Hero",
      issuedAt: Date.now(),
      kind: "registered",
      sid: "s1",
    });
    expect(await verifyToken(SECRET, t)).toMatchObject({ kind: "registered", sid: "s1" });
  });

  it("refuses inconsistent v2 payloads even when signed", async () => {
    const now = Date.now();
    for (const payload of [
      { accountId: "a", name: "n", issuedAt: now, kind: "registered" },
      { accountId: "a", name: "n", issuedAt: now, kind: "registered", sid: null },
      { accountId: "a", name: "n", issuedAt: now, kind: "admin", sid: null },
      { accountId: "a", name: "n", issuedAt: now, kind: "guest", sid: 5 },
      { accountId: "", name: "n", issuedAt: now },
      { accountId: "a", name: "n", issuedAt: now + 10 * 60_000 },
    ]) {
      expect(await verifyToken(SECRET, await signValue(SECRET, payload))).toBeNull();
    }
  });

  it("expires every kind after 30 days", async () => {
    const { env } = fakeWorld();
    expect(TOKEN_MAX_AGE_MS).toBe(30 * DAY);
    const old = await signToken(SECRET, {
      accountId: "a",
      name: "n",
      issuedAt: Date.now() - 31 * DAY,
      kind: "guest",
      sid: null,
    });
    expect(await authenticateToken(env, old)).toBeNull();
    const young = await signToken(SECRET, {
      accountId: "a",
      name: "n",
      issuedAt: Date.now() - 29 * DAY,
      kind: "guest",
      sid: null,
    });
    expect(await authenticateToken(env, young)).not.toBeNull();
  });

  it("signValue/verifyValue reject tampering and other keys", async () => {
    const s = await signValue("k1", { x: 1 });
    expect(await verifyValue("k1", s)).toEqual({ x: 1 });
    expect(await verifyValue("k2", s)).toBeUndefined();
    expect(await verifyValue("k1", `${s}x`)).toBeUndefined();
    expect(await verifyValue("k1", "nodot")).toBeUndefined();
  });
});

describe("authenticateToken", () => {
  it("checks registered sessions against the AccountDO (revocation)", async () => {
    const { env, accounts } = fakeWorld();
    const acc = env.ACCOUNT.getByName("acc-r") as unknown as {
      ensure(i: unknown): Promise<unknown>;
      addIdentity(i: unknown): Promise<unknown>;
      openSession(ua: string): Promise<{ sid: string }>;
      closeSession(sid: string): Promise<void>;
    };
    await acc.ensure({ kind: "guest", displayName: "Guest-1234" });
    await acc.addIdentity({
      provider: "email",
      subject: "r@example.test",
      email: "r@example.test",
    });
    const { sid } = await acc.openSession("test");
    const token = await signToken(SECRET, {
      accountId: "acc-r",
      name: "r",
      issuedAt: Date.now(),
      kind: "registered",
      sid,
    });
    expect(await authenticateToken(env, token)).toMatchObject({
      accountId: "acc-r",
      kind: "registered",
      sid,
    });
    const forgedSid = await signToken(SECRET, {
      accountId: "acc-r",
      name: "r",
      issuedAt: Date.now(),
      kind: "registered",
      sid: "not-a-session",
    });
    expect(await authenticateToken(env, forgedSid)).toBeNull();
    await acc.closeSession(sid);
    expect(await authenticateToken(env, token)).toBeNull();
    expect(accounts.get("acc-r")!.calls).toBeGreaterThan(0);
  });

  it("refuses a guest token once its account is registered", async () => {
    const { env } = fakeWorld();
    const guest = await signToken(SECRET, {
      accountId: "acc-g",
      name: "Guest-0002",
      issuedAt: Date.now(),
      kind: "guest",
      sid: null,
    });
    expect(await authenticateToken(env, guest)).not.toBeNull();
    const acc = env.ACCOUNT.getByName("acc-g") as unknown as {
      ensure(i: unknown): Promise<unknown>;
      addIdentity(i: unknown): Promise<unknown>;
    };
    await acc.ensure({ kind: "guest", displayName: "Guest-0002" });
    expect(await authenticateToken(env, guest)).not.toBeNull();
    await acc.addIdentity({ provider: "google", subject: "stub-x", email: null });
    expect(await authenticateToken(env, guest)).toBeNull();
  });

  it("fails closed when the AccountDO call throws", async () => {
    const { env } = fakeWorld();
    const broken = {
      ...env,
      ACCOUNT: {
        getByName() {
          return {
            checkSession: () => Promise.reject(new Error("down")),
            profile: () => Promise.reject(new Error("down")),
          };
        },
      },
    } as unknown as typeof env;
    const t = await signToken(SECRET, {
      accountId: "a",
      name: "n",
      issuedAt: Date.now(),
      kind: "registered",
      sid: "s",
    });
    expect(await authenticateToken(broken, t)).toBeNull();
  });

  it("reads the bearer header first, then ?token=", async () => {
    const { env } = fakeWorld();
    const a = await signToken(SECRET, { accountId: "A", name: "n", issuedAt: Date.now() });
    const b = await signToken(SECRET, { accountId: "B", name: "n", issuedAt: Date.now() });
    const both = new Request(`https://g.test/ws?token=${b}`, {
      headers: { authorization: `Bearer ${a}` },
    });
    expect((await authenticateRequest(both, env))?.accountId).toBe("A");
    const query = new Request(`https://g.test/ws?token=${b}`);
    expect((await authenticateRequest(query, env))?.accountId).toBe("B");
    expect(await authenticateRequest(new Request("https://g.test/ws"), env)).toBeNull();
    expect(await authenticateToken(env, "x".repeat(5000))).toBeNull();
  });
});
