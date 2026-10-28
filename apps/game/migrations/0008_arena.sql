-- Wave C arena ladder (docs/design/wave-C.md §6): written by the ArenaDO outbox.

CREATE TABLE IF NOT EXISTS arena_rating (
  id TEXT PRIMARY KEY,
  season_id TEXT,
  mode TEXT,
  account_id TEXT,
  display_name TEXT,
  class_id TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS arena_rating_ladder ON arena_rating (season_id, mode, rating DESC);
CREATE INDEX IF NOT EXISTS arena_rating_class ON arena_rating (season_id, mode, class_id, rating DESC);
