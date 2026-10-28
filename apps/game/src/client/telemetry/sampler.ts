/**
 * requestAnimationFrame sampler (docs/design/admin-dashboard.md §9). OWNER: T-telemetry.
 *
 * Runs only while `setActive(true)` (the core decides: visible, in a mode,
 * and this session is one of the sampled 25 %). The frame callback is bound
 * once; each frame does one subtraction and one ring push, no allocation.
 */
import { FrameRing, perfSummary, type PerfSummary } from "./ring.ts";

/** The minimal frame source (window.requestAnimationFrame in the browser). */
export interface FrameSource {
  request(cb: (timeMs: number) => void): number;
  cancel(handle: number): void;
}

export class FrameSampler {
  readonly ring = new FrameRing();
  readonly #source: FrameSource;
  readonly #tickBound = (t: number): void => this.#tick(t);
  #handle: number | null = null;
  #last = -1;

  constructor(source: FrameSource) {
    this.#source = source;
  }

  get running(): boolean {
    return this.#handle !== null;
  }

  /** Starts or stops the frame loop. A restart forgets the previous frame time. */
  setActive(on: boolean): void {
    if (on && this.#handle === null) {
      this.#last = -1;
      this.#handle = this.#source.request(this.#tickBound);
    } else if (!on && this.#handle !== null) {
      this.#source.cancel(this.#handle);
      this.#handle = null;
    }
  }

  /** The window's summary, then the ring is emptied; null when there is too little data. */
  take(minSamples: number): PerfSummary | null {
    const stats = this.ring.stats();
    this.ring.reset();
    if (!stats || stats.samples < minSamples) return null;
    return perfSummary(stats);
  }

  #tick(t: number): void {
    if (this.#last >= 0) this.ring.push(t - this.#last);
    this.#last = t;
    this.#handle = this.#source.request(this.#tickBound);
  }
}
