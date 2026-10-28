/**
 * Admin chart kit (docs/design/admin-dashboard.md §10.2). OWNER: T-ui-shell.
 *
 * Exports and props (kit/types.ts) are frozen: sections import only from here.
 * Charts live in charts.tsx, tables and CSV in table.tsx, number formatting in
 * format.ts, the shell toolbar in toolbar.tsx. Tiles, panels and the sources
 * note are here.
 */
import type { AdminSourceKind } from "@gamez/protocol";
import type { PanelProps, QuantilesTileProps, SourcesNoteProps, StatTileProps } from "./types.ts";
import { formatValue } from "./format.ts";
import { PanelTitleContext } from "./charts.tsx";

export type * from "./types.ts";
export { defineSection } from "./types.ts";
export {
  compact,
  csvFileName,
  dayString,
  downloadCsv,
  formatTick,
  formatValue,
  niceCeil,
  toCsv,
} from "./format.ts";
export {
  DistributionChart,
  foldBuckets,
  foldSeries,
  FunnelChart,
  funnelRows,
  seriesColor,
  TimeSeriesChart,
} from "./charts.tsx";
export { CsvButton, CsvRangeContext, DataTable, PlainTable, sortRows } from "./table.tsx";
export { adminRouteArg } from "./toolbar.tsx";

const STATUS: Record<NonNullable<StatTileProps["status"]>, { icon: string; text: string }> = {
  good: { icon: "✓", text: "Good" },
  warning: { icon: "!", text: "Warning" },
  critical: { icon: "✕", text: "Critical" },
};

/** A KPI tile. A status shows as an icon plus a word, never colour alone. */
export function StatTile({ label, value, format, hint, status }: StatTileProps) {
  const s = status ? STATUS[status] : null;
  return (
    <div className={`adm-tile${status ? ` ${status}` : ""}`}>
      <div className="adm-label">{label}</div>
      <div className="adm-value">{formatValue(value, format)}</div>
      {s ? (
        <div className={`adm-status-chip ${status}`}>
          <span aria-hidden="true" className="adm-status-icon">
            {s.icon}
          </span>
          {s.text}
        </div>
      ) : null}
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

/** p50 and p95 of a measure, with the sample count (n = 0 shows "no samples"). */
export function QuantilesTile({ label, q, format }: QuantilesTileProps) {
  if (!(q.n > 0)) return <StatTile label={label} value="–" hint="p50 / p95 · no samples" />;
  return (
    <StatTile
      label={label}
      value={`${formatValue(q.p50, format)} / ${formatValue(q.p95, format)}`}
      hint={`p50 / p95 · n=${formatValue(q.n, "compact")}`}
    />
  );
}

/** A card in the section grid; `wide` spans the whole row on wide screens. */
export function Panel({ title, hint, children, wide }: PanelProps) {
  return (
    <section className={`adm-section adm-panel${wide ? " wide" : ""}`}>
      <h2>{title}</h2>
      {hint ? <p className="adm-muted adm-hint">{hint}</p> : null}
      <PanelTitleContext.Provider value={title}>{children}</PanelTitleContext.Provider>
    </section>
  );
}

const KIND_TEXT: Record<AdminSourceKind, string> = {
  d1: "D1",
  ae: "Analytics Engine",
  local: "local stub",
  live: "live",
};

/** Source chips (where the numbers come from) and the sources that failed. */
export function SourcesNote({ sources }: SourcesNoteProps) {
  const kinds = (Object.keys(KIND_TEXT) as AdminSourceKind[]).filter((k) =>
    sources.some((s) => s.kind === k && s.ok),
  );
  const failed = sources.filter((s) => !s.ok);
  if (kinds.length === 0 && failed.length === 0) return null;
  return (
    <div className="adm-sources-note">
      {kinds.length > 0 ? (
        <ul className="adm-chips" aria-label="Data sources">
          {kinds.map((k) => (
            <li
              key={k}
              className="adm-chip"
              title={sources
                .filter((s) => s.kind === k && s.ok)
                .map((s) => s.name)
                .join(", ")}
            >
              {KIND_TEXT[k]}
            </li>
          ))}
        </ul>
      ) : null}
      {failed.length > 0 ? (
        <p className="adm-warn-note" role="note">
          <span aria-hidden="true" className="adm-status-icon">
            !
          </span>{" "}
          Missing data:{" "}
          {failed.map((s) => `${s.name} (${s.note ?? KIND_TEXT[s.kind] ?? s.kind})`).join(", ")}
        </p>
      ) : null}
    </div>
  );
}
