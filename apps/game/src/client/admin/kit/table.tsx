/**
 * Tables and CSV export for the admin kit (docs/design/admin-dashboard.md §10.2).
 * OWNER: T-ui-shell. DataTable sorts, pages ("show all") and exports; every
 * chart's "Table" disclosure uses PlainTable + CsvButton.
 */
import { createContext, useContext, useMemo, useState } from "react";
import type { DataColumn, DataTableProps } from "./types.ts";
import { csvFileName, downloadCsv, formatValue, toCsv } from "./format.ts";

/** The shell's current range, so exports are named gamez-<name>-<from>-<to>.csv. */
export const CsvRangeContext = createContext<{ from: number; to: number } | null>(null);

type Cell = string | number;

export function CsvButton({
  name,
  header,
  rows,
  label = "CSV",
}: {
  name: string;
  header: readonly string[];
  rows: () => readonly (readonly Cell[])[];
  label?: string;
}) {
  const range = useContext(CsvRangeContext);
  const file = csvFileName(name, range);
  return (
    <button
      type="button"
      className="adm-csv"
      aria-label={`Download ${file}`}
      title={`Download ${file}`}
      onClick={() => {
        downloadCsv(file, toCsv(header, rows()));
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 2v7M4 6.5 7 9.5l3-3M2.5 12h9" />
      </svg>
      {label}
    </button>
  );
}

/** A read-only table of already formatted cells (the chart "Table" views). */
export function PlainTable({
  caption,
  header,
  rows,
  numeric,
}: {
  caption?: string;
  header: readonly string[];
  rows: readonly (readonly string[])[];
  /** Columns aligned right (numbers). */
  numeric?: readonly number[];
}) {
  return (
    <div className="adm-table-wrap">
      <table>
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={`${i}-${h}`} scope="col" className={numeric?.includes(i) ? "num" : ""}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={numeric?.includes(j) ? "num" : ""}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Table" disclosure plus the CSV button, under every chart. */
export function ChartData({
  name,
  header,
  rows,
  csvRows,
  numeric,
}: {
  name: string;
  header: readonly string[];
  rows: readonly (readonly string[])[];
  csvRows: () => readonly (readonly Cell[])[];
  numeric?: readonly number[];
}) {
  return (
    <div className="adm-chart-data">
      <details>
        <summary>Table</summary>
        <PlainTable header={header} rows={rows} numeric={numeric} />
      </details>
      <CsvButton name={name} header={header} rows={csvRows} />
    </div>
  );
}

type Sort = { key: string; dir: "asc" | "desc" } | null;

function compare(a: Cell, b: Cell): number {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
    if (Number.isNaN(b)) return -1;
    return a - b;
  }
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

/** Rows sorted by a column (stable; the original order breaks ties). */
export function sortRows<Row>(
  rows: readonly Row[],
  column: DataColumn<Row> | undefined,
  dir: "asc" | "desc",
): Row[] {
  if (!column) return [...rows];
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: (column.raw ?? column.value)(row) }))
    .sort((a, b) => sign * compare(a.v, b.v) || a.i - b.i)
    .map((x) => x.row);
}

function isNumeric<Row>(column: DataColumn<Row>, rows: readonly Row[]): boolean {
  if (column.align) return column.align === "right";
  const first = rows[0];
  return first !== undefined && typeof column.value(first) === "number";
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  csvName,
  pageSize = 20,
}: DataTableProps<Row>) {
  const [sort, setSort] = useState<Sort>(null);
  const [all, setAll] = useState(false);
  const sorted = useMemo(
    () =>
      sort
        ? sortRows(
            rows,
            columns.find((c) => c.key === sort.key),
            sort.dir,
          )
        : rows,
    [rows, columns, sort],
  );
  const shown = all ? sorted : sorted.slice(0, pageSize);
  const hidden = sorted.length - shown.length;

  const toggle = (key: string) =>
    setSort((s) =>
      s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" },
    );

  return (
    <div className="adm-datatable">
      <div className="adm-table-wrap">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const ariaSort = active
                  ? sort.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : undefined;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={isNumeric(c, rows) ? "num" : ""}
                  >
                    <button type="button" className="adm-sort" onClick={() => toggle(c.key)}>
                      {c.label}
                      <span aria-hidden="true" className="adm-sort-mark">
                        {active ? (sort.dir === "asc" ? " ▲" : " ▼") : " ↕"}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="adm-muted">
                  No rows.
                </td>
              </tr>
            ) : (
              shown.map((r, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key} className={isNumeric(c, rows) ? "num" : ""}>
                      {formatValue(c.value(r), c.format)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="adm-row adm-table-foot">
        <small>
          {hidden > 0
            ? `${shown.length} of ${sorted.length} rows`
            : `${sorted.length} ${sorted.length === 1 ? "row" : "rows"}`}
        </small>
        {sorted.length > pageSize ? (
          <button type="button" onClick={() => setAll((v) => !v)}>
            {all ? `Show first ${pageSize}` : `Show all ${sorted.length}`}
          </button>
        ) : null}
        <CsvButton
          name={csvName}
          header={columns.map((c) => c.label)}
          rows={() => sorted.map((r) => columns.map((c) => (c.raw ?? c.value)(r)))}
        />
      </div>
    </div>
  );
}
