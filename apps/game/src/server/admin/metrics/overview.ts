/**
 * GET /api/admin/overview (docs/design/admin-dashboard.md §2.1). OWNER: T-api-tech.
 *
 * - accounts, dau/wau/mau, revenue (24 h) and the DAU series come from D1 (the
 *   read model): account_summary, account_activity, purchase.
 * - concurrent, errorRate1h and syncLagP95Ms come from Analytics Engine (the
 *   local stub on dev); every read goes through SourceLog so a failed source
 *   yields zeros and `ok: false`, never an error response.
 */
import type { AdminOverview, AdminRange, FiatCurrency, Series } from "@gamez/protocol";
import { CONCURRENT_WINDOW_MS } from "@gamez/protocol";
import type { TotalsRow } from "../../analytics/types.ts";
import {
  DAY_MS,
  dayLabel,
  firstActivityDay,
  HOUR_MS,
  num,
  rows,
  SourceLog,
  type MetricsDeps,
} from "./util.ts";

const EMPTY_ACCOUNTS: AdminOverview["accounts"] = { total: 0, guest: 0, registered: 0 };

export async function readOverview(d: MetricsDeps, range: AdminRange): Promise<AdminOverview> {
  const log = new SourceLog(d);
  const today = Math.floor(d.now / DAY_MS);
  const fromDay = Math.floor(range.from / DAY_MS);
  // `to` is exclusive: the last day that overlaps the range is the day of to-1.
  const toDay = Math.floor((range.to - 1) / DAY_MS);

  const accounts = await log.d1("account_summary", EMPTY_ACCOUNTS, async () => {
    const r = (
      await rows<{ total: number; guest: number }>(
        d.db,
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN kind = 'guest' THEN 1 ELSE 0 END), 0) AS guest
           FROM account_summary WHERE _deleted = 0`,
      )
    )[0];
    const total = num(r?.total);
    const guest = num(r?.guest);
    return { total, guest, registered: total - guest };
  });

  // One scan of the last 30 days gives DAU (today), WAU (7 days) and MAU (30 days).
  const active = await log.d1("account_activity", { dau: 0, wau: 0, mau: 0 }, async () => {
    const r = (
      await rows<{ dau: number; wau: number; mau: number }>(
        d.db,
        `SELECT COUNT(DISTINCT CASE WHEN day = ? THEN account_id END) AS dau,
                COUNT(DISTINCT CASE WHEN day BETWEEN ? AND ? THEN account_id END) AS wau,
                COUNT(DISTINCT CASE WHEN day BETWEEN ? AND ? THEN account_id END) AS mau
           FROM account_activity
          WHERE _deleted = 0 AND day BETWEEN ? AND ?`,
        today,
        today - 6,
        today,
        today - 29,
        today,
        today - 29,
        today,
      )
    )[0];
    return { dau: num(r?.dau), wau: num(r?.wau), mau: num(r?.mau) };
  });

  const activeDaily = await log.d1("account_activity", [] as { day: number; n: number }[], () =>
    rows<{ day: number; n: number }>(
      d.db,
      `SELECT day, COUNT(DISTINCT account_id) AS n FROM account_activity
        WHERE _deleted = 0 AND day BETWEEN ? AND ? GROUP BY day`,
      fromDay,
      toDay,
    ),
  );
  const byDay = new Map(activeDaily.map((r) => [num(r.day), num(r.n)] as const));
  // Days before activity tracking started have no data: the series starts there.
  const sinceDay = await firstActivityDay(log, d.db);
  const dauSeries: Series[] = [{ key: "dau", label: "DAU", points: [] }];
  const seriesFrom = sinceDay === null ? toDay + 1 : Math.max(fromDay, sinceDay);
  for (let day = seriesFrom; day <= toDay; day++) {
    dauSeries[0]!.points.push({ t: day * DAY_MS, v: byDay.get(day) ?? 0 });
  }

  const revenueMinor24h = await log.d1(
    "purchase",
    {} as Partial<Record<FiatCurrency, number>>,
    async () => {
      const r = await rows<{ currency: string; total: number }>(
        d.db,
        `SELECT currency, SUM(amount_minor) AS total FROM purchase
          WHERE _deleted = 0 AND status = 'paid' AND updated_at >= ?
          GROUP BY currency`,
        d.now - DAY_MS,
      );
      const out: Partial<Record<FiatCurrency, number>> = {};
      for (const row of r) {
        if (row.currency) out[row.currency as FiatCurrency] = num(row.total);
      }
      return out;
    },
  );

  // Concurrent players: distinct client sessions (index1) with a start or a
  // heartbeat in the window. A session is counted under both phases, so each
  // phase gives a lower bound on the union of the two and the reader takes
  // the larger one. An exact union needs an OR on blob1 that the query API
  // does not offer. The approximation is documented in design §2.1.
  const windowFrom = d.now - CONCURRENT_WINDOW_MS;
  const concurrent = await log.ae("client.session", 0, async (aq) => {
    const [starts, beats] = await Promise.all([
      aq.distinct({
        metric: "client.session",
        from: windowFrom,
        to: d.now,
        where: { phase: "start" },
      }),
      aq.distinct({
        metric: "client.session",
        from: windowFrom,
        to: d.now,
        where: { phase: "heartbeat" },
      }),
    ]);
    return Math.max(num(starts), num(beats));
  });

  const hourFrom = d.now - HOUR_MS;
  const errorRate1h = await log.ae("http.request", 0, async (aq) => {
    const data: TotalsRow[] = await aq.totals({
      metric: "http.request",
      from: hourFrom,
      to: d.now,
      groupBy: ["statusClass"],
      value: { op: "count" },
      limit: 20,
    });
    let total = 0;
    let server = 0;
    for (const row of data) {
      // WebSocket upgrades (101) are not request/response traffic: not in the denominator.
      if (row.keys.statusClass === "101") continue;
      total += num(row.value);
      if (row.keys.statusClass === "5xx") server += num(row.value);
    }
    return total > 0 ? server / total : 0;
  });

  const syncLagP95Ms = await log.ae("sync.batch", 0, async (aq) => {
    const [p95] = await aq.quantiles({
      metric: "sync.batch",
      field: "lagMs",
      from: hourFrom,
      to: d.now,
      q: [0.95],
    });
    return num(p95);
  });

  return {
    at: d.now,
    range,
    sources: log.sources,
    accounts,
    dau: active.dau,
    wau: active.wau,
    mau: active.mau,
    concurrent,
    revenueMinor24h,
    errorRate1h,
    syncLagP95Ms,
    activeSeries: dauSeries,
    activitySince: sinceDay === null ? null : dayLabel(sinceDay * DAY_MS),
  };
}
