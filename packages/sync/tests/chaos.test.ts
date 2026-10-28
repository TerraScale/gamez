import { describe, expect, test } from "vite-plus/test";
import { applyBatch, Outbox, type ProjectionMap, type ReplicationBatch } from "../src/index.ts";
import { FakeSqlStorage } from "./fakes.ts";
import { characterSummary, prng, setupD1, type Summary } from "./fixtures.ts";

/**
 * Property-style test: a random history of upserts/deletes goes through a real
 * Outbox with a flaky sink (lost sends, sends that succeed but aren't acked),
 * then the produced batches are delivered shuffled and duplicated. D1 must
 * end equal to the latest state per pk, and a full replay must change nothing.
 */

const projections: ProjectionMap = { character_summary: characterSummary };
const PKS = ["ash", "misty", "brock", "gary", "oak", "jenny"];

interface Latest {
  version: number;
  deleted: boolean;
  payload: Summary | null;
}

async function runSeed(seed: number) {
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  const outbox = new Outbox(new FakeSqlStorage().asSql(), `character:chaos:${seed}`);
  outbox.init();
  const latest = new Map<string, Latest>();
  const produced: ReplicationBatch[] = [];
  let flaky = true;
  const sink = {
    send: async (b: ReplicationBatch) => {
      const r = flaky ? rand() : 1;
      if (r < 0.15) throw new Error("send lost");
      produced.push(structuredClone(b));
      if (r < 0.3) throw new Error("sent but not acked");
    },
  };

  let maxSeq = 0;
  for (let step = 0; step < 400; step++) {
    if (rand() < 0.75) {
      const pk = pick(PKS);
      const op = rand() < 0.2 ? "delete" : "upsert";
      const payload: Summary = { name: `${pk}-${step}`, level: step };
      const r = outbox.append("character_summary", pk, op, payload);
      expect(r.version).toBe((latest.get(pk)?.version ?? 0) + 1);
      expect(r.seq).toBe(maxSeq + 1);
      maxSeq = r.seq;
      latest.set(pk, { version: r.version, deleted: op === "delete", payload });
    } else {
      await outbox.flush(sink, 1 + Math.floor(rand() * 20)).catch(() => {});
    }
  }
  flaky = false;
  await outbox.flush(sink, 7);
  expect(outbox.size()).toBe(0);

  // Every record reached the sink at least once.
  const seen = new Set(produced.flatMap((b) => b.records.map((r) => r.seq)));
  expect(seen.size).toBe(maxSeq);

  const deliveries = produced.flatMap((b) => (rand() < 0.3 ? [b, b] : [b]));
  for (let i = deliveries.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deliveries[i], deliveries[j]] = [deliveries[j]!, deliveries[i]!];
  }

  const d1 = await setupD1();
  let applied = 0;
  for (const b of deliveries) {
    const res = await applyBatch(d1.asD1(), b, projections);
    expect(res.applied + res.stale).toBe(b.records.length);
    expect(res.unknown).toBe(0);
    applied += res.applied;
  }
  expect(applied).toBeGreaterThanOrEqual(latest.size);

  const rows = d1.rows("character_summary");
  expect(rows).toHaveLength(latest.size);
  for (const row of rows) {
    const want = latest.get(String(row.id))!;
    expect(row._version).toBe(want.version);
    expect(row._deleted).toBe(want.deleted ? 1 : 0);
    if (!want.deleted) expect({ name: row.name, level: row.level }).toEqual(want.payload);
  }
  expect(d1.rows("sync_cursor")).toMatchObject([{ last_seq: maxSeq }]);

  // Replaying everything, in reverse, writes nothing.
  for (const b of deliveries.toReversed()) {
    expect((await applyBatch(d1.asD1(), b, projections)).applied).toBe(0);
  }
  expect(d1.rows("character_summary")).toEqual(rows);
}

describe("sync chaos", () => {
  test.each([1, 2, 3, 7, 42, 1337, 2026, 65535])("seed %i converges to the latest state", runSeed);
});
