/**
 * Admin chart kit and section contracts (docs/design/admin-dashboard.md §10).
 * CONTRACT (architect). Kit components: kit/index.tsx (T-ui-shell). Sections:
 * sections/*.tsx (T-ui-sections-a / T-ui-sections-b). Sections import ONLY
 * from kit/index.tsx, kit/types.ts, ../api.ts, ../dashboard.tsx, ../charts.tsx
 * and @gamez/protocol.
 *
 * Every chart: inline SVG, pixel units, colours from --adm-* tokens, an
 * accessible label, a <title> tooltip per mark, and a table view with CSV
 * export (dataviz conventions, as in charts.tsx). No chart library.
 */
import type { ReactNode } from "react";
import type { AdminSource, Distribution, FunnelStep, Quantiles, Series } from "@gamez/protocol";
import type { AdminResult } from "../api.ts";

/** How a number is printed: plain integer, compact (12.3k), percent of 1, ms, s, hours, money minor units. */
export type ValueFormat = "int" | "compact" | "pct" | "ms" | "s" | "h" | { money: string };

export interface StatTileProps {
  label: string;
  value: number | string;
  format?: ValueFormat;
  hint?: string;
  /** Status colour + icon + text (never colour alone). */
  status?: "good" | "warning" | "critical";
}

export interface TimeSeriesChartProps {
  title: string;
  series: Series[];
  kind?: "line" | "bar" | "stacked";
  format?: ValueFormat;
  /** Bucket width, for axis labels (hour vs day). */
  bucketMs: number;
  /** Shown instead of the chart when every point is 0. */
  emptyText?: string;
  /** CSV file name (without .csv). */
  csvName: string;
}

export interface DistributionChartProps {
  dist: Distribution;
  format?: ValueFormat;
  /** Most bars drawn (the rest fold into "other"); default 12. */
  maxBars?: number;
  /** Show each bar's share of the total. */
  share?: boolean;
  csvName: string;
}

export interface FunnelChartProps {
  title: string;
  steps: FunnelStep[];
  csvName: string;
}

export interface QuantilesTileProps {
  label: string;
  q: Quantiles;
  format?: ValueFormat;
}

export interface DataColumn<Row> {
  key: string;
  label: string;
  value: (row: Row) => number | string;
  format?: ValueFormat;
  align?: "left" | "right";
  /**
   * Raw value for CSV export and sorting when `value` is display text (money
   * as "USD 1.23" exports as the plain number 1.23). Defaults to `value`.
   */
  raw?: (row: Row) => number | string;
}

export interface DataTableProps<Row> {
  caption: string;
  columns: DataColumn<Row>[];
  rows: readonly Row[];
  csvName: string;
  /** Rows shown before "show all"; default 20. */
  pageSize?: number;
}

export interface SourcesNoteProps {
  sources: AdminSource[];
}

export interface PanelProps {
  title: string;
  hint?: string;
  children: ReactNode;
  /** Grid span on wide screens. */
  wide?: boolean;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface RangeState {
  from: number;
  to: number;
  bucket: "auto" | "hour" | "day";
}

export interface SectionContext {
  token: string;
  range: RangeState;
  /** "from=…&to=…[&bucket=…]" (+ "&fresh=1" on a manual refresh) for /api/admin/* GETs. */
  query: string;
  /** Whole days in the range, clamped 1..60 (for the wave C /api/admin/economy?days=). */
  days: number;
  get<T>(path: string): Promise<AdminResult<T>>;
  post<T>(path: string, body: unknown): Promise<AdminResult<T>>;
  setStatus(message: string): void;
  /** Re-runs the section's load (after an action). */
  reload(): void;
  /** Opens the player lookup on an account (sections link names to it). */
  openPlayer(accountId: string): void;
}

export type SectionGroup = "Live" | "Players" | "Game" | "Business" | "Ops";

export interface SectionDef<T> {
  id: string;
  label: string;
  group: SectionGroup;
  /** The section's data; null = the section loads by itself (lookup, config). */
  load: ((ctx: SectionContext) => Promise<AdminResult<T>>) | null;
  Component: (props: { data: T | null; ctx: SectionContext }) => ReactNode;
}

/** Erases T for the registry list (the shell treats data as opaque). */
export function defineSection<T>(def: SectionDef<T>): SectionDef<unknown> {
  return def as unknown as SectionDef<unknown>;
}
