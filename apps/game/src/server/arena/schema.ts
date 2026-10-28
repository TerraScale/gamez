/**
 * DDL of one ladder DO ("<mode>:<seasonId>", wave-C.md §6.3). Each statement
 * is run alone (the test fake accepts one statement per call).
 */
export const ARENA_SCHEMA: readonly string[] = [
  // Ghost pool and ratings. build_json NULL = never registered (cannot be a ghost).
  `CREATE TABLE IF NOT EXISTS arena_player (
    account_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    class_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    build_json TEXT,
    rating INTEGER NOT NULL,
    games INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  // Queue tickets. state: waiting | matched | failed. Idempotent by (account, opId).
  `CREATE TABLE IF NOT EXISTS arena_ticket (
    ticket_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    op_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    build_json TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    match_id TEXT,
    searches INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, op_id)
  )`,
  "CREATE INDEX IF NOT EXISTS arena_ticket_waiting ON arena_ticket (state, created_at)",
  // Match log (last 500 kept).
  `CREATE TABLE IF NOT EXISTS arena_match (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL UNIQUE,
    attacker_id TEXT NOT NULL,
    defender_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    json TEXT NOT NULL
  )`,
  // Per-account recent matches (last 20 kept).
  `CREATE TABLE IF NOT EXISTS arena_recent (
    account_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    match_id TEXT NOT NULL,
    PRIMARY KEY (account_id, match_id)
  )`,
  "CREATE INDEX IF NOT EXISTS arena_recent_seq ON arena_recent (account_id, seq)",
  // Fights reserved per account per UTC day.
  `CREATE TABLE IF NOT EXISTS arena_day (
    account_id TEXT NOT NULL,
    day INTEGER NOT NULL,
    fights INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, day)
  )`,
  // Crash-safe rewards and notices. step: coin -> xp -> notice -> done.
  `CREATE TABLE IF NOT EXISTS arena_reward (
    match_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    coin INTEGER NOT NULL,
    season_xp INTEGER NOT NULL,
    notify_account TEXT,
    notice_json TEXT,
    step TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    at INTEGER NOT NULL,
    next_at INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS arena_reward_open ON arena_reward (step, at)",
  // Dev-only build override per account (POST /api/dev/arena/build).
  `CREATE TABLE IF NOT EXISTS arena_dev_build (
    account_id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

/**
 * Columns added after the first schema shipped to local dev storage. Each runs
 * alone; "duplicate column" (already present) is ignored by the caller.
 */
export const ARENA_COLUMNS: readonly string[] = [
  "ALTER TABLE arena_reward ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0",
];
