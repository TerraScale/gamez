/**
 * D1 reads for the economy dashboard (wave-C.md §9.1). OWNER: T-admin. Display
 * only: gameplay never reads these tables. A missing table (not migrated yet)
 * or a failed query yields zeros, never an error.
 */
import {
  dayRange,
  foldFlows,
  priceIndex,
  type LedgerDayRow,
  type SaleDayRow,
} from "@gamez/economy";
import type { EconomyTelemetry, FiatCurrency, PriceIndexPoint } from "@gamez/protocol";
import { isMissingTable } from "../leaderboards/read.ts";

export const TELEMETRY_DAYS_DEFAULT = 14;
export const TELEMETRY_DAYS_MAX = 60;
/** Upper bound on sale rows read for the price index (oldest rows beyond it are ignored). */
export const SALES_ROW_LIMIT = 50_000;
const DAY = 86_400_000;

/** days query value: an integer clamped to 1..60, default 14 for anything else. */
export function parseDays(raw: string | null): number {
  const n = Number(raw ?? TELEMETRY_DAYS_DEFAULT);
  if (!Number.isFinite(n)) return TELEMETRY_DAYS_DEFAULT;
  return Math.min(TELEMETRY_DAYS_MAX, Math.max(1, Math.trunc(n)));
}

/** Runs one read; any failure logs (unless the table is missing) and yields `fallback`. */
async function safe<T>(label: string, fallback: T, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!isMissingTable(err)) console.error(`admin telemetry: ${label} failed`, err);
    return fallback;
  }
}

function rowsOf<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = db.prepare(sql);
  return (params.length ? stmt.bind(...params) : stmt).all<T>().then((r) => r.results);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function readEconomyTelemetry(
  db: D1Database,
  days: number,
  now: number,
): Promise<EconomyTelemetry> {
  const dayNumbers = dayRange(days, now);
  const sinceMs = dayNumbers[0]! * DAY;

  const moneySupply = await safe("money", { coin: 0, gem: 0, accounts: 0 }, async () => {
    const [row] = await rowsOf<{ coin: number; gem: number; accounts: number }>(
      db,
      `SELECT COALESCE(SUM(coin), 0) AS coin, COALESCE(SUM(gem), 0) AS gem, COUNT(*) AS accounts
       FROM account_wallet WHERE _deleted = 0`,
    );
    return { coin: num(row?.coin), gem: num(row?.gem), accounts: num(row?.accounts) };
  });

  // Faucets/sinks are coin flows (EconomyFlowDay): gem rows (store.gems,
  // pass.premium) never mix into the coin chart.
  const flowRows = await safe("flows", [] as LedgerDayRow[], async () =>
    (
      await rowsOf<{ day_index: number; flow: string; grp: string; total: number }>(
        db,
        `SELECT CAST(at AS INTEGER) / ${DAY} AS day_index, flow,
                COALESCE(NULLIF(reason_group, ''), reason, 'other') AS grp,
                SUM(amount) AS total
         FROM economy_ledger
         WHERE _deleted = 0 AND at >= ? AND COALESCE(currency, 'coin') = 'coin'
         GROUP BY day_index, flow, grp`,
        sinceMs,
      )
    ).map((r) => ({
      dayIndex: num(r.day_index),
      flow: String(r.flow ?? ""),
      reason: String(r.grp ?? "other"),
      total: num(r.total),
    })),
  );

  const saleRows = await safe("prices", [] as SaleDayRow[], async () =>
    (
      await rowsOf<{ day_index: number; category: string; price: number }>(
        db,
        `SELECT CAST(at AS INTEGER) / ${DAY} AS day_index, category, price
         FROM economy_sale WHERE _deleted = 0 AND at >= ?
         ORDER BY at DESC LIMIT ${SALES_ROW_LIMIT}`,
        sinceMs,
      )
    ).map((r) => ({
      dayIndex: num(r.day_index),
      category: String(r.category ?? ""),
      price: num(r.price),
    })),
  );

  const last24 = now - DAY;

  const market = await safe("market", { active: 0, sold24h: 0, volume24h: 0 }, async () => {
    const [active] = await rowsOf<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM market_listing
       WHERE _deleted = 0 AND status = 'active' AND ends_at > ?`,
      now,
    );
    const [sold] = await rowsOf<{ n: number; volume: number }>(
      db,
      `SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS volume FROM economy_sale
       WHERE _deleted = 0 AND venue = 'market' AND at >= ?`,
      last24,
    );
    return {
      active: num(active?.n),
      sold24h: num(sold?.n),
      volume24h: num(sold?.volume),
    };
  });

  const shops = await safe("shops", { leased: 0, auction: 0, grace: 0 }, async () => {
    const rows = await rowsOf<{ state: string; n: number }>(
      db,
      "SELECT state, COUNT(*) AS n FROM shop_index WHERE _deleted = 0 GROUP BY state",
    );
    const out = { leased: 0, auction: 0, grace: 0 };
    for (const r of rows) {
      if (r.state === "leased" || r.state === "auction" || r.state === "grace") {
        out[r.state] = num(r.n);
      }
    }
    return out;
  });

  const purchases = await safe(
    "purchases",
    { paid24h: 0, revenueMinor24h: {} as Partial<Record<FiatCurrency, number>> },
    async () => {
      const rows = await rowsOf<{ currency: string; n: number; minor: number }>(
        db,
        `SELECT currency, COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS minor
         FROM purchase WHERE _deleted = 0 AND status = 'paid' AND updated_at >= ?
         GROUP BY currency`,
        last24,
      );
      const revenueMinor24h: Partial<Record<FiatCurrency, number>> = {};
      let paid24h = 0;
      for (const r of rows) {
        paid24h += num(r.n);
        if (r.currency === "USD" || r.currency === "BRL" || r.currency === "EUR") {
          revenueMinor24h[r.currency] = num(r.minor);
        }
      }
      return { paid24h, revenueMinor24h };
    },
  );

  const prices: PriceIndexPoint[] = priceIndex(saleRows);
  return {
    at: now,
    moneySupply: { coin: moneySupply.coin, gem: moneySupply.gem },
    accounts: moneySupply.accounts,
    flows: foldFlows(flowRows, dayNumbers),
    priceIndex: prices,
    market,
    shops,
    purchases,
  };
}
