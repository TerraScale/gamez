/**
 * Per-socket rate limits for client messages (phase 0 hardening). A token
 * bucket allows `burst` messages at once and refills `perSecond` tokens each
 * second. Excess messages are dropped and counted, never queued.
 *
 * Pure: time is passed in (epoch ms), so tests and the RelayDO share one clock.
 */

export interface BucketSpec {
  burst: number;
  perSecond: number;
}

/** Limits for the client messages that cost the server work or fan out to others. */
export const RATE_LIMITS = {
  moveTo: { burst: 5, perSecond: 5 },
  /** Wave B: client-pose reports (presence worlds). */
  pose: { burst: 5, perSecond: 5 },
  ping: { burst: 3, perSecond: 1 },
} as const satisfies Record<string, BucketSpec>;

export type LimitedKind = keyof typeof RATE_LIMITS;

/** Minimum gap between two "rate_limited" error messages to the same socket. */
export const RATE_NOTICE_MS = 1000;

export class TokenBucket {
  #tokens: number;
  #last: number;
  /** Messages this bucket has refused. */
  dropped = 0;

  constructor(
    readonly spec: BucketSpec,
    now: number,
  ) {
    this.#tokens = spec.burst;
    this.#last = now;
  }

  /** Takes one token at `now`; false (and counts a drop) when the bucket is empty. */
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.#last) / 1000;
    this.#last = now;
    this.#tokens = Math.min(this.spec.burst, this.#tokens + elapsed * this.spec.perSecond);
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    this.dropped++;
    return false;
  }

  /** True when the bucket would hold `burst` tokens at `now` (a fresh bucket is equivalent). */
  full(now: number): boolean {
    const elapsed = Math.max(0, now - this.#last) / 1000;
    return this.#tokens + elapsed * this.spec.perSecond >= this.spec.burst;
  }
}

/** All buckets of one socket, plus the throttle for its "rate_limited" notices. */
export class SocketLimiter {
  readonly #buckets: Record<LimitedKind, TokenBucket>;
  #lastNotice = Number.NEGATIVE_INFINITY;

  constructor(now: number) {
    this.#buckets = {
      moveTo: new TokenBucket(RATE_LIMITS.moveTo, now),
      pose: new TokenBucket(RATE_LIMITS.pose, now),
      ping: new TokenBucket(RATE_LIMITS.ping, now),
    };
  }

  /** True when a message of `kind` may be handled now. */
  admit(kind: LimitedKind, now: number): boolean {
    return this.#buckets[kind].take(now);
  }

  /** Total messages dropped on this socket, across all kinds. */
  get dropped(): number {
    return this.#buckets.moveTo.dropped + this.#buckets.pose.dropped + this.#buckets.ping.dropped;
  }

  /** True at most once per RATE_NOTICE_MS; records the notice when it returns true. */
  noticeDue(now: number): boolean {
    if (now - this.#lastNotice < RATE_NOTICE_MS) return false;
    this.#lastNotice = now;
    return true;
  }
}
