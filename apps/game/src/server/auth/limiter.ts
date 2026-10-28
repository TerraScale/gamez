/**
 * Best-effort per-isolate, per-IP limiter for /api/auth/* (wave-B.md §3.2).
 * Each Worker isolate keeps its own buckets, so the effective limit is
 * "per IP per isolate": it slows down credential stuffing from one address,
 * while the IdentityDO lockout is the real per-login guard.
 */
import { TokenBucket, type BucketSpec } from "../rate-limit.ts";

/** 40 requests at once, then one per second. */
export const AUTH_LIMIT: BucketSpec = { burst: 40, perSecond: 1 };
const MAX_KEYS = 10_000;

export class IpLimiter {
  readonly #buckets = new Map<string, TokenBucket>();

  constructor(readonly spec: BucketSpec = AUTH_LIMIT) {}

  /** Takes one token for `ip`; false when it is over the limit. */
  take(ip: string, now: number): boolean {
    let b = this.#buckets.get(ip);
    if (!b) {
      if (this.#buckets.size >= MAX_KEYS) this.#buckets.clear();
      b = new TokenBucket(this.spec, now);
      this.#buckets.set(ip, b);
    }
    return b.take(now);
  }

  /** Milliseconds until `ip` gets a token again (rough, for Retry-After). */
  retryAfterMs(): number {
    return Math.ceil(1000 / this.spec.perSecond);
  }
}

/** The client address Cloudflare reports, or "local" (dev without the header). */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}
