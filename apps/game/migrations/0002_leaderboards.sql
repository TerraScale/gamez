-- Wave B leaderboards (docs/design/wave-B.md §4). Rows come only from the
-- InstanceDO outbox (VerifiedHost reports of the classic mode) through the
-- sync queue. pk = "<instanceName>/<report key>". Never read for gameplay.

CREATE TABLE IF NOT EXISTS classic_hero (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  display_name TEXT,
  mode TEXT,
  imported INTEGER NOT NULL DEFAULT 0,
  hero_name TEXT,
  class_id TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  deepest_depth INTEGER NOT NULL DEFAULT 0,
  rift_best_level INTEGER NOT NULL DEFAULT 0,
  rift_best_score INTEGER NOT NULL DEFAULT 0,
  play_ticks INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS classic_hero_level ON classic_hero (level DESC, xp DESC);
CREATE INDEX IF NOT EXISTS classic_hero_depth ON classic_hero (deepest_depth DESC, level DESC);
CREATE INDEX IF NOT EXISTS classic_hero_class ON classic_hero (class_id, level DESC);
CREATE INDEX IF NOT EXISTS classic_hero_account ON classic_hero (account_id);

CREATE TABLE IF NOT EXISTS leaderboard_rift (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  display_name TEXT,
  mode TEXT,
  imported INTEGER NOT NULL DEFAULT 0,
  hero_name TEXT,
  class_id TEXT,
  hero_level INTEGER NOT NULL DEFAULT 0,
  rift_level INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  ticks INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  run INTEGER NOT NULL DEFAULT 0,
  end_tick INTEGER NOT NULL DEFAULT 0,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS leaderboard_rift_score ON leaderboard_rift (completed, score DESC);
CREATE INDEX IF NOT EXISTS leaderboard_rift_class ON leaderboard_rift (class_id, completed, score DESC);
CREATE INDEX IF NOT EXISTS leaderboard_rift_account ON leaderboard_rift (account_id);
