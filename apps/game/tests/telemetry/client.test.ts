/**
 * Client telemetry (src/client/telemetry): percentile math on the ring, the
 * frame sampler, the message normaliser, platform detection, batching,
 * sendBeacon on pagehide, the error budget and the perf sampling decision.
 * Browser globals are replaced by fakes; nothing touches a real DOM.
 */
import { describe, expect, it } from "vite-plus/test";
import type { TelemetryBatch, TelemetryEvent } from "@gamez/protocol";
import { detectPlatform } from "../../src/client/telemetry/platform.ts";
import { normaliseMessage } from "../../src/client/telemetry/normalise.ts";
import { FrameRing, perfSummary, percentile, RING_SIZE } from "../../src/client/telemetry/ring.ts";
import { FrameSampler, type FrameSource } from "../../src/client/telemetry/sampler.ts";
import {
  activeSeconds,
  decidePerfSample,
  HEARTBEAT_MS,
  MIN_PERF_SAMPLES,
  TelemetryCore,
  type TelemetryEnv,
} from "../../src/client/telemetry/core.ts";
import {
  reportRenderError,
  setTelemetryContext,
  startTelemetry,
} from "../../src/client/telemetry/index.ts";

describe("percentile math", () => {
  it("uses the nearest rank", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 0.5)).toBe(5);
    expect(percentile(xs, 0.95)).toBe(10);
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
  });

  it("computes p50 and p95 over a full ring of 600 frames", () => {
    const ring = new FrameRing();
    for (let i = 1; i <= RING_SIZE; i++) ring.push(i);
    expect(ring.count).toBe(600);
    const stats = ring.stats();
    expect(stats?.p50).toBe(300);
    expect(stats?.p95).toBe(570);
    expect(stats?.samples).toBe(600);
  });

  it("overwrites the oldest frames once full and never grows past 600", () => {
    const ring = new FrameRing();
    for (let i = 0; i < 700; i++) ring.push(16);
    for (let i = 0; i < 100; i++) ring.push(100);
    expect(ring.count).toBe(RING_SIZE);
    // 100 slow frames out of 600 is 16.7 %, so p95 is slow and p50 is not.
    expect(ring.stats()?.p50).toBe(16);
    expect(ring.stats()?.p95).toBe(100);
  });

  it("ignores non-positive and non-finite deltas, and reset empties the ring", () => {
    const ring = new FrameRing();
    ring.push(0);
    ring.push(-3);
    ring.push(Number.NaN);
    ring.push(Number.POSITIVE_INFINITY);
    expect(ring.count).toBe(0);
    expect(ring.stats()).toBeNull();
    ring.push(16);
    ring.reset();
    expect(ring.count).toBe(0);
  });

  it("turns frame times into fps: 1000 / frame ms", () => {
    const summary = perfSummary({ p50: 16, p95: 25, samples: 600 });
    expect(summary.fpsP50).toBeCloseTo(62.5);
    expect(summary.fpsP95).toBeCloseTo(40);
    expect(summary.frameMsP95).toBe(25);
    expect(summary.samples).toBe(600);
    expect(perfSummary({ p50: 0, p95: 0, samples: 1 }).fpsP50).toBe(0);
  });
});

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function fakeFrames() {
  let next: ((t: number) => void) | null = null;
  let handle = 0;
  const cancelled: number[] = [];
  const source: FrameSource = {
    request(cb) {
      next = cb;
      handle += 1;
      return handle;
    },
    cancel(h) {
      cancelled.push(h);
      next = null;
    },
  };
  return {
    source,
    cancelled,
    get pending() {
      return next !== null;
    },
    frame(t: number) {
      const cb = next;
      next = null;
      cb?.(t);
    },
  };
}

describe("FrameSampler", () => {
  it("records frame deltas only while active, and cancels on stop", () => {
    const frames = fakeFrames();
    const sampler = new FrameSampler(frames.source);
    expect(sampler.running).toBe(false);
    sampler.setActive(true);
    expect(sampler.running).toBe(true);
    frames.frame(0); // first frame has no delta
    frames.frame(16);
    frames.frame(33);
    expect(sampler.ring.count).toBe(2);
    sampler.setActive(false);
    expect(frames.cancelled).toHaveLength(1);
    expect(frames.pending).toBe(false);
    sampler.setActive(false);
    expect(frames.cancelled).toHaveLength(1);
  });

  it("forgets the last frame time when restarted, so a pause is not one giant frame", () => {
    const frames = fakeFrames();
    const sampler = new FrameSampler(frames.source);
    sampler.setActive(true);
    frames.frame(0);
    frames.frame(16);
    sampler.setActive(false);
    sampler.setActive(true);
    frames.frame(10_000);
    expect(sampler.ring.count).toBe(1);
    frames.frame(10_016);
    expect(sampler.ring.stats()?.p95).toBe(16);
  });

  it("take() returns a summary with enough samples and empties the window", () => {
    const frames = fakeFrames();
    const sampler = new FrameSampler(frames.source);
    sampler.setActive(true);
    frames.frame(0);
    for (let i = 1; i <= 5; i++) frames.frame(i * 20);
    expect(sampler.take(MIN_PERF_SAMPLES)).toBeNull();
    expect(sampler.ring.count).toBe(0);

    sampler.setActive(true);
    frames.frame(0);
    for (let i = 1; i <= 12; i++) frames.frame(i * 20);
    const summary = sampler.take(MIN_PERF_SAMPLES);
    expect(summary?.samples).toBe(12);
    expect(summary?.fpsP50).toBeCloseTo(50);
    expect(sampler.ring.count).toBe(0);
  });
});

describe("normaliseMessage", () => {
  it("replaces URLs, hex ids and digit runs", () => {
    expect(normaliseMessage("Failed to load https://gamez.example/api/x?id=12")).toBe(
      "Failed to load <url>",
    );
    expect(normaliseMessage("ref 7f3a9c0bd21e failed")).toBe("ref <id> failed");
    expect(normaliseMessage("step 42 of 100")).toBe("step # of #");
  });

  it("removes e-mail addresses and mixed letter/digit tokens", () => {
    expect(normaliseMessage("no account bob.smith@example.org (sk_live42x9)")).toBe(
      "no account <email> (<id>)",
    );
  });

  it("keeps plain words and trims to 120 characters", () => {
    expect(normaliseMessage("  Cannot read property  ")).toBe("Cannot read property");
    expect(normaliseMessage("x".repeat(500))).toHaveLength(120);
  });

  it("accepts errors, numbers and odd values", () => {
    expect(normaliseMessage(new Error("boom 9"))).toBe("boom #");
    expect(normaliseMessage(404)).toBe("#");
    expect(normaliseMessage(undefined)).toBe("");
    expect(normaliseMessage({ toString: () => "hidden" })).toBe("");
  });
});

describe("detectPlatform", () => {
  it("classifies phones, tablets, installed apps and desktops", () => {
    expect(
      detectPlatform({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        standalone: false,
        touchPoints: 5,
      }),
    ).toEqual({ platform: "ios", device: "mobile" });
    expect(
      detectPlatform({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        standalone: false,
        touchPoints: 5,
      }),
    ).toEqual({ platform: "ios", device: "tablet" });
    expect(
      detectPlatform({
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari",
        standalone: false,
        touchPoints: 5,
      }),
    ).toEqual({ platform: "android", device: "mobile" });
    expect(
      detectPlatform({
        userAgent: "Mozilla/5.0 (Linux; Android 14; SM-X700) Safari",
        standalone: false,
        touchPoints: 5,
      }),
    ).toEqual({ platform: "android", device: "tablet" });
    expect(
      detectPlatform({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
        standalone: false,
        touchPoints: 0,
      }),
    ).toEqual({ platform: "web", device: "desktop" });
    expect(
      detectPlatform({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
        standalone: true,
        touchPoints: 0,
      }),
    ).toEqual({ platform: "pwa", device: "desktop" });
  });
});

describe("perf sampling decision", () => {
  it("samples the 25 % of sessions whose draw is below the rate", () => {
    expect(decidePerfSample(0)).toBe(true);
    expect(decidePerfSample(0.2499)).toBe(true);
    expect(decidePerfSample(0.25)).toBe(false);
    expect(decidePerfSample(0.99)).toBe(false);
  });

  it("counts only visible seconds", () => {
    expect(activeSeconds(59_999)).toBe(59);
    expect(activeSeconds(-5)).toBe(0);
  });
});

/** Fake browser: a clock, a visibility flag, and recorded sends and timers. */
function fakeEnv(over: Partial<TelemetryEnv> = {}) {
  let t = 1_000_000;
  let visible = true;
  const fetches: { url: string; body: string; headers: Record<string, string> }[] = [];
  const beacons: { url: string; body: string }[] = [];
  const intervals: { fn: () => void; ms: number; handle: number }[] = [];
  const cleared: unknown[] = [];
  const failFetch = { on: false };
  const env: TelemetryEnv = {
    sid: "sid-abcdefgh",
    build: "build-9",
    endpoint: "/api/telemetry",
    platform: "web",
    device: "desktop",
    now: () => t,
    perfNow: () => 480,
    random: () => 0.9,
    visible: () => visible,
    memoryMb: () => 64,
    fetch: (url, init) => {
      if (failFetch.on) throw new Error("network down");
      fetches.push({ url, body: init.body, headers: init.headers });
      return Promise.reject(new Error("offline"));
    },
    sendBeacon: (url, body) => {
      beacons.push({ url, body });
      return true;
    },
    setInterval: (fn, ms) => {
      const handle = intervals.length + 1;
      intervals.push({ fn, ms, handle });
      return handle;
    },
    clearInterval: (h) => cleared.push(h),
    frames: null,
    ...over,
  };
  return {
    env,
    fetches,
    beacons,
    intervals,
    cleared,
    failFetch,
    advance(ms: number) {
      t += ms;
    },
    setVisible(v: boolean) {
      visible = v;
    },
  };
}

function eventsOf(body: string): TelemetryEvent[] {
  return (JSON.parse(body) as TelemetryBatch).events;
}

describe("TelemetryCore batching", () => {
  it("sends session.start at once, then heartbeats carry the batch envelope", () => {
    const f = fakeEnv();
    const core = new TelemetryCore(f.env);
    core.start();
    expect(f.intervals[0]?.ms).toBe(HEARTBEAT_MS);
    // session.start is sent right away, so a session killed before the first
    // heartbeat (no pagehide) still counts.
    expect(f.fetches).toHaveLength(1);
    const first = JSON.parse(f.fetches[0]?.body ?? "{}") as TelemetryBatch;
    expect(first).toMatchObject({ v: 1, sid: "sid-abcdefgh", build: "build-9", contentHash: "" });
    expect(first.events).toEqual([
      { k: "session.start", platform: "web", device: "desktop", loadMs: 480 },
    ]);
    f.advance(60_000);
    f.intervals[0]?.fn();
    expect(f.fetches).toHaveLength(2);
    const sent = f.fetches[1];
    const batch = JSON.parse(sent?.body ?? "{}") as TelemetryBatch;
    expect(batch.events.map((e) => e.k)).toEqual(["session.heartbeat"]);
    expect(sent?.url).toBe("/api/telemetry");
    expect(sent?.headers["content-type"]).toBe("application/json");
    expect(sent?.headers.authorization).toBeUndefined();
  });

  it("adds a bearer header only when a token is set", () => {
    const f = fakeEnv();
    const core = new TelemetryCore(f.env);
    core.setContext({ token: "tok.en", mode: "classic", contentHash: "h1" });
    core.start();
    f.intervals[0]?.fn();
    expect(f.fetches[0]?.headers.authorization).toBe("Bearer tok.en");
    expect((JSON.parse(f.fetches[0]?.body ?? "{}") as TelemetryBatch).contentHash).toBe("h1");
  });

  it("never sends more than 20 events in one request", () => {
    const f = fakeEnv();
    const core = new TelemetryCore(f.env);
    core.start();
    // Five errors per minute at most, so spread them over several minutes.
    for (let minute = 0; minute < 5; minute++) {
      for (let i = 0; i < 5; i++) {
        f.advance(1000);
        core.reportError("error", `failure ${LETTERS[minute * 5 + i]} happened`);
      }
      f.advance(60_000);
    }
    f.intervals[0]?.fn();
    const sizes = f.fetches.map((x) => eventsOf(x.body).length);
    expect(sizes.every((n) => n <= 20)).toBe(true);
    // session.start, 25 errors and the heartbeat
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(27);
  });

  it("drops a failed send without retrying", async () => {
    const f = fakeEnv();
    const core = new TelemetryCore(f.env);
    core.start();
    f.fetches.length = 0; // session.start went out on its own
    f.intervals[0]?.fn();
    await Promise.resolve();
    expect(f.fetches).toHaveLength(1);
    expect(core.pending).toBe(0);
    f.failFetch.on = true;
    expect(() => f.intervals[0]?.fn()).not.toThrow();
  });
});

describe("TelemetryCore errors", () => {
  it("normalises messages before queueing", () => {
    const f = fakeEnv();
    const core = new TelemetryCore(f.env);
    core.start();
    f.fetches.length = 0; // session.start went out on its own
    core.reportError("unhandledrejection", new Error("GET https://x.test/a/12 failed"));
    f.intervals[0]?.fn();
    const events = eventsOf(f.fetches[0]?.body ?? "[]");
    expect(events.find((e) => e.k === "error")).toEqual({
      k: "error",
      kind: "unhandledrejection",
      message: "GET <url> failed",
    });
  });

  it("sends identical consecutive messages once", () => {
    const f = fakeEnv();
    const core = new TelemetryCore(f.env);
    core.start();
    f.fetches.length = 0; // session.start went out on its own
    core.reportError("error", "same");
    core.reportError("error", "same");
    core.reportError("error", "same 2");
    f.intervals[0]?.fn();
    const errors = eventsOf(f.fetches[0]?.body ?? "[]").filter((e) => e.k === "error");
    expect(errors).toHaveLength(2);
  });

  it("allows at most 5 error events per minute", () => {
    const f = fakeEnv();
    const core = new TelemetryCore(f.env);
    core.start();
    f.fetches.length = 0; // session.start went out on its own
    for (let i = 0; i < 9; i++) core.reportError("error", `failure ${LETTERS[i]} happened`);
    f.intervals[0]?.fn();
    const errors = eventsOf(f.fetches[0]?.body ?? "[]").filter((e) => e.k === "error");
    expect(errors).toHaveLength(5);
    f.advance(60_000);
    core.reportError("render", "later one");
    f.intervals[0]?.fn();
    const later = eventsOf(f.fetches[1]?.body ?? "[]");
    expect(later.find((e) => e.k === "error")).toEqual({
      k: "error",
      kind: "render",
      message: "later one",
    });
  });

  it("reports nothing before the session starts", () => {
    const f = fakeEnv();
    const core = new TelemetryCore(f.env);
    core.reportError("error", "early");
    expect(core.pending).toBe(0);
  });
});

describe("TelemetryCore session time and pagehide", () => {
  it("sends session.end with sendBeacon on pagehide, with visible seconds only", () => {
    const f = fakeEnv();
    const core = new TelemetryCore(f.env);
    core.setContext({ token: "t", mode: "classic", contentHash: "c" });
    core.start();
    f.advance(30_000);
    f.setVisible(false);
    core.setVisible(false);
    f.advance(600_000); // hidden: not session time
    core.setVisible(true);
    f.setVisible(true);
    f.advance(45_000);
    core.end();
    // Hiding the page flushed the start event by fetch; the end goes by beacon.
    expect(f.fetches).toHaveLength(1);
    expect(f.beacons).toHaveLength(1);
    const events = eventsOf(f.beacons[0]?.body ?? "[]");
    const end = events.at(-1);
    expect(end).toEqual({ k: "session.end", elapsedS: 75, mode: "classic" });
    expect(f.cleared).toHaveLength(1);
  });

  it("is idempotent and sends nothing after end", () => {
    const f = fakeEnv();
    const core = new TelemetryCore(f.env);
    core.start();
    core.end();
    core.end();
    core.reportError("error", "late");
    expect(f.beacons).toHaveLength(1);
  });

  it("falls back to keepalive fetch when sendBeacon refuses", () => {
    const f = fakeEnv({ sendBeacon: () => false });
    const core = new TelemetryCore(f.env);
    core.start();
    f.fetches.length = 0; // session.start went out on its own
    core.end();
    expect(f.fetches).toHaveLength(1);
    expect(eventsOf(f.fetches[0]?.body ?? "[]").at(-1)?.k).toBe("session.end");
  });
});

describe("TelemetryCore perf", () => {
  it("runs no frame sampler when the session is not sampled", () => {
    const frames = fakeFrames();
    const core = new TelemetryCore(fakeEnv({ frames: frames.source, random: () => 0.5 }).env);
    expect(core.perfEnabled).toBe(false);
    core.setContext({ mode: "classic", token: "", contentHash: "" });
    core.start();
    expect(frames.pending).toBe(false);
  });

  it("samples only while visible and inside a mode", () => {
    const frames = fakeFrames();
    const f = fakeEnv({ frames: frames.source, random: () => 0.1 });
    const core = new TelemetryCore(f.env);
    expect(core.perfEnabled).toBe(true);
    core.start();
    expect(frames.pending).toBe(false); // no mode yet
    core.setContext({ mode: "classic", token: "", contentHash: "" });
    expect(frames.pending).toBe(true);
    core.setVisible(false);
    expect(frames.pending).toBe(false);
    core.setVisible(true);
    expect(frames.pending).toBe(true);
    core.setContext({ mode: "", token: "", contentHash: "" });
    expect(frames.pending).toBe(false);
  });

  it("queues one perf event per window with fps from the frame times", () => {
    const frames = fakeFrames();
    const f = fakeEnv({ frames: frames.source, random: () => 0.1, memoryMb: () => 77 });
    const core = new TelemetryCore(f.env);
    core.setContext({ mode: "classic", token: "", contentHash: "" });
    core.start();
    f.fetches.length = 0; // session.start went out on its own
    frames.frame(0);
    for (let i = 1; i <= 20; i++) frames.frame(i * 20);
    f.advance(HEARTBEAT_MS);
    f.intervals[0]?.fn();
    const events = eventsOf(f.fetches[0]?.body ?? "[]");
    const perf = events.find((e) => e.k === "perf");
    expect(perf).toEqual({
      k: "perf",
      mode: "classic",
      fpsP50: expect.any(Number),
      fpsP95: expect.any(Number),
      frameMsP95: 20,
      samples: 20,
      heapMb: 77,
    });
    if (perf?.k === "perf") {
      expect(perf.fpsP50).toBeCloseTo(50);
      expect(perf.fpsP95).toBeCloseTo(50);
    }
  });

  it("never throws into the app when the frame source or fetch explodes", () => {
    const frames = fakeFrames();
    const f = fakeEnv({ frames: frames.source, random: () => 0.1 });
    const core = new TelemetryCore(f.env);
    core.setContext({ mode: "classic", token: "", contentHash: "" });
    core.start();
    f.failFetch.on = true;
    expect(() => {
      frames.frame(0);
      f.intervals[0]?.fn();
      core.end();
    }).not.toThrow();
  });
});

describe("module entry points without a browser", () => {
  it("startTelemetry and reportRenderError are no-ops without window", () => {
    expect(() => startTelemetry()).not.toThrow();
    expect(() => reportRenderError(new Error("boom"))).not.toThrow();
    expect(() =>
      setTelemetryContext({ token: "", mode: "classic", contentHash: "h" }),
    ).not.toThrow();
  });
});
