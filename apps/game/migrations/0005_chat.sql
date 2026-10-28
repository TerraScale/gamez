-- Wave B chat reports for the admin review queue (docs/design/wave-B.md §5).
-- Written by the ChatChannelDO outbox. pk = "<channel>/<messageId>/<reporterId>".

CREATE TABLE IF NOT EXISTS chat_report (
  id TEXT PRIMARY KEY,
  channel TEXT,
  message_id TEXT,
  reporter_id TEXT,
  reported_id TEXT,
  reason TEXT,
  text TEXT,
  at INTEGER,
  verdict TEXT,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_report_at ON chat_report (_deleted, at DESC);
CREATE INDEX IF NOT EXISTS chat_report_reported ON chat_report (reported_id);
