/**
 * D1 read of the arena ladder (arena_rating, migration 0008). Display only:
 * never used for a rule. `available: false` when the table is not migrated yet.
 */
import type { ArenaLadderResponse, ArenaLadderRow } from "@gamez/protocol";

export interface LadderQuery {
  seasonId: string;
  mode: string;
  classId: string | null;
  limit: number;
}

type Row = {
  account_id: string;
  display_name: string;
  class_id: string;
  level: number;
  rating: number;
  wins: number;
  losses: number;
};

/** Top `limit` rated players of the season (rating DESC, account id ASC). */
export async function readLadder(db: D1Database, q: LadderQuery): Promise<ArenaLadderResponse> {
  const columns =
    "SELECT account_id, display_name, class_id, level, rating, wins, losses FROM arena_rating WHERE season_id = ? AND mode = ? AND _deleted = 0";
  const order = "ORDER BY rating DESC, account_id ASC LIMIT ?";
  try {
    const stmt = q.classId
      ? db
          .prepare(`${columns} AND class_id = ? ${order}`)
          .bind(q.seasonId, q.mode, q.classId, q.limit)
      : db.prepare(`${columns} ${order}`).bind(q.seasonId, q.mode, q.limit);
    const res = await stmt.all<Row>();
    const rows: ArenaLadderRow[] = res.results.map((r, i) => ({
      rank: i + 1,
      accountId: r.account_id,
      displayName: r.display_name,
      classId: r.class_id,
      level: r.level,
      rating: r.rating,
      wins: r.wins,
      losses: r.losses,
    }));
    return { seasonId: q.seasonId, rows, available: true };
  } catch (err) {
    if (/no such table/i.test(String(err))) {
      return { seasonId: q.seasonId, rows: [], available: false };
    }
    throw err;
  }
}
