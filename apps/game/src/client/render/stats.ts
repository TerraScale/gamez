/**
 * Rolling frame statistics for `ArpgWorldRenderer.stats()`. fps is updated
 * every half second; drawMs is an exponential average of the time one frame
 * spent in the renderer's tick.
 */
export class FrameStats {
  private frames = 0;
  private windowMs = 0;
  private fpsValue = 0;
  private drawAvg = 0;

  frame(dtMs: number, drawMs: number): void {
    this.frames++;
    this.windowMs += Math.max(0, dtMs);
    if (this.windowMs >= 500) {
      this.fpsValue = (this.frames * 1000) / this.windowMs;
      this.frames = 0;
      this.windowMs = 0;
    }
    this.drawAvg = this.drawAvg === 0 ? drawMs : this.drawAvg * 0.9 + drawMs * 0.1;
  }

  get fps(): number {
    return Math.round(this.fpsValue * 10) / 10;
  }

  get drawMs(): number {
    return Math.round(this.drawAvg * 100) / 100;
  }
}
