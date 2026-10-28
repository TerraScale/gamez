/**
 * Economy telemetry math (wave-C.md §9). OWNER: T-admin. Pure helpers the
 * admin route uses on D1 rows. No clock reads: callers pass `now` and rows.
 *
 * Day keys are UTC "YYYY-MM-DD" built with integer arithmetic (no Date), so
 * the same rows always give the same output on every engine.
 */
import type { EconomyFlowDay, ItemCategory, PriceIndexPoint } from "@gamez/protocol";

export const DAY_MS = 86_400_000;

/** Median of integers (lower middle for even counts); 0 for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** Reason prefix used to group flows: "market.tax:classic:weapon/3" -> "market.tax". */
export function flowGroup(reason: string): string {
  const i = reason.indexOf(":");
  return i < 0 ? reason : reason.slice(0, i);
}

/** UTC day number of a millisecond timestamp (days since 1970-01-01). */
export function dayIndexOf(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** "YYYY-MM-DD" (UTC) of a day number (Howard Hinnant's civil-from-days). */
export function dayKeyOf(index: number): string {
  const z = index + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The day numbers of the last `days` UTC days ending today (oldest first). */
export function dayRange(days: number, now: number): number[] {
  const today = dayIndexOf(now);
  const out: number[] = [];
  for (let d = today - (days - 1); d <= today; d++) out.push(d);
  return out;
}

/** One ledger aggregate: signed wallet deltas summed per day, flow and reason. */
export interface LedgerDayRow {
  dayIndex: number;
  flow: string;
  /** reason_group, or the raw reason when the group is empty. */
  reason: string;
  total: number;
}

/**
 * Faucets (Σ amount where flow "faucet") and sinks (−Σ amount where flow
 * "sink": a sink refund is a positive delta) per day and reason group, one
 * entry per day in `days` (zeros when nothing happened).
 */
export function foldFlows(
  rows: readonly LedgerDayRow[],
  days: readonly number[],
): EconomyFlowDay[] {
  const byDay = new Map<number, EconomyFlowDay>();
  for (const d of days) byDay.set(d, { day: dayKeyOf(d), faucets: {}, sinks: {} });
  for (const row of rows) {
    const entry = byDay.get(row.dayIndex);
    if (!entry) continue;
    const group = flowGroup(row.reason);
    if (row.flow === "faucet") {
      entry.faucets[group] = (entry.faucets[group] ?? 0) + row.total;
    } else if (row.flow === "sink") {
      entry.sinks[group] = (entry.sinks[group] ?? 0) - row.total;
    }
  }
  return days.map((d) => byDay.get(d)!);
}

/** One sale: the day it happened, its category and price. */
export interface SaleDayRow {
  dayIndex: number;
  category: string;
  price: number;
}

/** Daily median price and volume per category, oldest day first, then category id. */
export function priceIndex(rows: readonly SaleDayRow[]): PriceIndexPoint[] {
  const groups = new Map<string, { dayIndex: number; category: string; prices: number[] }>();
  for (const row of rows) {
    if (!row.category) continue;
    const key = `${row.dayIndex}\u0000${row.category}`;
    let g = groups.get(key);
    if (!g) {
      g = { dayIndex: row.dayIndex, category: row.category, prices: [] };
      groups.set(key, g);
    }
    g.prices.push(row.price);
  }
  return [...groups.values()]
    .sort((a, b) =>
      a.dayIndex !== b.dayIndex
        ? a.dayIndex - b.dayIndex
        : a.category < b.category
          ? -1
          : a.category > b.category
            ? 1
            : 0,
    )
    .map((g) => ({
      day: dayKeyOf(g.dayIndex),
      category: g.category as ItemCategory,
      median: median(g.prices),
      volume: g.prices.length,
    }));
}
