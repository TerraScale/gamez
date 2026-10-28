import { describe, expect, it } from "vite-plus/test";
import { DO_ACTIVE_EVERY_MS } from "../../src/server/analytics/schema.ts";
import { DO_ACTIVE_MAX_KEYS, markDoActive } from "../../src/server/analytics/do-active.ts";
import {
  chatWsMode,
  WS_ABNORMAL_CLOSE,
  wsClosed,
  wsOpened,
} from "../../src/server/analytics/ws.ts";
import { RecordingAnalytics } from "./fake.ts";

describe("wsOpened / wsClosed", () => {
  it("writes ws.open with kind and mode", () => {
    const a = new RecordingAnalytics();
    wsOpened(a, "presence", "classic-town");
    expect(a.of("ws.open")).toEqual([
      {
        metric: "ws.open",
        blobs: { kind: "presence", mode: "classic-town" },
        doubles: {},
        index: undefined,
      },
    ]);
  });

  it("writes ws.close with the code as a string and the duration in seconds", () => {
    const a = new RecordingAnalytics();
    wsClosed(a, "chat", "global", 1000, 1_000_000, 1_000_000 + 12_345);
    const [p] = a.of("ws.close");
    expect(p?.blobs).toEqual({ kind: "chat", mode: "global", code: "1000" });
    expect(p?.doubles.durationS).toBe(12.3);
  });

  it("counts a missing or future open time as 0 seconds", () => {
    const a = new RecordingAnalytics();
    wsClosed(a, "presence", "plaza", 1001, undefined, 5_000);
    wsClosed(a, "presence", "plaza", 1001, 9_000, 5_000);
    expect(a.of("ws.close").map((p) => p.doubles.durationS)).toEqual([0, 0]);
  });

  it("records a socket error as the abnormal close code", () => {
    const a = new RecordingAnalytics();
    wsClosed(a, "presence", "plaza", WS_ABNORMAL_CLOSE, 0, 2_000);
    expect(a.of("ws.close")[0]?.blobs.code).toBe("1006");
  });

  it("never throws", () => {
    const boom = {
      write() {
        throw new Error("nope");
      },
      flush: () => Promise.resolve(),
    };
    expect(() => wsOpened(boom, "chat", "global")).not.toThrow();
    expect(() => wsClosed(boom, "chat", "global", 1000, 0, 1)).not.toThrow();
  });
});

describe("chatWsMode", () => {
  it("maps channels to bounded modes (guild ids are dropped)", () => {
    expect(chatWsMode("global")).toBe("global");
    expect(chatWsMode("mode:classic")).toBe("classic");
    expect(chatWsMode("guild:forest-wardens")).toBe("guild");
    expect(chatWsMode("whatever")).toBe("unknown");
  });
});

describe("markDoActive", () => {
  // Each test uses its own class name so the per-isolate map starts clean for it.
  it("writes once per class:id per slot", () => {
    const a = new RecordingAnalytics();
    const t0 = 1_000_000_000;
    expect(markDoActive(a, "T1", "x", t0)).toBe(true);
    expect(markDoActive(a, "T1", "x", t0 + 1000)).toBe(false);
    expect(markDoActive(a, "T1", "x", t0 + DO_ACTIVE_EVERY_MS - 1)).toBe(false);
    expect(markDoActive(a, "T1", "x", t0 + DO_ACTIVE_EVERY_MS)).toBe(true);
    expect(a.of("do.active")).toHaveLength(2);
  });

  it("keeps classes and ids apart", () => {
    const a = new RecordingAnalytics();
    const t0 = 2_000_000_000;
    markDoActive(a, "T2", "a", t0);
    markDoActive(a, "T2", "b", t0);
    markDoActive(a, "T3", "a", t0);
    const got = a.of("do.active").map((p) => [p.blobs.class, p.index]);
    expect(got).toEqual([
      ["T2", "a"],
      ["T2", "b"],
      ["T3", "a"],
    ]);
  });

  it("writes again when the clock goes backwards", () => {
    const a = new RecordingAnalytics();
    markDoActive(a, "T4", "x", 5_000_000_000);
    expect(markDoActive(a, "T4", "x", 4_000_000_000)).toBe(true);
  });

  it("bounds the remembered keys", () => {
    const a = new RecordingAnalytics();
    const t0 = 3_000_000_000;
    for (let i = 0; i < DO_ACTIVE_MAX_KEYS + 10; i++) markDoActive(a, "T5", `id${i}`, t0);
    // The first key was forgotten, so it writes again within the slot.
    expect(markDoActive(a, "T5", "id0", t0 + 1)).toBe(true);
  });
});
