import { describe, expect, it } from "vite-plus/test";
import {
  GUEST_TOKEN_MAX_AGE_MS,
  newGuest,
  signToken,
  verifyToken,
  type Identity,
} from "../../src/server/auth.ts";

const SECRET = "test-secret";
const identity: Identity = { accountId: "acc-1", name: "Guest-00AB", issuedAt: 1_700_000_000_000 };

function flipChar(s: string, i: number): string {
  const c = s[i] === "A" ? "B" : "A";
  return s.slice(0, i) + c + s.slice(i + 1);
}

describe("guest tokens", () => {
  it("round-trips a valid token", async () => {
    const token = await signToken(SECRET, identity);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyToken(SECRET, token)).toEqual(identity);
  });

  it("rejects a tampered payload", async () => {
    const token = await signToken(SECRET, identity);
    const [, mac] = token.split(".");
    const forged = btoa(JSON.stringify({ ...identity, accountId: "someone-else" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(await verifyToken(SECRET, `${forged}.${mac}`)).toBeNull();
    expect(await verifyToken(SECRET, flipChar(token, 3))).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const token = await signToken(SECRET, identity);
    expect(await verifyToken(SECRET, flipChar(token, token.length - 3))).toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signToken("other-secret", identity);
    expect(await verifyToken(SECRET, token)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    for (const bad of ["", ".", "abc", "a.b.c", "!!!.???", `${"x".repeat(10)}.`]) {
      expect(await verifyToken(SECRET, bad)).toBeNull();
    }
  });

  it("rejects tokens older than maxAge", async () => {
    const token = await signToken(SECRET, { ...identity, issuedAt: Date.now() - 10_000 });
    expect(await verifyToken(SECRET, token, 5_000)).toBeNull();
    expect(await verifyToken(SECRET, token, 60_000)).not.toBeNull();
  });

  it("expires guest tokens 30 days after issue", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    expect(GUEST_TOKEN_MAX_AGE_MS).toBe(30 * DAY);
    const young = await signToken(SECRET, { ...identity, issuedAt: Date.now() - 29 * DAY });
    const old = await signToken(SECRET, { ...identity, issuedAt: Date.now() - 31 * DAY });
    expect(await verifyToken(SECRET, young, GUEST_TOKEN_MAX_AGE_MS)).not.toBeNull();
    expect(await verifyToken(SECRET, old, GUEST_TOKEN_MAX_AGE_MS)).toBeNull();
  });

  it("creates guests with unique ids and Guest-XXXX names", () => {
    const a = newGuest();
    const b = newGuest();
    expect(a.accountId).not.toBe(b.accountId);
    expect(a.name).toMatch(/^Guest-[0-9A-F]{4}$/);
  });
});
