-- Wave B guild search (docs/design/wave-B.md §6). Written by the GuildDO
-- outbox; a disbanded guild is a tombstone (_deleted = 1).

CREATE TABLE IF NOT EXISTS guild_index (
  guild_id TEXT PRIMARY KEY,
  name TEXT,
  tag TEXT,
  open INTEGER NOT NULL DEFAULT 1,
  member_count INTEGER NOT NULL DEFAULT 0,
  leader_id TEXT,
  created_at INTEGER,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS guild_index_members ON guild_index (_deleted, member_count DESC);
