/**
 * Inline SVG charts for the admin dashboard (wave-C.md §9.3). OWNER: T-admin.
 * dataviz conventions: one y axis, a zero line, thin marks, a legend for two or
 * more series, a hover tooltip per mark (an SVG <title>), and a table view
 * beside every chart. Colours come from the --adm-* tokens in styles.ts.
 */
import { useEffect, useState } from "react";
import type { EconomyFlowDay, ItemCategory, PriceIndexPoint } from "@gamez/protocol";
import { ITEM_CATEGORIES } from "@gamez/protocol";
import { niceCeil } from "./kit/format.ts";

export { niceCeil };

/** Width before the first measurement (and in static renders). */
const DEFAULT_W = 640;
const MIN_W = 240;
const H = 220;
const PAD = { top: 14, right: 12, bottom: 26, left: 60 };

export const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/**
 * The chart's rendered width in CSS pixels. Charts draw in pixel units (no
 * viewBox scaling), so 11 px labels stay 11 px on a phone and on a desktop.
 */
export function useChartWidth(): [(el: HTMLElement | null) => void, number] {
  // A callback ref, so a chart that first renders as text (no data) still gets
  // measured when its <figure> appears later.
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_W);
  useEffect(() => {
    if (!el) return;
    const measure = () => setWidth(Math.max(MIN_W, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}

function totalOf(record: Record<string, number>): number {
  let sum = 0;
  for (const v of Object.values(record)) sum += v;
  return sum;
}

function topGroups(record: Record<string, number>, n = 3): string {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([k, v]) => `${k} ${fmt(v)}`)
    .join(", ");
}

const FAUCET = "var(--adm-cat-1)";
const SINK = "var(--adm-cat-2)";

/**
 * Faucets up from the zero line, sinks down from it, one day per column, on
 * one linear scale. The domain is [-maxSink, +maxFaucet] (each side rounded to
 * a nice number), so a quiet sink side does not waste half of the plot. Tiny
 * bars keep a 2 px floor; exact values are in the tooltip and the table.
 */
export function FlowsChart({ days, label }: { days: EconomyFlowDay[]; label: string }) {
  const [ref, W] = useChartWidth();
  const faucetTotals = days.map((d) => totalOf(d.faucets));
  const sinkTotals = days.map((d) => totalOf(d.sinks));
  const maxUp = Math.max(0, ...faucetTotals);
  const maxDown = Math.max(0, ...sinkTotals);
  const top = maxUp > 0 ? niceCeil(maxUp) : 0;
  const bottom = maxDown > 0 ? niceCeil(maxDown) : 0;
  const plotH = H - PAD.top - PAD.bottom;
  const plotW = W - PAD.left - PAD.right;
  // One scale for both sides; an empty window centres the zero line.
  const scale = top + bottom > 0 ? plotH / (top + bottom) : 0;
  const upH = top + bottom > 0 ? top * scale : plotH / 2;
  const downH = plotH - upH;
  const mid = PAD.top + upH;
  // A side's extent label would collide with the zero label when that side is very short.
  const LABEL_GAP = 14;
  const slot = plotW / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(28, slot * 0.6));
  const first = days[0]?.day ?? "";
  const last = days[days.length - 1]?.day ?? "";

  return (
    <figure style={{ margin: 0 }} ref={ref}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: "block", maxWidth: "100%" }}
        role="img"
        aria-label={`${label}. Coin faucets up, sinks down, ${days.length} days, faucet peak ${fmt(maxUp)}, sink peak ${fmt(maxDown)}.`}
      >
        <line x1={PAD.left} x2={W - PAD.right} y1={mid} y2={mid} className="adm-zero" />
        <text x={PAD.left - 6} y={mid + 4} textAnchor="end">
          0
        </text>
        {top > 0 && upH >= LABEL_GAP ? (
          <>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={PAD.top}
              y2={PAD.top}
              className="adm-grid-line"
            />
            <text x={PAD.left - 6} y={PAD.top + 4} textAnchor="end">
              +{fmt(top)}
            </text>
          </>
        ) : null}
        {bottom > 0 && downH >= LABEL_GAP ? (
          <>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={PAD.top + plotH}
              y2={PAD.top + plotH}
              className="adm-grid-line"
            />
            <text x={PAD.left - 6} y={PAD.top + plotH + 4} textAnchor="end">
              -{fmt(bottom)}
            </text>
          </>
        ) : null}
        {days.map((d, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          const up = faucetTotals[i]! * scale;
          const down = sinkTotals[i]! * scale;
          return (
            <g key={d.day}>
              <title>{`${d.day}: faucets ${fmt(faucetTotals[i]!)} (${topGroups(d.faucets) || "none"}); sinks ${fmt(sinkTotals[i]!)} (${topGroups(d.sinks) || "none"})`}</title>
              {up > 0 ? (
                <rect
                  x={cx - barW / 2}
                  y={mid - Math.max(2, up)}
                  width={barW}
                  height={Math.max(2, up)}
                  rx={2}
                  fill={FAUCET}
                />
              ) : null}
              {down > 0 ? (
                <rect
                  x={cx - barW / 2}
                  y={mid}
                  width={barW}
                  height={Math.max(2, down)}
                  rx={2}
                  fill={SINK}
                />
              ) : null}
              <rect x={cx - slot / 2} y={PAD.top} width={slot} height={plotH} fill="transparent" />
            </g>
          );
        })}
        <text x={PAD.left} y={H - 8}>
          {first}
        </text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end">
          {last}
        </text>
      </svg>
      <ul className="adm-legend" aria-label="Legend">
        <li>
          <span className="adm-swatch" style={{ background: FAUCET }} aria-hidden="true" />
          Faucets (coin created, up)
        </li>
        <li>
          <span className="adm-swatch" style={{ background: SINK }} aria-hidden="true" />
          Sinks (coin destroyed, down)
        </li>
      </ul>
    </figure>
  );
}

export function FlowsTable({ days }: { days: EconomyFlowDay[] }) {
  return (
    <div className="adm-table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Day (UTC)</th>
            <th scope="col">Faucets</th>
            <th scope="col">Sinks</th>
            <th scope="col">Net</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => {
            const f = totalOf(d.faucets);
            const s = totalOf(d.sinks);
            return (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td>{fmt(f)}</td>
                <td>{fmt(s)}</td>
                <td>{fmt(f - s)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Categories in their fixed palette order (slot n is always the same category). */
export function categorySlot(category: ItemCategory): number {
  return ITEM_CATEGORIES.indexOf(category) + 1;
}

/** One line per category: the daily median price, one y axis from zero. */
export function PriceChart({ points, days }: { points: PriceIndexPoint[]; days: string[] }) {
  const [ref, W] = useChartWidth();
  if (points.length === 0) {
    return <p className="adm-muted">No sales in this window yet.</p>;
  }
  const byCategory = new Map<ItemCategory, PriceIndexPoint[]>();
  for (const p of points) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }
  const categories = ITEM_CATEGORIES.filter((c) => byCategory.has(c));
  const peak = Math.max(1, ...points.map((p) => p.median));
  const max = niceCeil(peak);
  const plotH = H - PAD.top - PAD.bottom;
  const plotW = W - PAD.left - PAD.right;
  const x = (day: string) => {
    const i = days.indexOf(day);
    const span = Math.max(1, days.length - 1);
    return PAD.left + (plotW * Math.max(0, i)) / span;
  };
  const y = (v: number) => PAD.top + plotH - (plotH * v) / max;

  return (
    <figure style={{ margin: 0 }} ref={ref}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: "block", maxWidth: "100%" }}
        role="img"
        aria-label={`Median sale price per category, ${categories.length} lines over ${days.length} days, peak ${fmt(peak)} coin.`}
      >
        {[max, max / 2].map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="adm-grid-line" />
            <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end">
              {fmt(v)}
            </text>
          </g>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} className="adm-zero" />
        <text x={PAD.left - 6} y={y(0) + 4} textAnchor="end">
          0
        </text>
        {categories.map((cat) => {
          const series = byCategory.get(cat)!.sort((a, b) => (a.day < b.day ? -1 : 1));
          const slot = categorySlot(cat);
          const color = `var(--adm-cat-${slot})`;
          const path = series
            .map((p) => `${x(p.day).toFixed(1)},${y(p.median).toFixed(1)}`)
            .join(" ");
          return (
            <g key={cat}>
              <polyline points={path} fill="none" stroke={color} strokeWidth={2} />
              {series.map((p) => (
                <circle key={p.day} cx={x(p.day)} cy={y(p.median)} r={4} fill={color}>
                  <title>{`${cat} ${p.day}: median ${fmt(p.median)} coin, ${p.volume} sales`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        <text x={PAD.left} y={H - 8}>
          {days[0] ?? ""}
        </text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end">
          {days[days.length - 1] ?? ""}
        </text>
      </svg>
      <ul className="adm-legend" aria-label="Legend">
        {categories.map((cat) => (
          <li key={cat}>
            <span
              className="adm-swatch"
              style={{ background: `var(--adm-cat-${categorySlot(cat)})` }}
              aria-hidden="true"
            />
            {cat}
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function PriceTable({ points }: { points: PriceIndexPoint[] }) {
  return (
    <div className="adm-table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Day (UTC)</th>
            <th scope="col">Category</th>
            <th scope="col">Median</th>
            <th scope="col">Sales</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={`${p.day}-${p.category}`}>
              <td>{p.day}</td>
              <td>{p.category}</td>
              <td>{fmt(p.median)}</td>
              <td>{fmt(p.volume)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface SourceTotal {
  source: string;
  total: number;
}

/** Per-source totals over the window, largest first (ties by name). */
export function sourceTotals(days: EconomyFlowDay[], side: "faucets" | "sinks"): SourceTotal[] {
  const sums = new Map<string, number>();
  for (const d of days) {
    for (const [source, v] of Object.entries(d[side]))
      sums.set(source, (sums.get(source) ?? 0) + v);
  }
  return [...sums]
    .map(([source, total]) => ({ source, total }))
    .filter((s) => s.total !== 0)
    .sort((a, b) => b.total - a.total || (a.source < b.source ? -1 : 1));
}

/**
 * Where coin comes from and where it goes over the selected window: one
 * sorted list per side, each row a bar sized against that side's largest
 * source, with the exact total and its share of the side.
 */
export function SourcesBreakdown({ days }: { days: EconomyFlowDay[] }) {
  const sides = [
    { key: "faucets" as const, title: "Faucets (coin created)", color: FAUCET },
    { key: "sinks" as const, title: "Sinks (coin destroyed)", color: SINK },
  ];
  return (
    <div className="adm-sources">
      {sides.map((side) => {
        const rows = sourceTotals(days, side.key);
        const sum = rows.reduce((a, r) => a + r.total, 0);
        const max = Math.max(1, ...rows.map((r) => r.total));
        return (
          <div key={side.key} className="adm-source-side">
            <h3>{side.title}</h3>
            {rows.length === 0 ? (
              <p className="adm-muted">None in this window.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Total</th>
                    <th scope="col">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.source}>
                      <td>
                        <div>{r.source}</div>
                        <div className="adm-bar" aria-hidden="true">
                          <span
                            style={{
                              width: `${Math.max(2, (r.total / max) * 100)}%`,
                              background: side.color,
                            }}
                          />
                        </div>
                      </td>
                      <td>{fmt(r.total)}</td>
                      <td>{sum > 0 ? `${Math.round((r.total / sum) * 100)}%` : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
