import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { Outbox, type ReplicationBatch } from "../src/index.ts";
import { FakeSqlStorage, FakeStorage } from "./fakes.ts";

function setup() {
  const sql = new FakeSqlStorage();
  const outbox = new Outbox(sql.asSql(), "character:a:classic");
  outbox.init();
  return { sql, outbox };
}

function collectingSink() {
  const batches: ReplicationBatch[] = [];
  return { batches, send: async (b: ReplicationBatch) => void batches.push(b) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Outbox.append", () => {
  test("init is idempotent", () => {
    const { outbox } = setup();
    expect(() => outbox.init()).not.toThrow();
    expect(outbox.size()).toBe(0);
  });

  test("seq is monotonic per source and version per (table, pk)", () => {
    const { outbox } = setup();
    const recs = [
      outbox.append("character_summary", "a", "upsert", { level: 1 }),
      outbox.append("character_summary", "a", "upsert", { level: 2 }),
      outbox.append("character_summary", "b", "upsert", { level: 1 }),
      outbox.append("guild", "a", "upsert", { name: "x" }),
      outbox.append("character_summary", "a", "delete", { ignored: true }),
      outbox.append("character_summary", "a", "upsert", { level: 3 }),
    ];
    expect(recs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(recs.map((r) => r.version)).toEqual([1, 2, 1, 1, 3, 4]);
    expect(recs[4]).toMatchObject({ op: "delete", payload: null });
  });

  test("seq and version keep growing after a flush deletes rows", async () => {
    const { outbox } = setup();
    outbox.append("t", "a", "upsert", {});
    outbox.append("t", "a", "upsert", {});
    await outbox.flush(collectingSink());
    expect(outbox.size()).toBe(0);
    expect(outbox.append("t", "a", "upsert", {})).toMatchObject({ seq: 3, version: 3 });
  });

  test("a rolled-back transaction leaves neither the row nor the version bump", () => {
    const { sql, outbox } = setup();
    outbox.append("t", "a", "upsert", { v: 1 });
    expect(() =>
      sql.transactionSync(() => {
        outbox.append("t", "a", "upsert", { v: 2 });
        throw new Error("game logic failed");
      }),
    ).toThrow("game logic failed");
    expect(outbox.size()).toBe(1);
    expect(outbox.append("t", "a", "upsert", { v: 3 }).version).toBe(2);
  });

  test("records the current time", () => {
    const { outbox } = setup();
    vi.spyOn(Date, "now").mockReturnValue(1234);
    expect(outbox.append("t", "a", "upsert", {}).at).toBe(1234);
  });
});

describe("Outbox.pending", () => {
  test("returns the oldest records in seq order with payloads round-tripped", () => {
    const { outbox } = setup();
    const payload = { name: "Ash", pos: { x: 1.5, y: -2 }, tags: ["a"], none: null };
    const appended = [
      outbox.append("t", "b", "upsert", payload),
      outbox.append("t", "a", "upsert", 7),
      outbox.append("t", "c", "delete", null),
      outbox.append("t", "a", "upsert", "text"),
    ];
    expect(outbox.pending()).toEqual(appended);
    expect(outbox.pending(2)).toEqual(appended.slice(0, 2));
    expect(outbox.size()).toBe(4);
  });

  test("an undefined upsert payload is stored as null", () => {
    const { outbox } = setup();
    outbox.append("t", "a", "upsert", undefined);
    expect(outbox.pending()[0]!.payload).toBeNull();
  });
});

describe("Outbox.flush", () => {
  test("sends batches of at most maxBatch in seq order, then deletes them", async () => {
    const { outbox } = setup();
    for (let i = 0; i < 7; i++) outbox.append("t", `pk${i}`, "upsert", { i });
    const sizesDuringSend: number[] = [];
    const sink = collectingSink();
    const sent = await outbox.flush(
      {
        send: async (b) => {
          sizesDuringSend.push(outbox.size());
          await sink.send(b);
        },
      },
      3,
    );
    expect(sent).toBe(7);
    expect(sink.batches.map((b) => b.records.length)).toEqual([3, 3, 1]);
    expect(sink.batches.every((b) => b.source === "character:a:classic")).toBe(true);
    expect(sink.batches.flatMap((b) => b.records.map((r) => r.seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Rows are still there while each send is in flight.
    expect(sizesDuringSend).toEqual([7, 4, 1]);
    expect(outbox.size()).toBe(0);
  });

  test("returns 0 and sends nothing when empty", async () => {
    const { outbox } = setup();
    const sink = collectingSink();
    expect(await outbox.flush(sink)).toBe(0);
    expect(sink.batches).toEqual([]);
  });

  test("records appended during a send are kept for the next flush", async () => {
    const { outbox } = setup();
    outbox.append("t", "a", "upsert", 1);
    const sink = collectingSink();
    await outbox.flush({
      send: async (b) => {
        outbox.append("t", "a", "upsert", 2);
        await sink.send(b);
      },
    });
    expect(sink.batches).toHaveLength(1);
    expect(outbox.pending()).toMatchObject([{ seq: 2, version: 2, payload: 2 }]);
  });

  test("a throwing sink keeps the unsent rows and rethrows", async () => {
    const { outbox } = setup();
    for (let i = 0; i < 5; i++) outbox.append("t", `pk${i}`, "upsert", { i });
    let calls = 0;
    const failing = {
      send: async () => {
        if (++calls === 2) throw new Error("queue unavailable");
      },
    };
    await expect(outbox.flush(failing, 2)).rejects.toThrow("queue unavailable");
    expect(outbox.pending().map((r) => r.seq)).toEqual([3, 4, 5]);

    const sink = collectingSink();
    expect(await outbox.flush(sink, 2)).toBe(3);
    expect(sink.batches.flatMap((b) => b.records.map((r) => r.seq))).toEqual([3, 4, 5]);
  });

  test("rejects a non-positive maxBatch", async () => {
    const { outbox } = setup();
    await expect(outbox.flush(collectingSink(), 0)).rejects.toThrow("maxBatch");
  });
});

describe("Outbox.scheduleFlush", () => {
  test("sets an alarm delayMs from now when none is pending", async () => {
    const { outbox } = setup();
    const storage = new FakeStorage();
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    await outbox.scheduleFlush(storage.asStorage(), 500);
    expect(storage.alarm).toBe(10_500);
    await outbox.scheduleFlush(storage.asStorage());
    expect(storage.alarm).toBe(10_500);
  });

  test("does not overwrite an existing alarm", async () => {
    const { outbox } = setup();
    const storage = new FakeStorage();
    storage.alarm = 42;
    await outbox.scheduleFlush(storage.asStorage());
    expect(storage.alarm).toBe(42);
    expect(storage.setAlarmCalls).toBe(0);
  });
});
