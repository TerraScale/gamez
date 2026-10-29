-- Admin dashboard read model (docs/design/admin-dashboard.md §6). OWNER: T-projections.
-- Fed by the outbox like every other table: pk + _version/_deleted/_updated_at,
-- every other column nullable or defaulted (tombstones insert bare rows).

-- One row per account per UTC day it was active (AccountDO.checkSession/touch).
-- id = "<accountId>/<day>", day = floor(epoch ms / 86400000).
CREATE TABLE IF NOT EXISTS account_activity (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  day INTEGER NOT NULL DEFAULT 0,
  kind TEXT,
  first_at INTEGER NOT NULL DEFAULT 0,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_activity_day ON account_activity (day, kind);
CREATE INDEX IF NOT EXISTS account_activity_account ON account_activity (account_id, day);

-- Battle pass progress per account and season (account/pass.ts). id = "<accountId>/<seasonId>".
CREATE TABLE IF NOT EXISTS pass_progress (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  season_id TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  premium INTEGER NOT NULL DEFAULT 0,
  premium_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pass_progress_season ON pass_progress (season_id, premium);

-- When a guest became registered (or registered directly); null for guests.
ALTER TABLE account_summary ADD COLUMN registered_at INTEGER;
CREATE INDEX IF NOT EXISTS account_summary_created ON account_summary (created_at);
