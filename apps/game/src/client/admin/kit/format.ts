/**
 * Number, time and CSV formatting for the admin kit (docs/design/admin-dashboard.md §10.2).
 * OWNER: T-ui-shell. Pure functions (no DOM except downloadCsv), so they are
 * unit-tested directly. Times are shown in UTC: the server buckets in UTC.
 */
import type { ValueFormat } from "./types.ts";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const MONEY = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fixed(v: number, digits: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 12.3K from 1,000 up; plain integers below. */
export function compact(v: number): string {
  return Math.abs(v) < 1000 ? INT.format(Math.round(v)) : COMPACT.format(v);
}

/**
 * Formats a value for display (see ValueFormat). Strings pass through;
 * NaN and ±Infinity print as an en dash.
 * - int: 1,234 · compact: 12.3K · pct (a share of 1): 12.5%
 * - ms: 840 ms / 1.25 s · s: 42 s / 12.5 min / 3.2 h · h: 3.5 h
 * - { money: "USD" } (minor units): USD 1,234.56
 */
export function formatValue(v: number | string, format: ValueFormat = "int"): string {
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "–";
  if (typeof format === "object") return `${format.money} ${MONEY.format(v / 100)}`;
  switch (format) {
    case "compact":
      return compact(v);
    case "pct": {
      const p = v * 100;
      return `${fixed(p, Math.abs(p) >= 100 ? 0 : 1)}%`;
    }
    case "ms":
      if (Math.abs(v) < 1000) return `${INT.format(Math.round(v))} ms`;
      return `${fixed(v / 1000, Math.abs(v) < 10_000 ? 2 : 1)} s`;
    case "s":
      if (Math.abs(v) < 60) return `${fixed(v, Math.abs(v) < 10 ? 1 : 0)} s`;
      if (Math.abs(v) < 3600) return `${fixed(v / 60, 1)} min`;
      return `${fixed(v / 3600, 1)} h`;
    case "h":
      return `${fixed(v, Math.abs(v) < 10 ? 1 : 0)} h`;
    default:
      return INT.format(Math.round(v));
  }
}

/** Axis tick text: like formatValue, but counts go compact from 1,000 up (0 / 1K / 2K). */
export function formatTick(v: number, format: ValueFormat = "int"): string {
  if (format === "int" || format === "compact") return compact(v);
  if (typeof format === "object") {
    const major = v / 100;
    return `${format.money} ${Math.abs(major) >= 1000 ? COMPACT.format(major) : INT.format(major)}`;
  }
  if (format === "pct") return `${Math.round(v * 100)}%`;
  return formatValue(v, format);
}

/** 1, 2 or 5 times a power of ten, at least `v` (axis tops read as round numbers). */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

/**
 * A chart's axis top: the smallest of 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6 or 8
 * times a power of ten that is at least `v`, so the peak fills most of the
 * plot (niceCeil's 1-2-5 steps can leave half of it empty).
 */
export function niceTop(v: number): number {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const top = Number((m * pow).toPrecision(12));
    if (top >= v) return top;
  }
  return 10 * pow;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" (UTC) of an instant. */
export function dayString(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Short axis label of a bucket start: "Oct 28" for days, "13:00" for hours ("Oct 28" at midnight). */
export function axisTime(t: number, bucketMs: number): string {
  const d = new Date(t);
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (bucketMs >= DAY_MS) return day;
  const h = d.getUTCHours();
  return h === 0 ? day : `${pad2(h)}:00`;
}

/** Tooltip / table text of a bucket: "2026-10-28" or "2026-10-28 13:00 UTC". */
export function bucketText(t: number, bucketMs: number): string {
  if (bucketMs >= DAY_MS) return dayString(t);
  return `${dayString(t)} ${pad2(new Date(t).getUTCHours())}:00 UTC`;
}

/** CSV time cell: "2026-10-28" for days, ISO "2026-10-28T13:00:00Z" for hours. */
export function csvTime(t: number, bucketMs: number): string {
  if (bucketMs >= DAY_MS) return dayString(t);
  return new Date(t).toISOString().replace(".000Z", "Z");
}

/**
 * RFC 4180 CSV of a header row and rows: CRLF line ends, fields with a comma,
 * quote or line break quoted, quotes doubled. Text cells that a spreadsheet
 * would run as a formula (=, +, @, tab, CR, or "-" not starting a number) get
 * a leading apostrophe, since player-chosen names end up in these files.
 */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string {
  const cell = (v: string | number): string => {
    let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v;
    if (typeof v === "string" && /^([=+@\t\r]|-(?![\d.]))/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

/** File name of an export: gamez-<csvName>-<from>-<to>.csv (days, UTC; `to` is exclusive). */
export function csvFileName(name: string, range?: { from: number; to: number } | null): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  if (!range) return `gamez-${safe}.csv`;
  const last = Math.max(range.from, range.to - 1);
  return `gamez-${safe}-${dayString(range.from)}-${dayString(last)}.csv`;
}

/** Saves a CSV through a Blob URL. Returns false where the browser refuses (never throws). */
export function downloadCsv(fileName: string, csv: string): boolean {
  try {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}
