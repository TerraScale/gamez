# @gamez/sync

Sync engine v1: Durable Object SQLite (authoritative) -> D1 (read model).

```
DO write + Outbox.append()   (same transactionSync)
  -> alarm: Outbox.flush(queueSink)   ReplicationBatch per send
  -> queue consumer: applyBatch(env.DB, batch, projections)
```

## Guarantees

- **Atomic capture.** `append()` runs inside the caller's `transactionSync`, so a
  state change and its outbox record commit or roll back together.
- **Ordering metadata.** `seq` is monotonic per source DO (AUTOINCREMENT, never
  reused). `version` is monotonic per (table, pk) and survives deletes and
  flushes (`_outbox_versions` is never pruned).
- **At-least-once delivery.** `flush()` deletes rows only after `sink.send()`
  resolves. A failed send keeps the rows and rethrows so the alarm retries.
  Duplicates and reordering are expected downstream.
- **Convergence.** Every D1 write is guarded by `excluded._version > _version`,
  and deletes are tombstones (`_deleted = 1`). Duplicate, replayed or
  out-of-order batches therefore leave D1 at the latest state per pk, and an
  old upsert can never resurrect a deleted row. `_updated_at` is the record's
  `at`, so replays write identical rows.
- **`sync_cursor` is monitoring only.** It stores the max seq seen per source
  (lag = DO seq minus `last_seq`) and is never used to skip records.

## Using it

- Call `outbox.init()` once per DO start (idempotent), and
  `await outbox.scheduleFlush(ctx.storage)` after writes. It never overwrites an
  existing alarm, so if the DO uses its alarm for other things, call `flush()`
  from that alarm handler too.
- `flush()` stops after the first batch shorter than `maxBatch`. Records
  appended meanwhile wait for the next alarm.
- `applyBatch()` coalesces records per (table, pk) to the newest version, then
  writes in `db.batch()` calls of at most `MAX_STATEMENTS_PER_D1_BATCH` (100)
  statements plus the cursor upsert. Partial application is safe because every
  statement is version-guarded. Keep `queue max_batch_size x statements` under
  D1's per-invocation query limit.
- Records for tables without a projection are counted as `unknown`, logged
  and dropped. Invalid projections (identifiers not matching
  `/^[a-z_][a-z0-9_]*$/`, `toRow()` returning the pk or a meta column, more
  than 97 columns) throw before anything is written.

## D1 schema rules

Every projected table needs the pk column plus
`_version INTEGER NOT NULL`, `_deleted INTEGER NOT NULL DEFAULT 0` and
`_updated_at INTEGER NOT NULL`. Other columns must be nullable or have a
default, because a delete for an unseen pk inserts a bare tombstone row.
`toRow()` should return every column, since columns it omits keep their old
value. Readers filter on `_deleted = 0`. Create the cursor table with
`SYNC_CURSOR_DDL`.

## Limits and assumptions

- Each (table, pk) must be written by exactly one source DO, since versions
  are per source. Wiping a DO's storage restarts its versions, so D1 would
  ignore it until that projection is rebuilt.
- Queue messages are capped at 128 KB. Size `maxBatch` (or split in the sink)
  for your payloads.

## Tests

`tests/` runs the real code against `node:sqlite` fakes of `SqlStorage`,
`D1Database` and the DO alarm API, including a seeded chaos test that delivers
flaky, shuffled and duplicated batches and checks convergence.
