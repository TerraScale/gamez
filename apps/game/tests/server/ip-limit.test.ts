/**
 * Per-IP limits for guest minting and chat connects (ip-limit.ts, ADR 0012):
 * salted keys (never the raw IP), the dev exemption, fail-open, and the two
 * call sites (POST /api/guest -> 429, /ws/chat -> close 4429 before any DO).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { signToken } from "../../src/server/auth.ts";
import type { Env, RateLimiterLike } from "../../src/server/contracts.ts";
import { IpLimiter } from "../../src/server/auth/limiter.ts";
import {
  checkIpLimit,
  hashedIpKey,
  IP_LIMIT_RETRY_SEC,
  type IpLimitEnv,
} from "../../src/server/ip-limit.ts";
import { authRoutes, setAuthLimiter } from "../../src/server/routes/auth.ts";
import { CLOSE_CHAT_RATE_LIMITED, connectChat } from "../../src/server/routes/chat.ts";
import { ctxFor, fakeWorld, SECRET } from "../auth/fakes.ts";

/** Fixed-window stand-in for the Rate Limiting binding; records every key it sees. */
class FakeLimiter implements RateLimiterLike {
  readonly keys: string[] = [];
  readonly #counts = new Map<string, number>();
  constructor(readonly max: number) {}
  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(key);
    const n = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, n);
    return { success: n <= this.max };
  }
}

function fromIp(ip: string | null, path = "/api/guest"): Request {
  const headers: Record<string, string> = {};
  if (ip !== null) headers["cf-connecting-ip"] = ip;
  return new Request(`https://gamez.example.com${path}`, { method: "POST", headers });
}

describe("hashedIpKey", () => {
  it("is stable, scoped, salted by AUTH_SECRET and never contains the IP", async () => {
    const ip = "203.0.113.7";
    const a = await hashedIpKey("s1", "guest", ip);
    expect(a).toBe(await hashedIpKey("s1", "guest", ip));
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toContain("203");
    expect(await hashedIpKey("s1", "chatConnect", ip)).not.toBe(a);
    expect(await hashedIpKey("s2", "guest", ip)).not.toBe(a);
    expect(await hashedIpKey("s1", "guest", "203.0.113.8")).not.toBe(a);
  });
});

describe("checkIpLimit", () => {
  const prodEnv = (limiter?: RateLimiterLike): IpLimitEnv => ({
    AUTH_SECRET: SECRET,
    GUEST_LIMITER: limiter,
  });

  it("refuses an IP over the limit, keeps other IPs, and passes only hashed keys", async () => {
    const limiter = new FakeLimiter(3);
    const env = prodEnv(limiter);
    for (let i = 0; i < 3; i++)
      expect(await checkIpLimit(fromIp("198.51.100.1"), env, "guest")).toEqual({ ok: true });
    expect(await checkIpLimit(fromIp("198.51.100.1"), env, "guest")).toEqual({
      ok: false,
      retryAfterSec: IP_LIMIT_RETRY_SEC,
    });
    expect(await checkIpLimit(fromIp("198.51.100.2"), env, "guest")).toEqual({ ok: true });
    for (const key of limiter.keys) {
      expect(key).not.toContain("198.51");
      expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it("uses the binding of the scope", async () => {
    const guest = new FakeLimiter(10);
    const chat = new FakeLimiter(10);
    const env: IpLimitEnv = {
      AUTH_SECRET: SECRET,
      GUEST_LIMITER: guest,
      CHAT_CONNECT_LIMITER: chat,
    };
    await checkIpLimit(fromIp("198.51.100.1"), env, "chatConnect");
    expect(guest.keys).toHaveLength(0);
    expect(chat.keys).toHaveLength(1);
  });

  it("counts requests without cf-connecting-ip (and loopback) in production", async () => {
    const limiter = new FakeLimiter(1);
    const env = prodEnv(limiter);
    expect((await checkIpLimit(fromIp(null), env, "guest")).ok).toBe(true);
    expect((await checkIpLimit(fromIp(null), env, "guest")).ok).toBe(false);
    expect((await checkIpLimit(fromIp("127.0.0.1"), env, "guest")).ok).toBe(true);
    expect((await checkIpLimit(fromIp("127.0.0.1"), env, "guest")).ok).toBe(false);
  });

  it("exempts loopback and header-less requests only with DEV_ROUTES_ENABLED=1", async () => {
    const limiter = new FakeLimiter(1);
    const env: IpLimitEnv = { ...prodEnv(limiter), DEV_ROUTES_ENABLED: "1" };
    for (let i = 0; i < 5; i++) {
      expect((await checkIpLimit(fromIp(null), env, "guest")).ok).toBe(true);
      expect((await checkIpLimit(fromIp("127.0.0.1"), env, "guest")).ok).toBe(true);
      expect((await checkIpLimit(fromIp("::1"), env, "guest")).ok).toBe(true);
    }
    expect(limiter.keys).toHaveLength(0);
    // A real (or test) address is still limited in dev, which the e2e step relies on.
    expect((await checkIpLimit(fromIp("203.0.113.9"), env, "guest")).ok).toBe(true);
    expect((await checkIpLimit(fromIp("203.0.113.9"), env, "guest")).ok).toBe(false);
  });

  it("fails open when the binding is missing or throws", async () => {
    expect(await checkIpLimit(fromIp("198.51.100.1"), prodEnv(), "guest")).toEqual({ ok: true });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: RateLimiterLike = {
      limit: async () => {
        throw new Error("limiter down");
      },
    };
    expect(await checkIpLimit(fromIp("198.51.100.1"), prodEnv(broken), "guest")).toEqual({
      ok: true,
    });
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});

describe("configured limits (cloudflare.config.ts)", () => {
  // The config imports the Worker entrypoint, so the test reads its text instead.
  const config = readFileSync(join(import.meta.dirname, "../../cloudflare.config.ts"), "utf8");
  const limit = (name: string) => {
    const m = new RegExp(
      `${name}: \\{ namespace: "(\\d+)", simple: \\{ limit: (\\d+), period: (\\d+) \\} \\}`,
    ).exec(config);
    if (!m) throw new Error(`IP_LIMITS.${name} not found`);
    return { namespace: m[1], limit: Number(m[2]), period: Number(m[3]) };
  };

  it("declares one-minute windows with distinct namespaces, bound to the env names", () => {
    const guest = limit("guest");
    const chat = limit("chatConnect");
    expect(guest).toMatchObject({ limit: 20, period: IP_LIMIT_RETRY_SEC });
    expect(chat).toMatchObject({ limit: 60, period: IP_LIMIT_RETRY_SEC });
    expect(guest.namespace).not.toBe(chat.namespace);
    expect(config).toContain("GUEST_LIMITER: bindings.rateLimit(IP_LIMITS.guest)");
    expect(config).toContain("CHAT_CONNECT_LIMITER: bindings.rateLimit(IP_LIMITS.chatConnect)");
  });

  it("declares DEV_ROUTES_ENABLED only outside production and preview builds", () => {
    expect(config).toContain(
      'const dev = mode !== undefined && mode !== "production" && !isPreview;',
    );
    expect(config).toContain("DEV_ROUTES_ENABLED: bindings.secret()");
  });
});

describe("POST /api/guest", () => {
  beforeEach(() => setAuthLimiter(new IpLimiter({ burst: 1000, perSecond: 1000 })));

  it("answers 429 with Retry-After once an IP is over the limit, and mints for other IPs", async () => {
    const limiter = new FakeLimiter(2);
    const w = fakeWorld({ GUEST_LIMITER: limiter, DEV_ROUTES_ENABLED: undefined } as Partial<Env>);
    const mint = async (ip: string) => (await authRoutes(ctxFor(w.env, fromIp(ip))))!;
    expect((await mint("198.51.100.1")).status).toBe(200);
    expect((await mint("198.51.100.1")).status).toBe(200);
    const refused = await mint("198.51.100.1");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({
      error: { code: "rate_limited", retryAfterMs: 60_000 },
    });
    const other = await mint("198.51.100.2");
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ kind: "guest" });
  });
});

describe("/ws/chat connects", () => {
  /** Captures rejectSocket's close: Node has no WebSocketPair and refuses status 101. */
  let closes: { code: number; reason: string }[];
  beforeEach(() => {
    closes = [];
    const RealResponse = Response;
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = {};
        1 = {
          accept() {},
          close(code: number, reason: string) {
            closes.push({ code, reason });
          },
        };
      },
    );
    vi.stubGlobal(
      "Response",
      class extends RealResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
          super(body, init?.status === 101 ? { ...init, status: 200 } : init);
        }
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("closes with 4429 before authenticating or reaching ChatChannelDO", async () => {
    const limiter = new FakeLimiter(1);
    const forwarded: string[] = [];
    const env = {
      AUTH_SECRET: SECRET,
      CHAT_CONNECT_LIMITER: limiter,
      ACCOUNT: {
        getByName: () => ({ profile: async () => null, guild: async () => null }),
      },
      CHAT: {
        getByName: (channel: string) => ({
          fetch: async () => {
            forwarded.push(channel);
            return new Response("forwarded");
          },
        }),
      },
    } as unknown as Parameters<typeof connectChat>[1];
    const token = await signToken(SECRET, { accountId: "acc-1", name: "a", issuedAt: Date.now() });
    const connect = () => {
      const url = new URL(`https://gamez.example.com/ws/chat?channel=global&token=${token}`);
      const request = new Request(url, {
        headers: { Upgrade: "websocket", "cf-connecting-ip": "198.51.100.1" },
      });
      return connectChat(request, env, url, [{ id: "classic" }]);
    };
    expect(await (await connect()).text()).toBe("forwarded");
    await connect();
    expect(forwarded).toEqual(["global"]);
    expect(closes).toEqual([{ code: CLOSE_CHAT_RATE_LIMITED, reason: "rate limited" }]);
    expect(CLOSE_CHAT_RATE_LIMITED).toBe(4429);
  });
});
