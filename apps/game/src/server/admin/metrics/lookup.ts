/**
 * GET /api/admin/players/search?q=&cursor= and GET /api/admin/players/<accountId>
 * (docs/design/admin-dashboard.md §2.8). OWNER: T-api-players.
 *
 * Search is D1 only. The detail reads D1 for the account, the live AccountDO
 * (wallet, guild) only once the account row exists, and AE for the recent
 * server events. A failed source yields its empty value, never an error.
 */
import { currentSeason } from "@gamez/economy";
import type {
  AdminPlayerDetail,
  AdminPlayerSearch,
  AdminRange,
  Distribution,
} from "@gamez/protocol";
import type { GuildMembership } from "../../contracts.ts";
import type { TotalsRow } from "../../analytics/types.ts";
import { DAY_MS, dist, num, rows, SourceLog, type MetricsDeps } from "./util.ts";

export const SEARCH_PAGE = 25;
/** Ledger and purchase rows returned by the detail (newest first). */
export const DETAIL_ROWS = 50;
/** Classic simulates at 20 ticks per second. */
const TICKS_PER_SECOND = 20;
/** Days counted by activeDays30. */
const ACTIVE_WINDOW_DAYS = 30;

interface SearchRow {
  accountId: string;
  displayName: string;
  kind: string;
  createdAt: number;
}

interface AccountRow {
  accountId: string;
  displayName: string;
  kind: string;
  createdAt: number;
  registeredAt: number | null;
}

/** Keyset cursor "<created_at>:<account_id>" (account ids may contain ':'). */
export function encodeCursor(createdAt: number, accountId: string): string {
  return `${createdAt}:${accountId}`;
}

/** Parses a cursor; null for a missing or malformed one (the first page is answered). */
export function decodeCursor(
  cursor: string | null,
): { createdAt: number; accountId: string } | null {
  if (!cursor) return null;
  const sep = cursor.indexOf(":");
  if (sep <= 0) return null;
  const createdAt = Number(cursor.slice(0, sep));
  const accountId = cursor.slice(sep + 1);
  if (!Number.isSafeInteger(createdAt) || accountId === "") return null;
  return { createdAt, accountId };
}

/** By account id prefix or display name (case-insensitive substring), newest first. */
export async function searchPlayers(
  d: MetricsDeps,
  q: string,
  cursor: string | null,
): Promise<AdminPlayerSearch> {
  const log = new SourceLog(d);
  const where: string[] = ["s._deleted = 0"];
  const params: unknown[] = [];

  if (q !== "") {
    // Prefix of the account id (code points) or a substring of the display name.
    where.push("(substr(s.account_id, 1, ?) = ? OR instr(lower(s.display_name), lower(?)) > 0)");
    params.push(Array.from(q).length, q, q);
  }
  const after = decodeCursor(cursor);
  if (after) {
    where.push(
      "(COALESCE(s.created_at, 0) < ? OR (COALESCE(s.created_at, 0) = ? AND s.account_id > ?))",
    );
    params.push(after.createdAt, after.createdAt, after.accountId);
  }
  params.push(SEARCH_PAGE + 1);

  const sql = `SELECT s.account_id AS accountId, COALESCE(s.display_name, '') AS displayName,
      COALESCE(s.kind, '') AS kind, COALESCE(s.created_at, 0) AS createdAt
    FROM account_summary s
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(s.created_at, 0) DESC, s.account_id ASC
    LIMIT ?`;
  const found = await log.d1<SearchRow[]>("account_summary", [], () =>
    rows<SearchRow>(d.db, sql, ...params),
  );

  const page = found.slice(0, SEARCH_PAGE).map((r) => ({
    accountId: String(r.accountId),
    displayName: String(r.displayName ?? ""),
    kind: String(r.kind ?? ""),
    createdAt: num(r.createdAt),
  }));
  const more = found.length > SEARCH_PAGE;
  const tail = page[page.length - 1];
  const next = more && tail ? encodeCursor(tail.createdAt, tail.accountId) : null;

  // Last activity day (day start ms) of the page's accounts.
  const ids = page.map((r) => r.accountId);
  const lastDay = new Map<string, number>();
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(", ");
    const found = await log.d1<{ accountId: string; day: number }[]>("account_activity", [], () =>
      rows<{ accountId: string; day: number }>(
        d.db,
        `SELECT account_id AS accountId, MAX(day) AS day FROM account_activity
         WHERE _deleted = 0 AND account_id IN (${marks}) GROUP BY account_id`,
        ...ids,
      ),
    );
    for (const r of found) lastDay.set(String(r.accountId), num(r.day));
  }

  return {
    q,
    rows: page.map((r) => ({
      ...r,
      lastActiveDay: (lastDay.get(r.accountId) ?? 0) * DAY_MS,
    })),
    next,
  };
}

/** Null when the account is unknown everywhere (route answers 404). */
export async function readPlayer(
  d: MetricsDeps,
  accountId: string,
  range: AdminRange,
): Promise<AdminPlayerDetail | null> {
  const log = new SourceLog(d);

  const summary = await log.d1<AccountRow | null>("account_summary", null, async () => {
    const [row] = await rows<AccountRow>(
      d.db,
      `SELECT account_id AS accountId, COALESCE(display_name, '') AS displayName,
        COALESCE(kind, '') AS kind, COALESCE(created_at, 0) AS createdAt,
        registered_at AS registeredAt
       FROM account_summary WHERE account_id = ? AND _deleted = 0`,
      accountId,
    );
    return row ?? null;
  });
  // No summary row (or the table is unreadable): the account is unknown, and the DO is never created here.
  if (!summary) return null;

  const lastDay = await log.d1<number>("account_activity", 0, async () => {
    const [row] = await rows<{ day: number | null }>(
      d.db,
      "SELECT MAX(day) AS day FROM account_activity WHERE account_id = ? AND _deleted = 0",
      accountId,
    );
    return num(row?.day);
  });

  // Wallet: live AccountDO first (the row exists, so the DO is safe to address), D1 otherwise.
  const live = await log.live<{ balances: { coin: number; gem: number } } | null>(
    "ACCOUNT.wallet",
    null,
    () => d.env.ACCOUNT.getByName(accountId).wallet(),
  );
  const wallet: AdminPlayerDetail["wallet"] = live
    ? { coin: num(live.balances.coin), gem: num(live.balances.gem), source: "live" }
    : await log
        .d1<{ coin: number; gem: number } | null>("account_wallet", null, async () => {
          const [row] = await rows<{ coin: number; gem: number }>(
            d.db,
            "SELECT coin, gem FROM account_wallet WHERE account_id = ? AND _deleted = 0",
            accountId,
          );
          return row ?? null;
        })
        .then((row) => ({ coin: num(row?.coin), gem: num(row?.gem), source: "d1" as const }));

  const heroRows = await log.d1<
    {
      mode: string;
      heroName: string;
      classId: string;
      level: number;
      deepestDepth: number;
      kills: number;
      deaths: number;
      playTicks: number;
      updatedAt: number;
    }[]
  >("classic_hero", [], () =>
    rows(
      d.db,
      `SELECT COALESCE(mode, '') AS mode, COALESCE(hero_name, '') AS heroName,
        COALESCE(class_id, '') AS classId, level, deepest_depth AS deepestDepth,
        kills, deaths, play_ticks AS playTicks, _updated_at AS updatedAt
       FROM classic_hero WHERE account_id = ? AND _deleted = 0
       ORDER BY _updated_at DESC, id ASC`,
      accountId,
    ),
  );
  const heroes = heroRows.map((h) => ({
    mode: String(h.mode),
    heroName: String(h.heroName),
    classId: String(h.classId),
    level: num(h.level),
    deepestDepth: num(h.deepestDepth),
    kills: num(h.kills),
    deaths: num(h.deaths),
    playHours: num(h.playTicks) / TICKS_PER_SECOND / 3600,
    updatedAt: num(h.updatedAt),
  }));

  const ledger = await log.d1<
    { at: number; currency: string; amount: number; flow: string; reason: string }[]
  >("economy_ledger", [], async () =>
    (
      await rows<{ at: number; currency: string; amount: number; flow: string; reason: string }>(
        d.db,
        `SELECT at, COALESCE(currency, 'coin') AS currency, amount,
          COALESCE(flow, '') AS flow, COALESCE(reason, '') AS reason
         FROM economy_ledger WHERE account_id = ? AND _deleted = 0
         ORDER BY at DESC, id DESC LIMIT ?`,
        accountId,
        DETAIL_ROWS,
      )
    ).map((r) => ({
      at: num(r.at),
      currency: String(r.currency),
      amount: num(r.amount),
      flow: String(r.flow),
      reason: String(r.reason),
    })),
  );

  const purchases = await log.d1<AdminPlayerDetail["purchases"]>("purchase", [], async () =>
    (
      await rows<{
        id: string;
        sku: string;
        provider: string;
        currency: string;
        amountMinor: number;
        status: string;
        at: number;
      }>(
        d.db,
        `SELECT id, COALESCE(sku, '') AS sku, COALESCE(provider, '') AS provider,
          COALESCE(currency, '') AS currency, amount_minor AS amountMinor,
          COALESCE(status, '') AS status, updated_at AS at
         FROM purchase WHERE account_id = ? AND _deleted = 0
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
        accountId,
        DETAIL_ROWS,
      )
    ).map((r) => ({
      id: String(r.id),
      sku: String(r.sku),
      provider: String(r.provider),
      currency: String(r.currency),
      amountMinor: num(r.amountMinor),
      status: String(r.status),
      at: num(r.at),
    })),
  );

  // Reports against the account; "open" follows admin/moderation.ts (no verdict yet).
  const reports = await log.d1<AdminPlayerDetail["reports"]>(
    "chat_report",
    { against: 0, open: 0 },
    async () => {
      const [row] = await rows<{ against: number; open: number }>(
        d.db,
        `SELECT COUNT(*) AS against,
          COALESCE(SUM(CASE WHEN verdict IS NULL OR verdict = '' THEN 1 ELSE 0 END), 0) AS open
         FROM chat_report WHERE reported_id = ? AND _deleted = 0`,
        accountId,
      );
      return { against: num(row?.against), open: num(row?.open) };
    },
  );

  // Guild: live membership, named from guild_index (the guild id when the name is unknown).
  const membership = await log.live<GuildMembership | null>("ACCOUNT.guild", null, () =>
    d.env.ACCOUNT.getByName(accountId).guild(),
  );
  let guild: AdminPlayerDetail["guild"] = null;
  if (membership) {
    const name = await log.d1<string>("guild_index", membership.guildId, async () => {
      const [row] = await rows<{ name: string | null }>(
        d.db,
        "SELECT name FROM guild_index WHERE guild_id = ? AND _deleted = 0",
        membership.guildId,
      );
      return row?.name ? String(row.name) : membership.guildId;
    });
    guild = { guildId: membership.guildId, name };
  }

  // Arena: the current season's best rating row of the account.
  const seasonId = currentSeason(d.now).id;
  const arena = await log.d1<AdminPlayerDetail["arena"]>("arena_rating", null, async () => {
    const [row] = await rows<{ seasonId: string; rating: number; wins: number; losses: number }>(
      d.db,
      `SELECT season_id AS seasonId, rating, wins, losses FROM arena_rating
       WHERE account_id = ? AND season_id = ? AND _deleted = 0
       ORDER BY rating DESC LIMIT 1`,
      accountId,
      seasonId,
    );
    if (!row) return null;
    return {
      seasonId: String(row.seasonId),
      rating: num(row.rating),
      wins: num(row.wins),
      losses: num(row.losses),
    };
  });

  const today = Math.floor(d.now / DAY_MS);
  const activeDays30 = await log.d1<number>("account_activity", 0, async () => {
    const [row] = await rows<{ n: number }>(
      d.db,
      `SELECT COUNT(*) AS n FROM account_activity
       WHERE account_id = ? AND _deleted = 0 AND day >= ? AND day <= ?`,
      accountId,
      today - (ACTIVE_WINDOW_DAYS - 1),
      today,
    );
    return num(row?.n);
  });

  // Recent server events of this account in the range (AE index = accountId).
  const tallies = await log.ae<TotalsRow[]>("sim.tally", [], (aq) =>
    aq.totals({
      metric: "sim.tally",
      from: range.from,
      to: range.to,
      index: accountId,
      groupBy: ["metric"],
      value: { op: "sum", field: "amount" },
    }),
  );
  const resyncs = await log.ae("verify.resync", 0, async (aq) => {
    const [row] = await aq.totals({
      metric: "verify.resync",
      from: range.from,
      to: range.to,
      index: accountId,
      groupBy: [],
      value: { op: "count" },
    });
    return num(row?.value);
  });
  const recent: Distribution = dist(
    "recent",
    "Recent events",
    [
      ...tallies.map((t) => ({ label: t.keys.metric ?? "", value: num(t.value) })),
      { label: "resync", value: resyncs },
    ],
    "desc",
  );

  return {
    at: d.now,
    account: {
      accountId: summary.accountId,
      displayName: summary.displayName,
      kind: summary.kind,
      createdAt: num(summary.createdAt),
      lastActiveDay: lastDay * DAY_MS,
      registeredAt: typeof summary.registeredAt === "number" ? summary.registeredAt : null,
    },
    wallet,
    heroes,
    ledger,
    purchases,
    reports,
    guild,
    arena,
    activeDays30,
    recent,
    sources: log.sources,
  };
}
