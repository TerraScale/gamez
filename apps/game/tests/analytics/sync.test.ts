import { describe, expect, it } from "vite-plus/test";
import {
  recordSyncMessage,
  syncLagMs,
  syncOutcome,
  syncSource,
  type SyncMessageSample,
} from "../../src/server/analytics/sync.ts";
import { RecordingAnalytics } from "./fake.ts";

const MAX = 10;

function sample(over: Partial<SyncMessageSample> = {}): SyncMessageSample {
  return {
    source: "character:acc_1:classic",
    records: 3,
    enqueuedAt: 1_000,
    now: 1_250,
    applyMs: 40,
    attempts: 1,
    rows: 3,
    ok: true,
    maxRetries: MAX,
    ...over,
  };
}

describe("syncSource", () => {
  it("keeps the prefix before the first colon", () => {
    expect(syncSource("character:acc_1:classic")).toBe("character");
    expect(syncSource("market:classic-town")).toBe("market");
    expect(syncSource("guild")).toBe("guild");
    expect(syncSource("")).toBe("unknown");
    expect(syncSource(":x")).toBe("unknown");
  });
});

describe("syncOutcome", () => {
  it("is ok on success regardless of attempts", () => {
    expect(syncOutcome(true, 1, MAX)).toBe("ok");
    expect(syncOutcome(true, 99, MAX)).toBe("ok");
  });

  it("is retry while attempts are below the limit, dead at the limit", () => {
    expect(syncOutcome(false, 1, MAX)).toBe("retry");
    expect(syncOutcome(false, MAX - 1, MAX)).toBe("retry");
    expect(syncOutcome(false, MAX, MAX)).toBe("dead");
    expect(syncOutcome(false, MAX + 1, MAX)).toBe("dead");
  });
});

describe("syncLagMs", () => {
  it("is now minus the enqueue time", () => {
    expect(syncLagMs(1_000, 1_250)).toBe(250);
  });

  it("clamps negative and non-finite lags to 0", () => {
    expect(syncLagMs(2_000, 1_000)).toBe(0);
    expect(syncLagMs(Number.NaN, 1_000)).toBe(0);
  });
});

describe("recordSyncMessage", () => {
  it("writes sync.batch and a d1.query for an applied message", () => {
    const a = new RecordingAnalytics();
    recordSyncMessage(a, sample());
    expect(a.of("sync.batch")).toEqual([
      {
        metric: "sync.batch",
        blobs: { source: "character", outcome: "ok" },
        doubles: { records: 3, lagMs: 250, applyMs: 40, attempts: 1 },
        index: undefined,
      },
    ]);
    expect(a.of("d1.query")).toEqual([
      {
        metric: "d1.query",
        blobs: { label: "sync.apply", outcome: "ok" },
        doubles: { ms: 40, rows: 3 },
        index: undefined,
      },
    ]);
  });

  it("writes retry for a failure below the limit", () => {
    const a = new RecordingAnalytics();
    recordSyncMessage(a, sample({ ok: false, attempts: 2, rows: 0 }));
    expect(a.of("sync.batch")[0]?.blobs.outcome).toBe("retry");
    expect(a.of("d1.query")[0]).toMatchObject({
      blobs: { label: "sync.apply", outcome: "error" },
      doubles: { rows: 0 },
    });
  });

  it("writes dead when the failing delivery exhausts the retries", () => {
    const a = new RecordingAnalytics();
    recordSyncMessage(a, sample({ ok: false, attempts: MAX }));
    expect(a.of("sync.batch")[0]).toMatchObject({
      blobs: { source: "character", outcome: "dead" },
      doubles: { attempts: MAX },
    });
  });

  it("takes the lag from the enqueue time, not from apply time", () => {
    const a = new RecordingAnalytics();
    recordSyncMessage(a, sample({ enqueuedAt: 10_000, now: 10_900, applyMs: 5 }));
    expect(a.of("sync.batch")[0]?.doubles).toMatchObject({ lagMs: 900, applyMs: 5 });
  });

  it("never throws, even when the writer does", () => {
    const boom = {
      write() {
        throw new Error("nope");
      },
      flush: () => Promise.resolve(),
    };
    expect(() => recordSyncMessage(boom, sample())).not.toThrow();
  });
});
