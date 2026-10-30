-- Admin player lookup read paths (admin/metrics/lookup.ts). Read-model indexes only;
-- no table or column changes, so no projection or StorageFormat change.

-- The player detail's recent ledger rows: WHERE account_id = ? AND _deleted = 0
-- ORDER BY at DESC, id DESC LIMIT n.
CREATE INDEX IF NOT EXISTS economy_ledger_account_at ON economy_ledger (account_id, at);

-- The player detail's current-season arena row: WHERE account_id = ? AND season_id = ?.
CREATE INDEX IF NOT EXISTS arena_rating_account_season ON arena_rating (account_id, season_id);
