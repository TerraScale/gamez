-- D1 read model, phase 0. Rows are written only by the sync queue consumer
-- (applyBatch in @gamez/sync); the Durable Objects stay authoritative.

CREATE TABLE IF NOT EXISTS character_summary (
  character_id TEXT PRIMARY KEY,
  account_id TEXT,
  mode TEXT,
  name TEXT,
  x INTEGER,
  y INTEGER,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS character_summary_account ON character_summary (account_id);

-- Max outbox seq seen per source DO. For lag monitoring only, never for skipping.
CREATE TABLE IF NOT EXISTS sync_cursor (
  source TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
