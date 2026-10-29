/**
 * GET /api/admin/monetization (docs/design/admin-dashboard.md §2.5). OWNER: T-api-game.
 *
 * Read model only (D1): purchase (orders written by the AccountDO outbox),
 * account_activity (daily actives) and pass_progress. ARPU divides by the
 * accounts active in the range plus the accounts that paid in it; pass premium
 * counts pass_progress.premium plus paid premium-pass SKUs of the season. Money is in minor units
 * of each fiat currency. Statuses are the real OrderStatus values
 * (pending | paid | refunded | failed, economy.ts). Sandbox and stub
 * purchases are included and the "stub" provider is shown on its own.
 */
import { currentSeason } from "@gamez/economy";
import type {
  AdminMonetization,
  AdminRange,
  FiatCurrency,
  PaymentProviderId,
  Series,
} from "@gamez/protocol";
import { DAY_MS, SourceLog, num, rows, toSeries, type MetricsDeps } from "./util.ts";

const FIAT: readonly FiatCurrency[] = ["USD", "BRL", "EUR"];
const PROVIDERS: readonly PaymentProviderId[] = ["stripe", "asaas", "mercadopago", "stub"];
/** Top-N cap for the per-SKU table. */
const TOP = 20;

function isFiat(v: string): v is FiatCurrency {
  return (FIAT as readonly string[]).includes(v);
}

function isProvider(v: string): v is PaymentProviderId {
  return (PROVIDERS as readonly string[]).includes(v);
}

/** Bucket index of a time column relative to range.from (bind: from, bucketMs). */
const BUCKET = (col: string) => `CAST((${col} - ?) / ? AS INTEGER)`;

interface RevenueRow {
  currency: string;
  provider: string;
  minor: number;
}

interface SeriesBucketRow {
  b: number;
  currency: string;
  v: number;
}

interface SkuRow {
  sku: string;
  currency: string;
  paid: number;
  refunded: number;
  revenue: number;
}

/** Per-status counts of a GROUP BY status query. */
function countsOf(rs: readonly { status: string; n: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rs) out[r.status] = num(r.n);
  return out;
}

/** Paid revenue (updated_at in range), per currency and provider. */
export async function readMonetization(
  d: MetricsDeps,
  range: AdminRange,
): Promise<AdminMonetization> {
  const log = new SourceLog(d);
  const from = range.from;
  const to = range.to;
  const season = currentSeason(d.now);
  // Days overlapping [from, to): UTC day numbers, the last one holds to - 1.
  const dayFrom = Math.floor(from / DAY_MS);
  const dayTo = Math.floor((to - 1) / DAY_MS);

  const revenueRows = await log.d1("purchase", [] as RevenueRow[], () =>
    rows<RevenueRow>(
      d.db,
      `SELECT currency, provider, COALESCE(SUM(amount_minor), 0) AS minor
         FROM purchase
         WHERE _deleted = 0 AND status = 'paid' AND updated_at >= ? AND updated_at < ?
         GROUP BY currency, provider`,
      from,
      to,
    ),
  );

  const revenueSeriesRows = await log.d1("purchase", [] as SeriesBucketRow[], () =>
    rows<SeriesBucketRow>(
      d.db,
      `SELECT ${BUCKET("updated_at")} AS b, currency, SUM(amount_minor) AS v
         FROM purchase
         WHERE _deleted = 0 AND status = 'paid' AND updated_at >= ? AND updated_at < ?
         GROUP BY b, currency`,
      from,
      range.bucketMs,
      from,
      to,
    ),
  );

  const paidRefunded = await log.d1("purchase", [] as { status: string; n: number }[], () =>
    rows<{ status: string; n: number }>(
      d.db,
      `SELECT status, COUNT(*) AS n FROM purchase
         WHERE _deleted = 0 AND status IN ('paid', 'refunded') AND updated_at >= ? AND updated_at < ?
         GROUP BY status`,
      from,
      to,
    ),
  );

  const pendingFailed = await log.d1("purchase", [] as { status: string; n: number }[], () =>
    rows<{ status: string; n: number }>(
      d.db,
      `SELECT status, COUNT(*) AS n FROM purchase
         WHERE _deleted = 0 AND status IN ('pending', 'failed') AND created_at >= ? AND created_at < ?
         GROUP BY status`,
      from,
      to,
    ),
  );

  const skuRows = await log.d1("purchase", [] as SkuRow[], () =>
    rows<SkuRow>(
      d.db,
      `SELECT sku, currency,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
                SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded,
                SUM(CASE WHEN status = 'paid' THEN amount_minor ELSE 0 END) AS revenue
         FROM purchase
         WHERE _deleted = 0 AND status IN ('paid', 'refunded') AND updated_at >= ? AND updated_at < ?
         GROUP BY sku, currency
         ORDER BY revenue DESC, sku ASC, currency ASC
         LIMIT ${TOP}`,
      from,
      to,
    ),
  );

  const payersTotal = await log.d1("purchase", 0, async () => {
    const [r] = await rows<{ n: number }>(
      d.db,
      `SELECT COUNT(DISTINCT account_id) AS n FROM purchase
       WHERE _deleted = 0 AND status = 'paid' AND updated_at >= ? AND updated_at < ?`,
      from,
      to,
    );
    return num(r?.n);
  });

  const payersRows = await log.d1("purchase", [] as { currency: string; n: number }[], () =>
    rows<{ currency: string; n: number }>(
      d.db,
      `SELECT currency, COUNT(DISTINCT account_id) AS n FROM purchase
         WHERE _deleted = 0 AND status = 'paid' AND updated_at >= ? AND updated_at < ?
         GROUP BY currency`,
      from,
      to,
    ),
  );

  // ARPU population: accounts active in the range days UNION accounts that paid
  // in the range (a purchase is activity). Payers are then always a subset of
  // the actives, so ARPU <= ARPPU in every currency.
  const activeAccounts = await log.d1("account_activity", 0, async () => {
    const [r] = await rows<{ n: number }>(
      d.db,
      `SELECT COUNT(*) AS n FROM (
         SELECT account_id FROM account_activity
          WHERE _deleted = 0 AND day >= ? AND day <= ?
         UNION
         SELECT account_id FROM purchase
          WHERE _deleted = 0 AND status = 'paid' AND updated_at >= ? AND updated_at < ?
       )`,
      dayFrom,
      dayTo,
      from,
      to,
    );
    return num(r?.n);
  });

  // Premium holders: pass_progress.premium OR a paid (not refunded) premium SKU
  // of the season. The purchase side covers holders whose AccountDO has not sent
  // a pass_progress row yet (bought before the projection existed, or no pass
  // activity since). Players = pass_progress rows UNION holders, so
  // premium <= players always holds.
  const passStats = await log.d1("pass_progress", { players: 0, premium: 0 }, async () => {
    const [r] = await rows<{ players: number; premium: number }>(
      d.db,
      `WITH holders AS (
         SELECT account_id FROM pass_progress
          WHERE _deleted = 0 AND season_id = ? AND premium = 1
         UNION
         SELECT account_id FROM purchase
          WHERE _deleted = 0 AND status = 'paid' AND sku = ?
       ),
       players AS (
         SELECT account_id FROM pass_progress WHERE _deleted = 0 AND season_id = ?
         UNION
         SELECT account_id FROM holders
       )
       SELECT (SELECT COUNT(*) FROM players) AS players,
              (SELECT COUNT(*) FROM holders) AS premium`,
      season.id,
      season.premiumSku,
      season.id,
    );
    return { players: num(r?.players), premium: num(r?.premium) };
  });

  // ---- derive ----------------------------------------------------------------
  const revenueMinor: AdminMonetization["revenueMinor"] = { USD: {}, BRL: {}, EUR: {} };
  const revenueByCurrency: Record<FiatCurrency, number> = { USD: 0, BRL: 0, EUR: 0 };
  for (const r of revenueRows) {
    if (!isFiat(r.currency)) continue;
    const minor = num(r.minor);
    revenueByCurrency[r.currency] += minor;
    if (isProvider(r.provider)) {
      revenueMinor[r.currency][r.provider] = (revenueMinor[r.currency][r.provider] ?? 0) + minor;
    }
  }

  const revenuePoints = revenueSeriesRows
    .filter((r) => isFiat(r.currency))
    .map((r) => ({
      t: from + num(r.b) * range.bucketMs,
      key: r.currency,
      value: num(r.v),
    }));
  const revenueSeries: Series[] = toSeries(range, revenuePoints, {
    USD: "USD",
    BRL: "BRL",
    EUR: "EUR",
  });

  const status = countsOf(paidRefunded);
  const pending = countsOf(pendingFailed);

  const payersByCurrency: Record<FiatCurrency, number> = { USD: 0, BRL: 0, EUR: 0 };
  for (const p of payersRows) {
    if (isFiat(p.currency)) payersByCurrency[p.currency] = num(p.n);
  }

  const arpuMinor: Partial<Record<FiatCurrency, number>> = {};
  const arppuMinor: Partial<Record<FiatCurrency, number>> = {};
  for (const c of FIAT) {
    const revenue = revenueByCurrency[c];
    arpuMinor[c] = activeAccounts > 0 ? revenue / activeAccounts : 0;
    arppuMinor[c] = payersByCurrency[c] > 0 ? revenue / payersByCurrency[c] : 0;
  }

  const players = passStats.players;
  return {
    at: d.now,
    range,
    sources: log.sources,
    revenueMinor,
    revenueSeries,
    purchases: {
      paid: status.paid ?? 0,
      refunded: status.refunded ?? 0,
      pending: pending.pending ?? 0,
      failed: pending.failed ?? 0,
    },
    bySku: skuRows.map((r) => ({
      sku: r.sku ?? "",
      paid: num(r.paid),
      refunded: num(r.refunded),
      revenueMinor: num(r.revenue),
      currency: r.currency ?? "",
    })),
    payers: payersTotal,
    arpuMinor,
    arppuMinor,
    pass: {
      seasonId: season.id,
      players,
      premium: passStats.premium,
      conversion: players > 0 ? passStats.premium / players : 0,
    },
  };
}
