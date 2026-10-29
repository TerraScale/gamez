import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReplicationBatch } from "@gamez/sync";
import {
  consumeSyncBatch,
  SYNC_DLQ_RETRY_SECONDS,
  SYNC_MAX_RETRIES,
  SYNC_STATEMENT_BUDGET,
  type SyncConsumerDeps,
} from "../../src/server/sync-consumer.ts";
import type { SyncMessageSample } from "../../src/server/analytics/sync.ts";

type FakeMessage = {
  body: ReplicationBatch;
  attempts: number;
  acked: boolean;
  retries: Array<{ delaySeconds?: number } | undefined>;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

function message(records: number, attempts = 1, source = "market:classic:weapon"): FakeMessage {
  const msg: FakeMessage = {
    body: {
      source,
      records: Array.from({ length: records }, (_, i) => ({
        seq: i + 1,
        table: "t",
        pk: `pk${i}`,
        op: "upsert",
        version: 1,
        payload: { i },
        at: 0,
      })),
    },
    attempts,
    acked: false,
    retries: [],
    ack() {
      msg.acked = true;
    },
    retry(options) {
      msg.retries.push(options);
    },
  };
  return msg;
}

function batchOf(queue: string, messages: FakeMessage[]) {
  return { queue, messages } as unknown as MessageBatch<ReplicationBatch>;
}

const ok = { applied: 1, stale: 0, unknown: 0 };
const env = { DB: {} as D1Database };

function deps(overrides: Partial<SyncConsumerDeps> = {}): SyncConsumerDeps {
  return {
    applyBatch: vi.fn(async () => ok),
    projections: {},
    ...overrides,
  } as SyncConsumerDeps;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumeSyncBatch: retries", () => {
  it("acks a message that applies", async () => {
    const msg = message(2);
    await consumeSyncBatch(batchOf("gamez-sync", [msg]), env, deps());
    expect(msg.acked).toBe(true);
    expect(msg.retries).toEqual([]);
  });

  it("retries a failure with a delay that grows with attempts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = deps({
      applyBatch: vi.fn(async () => {
        throw new Error("D1 unavailable");
      }),
    });
    const first = message(1, 1);
    const second = message(1, 2);
    const third = message(1, 3);
    await consumeSyncBatch(batchOf("gamez-sync", [first, second, third]), env, failing);

    expect(first.retries).toEqual([{ delaySeconds: 10 }]);
    expect(second.retries).toEqual([{ delaySeconds: 20 }]);
    expect(third.retries).toEqual([{ delaySeconds: 40 }]);
    expect(first.acked || second.acked || third.acked).toBe(false);
  });

  it("caps the retry delay at 900 seconds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = deps({
      applyBatch: vi.fn(async () => {
        throw new Error("D1 unavailable");
      }),
    });
    const late = message(1, 12);
    await consumeSyncBatch(batchOf("gamez-sync", [late]), env, failing);
    expect(late.retries).toEqual([{ delaySeconds: 900 }]);
  });
});

describe("consumeSyncBatch: statement budget", () => {
  it("applies messages up to the budget and retries the rest with a short delay", async () => {
    const applied: string[] = [];
    const applyBatch = vi.fn(async (_db: D1Database, batch: ReplicationBatch) => {
      applied.push(batch.source);
      return ok;
    });
    // Each message costs records + 1 statements: 301 each, so the third exceeds 800.
    const a = message(300);
    const b = message(300);
    const c = message(300);
    const d = message(300);
    await consumeSyncBatch(batchOf("gamez-sync", [a, b, c, d]), env, deps({ applyBatch }));

    expect(SYNC_STATEMENT_BUDGET).toBe(800);
    expect(applied).toHaveLength(2);
    expect(a.acked && b.acked).toBe(true);
    expect(c.acked || d.acked).toBe(false);
    expect(c.retries).toEqual([{ delaySeconds: 2 }]);
    expect(d.retries).toEqual([{ delaySeconds: 2 }]);
  });

  it("never passes a budget-skipped message to applyBatch", async () => {
    const applied: string[] = [];
    const applyBatch = vi.fn(async (_db: D1Database, batch: ReplicationBatch) => {
      applied.push(batch.source);
      return ok;
    });
    const a = message(300, 1, "a");
    const b = message(300, 1, "b");
    const c = message(300, 1, "c");
    await consumeSyncBatch(batchOf("gamez-sync", [a, b, c]), env, deps({ applyBatch }));
    expect(applied).toEqual(["a", "b"]);
    expect(c.retries).toEqual([{ delaySeconds: 2 }]);
    expect(c.acked).toBe(false);
  });

  it("applies a full batch of four 200-record messages within the budget", async () => {
    const applyBatch = vi.fn(async () => ok);
    const msgs = [message(200), message(200), message(200), message(200)];
    await consumeSyncBatch(batchOf("gamez-sync", msgs), env, deps({ applyBatch }));
    // 4 x 201 = 804 would be over budget; the fourth one is skipped and retried.
    expect(applyBatch).toHaveBeenCalledTimes(3);
    expect(msgs[3]!.retries).toEqual([{ delaySeconds: 2 }]);
  });
});

describe("consumeSyncBatch: DLQ consumer", () => {
  it("re-applies dead-lettered batches and acks on success", async () => {
    const applyBatch = vi.fn(async () => ok);
    const msg = message(3, 7);
    await consumeSyncBatch(batchOf("gamez-sync-dlq", [msg]), env, deps({ applyBatch }));
    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(msg.acked).toBe(true);
  });

  it("logs each failure with source and record count, then retries with 900 seconds", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = deps({
      applyBatch: vi.fn(async () => {
        throw new Error("D1 unavailable");
      }),
    });
    const msg = message(5, 9, "chat:global");
    await consumeSyncBatch(batchOf("gamez-sync-dlq", [msg]), env, failing);

    expect(SYNC_DLQ_RETRY_SECONDS).toBe(900);
    expect(msg.retries).toEqual([{ delaySeconds: 900 }]);
    expect(errors).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ source: "chat:global", records: 5 }),
    );
  });
});

describe("consumeSyncBatch: admin instrumentation (admin-dashboard.md §2.7)", () => {
  it("records each applied or failed main-queue message before its ack or retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const samples: SyncMessageSample[] = [];
    let calls = 0;
    const applyBatch = vi.fn(async () => {
      if (++calls === 2) throw new Error("D1 unavailable");
      return { applied: 3, stale: 0, unknown: 0 };
    });
    const good = message(3, 1, "character:acc:classic");
    const bad = message(1, SYNC_MAX_RETRIES, "chat:global");
    const skipped = [message(900, 1, "market:classic:weapon")];
    const bySource = new Map([
      [good.body.source, good],
      [bad.body.source, bad],
    ]);
    const record = (s: SyncMessageSample) => {
      const msg = bySource.get(s.source)!;
      // Recorded before the ack or retry decision is made.
      expect(msg.acked).toBe(false);
      expect(msg.retries).toEqual([]);
      samples.push(s);
    };
    await consumeSyncBatch(
      batchOf("gamez-sync", [good, bad, ...skipped]),
      env,
      deps({ applyBatch, record }),
    );
    expect(samples.map((s) => [s.source, s.ok, s.rows, s.attempts])).toEqual([
      ["character:acc:classic", true, 3, 1],
      ["chat:global", false, 0, SYNC_MAX_RETRIES],
    ]);
    expect(samples.every((s) => s.maxRetries === SYNC_MAX_RETRIES)).toBe(true);
    expect(skipped[0]!.retries).toEqual([{ delaySeconds: 2 }]);
  });

  it("never records DLQ re-applies", async () => {
    const record = vi.fn();
    await consumeSyncBatch(batchOf("gamez-sync-dlq", [message(2)]), env, deps({ record }));
    expect(record).not.toHaveBeenCalled();
  });
});
