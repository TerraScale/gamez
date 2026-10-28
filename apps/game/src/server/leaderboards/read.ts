/**
 * Runs a leaderboard query against the D1 read model (wave-B.md §4). OWNER:
 * T-leaderboards. Gameplay never reads these tables; the API is display only.
 */
import type { LeaderboardResponse } from "@gamez/protocol";
import {
  buildLeaderboardSql,
  mapLeaderboardRows,
  unavailableResponse,
  type LeaderboardParams,
} from "./query.ts";

/** True for D1/SQLite errors caused by a table that is not migrated yet. */
export function isMissingTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
}

/**
 * Rows of one board. A missing table answers available: false with no rows
 * (the caller decides the HTTP status); other errors are rethrown.
 */
export async function readLeaderboard(
  db: D1Database,
  q: LeaderboardParams,
): Promise<LeaderboardResponse> {
  const { sql, params } = buildLeaderboardSql(q);
  try {
    const res = await db
      .prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>();
    return {
      board: q.board,
      mode: q.mode,
      classId: q.classId,
      rows: mapLeaderboardRows(q.board, res.results),
      available: true,
    };
  } catch (err) {
    if (isMissingTable(err)) return unavailableResponse(q);
    throw err;
  }
}
