-- Wave C auction house + sales (docs/design/wave-C.md §4, §9). Written only by
-- the MarketDO / ShopDO outboxes through the sync queue. Search, "my listings"
-- and the price index read it; gameplay never does.

CREATE TABLE IF NOT EXISTS market_listing (
  id TEXT PRIMARY KEY,
  shard TEXT,
  scope TEXT,
  category TEXT,
  seller_id TEXT,
  seller_name TEXT,
  item_id TEXT,
  name TEXT,
  name_lower TEXT,
  rarity TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  slot TEXT,
  icon TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  -- the full MarketListing JSON (what the search API returns)
  listing_json TEXT,
  buyout INTEGER,
  start_bid INTEGER,
  top_bid INTEGER,
  top_bidder_id TEXT,
  -- sort key: buyout, else top bid, else start bid
  price INTEGER NOT NULL DEFAULT 0,
  bids INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  ends_at INTEGER NOT NULL DEFAULT 0,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS market_listing_browse ON market_listing (status, scope, category, price);
CREATE INDEX IF NOT EXISTS market_listing_ending ON market_listing (status, ends_at);
CREATE INDEX IF NOT EXISTS market_listing_seller ON market_listing (seller_id, status);
CREATE INDEX IF NOT EXISTS market_listing_bidder ON market_listing (top_bidder_id, status);

CREATE TABLE IF NOT EXISTS economy_sale (
  id TEXT PRIMARY KEY,
  venue TEXT,
  scope TEXT,
  category TEXT,
  item_id TEXT,
  name TEXT,
  rarity TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  seller_id TEXT,
  buyer_id TEXT,
  at INTEGER NOT NULL DEFAULT 0,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS economy_sale_day ON economy_sale (at, category);
