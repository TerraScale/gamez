/**
 * Pure helpers of the QA scenarios (no browser, no I/O): the missing-id split
 * between art and HUD icons, and the frame/longtask summary split into boot and
 * steady state. Imported by run.ts and unit-tested in tools/qa/tests.
 */

/** Renderer ids over this length of frame gap count as a long frame. */
export const LONG_FRAME_MS = 100;
/** Boot is everything before this many ms since navigation start. */
export const BOOT_MS = 5000;

/**
 * HUD icons (`icon.item.*`, `icon.skill.*`, `icon.status.*`) are drawn as inline
 * SVG by the HUD (hud/icons.tsx), so a missing sprite for them is not an art gap.
 */
export function isIconId(id: string): boolean {
  return id.startsWith("icon.");
}

/** Splits renderer missing ids into real art gaps and informational icon ids. */
export function splitMissingIds(ids: readonly string[]): { art: string[]; icons: string[] } {
  const art: string[] = [];
  const icons: string[] = [];
  for (const id of ids) (isIconId(id) ? icons : art).push(id);
  return { art, icons };
}

/** Count and worst value of a set of samples (0 when empty). */
export interface Spread {
  count: number;
  max: number;
}

export interface PerfSummary {
  /** Boot/steady split point, ms since navigation start. */
  bootMs: number;
  /** Long frames that overlapped a harness screenshot (the page is frozen while it is taken); not counted. */
  excludedFrames: number;
  /** Screenshots the harness took (each is a pause in the page's frames). */
  harnessPauses: number;
  /** Frame gap that counts as a long frame, ms. */
  longFrameMs: number;
  /** False when the page probe was not installed (nothing measured). */
  installed: boolean;
  /** Age of the measured document (ms). A dev-server reload restarts it, so a value below the run length means a reload. */
  documentMs: number | null;
  longFrames: { boot: Spread; steady: Spread };
  longtasks: { boot: Spread; steady: Spread };
}

/** A stretch of page time the harness froze the page for (screenshots): [fromMs, toMs]. */
export type Pause = readonly [number, number];

/** Raw probe output: [frameTimeMs, gapMs] pairs and [startMs, durationMs] longtasks. */
export interface PerfProbe {
  frames?: readonly (readonly [number, number])[];
  longtasks?: readonly (readonly [number, number])[];
  /** performance.now() when the probe was read. */
  nowMs?: number;
}

function spread(values: readonly number[]): Spread {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  return { count: values.length, max: Math.round(max) };
}

/**
 * Splits probe output into boot (first BOOT_MS) and steady state. A longtask
 * is classified by its start, a long frame by the time it ended.
 */
export function summarisePerf(
  probe: PerfProbe | null | undefined,
  pauses: readonly Pause[] = [],
  bootMs = BOOT_MS,
  longFrameMs = LONG_FRAME_MS,
): PerfSummary {
  const frames = probe?.frames ?? [];
  const tasks = probe?.longtasks ?? [];
  const over = frames.filter(([, gap]) => gap > longFrameMs);
  // A frame gap [t - gap, t] that overlaps a harness pause was caused by the harness.
  const paused = (([t, gap]: readonly [number, number]) =>
    pauses.some(([a, b]) => a < t && b > t - gap)) as (f: readonly [number, number]) => boolean;
  const longFrames = over.filter((f) => !paused(f));
  const excludedFrames = over.length - longFrames.length;
  const split = (rows: readonly (readonly [number, number])[], keep: (v: number) => boolean) =>
    rows.filter(([t]) => keep(t)).map(([, v]) => v);
  return {
    bootMs,
    excludedFrames,
    harnessPauses: pauses.length,
    longFrameMs,
    installed: probe != null,
    documentMs: probe?.nowMs ?? null,
    longFrames: {
      boot: spread(split(longFrames, (t) => t < bootMs)),
      steady: spread(split(longFrames, (t) => t >= bootMs)),
    },
    longtasks: {
      boot: spread(split(tasks, (t) => t < bootMs)),
      steady: spread(split(tasks, (t) => t >= bootMs)),
    },
  };
}

/**
 * Page script (Page.addScriptToEvaluateOnNewDocument) that records long frames
 * and longtasks from document start, so the boot is measured too. The
 * observer is not buffered: entries are taken from the first frame on.
 */
export const PERF_PROBE_SOURCE = `(() => {
  if (window.__qaPerf) return;
  const q = { frames: [], longtasks: [], limitMs: ${LONG_FRAME_MS} };
  // Frames and longtasks are kept per document: a reload starts a new probe.
  window.__qaPerf = q;
  let last = -1;
  const tick = (t) => {
    if (last >= 0 && t - last > ${LONG_FRAME_MS}) q.frames.push([Math.round(t), Math.round(t - last)]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) q.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: "longtask" });
  } catch (err) {
    q.unsupported = String(err);
  }
})();`;
