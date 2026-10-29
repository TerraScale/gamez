import type { Analytics } from "../../src/server/analytics/types.ts";

/** One recorded point, as the writer received it. */
export interface Recorded {
  metric: string;
  blobs: Record<string, string>;
  doubles: Record<string, number>;
  index: string | undefined;
}

/** A recording Analytics writer (the frozen interface, no backend). */
export class RecordingAnalytics implements Analytics {
  readonly points: Recorded[] = [];
  flushes = 0;

  write(
    metric: string,
    blobs: Record<string, string | undefined>,
    doubles?: Record<string, number | undefined>,
    index?: string,
  ): void {
    this.points.push({
      metric,
      blobs: Object.fromEntries(
        Object.entries(blobs).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      doubles: Object.fromEntries(
        Object.entries(doubles ?? {}).filter((e): e is [string, number] => e[1] !== undefined),
      ),
      index,
    });
  }

  flush(): Promise<void> {
    this.flushes++;
    return Promise.resolve();
  }

  of(metric: string): Recorded[] {
    return this.points.filter((p) => p.metric === metric);
  }
}
