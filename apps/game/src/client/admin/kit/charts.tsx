/**
 * SVG charts of the admin kit (docs/design/admin-dashboard.md §10.2). OWNER: T-ui-shell.
 *
 * dataviz conventions: pixel units (the width is measured with a
 * ResizeObserver, nothing scales), one y axis from zero, hairline grid, thin
 * marks (2 px lines, bars at most 24 px with a 4 px rounded data end and a
 * 2 px surface gap), categorical colours in fixed slot order with the tail
 * folded into "Other", a legend for two or more series, one <title> tooltip
 * per bucket or bar (every series at that x), and a "Table" view plus CSV
 * under every chart. Text uses ink tokens, never series colours.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { DistBucket, Series } from "@gamez/protocol";
import { useChartWidth } from "../charts.tsx";
import type { DistributionChartProps, FunnelChartProps, TimeSeriesChartProps } from "./types.ts";
import { axisTime, bucketText, csvTime, formatTick, formatValue, niceTop } from "./format.ts";
import { ChartData } from "./table.tsx";

/** Most categorical slots (--adm-cat-1..8); more series fold into "Other". */
export const MAX_SERIES = 8;
export const OTHER_KEY = "other";
const CHAR_W = 6.6;
const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;

export function seriesColor(index: number, key: string): string {
  return key === OTHER_KEY ? "var(--adm-other)" : `var(--adm-cat-${(index % MAX_SERIES) + 1})`;
}

function sum(values: readonly number[]): number {
  let s = 0;
  for (const v of values) if (Number.isFinite(v)) s += v;
  return s;
}

/**
 * At most `max` series: the `max - 1` largest (by total) keep their order and
 * colour slot, the rest are summed per bucket into one "Other" series.
 */
export function foldSeries(series: readonly Series[], max = MAX_SERIES): Series[] {
  if (series.length <= max) return [...series];
  const totals = series.map((s, i) => ({ i, total: sum(s.points.map((p) => p.v)) }));
  const keep = new Set(
    [...totals]
      .sort((a, b) => b.total - a.total || a.i - b.i)
      .slice(0, max - 1)
      .map((x) => x.i),
  );
  const other = new Map<number, number>();
  const folded: string[] = [];
  series.forEach((s, i) => {
    if (keep.has(i)) return;
    folded.push(s.label);
    for (const p of s.points) other.set(p.t, (other.get(p.t) ?? 0) + p.v);
  });
  return [
    ...series.filter((_, i) => keep.has(i)),
    {
      key: OTHER_KEY,
      label: `Other (${folded.length})`,
      points: [...other].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v })),
    },
  ];
}

/** Every bucket start across the series (ascending) and each series' value per bucket (0 when missing). */
export function alignSeries(series: readonly Series[]): { times: number[]; values: number[][] } {
  const set = new Set<number>();
  for (const s of series) for (const p of s.points) set.add(p.t);
  const times = [...set].sort((a, b) => a - b);
  const index = new Map(times.map((t, i) => [t, i]));
  const values = series.map((s) => {
    const row = Array.from({ length: times.length }, () => 0);
    for (const p of s.points) {
      const i = index.get(p.t);
      if (i !== undefined && Number.isFinite(p.v)) row[i] = (row[i] ?? 0) + p.v;
    }
    return row;
  });
  return { times, values };
}

/** Folded distribution buckets: the `max - 1` largest keep their order, the rest become "Other". */
export function foldBuckets(buckets: readonly DistBucket[], max: number): DistBucket[] {
  if (buckets.length <= max || max < 2) return [...buckets];
  const keep = new Set(
    buckets
      .map((b, i) => ({ i, v: b.value }))
      .sort((a, b) => b.v - a.v || a.i - b.i)
      .slice(0, max - 1)
      .map((x) => x.i),
  );
  const rest = buckets.filter((_, i) => !keep.has(i));
  return [
    ...buckets.filter((_, i) => keep.has(i)),
    { label: `Other (${rest.length})`, value: sum(rest.map((b) => b.value)) },
  ];
}

/** A bar with a rounded data end and a square base ("up", "down" or "right" is the data end). */
export function barPath(
  x: number,
  y: number,
  w: number,
  h: number,
  end: "up" | "down" | "right",
): string {
  if (w <= 0 || h <= 0) return "";
  const r = Math.max(0, Math.min(RADIUS, (end === "right" ? h : w) / 2, end === "right" ? w : h));
  const n = (v: number) => Number(v.toFixed(2));
  if (end === "up") {
    return `M${n(x)},${n(y + h)}V${n(y + r)}Q${n(x)},${n(y)} ${n(x + r)},${n(y)}H${n(x + w - r)}Q${n(x + w)},${n(y)} ${n(x + w)},${n(y + r)}V${n(y + h)}Z`;
  }
  if (end === "down") {
    return `M${n(x)},${n(y)}V${n(y + h - r)}Q${n(x)},${n(y + h)} ${n(x + r)},${n(y + h)}H${n(x + w - r)}Q${n(x + w)},${n(y + h)} ${n(x + w)},${n(y + h - r)}V${n(y)}Z`;
  }
  return `M${n(x)},${n(y)}H${n(x + w - r)}Q${n(x + w)},${n(y)} ${n(x + w)},${n(y + r)}V${n(y + h - r)}Q${n(x + w)},${n(y + h)} ${n(x + w - r)},${n(y + h)}H${n(x)}Z`;
}

function truncate(text: string, px: number): string {
  const max = Math.max(1, Math.floor(px / CHAR_W));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** The title of the enclosing Panel, so a chart does not repeat it as a heading. */
export const PanelTitleContext = createContext<string | null>(null);

function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function ChartTitle({ text }: { text: string }) {
  const panel = useContext(PanelTitleContext);
  // The panel heading already says it; the figure keeps its accessible label.
  if (panel !== null && sameTitle(panel, text)) return null;
  return <h3 className="adm-chart-title">{text}</h3>;
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <figure className="adm-chart">
      <ChartTitle text={title} />
      <p className="adm-muted adm-empty">{text}</p>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

const TS_H = 220;
const TS_PAD = { top: 12, right: 16, bottom: 26, left: 56 };

export function TimeSeriesChart({
  title,
  series,
  kind = "line",
  format = "int",
  bucketMs,
  emptyText = "No data in this range.",
  csvName,
}: TimeSeriesChartProps) {
  const [ref, W] = useChartWidth();
  const shown = foldSeries(series);
  const { times, values } = alignSeries(shown);
  const empty = times.length === 0 || values.every((row) => row.every((v) => v === 0));

  const header = ["time", ...shown.map((s) => s.label)];
  const tableRows = times.map((t, i) => [
    bucketText(t, bucketMs),
    ...values.map((row) => formatValue(row[i] ?? 0, format)),
  ]);
  const csvRows = () =>
    times.map((t, i) => [csvTime(t, bucketMs), ...values.map((r) => r[i] ?? 0)]);
  const numeric = shown.map((_, i) => i + 1);

  if (empty) return <Empty title={title} text={emptyText} />;

  const n = times.length;
  const stacked = kind === "stacked";
  const totals = times.map((_, i) => sum(values.map((row) => Math.max(0, row[i] ?? 0))));
  const all = values.flat();
  const hiRaw = stacked ? Math.max(0, ...totals) : Math.max(0, ...all);
  const loRaw = stacked ? 0 : Math.min(0, ...all);
  const top = hiRaw > 0 ? niceTop(hiRaw) : loRaw < 0 ? 0 : 1;
  const bottom = loRaw < 0 ? -niceTop(-loRaw) : 0;
  const plotW = Math.max(40, W - TS_PAD.left - TS_PAD.right);
  const plotH = TS_H - TS_PAD.top - TS_PAD.bottom;
  const y = (v: number) => TS_PAD.top + ((top - v) / (top - bottom)) * plotH;
  const slot = plotW / n;
  const cx = (i: number) => TS_PAD.left + slot * i + slot / 2;
  const ticks = [top, top / 2, ...(bottom < 0 ? [bottom] : [])];
  const maxLabels = Math.max(2, Math.floor(plotW / 72));
  const step = Math.ceil(n / maxLabels);
  const peakIndex = stacked
    ? totals.indexOf(hiRaw)
    : values.reduce(
        (best, row) => {
          row.forEach((v, i) => {
            if (v > best.v) best = { v, i };
          });
          return best;
        },
        { v: -Infinity, i: 0 },
      ).i;

  const marks: ReactNode[] = [];
  if (kind === "line") {
    shown.forEach((s, si) => {
      const row = values[si] ?? [];
      const color = seriesColor(si, s.key);
      const last = row.length - 1;
      marks.push(
        <g key={s.key}>
          {n > 1 ? (
            <polyline
              points={row.map((v, i) => `${cx(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}
          <circle
            cx={cx(last)}
            cy={y(row[last] ?? 0)}
            r={4}
            fill={color}
            className="adm-ring"
            strokeWidth={2}
          />
        </g>,
      );
    });
  } else if (stacked) {
    const w = Math.max(1, Math.min(BAR_MAX, slot * 0.7));
    times.forEach((t, i) => {
      let base = 0;
      const topIndex = values.reduce((acc, row, si) => ((row[i] ?? 0) > 0 ? si : acc), -1);
      values.forEach((row, si) => {
        const v = Math.max(0, row[i] ?? 0);
        if (v <= 0) return;
        const y1 = y(base);
        const y2 = y(base + v);
        base += v;
        // The 2 px surface gap sits on each segment's top, except the column's top segment.
        const h = Math.max(1, y1 - y2 - (si === topIndex ? 0 : GAP));
        marks.push(
          <path
            key={`${t}-${shown[si]?.key}`}
            d={
              si === topIndex
                ? barPath(cx(i) - w / 2, y1 - h, w, h, "up")
                : `M${(cx(i) - w / 2).toFixed(2)},${(y1 - h).toFixed(2)}h${w.toFixed(2)}v${h.toFixed(2)}h${(-w).toFixed(2)}Z`
            }
            fill={seriesColor(si, shown[si]?.key ?? "")}
          />,
        );
      });
    });
  } else {
    const k = shown.length;
    const groupW = Math.max(1, slot * 0.8);
    const w = Math.max(1, Math.min(BAR_MAX, (groupW - GAP * (k - 1)) / k));
    const span = w * k + GAP * (k - 1);
    times.forEach((t, i) => {
      values.forEach((row, si) => {
        const v = row[i] ?? 0;
        if (v === 0) return;
        const x = cx(i) - span / 2 + si * (w + GAP);
        const h = Math.max(1, Math.abs(y(v) - y(0)));
        marks.push(
          <path
            key={`${t}-${shown[si]?.key}`}
            d={v > 0 ? barPath(x, y(0) - h, w, h, "up") : barPath(x, y(0), w, h, "down")}
            fill={seriesColor(si, shown[si]?.key ?? "")}
          />,
        );
      });
    });
  }

  const summary = `${title}. ${stacked ? "Stacked bar" : kind === "bar" ? "Bar" : "Line"} chart, ${shown.length} series over ${n} ${n === 1 ? "bucket" : "buckets"} from ${bucketText(times[0]!, bucketMs)} to ${bucketText(times[n - 1]!, bucketMs)}; peak ${formatValue(hiRaw, format)} at ${bucketText(times[peakIndex] ?? times[0]!, bucketMs)}.`;

  return (
    <figure className="adm-chart" ref={ref}>
      <ChartTitle text={title} />
      <svg width={W} height={TS_H} viewBox={`0 0 ${W} ${TS_H}`} role="img" aria-label={summary}>
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={TS_PAD.left}
              x2={TS_PAD.left + plotW}
              y1={y(v)}
              y2={y(v)}
              className="adm-grid-line"
            />
            <text x={TS_PAD.left - 6} y={y(v) + 4} textAnchor="end">
              {formatTick(v, format)}
            </text>
          </g>
        ))}
        <line x1={TS_PAD.left} x2={TS_PAD.left + plotW} y1={y(0)} y2={y(0)} className="adm-zero" />
        <text x={TS_PAD.left - 6} y={y(0) + 4} textAnchor="end">
          0
        </text>
        {marks}
        {times.map((t, i) =>
          i % step === 0 ? (
            <text key={`x-${t}`} x={cx(i)} y={TS_H - 8} textAnchor="middle">
              {axisTime(t, bucketMs)}
            </text>
          ) : null,
        )}
        {times.map((t, i) => (
          <rect
            key={`hit-${t}`}
            className="adm-hit"
            x={TS_PAD.left + slot * i}
            y={TS_PAD.top}
            width={slot}
            height={plotH}
          >
            <title>
              {[
                bucketText(t, bucketMs),
                ...shown.map((s, si) => `${formatValue(values[si]?.[i] ?? 0, format)}  ${s.label}`),
                ...(stacked && shown.length > 1
                  ? [`${formatValue(totals[i] ?? 0, format)}  total`]
                  : []),
              ].join("\n")}
            </title>
          </rect>
        ))}
      </svg>
      {shown.length > 1 ? (
        <ul className="adm-legend" aria-label="Legend">
          {shown.map((s, si) => (
            <li key={s.key}>
              <span
                className={kind === "line" ? "adm-swatch line" : "adm-swatch"}
                style={{ background: seriesColor(si, s.key) }}
                aria-hidden="true"
              />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <ChartData
        name={csvName}
        header={header}
        rows={tableRows}
        csvRows={csvRows}
        numeric={numeric}
      />
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars: distributions and funnels
// ---------------------------------------------------------------------------

const ROW_H = 28;
const HBAR = 16;

interface HBarRow {
  label: string;
  value: number;
  /** Text at the bar's tip. */
  tip: string;
  /** Tooltip text. */
  title: string;
}

function HBars({ rows, label, color }: { rows: HBarRow[]; label: string; color: string }) {
  const [ref, W] = useChartWidth();
  const longest = Math.max(1, ...rows.map((r) => r.label.length));
  const labelW = Math.round(Math.min(W * 0.4, Math.max(48, longest * CHAR_W + 16)));
  const tipW = Math.round(
    Math.min(W * 0.3, Math.max(40, ...rows.map((r) => r.tip.length * CHAR_W + 10))),
  );
  const plotW = Math.max(20, W - labelW - tipW);
  const max = Math.max(0, ...rows.map((r) => r.value));
  const H = rows.length * ROW_H + 4;
  return (
    <div ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <line x1={labelW} x2={labelW} y1={0} y2={H} className="adm-zero" />
        {rows.map((r, i) => {
          const top = i * ROW_H + (ROW_H - HBAR) / 2;
          const w = max > 0 && r.value > 0 ? Math.max(2, (r.value / max) * plotW) : 0;
          return (
            <g key={`${i}-${r.label}`}>
              <title>{r.title}</title>
              <text x={labelW - 8} y={top + HBAR / 2 + 4} textAnchor="end">
                {truncate(r.label, labelW - 12)}
              </text>
              {w > 0 ? <path d={barPath(labelW, top, w, HBAR, "right")} fill={color} /> : null}
              <text x={labelW + w + 6} y={top + HBAR / 2 + 4} className="adm-value-label">
                {r.tip}
              </text>
              <rect
                className="adm-hit"
                x={0}
                y={i * ROW_H}
                width={W}
                height={ROW_H}
                aria-hidden="true"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function DistributionChart({
  dist,
  format = "int",
  maxBars = 12,
  share = false,
  csvName,
}: DistributionChartProps) {
  const buckets = foldBuckets(dist.buckets, Math.max(2, maxBars));
  const total = sum(buckets.map((b) => Math.max(0, b.value)));
  if (buckets.every((b) => b.value === 0)) {
    return <Empty title={dist.label} text="No data in this range." />;
  }
  const shareText = (v: number) => (total > 0 ? formatValue(v / total, "pct") : "–");
  const rows: HBarRow[] = buckets.map((b) => ({
    label: b.label,
    value: Math.max(0, b.value),
    tip: share
      ? `${formatValue(b.value, format)} (${shareText(b.value)})`
      : formatValue(b.value, format),
    title: `${b.label}: ${formatValue(b.value, format)}${share ? `, ${shareText(b.value)} of ${formatValue(total, format)}` : ""}`,
  }));
  const top = buckets.reduce((a, b) => (b.value > a.value ? b : a), buckets[0]!);
  const header = share ? [dist.label, "value", "share"] : [dist.label, "value"];
  return (
    <figure className="adm-chart">
      <ChartTitle text={dist.label} />
      <HBars
        rows={rows}
        color="var(--adm-cat-1)"
        label={`${dist.label}. ${buckets.length} bars, total ${formatValue(total, format)}; largest ${top.label} at ${formatValue(top.value, format)}.`}
      />
      <ChartData
        name={csvName}
        header={header}
        numeric={share ? [1, 2] : [1]}
        rows={buckets.map((b) => [
          b.label,
          formatValue(b.value, format),
          ...(share ? [shareText(b.value)] : []),
        ])}
        csvRows={() =>
          buckets.map((b) => [
            b.label,
            b.value,
            ...(share ? [total > 0 ? Number((b.value / total).toFixed(6)) : 0] : []),
          ])
        }
      />
    </figure>
  );
}

export interface FunnelRow {
  label: string;
  value: number;
  /** Share of the previous step (null for the first step or after a zero step). */
  fromPrevious: number | null;
  /** Share of the first step (null when the first step is zero). */
  fromFirst: number | null;
}

/** Step conversion: each step as a share of the previous one and of the first. */
export function funnelRows(steps: readonly { label: string; value: number }[]): FunnelRow[] {
  const first = steps[0]?.value ?? 0;
  return steps.map((s, i) => {
    const prev = i > 0 ? (steps[i - 1]?.value ?? 0) : 0;
    return {
      label: s.label,
      value: s.value,
      fromPrevious: i > 0 && prev > 0 ? s.value / prev : null,
      fromFirst: first > 0 ? s.value / first : null,
    };
  });
}

export function FunnelChart({ title, steps, csvName }: FunnelChartProps) {
  const rows = funnelRows(steps);
  if (rows.every((r) => r.value === 0)) {
    return <Empty title={title} text="No data in this range." />;
  }
  const pct = (v: number | null) => (v === null ? "–" : formatValue(v, "pct"));
  const bars: HBarRow[] = rows.map((r, i) => ({
    label: r.label,
    value: r.value,
    tip: i === 0 ? formatValue(r.value) : `${formatValue(r.value)} · ${pct(r.fromPrevious)}`,
    title:
      i === 0
        ? `${r.label}: ${formatValue(r.value)}`
        : `${r.label}: ${formatValue(r.value)}, ${pct(r.fromPrevious)} of the previous step, ${pct(r.fromFirst)} of the first`,
  }));
  const last = rows[rows.length - 1]!;
  return (
    <figure className="adm-chart">
      <ChartTitle text={title} />
      <HBars
        rows={bars}
        color="var(--adm-cat-1)"
        label={`${title}. Funnel of ${rows.length} steps from ${formatValue(rows[0]!.value)} to ${formatValue(last.value)} (${pct(last.fromFirst)} overall).`}
      />
      <ChartData
        name={csvName}
        header={["step", "count", "from previous", "from first"]}
        numeric={[1, 2, 3]}
        rows={rows.map((r) => [
          r.label,
          formatValue(r.value),
          pct(r.fromPrevious),
          pct(r.fromFirst),
        ])}
        csvRows={() =>
          rows.map((r) => [
            r.label,
            r.value,
            r.fromPrevious === null ? "" : Number(r.fromPrevious.toFixed(6)),
            r.fromFirst === null ? "" : Number(r.fromFirst.toFixed(6)),
          ])
        }
      />
    </figure>
  );
}
