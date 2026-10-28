// node:v8 typings: tests/node-sqlite.d.ts (the package has no @types/node).
import { serialize } from "node:v8";
import { describe, expect, test, vi } from "vite-plus/test";
import { estimateRecordBytes, Outbox, type ReplicationBatch } from "../src/index.ts";
import { FakeSqlStorage } from "./fakes.ts";

/** Cloudflare Queues rejects message bodies above 128 KiB. */
const QUEUE_LIMIT = 128 * 1024;

function setup() {
  const sql = new FakeSqlStorage();
  const outbox = new Outbox(sql.asSql(), "market:classic:weapon");
  outbox.init();
  return { sql, outbox };
}

/**
 * A sink with the queue's real size limit: it throws the way Queue.send does
 * when the v8-serialised body is too large. Successful batches are recorded.
 */
function queueLikeSink() {
  const sent: ReplicationBatch[] = [];
  const sizes: number[] = [];
  let rejected = 0;
  return {
    sent,
    sizes,
    get rejected() {
      return rejected;
    },
    send: async (batch: ReplicationBatch) => {
      const size = serialize(batch).length;
      if (size > QUEUE_LIMIT) {
        rejected++;
        throw new Error(`Message too large: ${size} bytes`);
      }
      sizes.push(size);
      sent.push(batch);
    },
  };
}

/** About 1.2 KB of market_listing-like JSON. Every 5th record has non-Latin1 text. */
function listingPayload(i: number) {
  const nonLatin = i % 5 === 0;
  return {
    id: `listing-${i}`,
    item: {
      name: nonLatin ? "名剣 of the Ashen Hollow" : "Iron Sword of the Ashen Hollow",
      lines: Array.from({ length: 8 }, (_, j) => `+${j} line ${j} stat bonus text`),
    },
    seller: { id: `acct-${i}`, name: nonLatin ? "売り手" : "Seller" },
    topBidder: null,
    price: 1000 + i,
    expiresAt: 1_700_000_000_000 + i,
    description: (nonLatin ? "剣".repeat(550) : "d".repeat(1100)) + `#${i}`,
  };
}

describe("Outbox.flush byte budget", () => {
  test("200 listing-sized records flush in batches that all fit the queue limit", async () => {
    const { outbox } = setup();
    for (let i = 1; i <= 200; i++)
      outbox.append("market_listing", `l${i}`, "upsert", listingPayload(i));

    const sink = queueLikeSink();
    const sent = await outbox.flush(sink, 200);

    expect(sink.rejected).toBe(0);
    expect(sink.sizes.every((s) => s <= QUEUE_LIMIT)).toBe(true);
    expect(sink.sent.length).toBeGreaterThan(1);
    expect(sent).toBe(200);
    expect(sink.sent.flatMap((b) => b.records.map((r) => r.seq))).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1),
    );
    expect(outbox.size()).toBe(0);
  });

  test("an oversize head record is reported and does not block later records", async () => {
    const { outbox } = setup();
    outbox.append("t", "small-1", "upsert", { v: 1 });
    outbox.append("chat_report", "huge", "upsert", { text: "x".repeat(200 * 1024) });
    outbox.append("t", "small-3", "upsert", { v: 3 });
    outbox.append("t", "small-4", "upsert", { v: 4 });

    const sink = queueLikeSink();
    const onOversize = vi.fn();
    const sent = await outbox.flush(sink, 200, { onOversize });

    expect(onOversize).toHaveBeenCalledTimes(1);
    expect(onOversize.mock.calls[0]![0]).toMatchObject({
      seq: 2,
      table: "chat_report",
      pk: "huge",
    });
    expect(sink.sent.flatMap((b) => b.records.map((r) => r.seq))).toEqual([1, 3, 4]);
    expect(sent).toBe(3);
    expect(outbox.size()).toBe(0);
  });

  test("a head oversize record at the start of the outbox does not stop the flush", async () => {
    const { outbox } = setup();
    outbox.append("chat_report", "huge", "upsert", { text: "x".repeat(200 * 1024) });
    outbox.append("t", "small", "upsert", { v: 1 });

    const sink = queueLikeSink();
    const onOversize = vi.fn();
    await outbox.flush(sink, 200, { onOversize });

    expect(onOversize).toHaveBeenCalledTimes(1);
    expect(sink.sent.flatMap((b) => b.records.map((r) => r.seq))).toEqual([2]);
    expect(outbox.size()).toBe(0);
  });

  test("a send that reports too large is retried once with the first half of the batch", async () => {
    const { outbox } = setup();
    for (let i = 0; i < 10; i++) outbox.append("t", `pk${i}`, "upsert", { i });

    const delivered: ReplicationBatch[] = [];
    const sink = {
      send: async (batch: ReplicationBatch) => {
        // Small records, so the byte estimate never cuts. The sink is what rejects.
        if (batch.records.length > 5) throw new Error("payload exceeds the message limit");
        delivered.push(batch);
      },
    };
    const sent = await outbox.flush(sink, 10);

    expect(sent).toBe(10);
    expect(delivered.map((b) => b.records.length)).toEqual([5, 5]);
    expect(delivered.flatMap((b) => b.records.map((r) => r.seq))).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    expect(outbox.size()).toBe(0);
  });

  test("a send error unrelated to size is rethrown without halving, and rows stay", async () => {
    const { outbox } = setup();
    for (let i = 0; i < 4; i++) outbox.append("t", `pk${i}`, "upsert", { i });
    const send = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    await expect(outbox.flush({ send }, 4)).rejects.toThrow("queue unavailable");
    expect(send).toHaveBeenCalledTimes(1);
    expect(outbox.size()).toBe(4);
  });
});

describe("estimateRecordBytes", () => {
  test("is the JSON length plus overhead, doubled for non-Latin1 text", () => {
    const ascii = outboxRecord("a", { text: "abc" });
    const json = JSON.stringify(ascii);
    expect(estimateRecordBytes(ascii)).toBe(json.length + 32);

    const wide = outboxRecord("a", { text: "名剣" });
    const wideJson = JSON.stringify(wide);
    expect(estimateRecordBytes(wide)).toBe(wideJson.length * 2 + 32);
  });

  test("Latin1 text (up to U+00FF) is not doubled", () => {
    const latin = outboxRecord("a", { text: "café ÿ" });
    expect(estimateRecordBytes(latin)).toBe(JSON.stringify(latin).length + 32);
  });
});

function outboxRecord(pk: string, payload: unknown) {
  return {
    seq: 1,
    table: "t",
    pk,
    op: "upsert" as const,
    version: 1,
    payload,
    at: 0,
  };
}
