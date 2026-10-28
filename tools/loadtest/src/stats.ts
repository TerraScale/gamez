/**
 * Fixed-memory latency histogram (1 ms bins up to 60 s, plus an overflow bin)
 * that merges across worker threads by summing counts. Pure.
 */

export const HIST_MAX_MS = 60_000;

export interface HistogramData {
  /** counts[i] = samples in [i, i+1) ms; the last bin holds everything >= HIST_MAX_MS. */
  counts: number[];
  total: number;
  sum: number;
  max: number;
}

export interface Percentiles {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export class Histogram {
  counts = new Uint32Array(HIST_MAX_MS + 1);
  total = 0;
  sum = 0;
  max = 0;

  add(ms: number): void {
    if (!Number.isFinite(ms)) return;
    const v = Math.max(0, ms);
    this.counts[Math.min(HIST_MAX_MS, Math.floor(v))]!++;
    this.total++;
    this.sum += v;
    if (v > this.max) this.max = v;
  }

  reset(): void {
    this.counts.fill(0);
    this.total = 0;
    this.sum = 0;
    this.max = 0;
  }

  /** Sparse-friendly plain data for postMessage (only up to the last non-empty bin). */
  toData(): HistogramData {
    let last = this.counts.length - 1;
    while (last >= 0 && this.counts[last] === 0) last--;
    return {
      counts: Array.from(this.counts.subarray(0, last + 1)),
      total: this.total,
      sum: this.sum,
      max: this.max,
    };
  }

  merge(d: HistogramData): void {
    for (let i = 0; i < d.counts.length; i++) this.counts[i]! += d.counts[i]!;
    this.total += d.total;
    this.sum += d.sum;
    if (d.max > this.max) this.max = d.max;
  }

  /** The value below which `q` (0..1) of the samples fall, at 1 ms resolution (upper bin edge). */
  quantile(q: number): number {
    if (this.total === 0) return Number.NaN;
    const rank = Math.max(1, Math.ceil(q * this.total));
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      seen += this.counts[i]!;
      if (seen >= rank) return Math.min(i + 1, this.max === 0 ? 0 : Math.ceil(this.max));
    }
    return this.max;
  }

  summary(): Percentiles {
    return {
      n: this.total,
      mean: this.total === 0 ? Number.NaN : this.sum / this.total,
      p50: this.quantile(0.5),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
      max: this.max,
    };
  }
}

/** Percentiles of a small sample list (join times), exact. */
export function percentilesOf(values: number[]): Percentiles {
  if (values.length === 0) {
    return {
      n: 0,
      mean: Number.NaN,
      p50: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
      max: Number.NaN,
    };
  }
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[s.length - 1]!,
  };
}
