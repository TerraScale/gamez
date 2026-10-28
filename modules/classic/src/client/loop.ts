/**
 * Fixed-step accumulator of the classic client (docs/design/classic.md §12.2).
 * Pure: no DOM and no clock. The game feeds it the frame delta and the sim
 * speed (ControlState.speed, only above 1 in Full Idle) and gets back how many
 * sim ticks to run and the render alpha for interpolation.
 */

/** Sim tick length in ms (20 Hz). */
export const STEP_MS = 50;
/** Frame deltas are clamped to this so a tab switch does not run hundreds of ticks. */
export const MAX_FRAME_MS = 250;
/** Ticks per frame at speed 1 (scaled by the speed multiplier). Excess time is dropped. */
export const MAX_TICKS_PER_FRAME = 8;

export interface FrameAdvance {
  /** Sim ticks to run this frame (step(ticks)); 0 when none is due. */
  ticks: number;
  /** Render alpha 0..1: how far the render time is between the last and the next tick. */
  alpha: number;
  /** True when the catch-up cap dropped simulated time. */
  dropped: boolean;
}

export class FixedLoop {
  private acc = 0;

  constructor(
    private readonly stepMs = STEP_MS,
    private readonly maxFrameMs = MAX_FRAME_MS,
    private readonly maxTicks = MAX_TICKS_PER_FRAME,
  ) {}

  /** Adds `dtMs * speed` to the accumulator and returns the ticks to run now. */
  advance(dtMs: number, speed: number): FrameAdvance {
    const dt = Number.isFinite(dtMs) ? Math.max(0, Math.min(dtMs, this.maxFrameMs)) : 0;
    const s = Number.isFinite(speed) && speed >= 1 ? speed : 1;
    this.acc += dt * s;
    const cap = this.maxTicks * s;
    let ticks = Math.floor(this.acc / this.stepMs);
    let dropped = false;
    if (ticks > cap) {
      ticks = cap;
      this.acc = 0;
      dropped = true;
    } else {
      this.acc -= ticks * this.stepMs;
    }
    return { ticks, alpha: Math.min(1, this.acc / this.stepMs), dropped };
  }

  /** Forgets the pending time (new sim, tab hidden, area change). */
  reset(): void {
    this.acc = 0;
  }

  /** Pending time in ms (diagnostics and tests). */
  get pendingMs(): number {
    return this.acc;
  }
}

/**
 * Rolling one-second window for the perf overlay: frames per second, sim
 * milliseconds per tick and ticks per second. Feed it with wall-clock ms.
 */
export class PerfWindow {
  fps = 0;
  tickMs = 0;
  ticksPerSecond = 0;
  private frames = 0;
  private steps = 0;
  private stepMs = 0;
  private startMs = -1;

  constructor(private readonly windowMs = 1000) {}

  /** Call once per rendered frame. */
  frame(nowMs: number): void {
    if (this.startMs < 0) this.startMs = nowMs;
    this.frames++;
    this.close(nowMs);
  }

  /** Records `ticks` sim ticks that took `ms` of wall time in total. */
  addSteps(ticks: number, ms: number, nowMs: number): void {
    if (ticks <= 0) return;
    if (this.startMs < 0) this.startMs = nowMs;
    this.steps += ticks;
    this.stepMs += ms;
    this.close(nowMs);
  }

  private close(nowMs: number): void {
    const span = nowMs - this.startMs;
    if (span < this.windowMs) return;
    this.fps = Math.round((this.frames * 1000) / span);
    this.ticksPerSecond = Math.round((this.steps * 1000) / span);
    this.tickMs = this.steps > 0 ? Math.round((this.stepMs / this.steps) * 100) / 100 : 0;
    this.frames = 0;
    this.steps = 0;
    this.stepMs = 0;
    this.startMs = nowMs;
  }
}
