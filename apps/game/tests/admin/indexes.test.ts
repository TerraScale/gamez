/**
 * Migration 0011 (admin player lookup indexes): the lookup reads use an index
 * rather than scanning the table. Checked with EXPLAIN QUERY PLAN over the same
 * SQL that admin/metrics/lookup.ts runs.
 */
import { describe, expect, it } from "vite-plus/test";
import { FakeD1 } from "../leaderboards/fake-d1.ts";

const MIGRATIONS = [
  "0001_init.sql",
  "0002_leaderboards.sql",
  "0003_accounts.sql",
  "0004_guilds.sql",
  "0005_chat.sql",
  "0006_market.sql",
  "0007_shops.sql",
  "0008_arena.sql",
  "0009_economy.sql",
  "0010_admin.sql",
  "0011_admin_indexes.sql",
];

/** The plan details of a query, e.g. "SEARCH economy_ledger USING INDEX economy_ledger_account_at (account_id=?)". */
function plan(d1: FakeD1, sql: string): string[] {
  const rows = d1.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
  return rows.map((r) => r.detail);
}

describe("admin lookup indexes (migration 0011)", () => {
  it("applies after every earlier migration", () => {
    const d1 = new FakeD1();
    expect(() => d1.migrate(MIGRATIONS)).not.toThrow();
    const names = (
      d1.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toContain("economy_ledger_account_at");
    expect(names).toContain("arena_rating_account_season");
  });

  it("serves the player's recent ledger rows from the account index", () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const details = plan(
      d1,
      `SELECT at, amount FROM economy_ledger WHERE account_id = 'a' AND _deleted = 0
       ORDER BY at DESC, id DESC LIMIT 25`,
    );
    expect(details.join("\n")).toContain("economy_ledger_account_at");
  });

  it("serves the player's current-season arena row from the account index", () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const details = plan(
      d1,
      `SELECT season_id, rating FROM arena_rating WHERE account_id = 'a' AND season_id = 's1'
       AND _deleted = 0 ORDER BY rating DESC LIMIT 1`,
    );
    expect(details.join("\n")).toContain("arena_rating_account_season");
  });

  it("keeps the hero lookup on the existing classic_hero account index", () => {
    // 0002 already indexes classic_hero(account_id); a second one would only cost writes.
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const details = plan(
      d1,
      "SELECT hero_name FROM classic_hero WHERE account_id = 'a' AND _deleted = 0",
    );
    expect(details.join("\n")).toContain("classic_hero_account");
  });
});
