/**
 * Per-IP rate limits for guest minting and chat connects (ADR 0007 R9b
 * follow-up, ADR 0012). Backed by Cloudflare Rate Limiting bindings
 * (cloudflare.config.ts IP_LIMITS: 20 guests and 60 chat connects per IP per
 * minute), which count per key across isolates.
 *
 * The key is never the raw IP: it is HMAC-SHA256(AUTH_SECRET-derived key,
 * scope + IP), truncated to 128 bits. Nothing here stores anything; the
 * binding keeps short-lived counters for the hashed key only.
 *
 * Fails open: a missing binding (tests, older config) or a binding error lets
 * the request through and logs, so a limiter outage never blocks sign-up.
 */
import { toBase64Url } from "./auth.ts";
import type { RateLimiterLike } from "./contracts.ts";
import { devRoutesEnabled } from "./http.ts";

export type IpLimitScope = "guest" | "chatConnect";

export interface IpLimitEnv {
  AUTH_SECRET: string;
  DEV_ROUTES_ENABLED?: string;
  GUEST_LIMITER?: RateLimiterLike;
  CHAT_CONNECT_LIMITER?: RateLimiterLike;
}

/** Seconds a refused caller should wait: the bindings' window (`period` in cloudflare.config.ts). */
export const IP_LIMIT_RETRY_SEC = 60;

export type IpLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

const encoder = new TextEncoder();
/** Domain separation: this HMAC key is never the token-signing key itself. */
const KEY_LABEL = "gamez/ip-limit/v1";
let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function limitKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = (async () => {
    const base = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const derived = await crypto.subtle.sign("HMAC", base, encoder.encode(KEY_LABEL));
    return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
  })();
  cachedKey = { secret, key };
  return key;
}

/** The salted hash a limiter counts under: base64url, 22 chars, no raw IP. */
export async function hashedIpKey(
  secret: string,
  scope: IpLimitScope,
  ip: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await limitKey(secret),
    encoder.encode(`${scope}:${ip}`),
  );
  return toBase64Url(new Uint8Array(mac).slice(0, 16));
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.") || ip === "::ffff:127.0.0.1";
}

function binding(env: IpLimitEnv, scope: IpLimitScope): RateLimiterLike | undefined {
  return scope === "guest" ? env.GUEST_LIMITER : env.CHAT_CONNECT_LIMITER;
}

/**
 * Counts one `scope` request from the caller's IP (`cf-connecting-ip`, which
 * Cloudflare always sets and overwrites in production). With the dev switch
 * on, requests without that header or from loopback are not counted, so the
 * local e2e suite and bots (hundreds of guests from one machine) keep working;
 * production has no exemption, and a missing header counts under "unknown".
 */
export async function checkIpLimit(
  request: Request,
  env: IpLimitEnv,
  scope: IpLimitScope,
): Promise<IpLimitResult> {
  const limiter = binding(env, scope);
  if (!limiter) return { ok: true };
  const ip = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (devRoutesEnabled(env) && (ip === "" || isLoopback(ip))) return { ok: true };
  try {
    const key = await hashedIpKey(env.AUTH_SECRET, scope, ip === "" ? "unknown" : ip);
    const { success } = await limiter.limit({ key });
    return success ? { ok: true } : { ok: false, retryAfterSec: IP_LIMIT_RETRY_SEC };
  } catch (err) {
    console.error(`ip-limit: ${scope} limiter failed; letting the request through`, err);
    return { ok: true };
  }
}
