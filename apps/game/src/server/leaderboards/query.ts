/**
 * Leaderboard query parsing and SQL builders (wave-B.md §4). Pure: no D1 here,
 * so the rules are unit-tested without a database. OWNER: T-leaderboards.
 *
 * Only bound parameters reach SQL. Column names come from the fixed maps below.
 */
import type { LeaderboardBoard, LeaderboardResponse, LeaderboardRow } from "@gamez/protocol";

export const LEADERBOARD_BOARDS: readonly LeaderboardBoard[] = ["level", "depth", "rift"];
/** Only the classic mode has boards in wave B. */
export const LEADERBOARD_MODES: readonly string[] = ["classic"];
export const LIMIT_DEFAULT = 50;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;

const CLASS_ID = /^classic\.[a-z][a-z0-9_]{0,31}$/;

/** A validated leaderboard request (limit already clamped). */
export interface LeaderboardParams {
  board: LeaderboardBoard;
  mode: string;
  classId: string | null;
  limit: number;
}

export type ParsedQuery = { ok: true; query: LeaderboardParams } | { ok: false; message: string };

/** Clamps a limit to LIMIT_MIN..LIMIT_MAX; missing or non-numeric means LIMIT_DEFAULT. */
export function clampLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return LIMIT_DEFAULT;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.floor(n)));
}

/** Validates ?board=&mode=&classId=&limit= . */
export function parseLeaderboardQuery(params: URLSearchParams): ParsedQuery {
  const board = params.get("board") ?? "";
  if (!(LEADERBOARD_BOARDS as readonly string[]).includes(board)) {
    return { ok: false, message: "board must be one of level, depth, rift" };
  }
  const mode = params.get("mode") ?? "classic";
  if (!LEADERBOARD_MODES.includes(mode)) {
    return { ok: false, message: "mode must be classic" };
  }
  const classRaw = params.get("classId");
  const classId = classRaw === null || classRaw === "" ? null : classRaw;
  if (classId !== null && !CLASS_ID.test(classId)) {
    return { ok: false, message: "classId must look like classic.<name>" };
  }
  return {
    ok: true,
    query: {
      board: board as LeaderboardBoard,
      mode,
      classId,
      limit: clampLimit(params.get("limit")),
    },
  };
}

export interface SqlQuery {
  sql: string;
  params: (string | number)[];
}

/**
 * SQL for one board. Rows are never deleted (_deleted = 0). Ties break on id
 * so the order is stable across requests.
 */
export function buildLeaderboardSql(q: LeaderboardParams): SqlQuery {
  const classClause = q.classId === null ? "" : " AND class_id = ?";
  const classParams: (string | number)[] = q.classId === null ? [] : [q.classId];
  switch (q.board) {
    case "level":
      return {
        sql:
          "SELECT id, account_id, display_name, hero_name, class_id, level, xp, imported, _updated_at" +
          " FROM classic_hero WHERE _deleted = 0 AND mode = ?" +
          classClause +
          " ORDER BY level DESC, xp DESC, id ASC LIMIT ?",
        params: [q.mode, ...classParams, q.limit],
      };
    case "depth":
      return {
        sql:
          "SELECT id, account_id, display_name, hero_name, class_id, level, xp, deepest_depth, imported, _updated_at" +
          " FROM classic_hero WHERE _deleted = 0 AND mode = ?" +
          classClause +
          " ORDER BY deepest_depth DESC, level DESC, id ASC LIMIT ?",
        params: [q.mode, ...classParams, q.limit],
      };
    case "rift":
      // Best completed run per account (window over account), then ranked by score.
      return {
        sql:
          "SELECT * FROM (" +
          "SELECT id, account_id, display_name, hero_name, class_id, hero_level, rift_level, score, ticks, deaths," +
          " end_tick, imported, _updated_at," +
          " ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY score DESC, end_tick ASC, id ASC) AS rn" +
          " FROM leaderboard_rift WHERE _deleted = 0 AND completed = 1 AND mode = ?" +
          classClause +
          ") WHERE rn = 1 ORDER BY score DESC, end_tick ASC, id ASC LIMIT ?",
        params: [q.mode, ...classParams, q.limit],
      };
  }
}

type Row = Record<string, unknown>;

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : 0;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Maps D1 rows (in query order) to ranked LeaderboardRow values. */
export function mapLeaderboardRows(board: LeaderboardBoard, rows: Row[]): LeaderboardRow[] {
  return rows.map((r, i): LeaderboardRow => {
    const base = {
      rank: i + 1,
      accountId: str(r.account_id),
      displayName: str(r.display_name),
      heroName: str(r.hero_name),
      classId: str(r.class_id),
      imported: num(r.imported) === 1,
      updatedAt: num(r._updated_at),
    };
    if (board === "rift") {
      return {
        ...base,
        heroLevel: num(r.hero_level),
        value: num(r.score),
        extra: {
          riftLevel: num(r.rift_level),
          ticks: num(r.ticks),
          deaths: num(r.deaths),
        },
      };
    }
    if (board === "depth") {
      return {
        ...base,
        heroLevel: num(r.level),
        value: num(r.deepest_depth),
        extra: { xp: num(r.xp) },
      };
    }
    return {
      ...base,
      heroLevel: num(r.level),
      value: num(r.level),
      extra: { xp: num(r.xp) },
    };
  });
}

/** The response for a board whose table is not migrated yet. */
export function unavailableResponse(q: LeaderboardParams): LeaderboardResponse {
  return { board: q.board, mode: q.mode, classId: q.classId, rows: [], available: false };
}
