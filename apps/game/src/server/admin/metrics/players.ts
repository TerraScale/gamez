/**
 * GET /api/admin/players (docs/design/admin-dashboard.md §2.2). OWNER: T-api-players.
 * D1 reads (accounts, signups, activity, retention) and AE reads (sessions and
 * the client.session breakdowns). Every read goes through SourceLog: a failed
 * source yields its empty value and ok: false, never an error response.
 */
import type { AdminPlayers, AdminRange, RetentionCohort, Series } from "@gamez/protocol";
import {
  DAY_MS,
  SourceLog,
  dayLabel,
  firstActivityDay,
  dist,
  distOf,
  num,
  rows,
  seriesRows,
  toSeries,
  type MetricsDeps,
} from "./util.ts";

/** Session length bands in the fixed display order (client.session lengthBand). */
export const SESSION_BANDS = ["<1m", "1-5m", "5-15m", "15-30m", "30-60m", "1-2h", "2h+"] as const;
/** Retention cohorts shown per request (newest first). */
export const COHORT_LIMIT = 30;
/** Windows of the active-account series: DAU = 1 day, WAU = 7, MAU = 30 (trailing, ending that day). */
const ACTIVE_WINDOWS = [
  { key: "dau", label: "DAU", days: 1 },
  { key: "wau", label: "WAU", days: 7 },
  { key: "mau", label: "MAU", days: 30 },
] as const;
/** Retention offsets: exact day c+N. */
const RETENTION_OFFSETS = [1, 7, 30] as const;

interface AccountKindRow {
  kind: string;
  n: number;
}

interface WindowRow {
  day: number;
  n: number;
}

interface BucketRow {
  b: number;
  n: number;
}

/** Whole UTC days covered by [from, to): first and last day number (inclusive). */
function dayBounds(range: AdminRange): { first: number; last: number } {
  return { first: Math.floor(range.from / DAY_MS), last: Math.floor((range.to - 1) / DAY_MS) };
}

function daysBetween(first: number, last: number): number[] {
  const out: number[] = [];
  for (let d = first; d <= last; d++) out.push(d);
  return out;
}

/**
 * Distinct accounts active in each day's trailing window of `window` days
 * (window 1 = DAU). Map day number -> count; days without activity are absent.
 */
async function activeWindow(
  db: D1Database,
  first: number,
  last: number,
  window: number,
): Promise<Map<number, number>> {
  const sql = `WITH RECURSIVE days(d) AS (SELECT ? UNION ALL SELECT d + 1 FROM days WHERE d < ?)
    SELECT w.d AS day, COUNT(DISTINCT a.account_id) AS n
    FROM days w
    JOIN account_activity a ON a._deleted = 0 AND a.day BETWEEN w.d - ? AND w.d
    GROUP BY w.d`;
  const found = await rows<WindowRow>(db, sql, first, last, window - 1);
  return new Map(found.map((r) => [num(r.day), num(r.n)]));
}

/** Accounts created (or registered) per bucket, as a series. */
async function signupSeries(
  db: D1Database,
  range: AdminRange,
  column: "created_at" | "registered_at",
  key: string,
  label: string,
  log: SourceLog,
): Promise<Series> {
  const sql = `SELECT CAST((${column} - ?) / ? AS INTEGER) AS b, COUNT(*) AS n
    FROM account_summary
    WHERE _deleted = 0 AND ${column} >= ? AND ${column} < ?
    GROUP BY b`;
  const found = await log.d1<BucketRow[]>(`account_summary.${column}`, [], () =>
    rows<BucketRow>(db, sql, range.from, range.bucketMs, range.from, range.to),
  );
  const data = found.map((r) => ({
    t: range.from + num(r.b) * range.bucketMs,
    key,
    value: num(r.n),
  }));
  // Keep the series present even when empty (a zero point at the range start).
  data.push({ t: range.from, key, value: 0 });
  return toSeries(range, data, { [key]: label })[0] ?? { key, label, points: [] };
}

/**
 * Retention cohorts of the newest COHORT_LIMIT days of the range. `size` =
 * accounts created that day; dN = share of them with an account_activity row
 * on exactly day c + N (null when that day is after today or the cohort is empty).
 */
async function retentionCohorts(
  d: MetricsDeps,
  log: SourceLog,
  first: number,
  last: number,
): Promise<RetentionCohort[]> {
  if (last < first) return [];
  const cohortFirst = Math.max(first, last - (COHORT_LIMIT - 1));
  const from = cohortFirst * DAY_MS;
  const to = (last + 1) * DAY_MS;
  const today = Math.floor(d.now / DAY_MS);

  const sizes = await log.d1<Map<number, number> | null>("account_summary", null, async () => {
    const found = await rows<{ c: number; n: number }>(
      d.db,
      `SELECT CAST(created_at / ? AS INTEGER) AS c, COUNT(*) AS n
       FROM account_summary
       WHERE _deleted = 0 AND created_at >= ? AND created_at < ?
       GROUP BY c`,
      DAY_MS,
      from,
      to,
    );
    return new Map(found.map((r) => [num(r.c), num(r.n)]));
  });
  if (sizes === null) return [];

  const active = new Map<number, Map<number, number>>();
  for (const offset of RETENTION_OFFSETS) {
    const counts = await log.d1<Map<number, number>>("account_activity", new Map(), async () => {
      const found = await rows<{ c: number; n: number }>(
        d.db,
        `SELECT CAST(s.created_at / ? AS INTEGER) AS c, COUNT(DISTINCT s.account_id) AS n
         FROM account_summary s
         JOIN account_activity a
           ON a.account_id = s.account_id AND a._deleted = 0
          AND a.day = CAST(s.created_at / ? AS INTEGER) + ?
         WHERE s._deleted = 0 AND s.created_at >= ? AND s.created_at < ?
         GROUP BY c`,
        DAY_MS,
        DAY_MS,
        offset,
        from,
        to,
      );
      return new Map(found.map((r) => [num(r.c), num(r.n)]));
    });
    active.set(offset, counts);
  }

  const cohorts: RetentionCohort[] = [];
  for (let c = last; c >= cohortFirst; c--) {
    const size = sizes.get(c) ?? 0;
    const share = (offset: (typeof RETENTION_OFFSETS)[number]): number | null => {
      if (c + offset > today) return null;
      // An empty cohort has no retention: null, rendered as a dash.
      if (size === 0) return null;
      return (active.get(offset)?.get(c) ?? 0) / size;
    };
    cohorts.push({
      day: dayLabel(c * DAY_MS),
      size,
      d1: share(1),
      d7: share(7),
      d30: share(30),
    });
  }
  return cohorts;
}

export async function readPlayers(d: MetricsDeps, range: AdminRange): Promise<AdminPlayers> {
  const log = new SourceLog(d);
  const { first, last } = dayBounds(range);
  const days = last >= first ? daysBetween(first, last) : [];

  // Accounts (independent of the range).
  const kinds = await log.d1<AccountKindRow[]>("account_summary", [], () =>
    rows<AccountKindRow>(
      d.db,
      "SELECT COALESCE(kind, '') AS kind, COUNT(*) AS n FROM account_summary WHERE _deleted = 0 GROUP BY kind",
    ),
  );
  let total = 0;
  let guest = 0;
  for (const r of kinds) {
    const n = num(r.n);
    total += n;
    if (r.kind === "guest") guest += n;
  }
  const accounts = { total, guest, registered: total - guest };

  // Signups per bucket: new (created_at) and registered (registered_at, null for guests).
  const signups = [
    await signupSeries(d.db, range, "created_at", "new", "New accounts", log),
    await signupSeries(d.db, range, "registered_at", "registered", "Registered", log),
  ];

  // Active accounts per day of the range: DAU, WAU (7 days), MAU (30 days) ending that day.
  // Days before activity tracking started (first account_activity row) have no data.
  const sinceDay = await firstActivityDay(log, d.db);
  const trackedDays = sinceDay === null ? [] : days.filter((day) => day >= sinceDay);
  const active: Series[] = [];
  for (const w of ACTIVE_WINDOWS) {
    const counts =
      days.length === 0
        ? new Map<number, number>()
        : await log.d1<Map<number, number>>("account_activity", new Map(), () =>
            activeWindow(d.db, first, last, w.days),
          );
    active.push({
      key: w.key,
      label: w.label,
      points: trackedDays.map((day) => ({ t: day * DAY_MS, v: counts.get(day) ?? 0 })),
    });
  }

  const retention = await retentionCohorts(d, log, first, last);

  // Sessions (AE). Starts per bucket; length stats over phase end.
  const sessionStarts = await log.ae(
    "client.session",
    [] as { t: number; keys: Record<string, string>; value: number }[],
    (aq) =>
      aq.series({
        metric: "client.session",
        from: range.from,
        to: range.to,
        bucketMs: range.bucketMs,
        where: { phase: "start" },
        groupBy: [],
        value: { op: "count" },
      }),
  );
  const perBucket = toSeries(
    range,
    [...seriesRows(sessionStarts, null, "sessions"), { t: range.from, key: "sessions", value: 0 }],
    { sessions: "Sessions" },
  );

  const lengthQ = await log.ae("client.session", [0, 0], (aq) =>
    aq.quantiles({
      metric: "client.session",
      from: range.from,
      to: range.to,
      where: { phase: "end" },
      field: "elapsedS",
      q: [0.5, 0.95],
    }),
  );
  const lengthN = await log.ae("client.session", 0, async (aq) => {
    const [row] = await aq.totals({
      metric: "client.session",
      from: range.from,
      to: range.to,
      where: { phase: "end" },
      groupBy: [],
      value: { op: "count" },
    });
    return num(row?.value);
  });
  const lengthS = {
    p50: num(lengthQ[0]),
    p95: num(lengthQ[1]),
    n: lengthN,
  };

  const bandRows = await log.ae(
    "client.session",
    [] as { keys: Record<string, string>; value: number }[],
    (aq) =>
      aq.totals({
        metric: "client.session",
        from: range.from,
        to: range.to,
        where: { phase: "end" },
        groupBy: ["lengthBand"],
        value: { op: "count" },
      }),
  );
  const byBand = new Map(bandRows.map((r) => [r.keys.lengthBand ?? "", num(r.value)]));
  const lengthHistogram = dist(
    "sessionLength",
    "Session length",
    SESSION_BANDS.map((band) => ({ label: band, value: byBand.get(band) ?? 0 })),
  );

  const startsBy = async (
    field: "platform" | "device" | "country" | "continent",
    limit?: number,
  ): Promise<{ keys: Record<string, string>; value: number }[]> =>
    log.ae("client.session", [], (aq) =>
      aq.totals({
        metric: "client.session",
        from: range.from,
        to: range.to,
        where: { phase: "start" },
        groupBy: [field],
        value: { op: "count" },
        ...(limit === undefined ? {} : { limit }),
      }),
    );

  const platforms = distOf("platforms", "Platform", await startsBy("platform"), "platform");
  const devices = distOf("devices", "Device", await startsBy("device"), "device");
  const countries = distOf("countries", "Country", await startsBy("country", 20), "country");
  const continents = distOf("continents", "Continent", await startsBy("continent"), "continent");

  return {
    at: d.now,
    range,
    sources: log.sources,
    accounts,
    signups,
    active,
    retention,
    activitySince: sinceDay === null ? null : dayLabel(sinceDay * DAY_MS),
    sessions: {
      perBucket,
      lengthS,
      lengthHistogram,
    },
    platforms,
    devices,
    countries,
    continents,
  };
}
