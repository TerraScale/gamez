-- Wave C shop plots (docs/design/wave-C.md §5): one row per plot, written by
-- the PlotAuctionDO outbox. The shop directory and the admin dashboard read it.

CREATE TABLE IF NOT EXISTS shop_index (
  id TEXT PRIMARY KEY,
  world TEXT,
  plot_id TEXT,
  state TEXT,
  owner_id TEXT,
  owner_name TEXT,
  shop_name TEXT,
  rent INTEGER NOT NULL DEFAULT 0,
  lease_ends_at INTEGER NOT NULL DEFAULT 0,
  auction_ends_at INTEGER NOT NULL DEFAULT 0,
  top_bid INTEGER,
  stock_count INTEGER NOT NULL DEFAULT 0,
  open INTEGER NOT NULL DEFAULT 0,
  plot_json TEXT,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS shop_index_world ON shop_index (world, state);
CREATE INDEX IF NOT EXISTS shop_index_owner ON shop_index (owner_id);
