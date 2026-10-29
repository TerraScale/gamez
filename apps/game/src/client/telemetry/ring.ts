/**
 * Frame-time ring and percentile math for the perf sampler
 * (docs/design/admin-dashboard.md §9). Pure, no DOM. OWNER: T-telemetry.
 *
 * The ring is preallocated once; pushing a frame never allocates. A summary
 * copies the valid frames into a second preallocated array and sorts it, so
 * only the once-a-minute summary touches the sort (no per-frame work).
 */
export const RING_SIZE = 600;

/** Nearest-rank percentile of an ascending-sorted list of the first `n` values. */
export function percentileSorted(sorted: ArrayLike<number>, n: number, q: number): number {
  if (n <= 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sorted[idx] ?? 0;
}

/** Percentile of any list (copies and sorts; for tests and small inputs). */
export function percentile(values: readonly number[], q: number): number {
  const sorted = Float32Array.from(values).sort();
  return percentileSorted(sorted, sorted.length, q);
}

export interface FrameStats {
  /** Frame time (ms) at the 50th and 95th percentile over the ring. */
  p50: number;
  p95: number;
  /** Number of frames the stats were computed from. */
  samples: number;
}

export class FrameRing {
  readonly #frames = new Float32Array(RING_SIZE);
  readonly #scratch = new Float32Array(RING_SIZE);
  #count = 0;
  #next = 0;

  /** Valid samples held (at most RING_SIZE). */
  get count(): number {
    return this.#count;
  }

  /** Records one frame delta in milliseconds; non-positive or non-finite deltas are ignored. */
  push(frameMs: number): void {
    if (!(frameMs > 0) || !Number.isFinite(frameMs)) return;
    this.#frames[this.#next] = frameMs;
    this.#next = (this.#next + 1) % RING_SIZE;
    if (this.#count < RING_SIZE) this.#count++;
  }

  /** Drops every sample (the next window starts empty). */
  reset(): void {
    this.#count = 0;
    this.#next = 0;
  }

  /** p50/p95 frame times over the valid samples, or null when the ring is empty. */
  stats(): FrameStats | null {
    const n = this.#count;
    if (n === 0) return null;
    const scratch = this.#scratch;
    for (let i = 0; i < n; i++) scratch[i] = this.#frames[i] ?? 0;
    const sorted = scratch.subarray(0, n);
    sorted.sort();
    return {
      p50: percentileSorted(sorted, n, 0.5),
      p95: percentileSorted(sorted, n, 0.95),
      samples: n,
    };
  }
}

export interface PerfSummary {
  fpsP50: number;
  fpsP95: number;
  frameMsP95: number;
  samples: number;
}

/** The wire perf numbers from frame stats: fps = 1000 / frame ms (0 when unknown). */
export function perfSummary(stats: FrameStats): PerfSummary {
  return {
    fpsP50: stats.p50 > 0 ? 1000 / stats.p50 : 0,
    fpsP95: stats.p95 > 0 ? 1000 / stats.p95 : 0,
    frameMsP95: stats.p95,
    samples: stats.samples,
  };
}
