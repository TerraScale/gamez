-- Wave C economy telemetry + purchases (docs/design/wave-C.md §8, §9): written
-- by the AccountDO outbox. Admin dashboard only (money supply, faucets vs
-- sinks, revenue). High churn: move to Pipelines -> R2 when it grows (plan §4).

CREATE TABLE IF NOT EXISTS account_wallet (
  account_id TEXT PRIMARY KEY,
  coin INTEGER NOT NULL DEFAULT 0,
  gem INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS economy_ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  tx_id TEXT,
  currency TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  flow TEXT,
  reason_group TEXT,
  reason TEXT,
  at INTEGER NOT NULL DEFAULT 0,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS economy_ledger_day ON economy_ledger (at, flow, reason_group);

CREATE TABLE IF NOT EXISTS purchase (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  sku TEXT,
  provider TEXT,
  currency TEXT,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  provider_ref TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS purchase_day ON purchase (status, updated_at);
CREATE INDEX IF NOT EXISTS purchase_account ON purchase (account_id);
