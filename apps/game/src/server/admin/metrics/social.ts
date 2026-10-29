/**
 * GET /api/admin/social (docs/design/admin-dashboard.md §2.6). OWNER: T-api-game.
 *
 * Chat and moderation actions come from Analytics Engine (chat.message,
 * mod.action). Open reports, guilds and the top-10 boards come from D1. The
 * boards reuse the leaderboard SQL of wave B (leaderboards/query.ts), so the
 * admin numbers match the public ones.
 */
import { currentSeason } from "@gamez/economy";
import type { AdminRange, AdminSocial, Distribution, Series } from "@gamez/protocol";
import type { SeriesRow, TotalsRow } from "../../analytics/types.ts";
import { buildLeaderboardSql, mapLeaderboardRows } from "../../leaderboards/query.ts";
import { SourceLog, dist, num, rows, seriesRows, toSeries, type MetricsDeps } from "./util.ts";

/** Top-N cap for ranked lists. */
const TOP = 20;
/** Rows on each board (§2.6: top 10). */
const BOARD_LIMIT = 10;
/** The leaderboards are classic-only (wave B, leaderboards/query.ts LEADERBOARD_MODES). */
const BOARD_MODE = "classic";
const GUILD_BANDS = ["1", "2-4", "5-9", "10-19", "20+"] as const;
const OUTCOME_LABELS: Record<string, string> = {
  ok: "Accepted",
  filtered: "Filtered",
  muted: "Muted",
  rate_limited: "Rate limited",
  guard: "Guard",
};

interface ChatStats {
  messages: number;
  blocked: number;
  series: Series[];
  byChannel: Distribution;
}

async function readChat(range: AdminRange, log: SourceLog): Promise<ChatStats> {
  const from = range.from;
  const to = range.to;
  const outcomes = await log.ae("chat.message", [] as TotalsRow[], (aq) =>
    aq.totals({
      metric: "chat.message",
      from,
      to,
      groupBy: ["outcome"],
      value: { op: "count" },
      limit: TOP,
    }),
  );
  const outcomeSeries = await log.ae("chat.message", [] as SeriesRow[], (aq) =>
    aq.series({
      metric: "chat.message",
      from,
      to,
      bucketMs: range.bucketMs,
      groupBy: ["outcome"],
      value: { op: "count" },
      limit: TOP,
    }),
  );
  const byChannel = await log.ae("chat.message", [] as TotalsRow[], (aq) =>
    aq.totals({
      metric: "chat.message",
      from,
      to,
      where: { outcome: "ok" },
      groupBy: ["channelKind"],
      value: { op: "count" },
      limit: TOP,
    }),
  );

  let messages = 0;
  let blocked = 0;
  for (const r of outcomes) {
    if (r.keys.outcome === "ok") messages += num(r.value);
    else blocked += num(r.value);
  }
  return {
    messages,
    blocked,
    series: toSeries(range, seriesRows(outcomeSeries, "outcome"), OUTCOME_LABELS),
    byChannel: dist(
      "chatByChannel",
      "Channel",
      byChannel.map((r) => ({ label: r.keys.channelKind ?? "", value: r.value })),
      "desc",
    ),
  };
}

interface ModStats {
  actions: Distribution;
  series: Series[];
}

async function readModActions(range: AdminRange, log: SourceLog): Promise<ModStats> {
  const totals = await log.ae("mod.action", [] as TotalsRow[], (aq) =>
    aq.totals({
      metric: "mod.action",
      from: range.from,
      to: range.to,
      groupBy: ["action"],
      value: { op: "count" },
      limit: TOP,
    }),
  );
  const series = await log.ae("mod.action", [] as SeriesRow[], (aq) =>
    aq.series({
      metric: "mod.action",
      from: range.from,
      to: range.to,
      bucketMs: range.bucketMs,
      groupBy: ["action"],
      value: { op: "count" },
      limit: TOP,
    }),
  );
  return {
    actions: dist(
      "modActions",
      "Actions",
      totals.map((r) => ({ label: r.keys.action ?? "", value: r.value })),
      "desc",
    ),
    series: toSeries(range, seriesRows(series, "action"), {}),
  };
}

interface ReportStats {
  open: number;
  reports: number;
}

/**
 * Open reports use the review-queue rule of admin/moderation.ts (not deleted,
 * against a real account, no verdict yet) and count the current state, not the
 * range. `reports` counts reports filed in the range.
 */
async function readReports(db: D1Database, range: AdminRange): Promise<ReportStats> {
  const [o] = await rows<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM chat_report
     WHERE _deleted = 0 AND reported_id IS NOT NULL AND reported_id <> ''
       AND (verdict IS NULL OR verdict = '')`,
  );
  const [r] = await rows<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM chat_report WHERE _deleted = 0 AND at >= ? AND at < ?`,
    range.from,
    range.to,
  );
  return { open: num(o?.n), reports: num(r?.n) };
}

interface GuildStats {
  count: number;
  members: number;
  sizeHistogram: Distribution;
}

async function readGuilds(db: D1Database): Promise<GuildStats> {
  const [t] = await rows<{ count: number; members: number }>(
    db,
    `SELECT COUNT(*) AS count, COALESCE(SUM(member_count), 0) AS members
     FROM guild_index WHERE _deleted = 0`,
  );
  const bands = await rows<{ label: string; n: number }>(
    db,
    `SELECT CASE WHEN member_count <= 1 THEN '1' WHEN member_count <= 4 THEN '2-4'
                 WHEN member_count <= 9 THEN '5-9' WHEN member_count <= 19 THEN '10-19'
                 ELSE '20+' END AS label,
            COUNT(*) AS n
     FROM guild_index WHERE _deleted = 0 GROUP BY label`,
  );
  const map = new Map(bands.map((b) => [b.label, num(b.n)]));
  return {
    count: num(t?.count),
    members: num(t?.members),
    sizeHistogram: dist(
      "guildSize",
      "Guild size",
      GUILD_BANDS.map((label) => ({ label, value: map.get(label) ?? 0 })),
    ),
  };
}

interface BoardRow {
  name: string;
  classId: string;
  value: number;
  accountId?: string;
}

function withAccount(row: Omit<BoardRow, "accountId">, accountId: string): BoardRow {
  return accountId ? { ...row, accountId } : row;
}

/**
 * Top rows of the classic level and rift boards (the wave B SQL, unchanged),
 * and of the arena ladder for the current season.
 */
async function readBoards(
  db: D1Database,
  log: SourceLog,
  season: string,
): Promise<{ level: BoardRow[]; rift: BoardRow[]; arena: BoardRow[] }> {
  const board = async (name: "level" | "rift"): Promise<BoardRow[]> => {
    const q = buildLeaderboardSql({
      board: name,
      mode: BOARD_MODE,
      classId: null,
      limit: BOARD_LIMIT,
    });
    const table = name === "level" ? "classic_hero" : "leaderboard_rift";
    return log.d1(table, [] as BoardRow[], async () => {
      const raw = await rows<Record<string, unknown>>(db, q.sql, ...q.params);
      return mapLeaderboardRows(name, raw).map((r) =>
        withAccount(
          { name: r.displayName || r.heroName, classId: r.classId, value: r.value },
          r.accountId,
        ),
      );
    });
  };
  const level = await board("level");
  const rift = await board("rift");
  const arena = await log.d1("arena_rating", [] as BoardRow[], async () => {
    const raw = await rows<{
      account_id: string | null;
      display_name: string | null;
      class_id: string | null;
      rating: number;
    }>(
      db,
      `SELECT account_id, display_name, class_id, rating FROM arena_rating
       WHERE _deleted = 0 AND season_id = ? AND mode = ?
       ORDER BY rating DESC, id ASC LIMIT ?`,
      season,
      BOARD_MODE,
      BOARD_LIMIT,
    );
    return raw.map((r) =>
      withAccount(
        { name: r.display_name ?? "", classId: r.class_id ?? "", value: num(r.rating) },
        r.account_id ?? "",
      ),
    );
  });
  return { level, rift, arena };
}

/** GET /api/admin/social. */
export async function readSocial(d: MetricsDeps, range: AdminRange): Promise<AdminSocial> {
  const log = new SourceLog(d);

  const chat = await readChat(range, log);
  const mod = await readModActions(range, log);
  const reports = await log.d1("chat_report", { open: 0, reports: 0 } as ReportStats, () =>
    readReports(d.db, range),
  );
  const guilds = await log.d1(
    "guild_index",
    { count: 0, members: 0, sizeHistogram: dist("guildSize", "Guild size", []) } as GuildStats,
    () => readGuilds(d.db),
  );
  const season = currentSeason(d.now).id;
  const boards = await readBoards(d.db, log, season);

  return {
    at: d.now,
    range,
    sources: log.sources,
    chat,
    moderation: {
      open: reports.open,
      reports: reports.reports,
      actions: mod.actions,
      series: mod.series,
    },
    guilds: {
      count: guilds.count,
      members: guilds.members,
      sizeHistogram: guilds.sizeHistogram,
    },
    leaderboards: {
      level: boards.level,
      rift: boards.rift,
      arena: boards.arena,
    },
  };
}
