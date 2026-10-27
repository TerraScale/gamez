/**
 * Estimates the server clock from ping/pong round trips. Each sample assumes
 * the server stamped its time halfway through the round trip; the estimate is
 * the median of the most recent samples, so one slow round trip can't skew it.
 */
export class ClockSync {
  #offsets: number[] = [];
  #rtts: number[] = [];
  #seed: number | null = null;

  constructor(readonly maxSamples = 9) {}

  /** Rough offset from a one-way server timestamp; used only until the first pong. */
  seed(serverTime: number, now = Date.now()): void {
    this.#seed = serverTime - now;
  }

  /** Records a pong: `sentAt` and `receivedAt` are client times, `serverTime` the server's stamp. */
  addSample(sentAt: number, serverTime: number, receivedAt: number): void {
    const rtt = receivedAt - sentAt;
    if (rtt < 0) return;
    this.#offsets.push(serverTime + rtt / 2 - receivedAt);
    this.#rtts.push(rtt);
    if (this.#offsets.length > this.maxSamples) {
      this.#offsets.shift();
      this.#rtts.shift();
    }
  }

  /** Server time minus client time, in ms. */
  get offset(): number {
    return median(this.#offsets) ?? this.#seed ?? 0;
  }

  /** Median round trip in ms, or null before the first pong. */
  get rtt(): number | null {
    return median(this.#rtts);
  }

  serverNow(now = Date.now()): number {
    return now + this.offset;
  }

  reset(): void {
    this.#offsets = [];
    this.#rtts = [];
    this.#seed = null;
  }
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
