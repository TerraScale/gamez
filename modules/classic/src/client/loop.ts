/**
 * Fixed-step accumulator of the classic client (docs/design/classic.md §12.2).
 * Pure: no DOM and no clock. The game feeds it the frame delta and the sim
 * speed (ControlState.speed, only above 1 in Full Idle) and gets back how many
 * sim ticks to run and the render alpha for interpolation.
 *
 * Wave A (QA major #1c: Idle x8 ran ~22-50 ticks/s in the headless browser
 * instead of 160): slow frames no longer lose simulated time. A frame of up
 * to MAX_FRAME_MS counts in full (a tab switch beyond that is dropped), the
 * per-frame tick cap is MAX_TICKS_PER_FRAME x speed (one second of sim at
 * 20 Hz), and whatever the cap leaves is kept as a backlog of at most
 * MAX_BACKLOG_MS x speed that the next frames work off. When the host
 * reports what its steps cost (observe), the per-frame ticks also stay
 * within FRAME_BUDGET_MS of sim work, so a slow device degrades to a lower
 * sim rate instead of ever longer frames.
 */

/** Sim tick length in ms (20 Hz). */
export const STEP_MS = 50;
/** Frame deltas are clamped to this (a hidden tab or a debugger pause is not caught up). */
export const MAX_FRAME_MS = 1000;
/** Ticks per frame at speed 1 (scaled by the speed multiplier): one second of sim. */
export const MAX_TICKS_PER_FRAME = 20;
/** Pending sim time kept beyond the per-frame cap, in wall ms (scaled by the speed). */
export const MAX_BACKLOG_MS = 1000;
/** Sim work per frame (ms) once observe() has measured the tick cost. */
export const FRAME_BUDGET_MS = 40;

export interface FrameAdvance {
  /** Sim ticks to run this frame (step(ticks)); 0 when none is due. */
  ticks: number;
  /** Render alpha 0..1: how far the render time is between the last and the next tick. */
  alpha: number;
  /** True when simulated time was dropped (backlog over its bound). */
  dropped: boolean;
}

export class FixedLoop {
  private acc = 0;
  /** Smoothed wall ms per tick (0 = unknown: no budget cap). */
  private costMs = 0;

  constructor(
    private readonly stepMs = STEP_MS,
    private readonly maxFrameMs = MAX_FRAME_MS,
    private readonly maxTicks = MAX_TICKS_PER_FRAME,
    private readonly maxBacklogMs = MAX_BACKLOG_MS,
    private readonly budgetMs = FRAME_BUDGET_MS,
  ) {}

  /** Adds `dtMs * speed` to the accumulator and returns the ticks to run now. */
  advance(dtMs: number, speed: number): FrameAdvance {
    const dt = Number.isFinite(dtMs) ? Math.max(0, Math.min(dtMs, this.maxFrameMs)) : 0;
    const s = Number.isFinite(speed) && speed >= 1 ? speed : 1;
    this.acc += dt * s;
    let cap = this.maxTicks * s;
    if (this.costMs > 0) {
      // Never below `s` ticks per frame: the sim keeps moving at least at speed x frames.
      cap = Math.min(cap, Math.max(s, Math.floor(this.budgetMs / this.costMs)));
    }
    const ticks = Math.min(cap, Math.floor(this.acc / this.stepMs));
    this.acc -= ticks * this.stepMs;
    let dropped = false;
    const maxAcc = this.maxBacklogMs * s;
    if (this.acc > maxAcc) {
      this.acc = maxAcc;
      dropped = true;
    }
    return { ticks, alpha: Math.min(1, this.acc / this.stepMs), dropped };
  }

  /**
   * Optional feedback from the host: `ticks` sim ticks took `ms` of wall
   * time. Enables the per-frame budget (an exponential average of the cost).
   */
  observe(ticks: number, ms: number): void {
    if (!(ticks > 0) || !Number.isFinite(ms) || ms < 0) return;
    const per = ms / ticks;
    this.costMs = this.costMs === 0 ? per : this.costMs * 0.8 + per * 0.2;
  }

  /** Forgets the pending time (new sim, tab hidden, area change). */
  reset(): void {
    this.acc = 0;
  }

  /** Pending time in ms (diagnostics and tests). */
  get pendingMs(): number {
    return this.acc;
  }

  /** Measured wall ms per tick (0 until observe() was called). */
  get tickCostMs(): number {
    return this.costMs;
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
