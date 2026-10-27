/**
 * Sync benchmark: DO-side Outbox (append in transactions, then flush) and the
 * D1-side applyBatch, for batch sizes 10, 100 and 500. Uses the in-memory
 * node:sqlite fakes from packages/sync/tests, so SQL semantics match
 * production but commits are not durable: read these as relative numbers.
 * Run with `pnpm --filter @gamez/bench bench:sync`.
 */
import {
  applyBatch,
  Outbox,
  SYNC_CURSOR_DDL,
  type OutboxRecord,
  type ProjectionMap,
} from "@gamez/sync";
import { FakeD1Database, FakeSqlStorage } from "../../../packages/sync/tests/fakes.ts";
import { CHARACTER_SUMMARY_DDL, characterSummary } from "../../../packages/sync/tests/fixtures.ts";
import { fmt, measureAsync, printTable, writeResults, type Timing } from "./lib.ts";

const RECORDS = 5_000;
const KEYS = 500;
const BATCH_SIZES = [10, 100, 500];
const SOURCE = "character:bench:classic";
const projections: ProjectionMap = { character_summary: characterSummary };

const summary = (n: number) => ({ name: `hero${n % KEYS}`, level: n });

interface OutboxState {
  outbox: Outbox;
  sql: FakeSqlStorage;
}

const newOutbox = (): OutboxState => {
  const sql = new FakeSqlStorage();
  const outbox = new Outbox(sql.asSql(), SOURCE);
  outbox.init();
  return { outbox, sql };
};

/** Appends RECORDS upserts, committing every `batch` appends in one transaction. */
function appendAll({ outbox, sql }: OutboxState, batch: number): void {
  for (let start = 0; start < RECORDS; start += batch) {
    sql.transactionSync(() => {
      const end = Math.min(start + batch, RECORDS);
      for (let i = start; i < end; i++) {
        outbox.append("character_summary", `c${i % KEYS}`, "upsert", summary(i));
      }
    });
  }
}

// ---- Outbox: append + flush(maxBatch) ----------------------------------------

const outboxRows: Timing[] = [];
for (const batch of BATCH_SIZES) {
  let sends = 0;
  const row = await measureAsync(
    `batch ${batch}`,
    "records",
    RECORDS,
    async (state: OutboxState) => {
      appendAll(state, batch);
      sends = 0;
      await state.outbox.flush(
        {
          send: async () => {
            sends++;
          },
        },
        batch,
      );
    },
    newOutbox,
    { minIterations: 3, minTimeMs: 1000 },
  );
  row.extra = { sendsPerCycle: sends };
  outboxRows.push(row);
}

// ---- applyBatch (D1 side) ----------------------------------------------------

/** Builds a D1 fake synchronously (the exec() wrapper runs its SQL immediately). */
function newD1(): FakeD1Database {
  const d1 = new FakeD1Database();
  d1.db.exec(CHARACTER_SUMMARY_DDL);
  d1.db.exec(SYNC_CURSOR_DDL);
  return d1;
}

function replicationRecords(): OutboxRecord[] {
  const out: OutboxRecord[] = [];
  for (let i = 0; i < RECORDS; i++) {
    out.push({
      seq: i + 1,
      table: "character_summary",
      pk: `c${i}`,
      op: "upsert",
      version: 1,
      payload: summary(i),
      at: i,
    });
  }
  return out;
}

interface ApplyState {
  d1: FakeD1Database;
  all: OutboxRecord[];
}

const applyRows: Timing[] = [];
for (const batch of BATCH_SIZES) {
  let d1Calls = 0;
  const row = await measureAsync(
    `batch ${batch}`,
    "records",
    RECORDS,
    async ({ d1, all }: ApplyState) => {
      for (let i = 0; i < all.length; i += batch) {
        await applyBatch(
          d1.asD1(),
          { source: SOURCE, records: all.slice(i, i + batch) },
          projections,
        );
      }
      d1Calls = d1.batchSizes.length;
    },
    () => ({ d1: newD1(), all: replicationRecords() }),
    { minIterations: 3, minTimeMs: 1000 },
  );
  row.extra = { d1BatchCallsPerCycle: d1Calls };
  applyRows.push(row);
}

printTable("Sync: Outbox append (one transaction per batch) + flush(maxBatch)", outboxRows);
printTable("Sync: applyBatch into the D1 fake, replication batch size", applyRows);
console.log(
  `\n${fmt(RECORDS, 0)} records per cycle over ${KEYS} keys. Sends per cycle: ${outboxRows
    .map((r) => `${r.name} -> ${r.extra?.sendsPerCycle}`)
    .join(", ")}.`,
);

writeResults("sync", { outbox: outboxRows, applyBatch: applyRows });
