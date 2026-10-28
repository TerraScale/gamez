-- Wave B accounts read model (docs/design/wave-B.md §3): admin views and
-- display-name lookups only. Written by the AccountDO outbox.

CREATE TABLE IF NOT EXISTS account_summary (
  account_id TEXT PRIMARY KEY,
  display_name TEXT,
  kind TEXT,
  created_at INTEGER,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);
