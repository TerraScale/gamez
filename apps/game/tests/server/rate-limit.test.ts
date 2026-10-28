import { describe, expect, it } from "vite-plus/test";
import { RATE_NOTICE_MS, SocketLimiter, TokenBucket } from "../../src/server/rate-limit.ts";

describe("TokenBucket", () => {
  it("allows a burst, then refuses until tokens refill", () => {
    const b = new TokenBucket({ burst: 3, perSecond: 1 }, 0);
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false]);
    expect(b.dropped).toBe(1);
    expect(b.take(999)).toBe(false);
    expect(b.take(1000)).toBe(true);
    expect(b.take(1000)).toBe(false);
  });

  it("refills at perSecond and never above burst", () => {
    const b = new TokenBucket({ burst: 5, perSecond: 5 }, 0);
    for (let i = 0; i < 5; i++) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    // 200 ms at 5/s refills exactly one token.
    expect(b.take(200)).toBe(true);
    expect(b.take(200)).toBe(false);
    // A long idle period refills to burst, not beyond it.
    for (let i = 0; i < 5; i++) expect(b.take(60_000)).toBe(true);
    expect(b.take(60_000)).toBe(false);
    expect(b.dropped).toBe(3);
  });

  it("tolerates a clock that goes backwards without minting tokens", () => {
    const b = new TokenBucket({ burst: 1, perSecond: 1 }, 10_000);
    expect(b.take(10_000)).toBe(true);
    expect(b.take(5_000)).toBe(false);
    expect(b.take(5_500)).toBe(false);
    expect(b.take(6_000)).toBe(true);
  });
});

describe("SocketLimiter", () => {
  it("limits moveTo and ping independently, with the spec'd burst sizes", () => {
    const l = new SocketLimiter(0);
    const moves = Array.from({ length: 6 }, () => l.admit("moveTo", 0));
    expect(moves).toEqual([true, true, true, true, true, false]);
    const pings = Array.from({ length: 4 }, () => l.admit("ping", 0));
    expect(pings).toEqual([true, true, true, false]);
    expect(l.dropped).toBe(2);
  });

  it("refills moveTo at 5 per second and ping at 1 per second", () => {
    const l = new SocketLimiter(0);
    for (let i = 0; i < 3; i++) l.admit("ping", 0);
    expect(l.admit("ping", 999)).toBe(false);
    expect(l.admit("ping", 1000)).toBe(true);
    for (let i = 0; i < 5; i++) l.admit("moveTo", 0);
    expect(l.admit("moveTo", 199)).toBe(false);
    expect(l.admit("moveTo", 200)).toBe(true);
  });

  it("issues at most one notice per second", () => {
    const l = new SocketLimiter(0);
    expect(l.noticeDue(0)).toBe(true);
    expect(l.noticeDue(RATE_NOTICE_MS - 1)).toBe(false);
    expect(l.noticeDue(RATE_NOTICE_MS)).toBe(true);
    expect(l.noticeDue(RATE_NOTICE_MS + 1)).toBe(false);
  });
});
