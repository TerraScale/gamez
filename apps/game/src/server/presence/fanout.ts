/**
 * The relays a ChunkDO fans its deltas out to (wave C §12: sharded relays).
 * Each delta goes to every subscribed relay exactly once, however many players
 * sit behind it; a relay that fails MAX_RELAY_FAILURES deliveries in a row is
 * dropped (it re-subscribes when it recovers). Pure: the transport is a callback.
 */

/** Consecutive failed deliveries after which a relay is dropped. */
export const MAX_RELAY_FAILURES = 3;
/**
 * A delivery slower than this counts as failed. The chunk keeps one delta in
 * flight, so a hung relay must not stall every other relay's deltas.
 */
export const DELIVER_TIMEOUT_MS = 10_000;

export interface FanoutResult {
  /** Relays the delta reached. */
  delivered: string[];
  /** Relays that failed this time (still subscribed unless also in `dropped`). */
  failed: { relay: string; failures: number; reason: unknown }[];
  /** Relays removed because they failed too often. */
  dropped: string[];
}

export class RelayFanout {
  /** Relay name -> consecutive delivery failures. */
  readonly #relays = new Map<string, number>();
  readonly #maxFailures: number;
  readonly #timeoutMs: number;

  constructor(
    relays: Iterable<string> = [],
    maxFailures = MAX_RELAY_FAILURES,
    timeoutMs = DELIVER_TIMEOUT_MS,
  ) {
    for (const r of relays) this.#relays.set(r, 0);
    this.#maxFailures = maxFailures;
    this.#timeoutMs = timeoutMs;
  }

  /** Subscribes a relay; true when it was not subscribed yet. */
  add(relay: string): boolean {
    if (this.#relays.has(relay)) return false;
    this.#relays.set(relay, 0);
    return true;
  }

  /** Unsubscribes a relay; true when it was subscribed. */
  remove(relay: string): boolean {
    return this.#relays.delete(relay);
  }

  has(relay: string): boolean {
    return this.#relays.has(relay);
  }

  /** Subscribed relays, in subscription order. */
  names(): string[] {
    return [...this.#relays.keys()];
  }

  get size(): number {
    return this.#relays.size;
  }

  /**
   * Sends one delta to every relay subscribed right now, concurrently. Relays
   * that unsubscribe while their delivery is in flight are left alone.
   */
  async deliver(send: (relay: string) => Promise<void>): Promise<FanoutResult> {
    const relays = this.names();
    const results = await Promise.allSettled(relays.map((r) => this.#timed(send(r))));
    const out: FanoutResult = { delivered: [], failed: [], dropped: [] };
    results.forEach((result, i) => {
      const relay = relays[i]!;
      if (!this.#relays.has(relay)) return;
      if (result.status === "fulfilled") {
        this.#relays.set(relay, 0);
        out.delivered.push(relay);
        return;
      }
      const failures = (this.#relays.get(relay) ?? 0) + 1;
      out.failed.push({ relay, failures, reason: result.reason });
      if (failures < this.#maxFailures) {
        this.#relays.set(relay, failures);
        return;
      }
      this.#relays.delete(relay);
      out.dropped.push(relay);
    });
    return out;
  }

  #timed(p: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deliver timed out")), this.#timeoutMs);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}
