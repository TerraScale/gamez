/**
 * Client telemetry entry points (docs/design/admin-dashboard.md §9). OWNER: T-telemetry.
 *
 *   startTelemetry(opts?)                  once at boot (idempotent)
 *   setTelemetryContext({token, mode, contentHash})   when the session or mode changes
 *   reportRenderError(err)                 from error boundaries
 *
 * Nothing here throws into the app, and nothing waits for the network.
 */
import { detectPlatform } from "./platform.ts";
import { TelemetryCore, type TelemetryContext, type TelemetryEnv } from "./core.ts";
import type { FrameSource } from "./sampler.ts";

export { normaliseMessage } from "./normalise.ts";
export { detectPlatform } from "./platform.ts";
export { TelemetryCore, decidePerfSample, activeSeconds } from "./core.ts";
export type { TelemetryContext, TelemetryEnv } from "./core.ts";
export { percentile, perfSummary, FrameRing } from "./ring.ts";
export { FrameSampler } from "./sampler.ts";

export interface StartTelemetryOptions {
  /** Batch endpoint; defaults to the same-origin /api/telemetry. */
  endpoint?: string;
  /** Test seam for the perf sampling decision (default Math.random). */
  random?: () => number;
}

const ENDPOINT = "/api/telemetry";

let core: TelemetryCore | null = null;
let context: TelemetryContext = { token: "", mode: "", contentHash: "" };

function buildId(): string {
  try {
    const v = import.meta.env.VITE_BUILD_ID;
    return typeof v === "string" && v.length > 0 ? v.slice(0, 40) : "dev";
  } catch {
    return "dev";
  }
}

function newSid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Non-secure contexts lack randomUUID; this id only separates page loads.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

function frameSource(): FrameSource | null {
  if (typeof requestAnimationFrame !== "function") return null;
  return {
    request: (cb) => requestAnimationFrame(cb),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

function memoryMb(): number {
  try {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    const used = mem?.usedJSHeapSize;
    return typeof used === "number" && Number.isFinite(used) ? Math.round(used / 1048576) : 0;
  } catch {
    return 0;
  }
}

function browserEnv(opts: StartTelemetryOptions): TelemetryEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  let standalone = nav.standalone === true;
  try {
    standalone = standalone || matchMedia("(display-mode: standalone)").matches;
  } catch {
    // no matchMedia
  }
  const { platform, device } = detectPlatform({
    userAgent: nav.userAgent ?? "",
    standalone,
    touchPoints: nav.maxTouchPoints ?? 0,
  });
  const random = opts.random ?? Math.random;
  return {
    sid: newSid(),
    build: buildId(),
    endpoint: opts.endpoint ?? ENDPOINT,
    platform,
    device,
    now: () => Date.now(),
    perfNow: () => Math.round(performance.now()),
    random,
    visible: () => document.visibilityState === "visible",
    memoryMb,
    fetch: (url, init) => fetch(url, init),
    sendBeacon: (url, body) =>
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" })),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    frames: frameSource(),
  };
}

function attachListeners(c: TelemetryCore): void {
  addEventListener("error", (e) => {
    try {
      c.reportError("error", e.error ?? e.message);
    } catch {
      // never throw into the app
    }
  });
  addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    try {
      c.reportError("unhandledrejection", e.reason);
    } catch {
      // never throw into the app
    }
  });
  document.addEventListener("visibilitychange", () => {
    try {
      c.setVisible(document.visibilityState === "visible");
    } catch {
      // never throw into the app
    }
  });
  addEventListener("pagehide", () => {
    try {
      c.end();
    } catch {
      // never throw into the app
    }
  });
}

/** Starts the session once per page load. Later calls do nothing. */
export function startTelemetry(opts: StartTelemetryOptions = {}): void {
  try {
    if (core || typeof window === "undefined" || typeof document === "undefined") return;
    const next = new TelemetryCore(browserEnv(opts));
    core = next;
    next.setContext(context);
    next.start();
    attachListeners(next);
  } catch {
    core = null;
  }
}

/** Sets the bearer token, mode and contentHash that later events carry. */
export function setTelemetryContext(next: TelemetryContext): void {
  try {
    context = {
      token: typeof next.token === "string" ? next.token : "",
      mode: typeof next.mode === "string" ? next.mode : "",
      contentHash: typeof next.contentHash === "string" ? next.contentHash : "",
    };
    core?.setContext(context);
  } catch {
    // never throw into the app
  }
}

/** Reports a render error from an error boundary (kind "render"). */
export function reportRenderError(err: unknown): void {
  try {
    core?.reportError("render", err);
  } catch {
    // never throw into the app
  }
}
