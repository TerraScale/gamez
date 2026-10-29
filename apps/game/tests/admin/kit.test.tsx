/**
 * Admin chart kit (docs/design/admin-dashboard.md §10.2, §13 "UI"): every
 * component rendered with react-dom/server (empty data, one series, many
 * series folded into "Other"), CSV escaping and file names, formatValue.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { Series } from "@gamez/protocol";
import {
  CsvRangeContext,
  DataTable,
  DistributionChart,
  foldBuckets,
  foldSeries,
  formatValue,
  FunnelChart,
  funnelRows,
  Panel,
  QuantilesTile,
  sortRows,
  SourcesNote,
  StatTile,
  TimeSeriesChart,
  toCsv,
  csvFileName,
  adminRouteArg,
} from "../../src/client/admin/kit/index.tsx";
import {
  alignSeries,
  barPath,
  seriesColor,
  MAX_SERIES,
} from "../../src/client/admin/kit/charts.tsx";
import {
  axisTime,
  bucketText,
  csvTime,
  formatTick,
  niceTop,
} from "../../src/client/admin/kit/format.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20);

function series(key: string, values: number[], label = key, step = DAY): Series {
  return { key, label, points: values.map((v, i) => ({ t: T0 + i * step, v })) };
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("formatValue", () => {
  it("prints every ValueFormat", () => {
    expect(formatValue(1234567.4)).toBe("1,234,567");
    expect(formatValue(1234567.4, "int")).toBe("1,234,567");
    expect(formatValue(999, "compact")).toBe("999");
    expect(formatValue(12_345, "compact")).toBe("12.3K");
    expect(formatValue(4_200_000, "compact")).toBe("4.2M");
    expect(formatValue(0.125, "pct")).toBe("12.5%");
    expect(formatValue(1, "pct")).toBe("100%");
    expect(formatValue(840, "ms")).toBe("840 ms");
    expect(formatValue(1250, "ms")).toBe("1.25 s");
    expect(formatValue(42, "s")).toBe("42 s");
    expect(formatValue(750, "s")).toBe("12.5 min");
    expect(formatValue(11_520, "s")).toBe("3.2 h");
    expect(formatValue(3.5, "h")).toBe("3.5 h");
    expect(formatValue(1250, "h")).toBe("1,250 h");
    expect(formatValue(123_456, { money: "USD" })).toBe("USD 1,234.56");
    expect(formatValue(5, { money: "BRL" })).toBe("BRL 0.05");
  });

  it("passes strings through and prints non-finite numbers as a dash", () => {
    expect(formatValue("3 / 4")).toBe("3 / 4");
    expect(formatValue(Number.NaN)).toBe("–");
    expect(formatValue(Infinity, "pct")).toBe("–");
  });

  it("axis ticks go compact from 1,000", () => {
    expect(formatTick(0)).toBe("0");
    expect(formatTick(2000)).toBe("2K");
    expect(formatTick(0.5, "pct")).toBe("50%");
    expect(formatTick(500_000, { money: "USD" })).toBe("USD 5K");
  });

  it("axis tops sit just above the peak on round steps", () => {
    expect(niceTop(0)).toBe(1);
    expect(niceTop(7)).toBe(8);
    expect(niceTop(10_800)).toBe(12_000);
    expect(niceTop(250)).toBe(250);
    expect(niceTop(251)).toBe(300);
    expect(niceTop(0.13)).toBe(0.15);
  });

  it("labels hour and day buckets in UTC", () => {
    const t = Date.UTC(2026, 9, 28, 13);
    expect(axisTime(t, HOUR)).toBe("13:00");
    expect(axisTime(Date.UTC(2026, 9, 28), HOUR)).toBe("Oct 28");
    expect(axisTime(t, DAY)).toBe("Oct 28");
    expect(bucketText(t, HOUR)).toBe("2026-10-28 13:00 UTC");
    expect(bucketText(t, DAY)).toBe("2026-10-28");
    expect(csvTime(t, HOUR)).toBe("2026-10-28T13:00:00Z");
    expect(csvTime(t, DAY)).toBe("2026-10-28");
  });
});

describe("toCsv", () => {
  it("is RFC 4180: CRLF, quoted commas, quotes and line breaks, doubled quotes", () => {
    const csv = toCsv(
      ["name", "value"],
      [
        ["plain", 1],
        ['say "hi"', 2],
        ["a,b", 3],
        ["two\nlines", 4.5],
      ],
    );
    expect(csv).toBe('name,value\r\nplain,1\r\n"say ""hi""",2\r\n"a,b",3\r\n"two\nlines",4.5');
  });

  it("defuses spreadsheet formulas in text cells but keeps negative numbers", () => {
    const csv = toCsv(["v"], [["=HYPERLINK(1)"], ["+1"], ["@x"], ["-x"], ["-12"], [-12], [NaN]]);
    expect(csv.split("\r\n")).toEqual([
      "v",
      "'=HYPERLINK(1)",
      "'+1",
      "'@x",
      "'-x",
      "-12",
      "-12",
      "",
    ]);
  });

  it("names files gamez-<name>-<from>-<to>.csv (to is exclusive)", () => {
    expect(csvFileName("dau", { from: Date.UTC(2026, 9, 21), to: Date.UTC(2026, 9, 28) })).toBe(
      "gamez-dau-2026-10-21-2026-10-27.csv",
    );
    expect(csvFileName("weird name/../x", null)).toBe("gamez-weird-name-..-x.csv");
    expect(csvFileName("", null)).toBe("gamez-export.csv");
  });
});

describe("TimeSeriesChart", () => {
  it("shows the empty text instead of an SVG when every point is 0", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart
        title="DAU"
        series={[series("dau", [0, 0, 0])]}
        bucketMs={DAY}
        emptyText="Nobody played yet."
        csvName="dau"
      />,
    );
    expect(html).toContain("DAU");
    expect(html).toContain("Nobody played yet.");
    expect(html).not.toContain("<svg");
    const none = renderToStaticMarkup(
      <TimeSeriesChart title="X" series={[]} bucketMs={DAY} csvName="x" />,
    );
    expect(none).toContain("No data in this range.");
  });

  it("draws one series as a line with no legend, a tooltip per bucket and a table", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart
        title="Daily active"
        series={[series("dau", [3, 7, 5], "DAU")]}
        bucketMs={DAY}
        csvName="dau"
      />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain("Daily active. Line chart, 1 series over 3 buckets");
    expect(html).toContain("<polyline");
    expect(count(html, /<title>/g)).toBe(3);
    expect(html).toContain("2026-10-21\n7  DAU");
    expect(html).not.toContain("adm-legend");
    expect(html).toContain("<summary>Table</summary>");
    expect(html).toContain("CSV");
    expect(html).toContain("Oct 20");
    // y axis tops at a nice number just above the peak
    expect(html).toContain(">8<");
  });

  it("names the CSV after the shell's range", () => {
    const html = renderToStaticMarkup(
      <CsvRangeContext.Provider value={{ from: T0, to: T0 + 7 * DAY }}>
        <TimeSeriesChart title="t" series={[series("a", [1])]} bucketMs={DAY} csvName="dau" />
      </CsvRangeContext.Provider>,
    );
    expect(html).toContain("gamez-dau-2026-10-20-2026-10-26.csv");
  });

  it("folds more than eight series into Other and keeps a legend", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      series(`s${i}`, [i + 1, i + 2], `Series ${i}`),
    );
    const folded = foldSeries(many);
    expect(folded).toHaveLength(MAX_SERIES);
    expect(folded.map((s) => s.key).slice(0, 7)).toEqual([
      "s4",
      "s5",
      "s6",
      "s7",
      "s8",
      "s9",
      "s10",
    ]);
    const other = folded[7]!;
    expect(other.key).toBe("other");
    expect(other.label).toBe("Other (4)");
    // s0..s3: (1+2+3+4) and (2+3+4+5)
    expect(other.points.map((p) => p.v)).toEqual([10, 14]);
    expect(seriesColor(7, "other")).toBe("var(--adm-other)");
    expect(seriesColor(0, "s4")).toBe("var(--adm-cat-1)");

    const html = renderToStaticMarkup(
      <TimeSeriesChart title="Many" series={many} kind="line" bucketMs={DAY} csvName="many" />,
    );
    expect(count(html, /<polyline/g)).toBe(8);
    expect(html).toContain("adm-legend");
    expect(html).toContain("Other (4)");
    expect(html).not.toContain("Series 0<");
  });

  it("stacks bars with a total in the tooltip, and groups plain bars", () => {
    const two = [series("a", [2, 0, 4], "Manual"), series("b", [1, 3, 0], "Auto")];
    const stacked = renderToStaticMarkup(
      <TimeSeriesChart title="Split" series={two} kind="stacked" bucketMs={DAY} csvName="s" />,
    );
    expect(count(stacked, /<path d="[^"]*" fill="var\(--adm-cat/g)).toBe(4);
    expect(stacked).toContain("3  total");
    expect(stacked).toContain("Stacked bar chart");
    const bars = renderToStaticMarkup(
      <TimeSeriesChart title="Bars" series={two} kind="bar" bucketMs={DAY} csvName="b" />,
    );
    expect(count(bars, /<path d="[^"]*" fill="var\(--adm-cat/g)).toBe(4);
    expect(bars).toContain("Bar chart");
  });

  it("aligns series with different buckets (missing points are 0)", () => {
    const { times, values } = alignSeries([
      { key: "a", label: "a", points: [{ t: 2, v: 1 }] },
      {
        key: "b",
        label: "b",
        points: [
          { t: 1, v: 5 },
          { t: 2, v: 6 },
        ],
      },
    ]);
    expect(times).toEqual([1, 2]);
    expect(values).toEqual([
      [0, 1],
      [5, 6],
    ]);
  });

  it("formats hour buckets and money axes", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart
        title="Revenue"
        series={[series("usd", [1999, 0, 500], "USD", HOUR)]}
        format={{ money: "USD" }}
        bucketMs={HOUR}
        csvName="rev"
      />,
    );
    expect(html).toContain("USD 19.99");
    expect(html).toContain("2026-10-20 00:00 UTC");
  });
});

describe("bars", () => {
  it("rounds only the data end", () => {
    expect(barPath(0, 0, 10, 20, "up")).toMatch(/^M0,20V4Q0,0 4,0H6Q10,0 10,4V20Z$/);
    expect(barPath(0, 0, 0, 20, "up")).toBe("");
    expect(barPath(0, 0, 50, 16, "right")).toContain("H46");
  });
});

describe("DistributionChart", () => {
  const dist = {
    key: "class",
    label: "Heroes by class",
    buckets: [
      { label: "warrior", value: 6 },
      { label: "rogue", value: 3 },
      { label: "sorcerer", value: 1 },
    ],
  };

  it("draws horizontal bars with value labels and optional share", () => {
    const html = renderToStaticMarkup(<DistributionChart dist={dist} share csvName="class" />);
    expect(html).toContain("Heroes by class");
    expect(count(html, /<path d="[^"]*" fill="var\(--adm-cat/g)).toBe(3);
    expect(html).toContain("6 (60.0%)");
    expect(html).toContain("warrior: 6, 60.0% of 10");
    expect(html).toContain("largest warrior at 6");
    const plain = renderToStaticMarkup(<DistributionChart dist={dist} csvName="class" />);
    expect(plain).not.toContain("60.0%");
  });

  it("folds the smallest buckets into Other past maxBars", () => {
    const buckets = Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, value: i }));
    expect(foldBuckets(buckets, 3)).toEqual([
      { label: "L4", value: 4 },
      { label: "L5", value: 5 },
      { label: "Other (4)", value: 0 + 1 + 2 + 3 },
    ]);
    const html = renderToStaticMarkup(
      <DistributionChart dist={{ key: "k", label: "K", buckets }} maxBars={3} csvName="k" />,
    );
    expect(html).toContain("Other (4)");
    expect(html).not.toContain(">L0<");
  });

  it("shows an empty state", () => {
    const html = renderToStaticMarkup(
      <DistributionChart dist={{ key: "k", label: "Deaths", buckets: [] }} csvName="k" />,
    );
    expect(html).toContain("No data in this range.");
    expect(html).not.toContain("<svg");
  });
});

describe("FunnelChart", () => {
  it("computes step conversion from the previous and the first step", () => {
    const rows = funnelRows([
      { label: "Accepted", value: 200 },
      { label: "Progressed", value: 150 },
      { label: "Completed", value: 60 },
      { label: "Repeated", value: 0 },
      { label: "Again", value: 5 },
    ]);
    expect(rows.map((r) => r.fromPrevious)).toEqual([null, 0.75, 0.4, 0, null]);
    expect(rows.map((r) => r.fromFirst)).toEqual([1, 0.75, 0.3, 0, 0.025]);
  });

  it("labels each step with its conversion", () => {
    const html = renderToStaticMarkup(
      <FunnelChart
        title="Quests"
        steps={[
          { label: "Accepted", value: 200 },
          { label: "Completed", value: 50 },
        ]}
        csvName="quests"
      />,
    );
    expect(html).toContain("50 · 25.0%");
    expect(html).toContain("25.0% of the previous step");
    expect(html).toContain("(25.0% overall)");
    const empty = renderToStaticMarkup(<FunnelChart title="Q" steps={[]} csvName="q" />);
    expect(empty).toContain("No data in this range.");
  });
});

describe("tiles, panel, sources", () => {
  it("shows a status as an icon and a word, not colour alone", () => {
    const html = renderToStaticMarkup(
      <StatTile label="Error rate" value={0.031} format="pct" status="critical" hint="1 h" />,
    );
    expect(html).toContain("3.1%");
    expect(html).toContain("Critical");
    expect(html).toContain("✕");
    expect(html).toContain("adm-tile critical");
  });

  it("prints quantiles, or no samples", () => {
    expect(
      renderToStaticMarkup(
        <QuantilesTile label="Frame" q={{ p50: 16, p95: 40, n: 1200 }} format="ms" />,
      ),
    ).toContain("16 ms / 40 ms");
    expect(
      renderToStaticMarkup(<QuantilesTile label="Frame" q={{ p50: 0, p95: 0, n: 0 }} />),
    ).toContain("no samples");
  });

  it("renders a panel with a wide class", () => {
    const html = renderToStaticMarkup(
      <Panel title="Retention" hint="cohorts" wide>
        <p>x</p>
      </Panel>,
    );
    expect(html).toContain("adm-panel wide");
    expect(html).toContain("Retention");
  });

  it("lists source chips and failed sources", () => {
    const html = renderToStaticMarkup(
      <SourcesNote
        sources={[
          { name: "account_activity", kind: "d1", ok: true },
          { name: "http.request", kind: "local", ok: true },
          { name: "ws.open", kind: "ae", ok: false, note: "no analytics backend" },
        ]}
      />,
    );
    expect(html).toContain(">D1<");
    expect(html).toContain(">local stub<");
    expect(html).not.toContain(">Analytics Engine<");
    expect(html).toContain("Missing data: ws.open (no analytics backend)");
    expect(renderToStaticMarkup(<SourcesNote sources={[]} />)).toBe("");
  });
});

describe("DataTable", () => {
  interface Row {
    name: string;
    gold: number;
  }
  const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({ name: `p${i}`, gold: i * 10 }));
  const columns = [
    { key: "name", label: "Name", value: (r: Row) => r.name },
    { key: "gold", label: "Gold", value: (r: Row) => r.gold, format: "compact" as const },
  ];

  it("shows the first page with a show-all button and CSV", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="Rich players" columns={columns} rows={rows} csvName="rich" />,
    );
    expect(html).toContain("<caption>Rich players</caption>");
    expect(count(html, /<tr>/g)).toBe(21);
    expect(html).toContain("20 of 25 rows");
    expect(html).toContain("Show all 25");
    expect(html).toContain("CSV");
    expect(html).toContain('class="num"');
  });

  it("shows an empty table", () => {
    const html = renderToStaticMarkup(
      <DataTable caption="None" columns={columns} rows={[]} csvName="none" />,
    );
    expect(html).toContain("No rows.");
    expect(html).not.toContain("Show all");
  });

  it("sorts numbers and text, stable on ties", () => {
    const col = columns[1]!;
    expect(sortRows(rows, col, "desc")[0]?.name).toBe("p24");
    const named = [{ name: "b10" }, { name: "b9" }, { name: "a" }];
    const byName = { key: "n", label: "n", value: (r: { name: string }) => r.name };
    expect(sortRows(named, byName, "asc").map((r) => r.name)).toEqual(["a", "b9", "b10"]);
    const ties = [
      { name: "x", gold: 1 },
      { name: "y", gold: 1 },
    ];
    expect(sortRows(ties, col, "desc").map((r) => r.name)).toEqual(["x", "y"]);
  });
});

describe("adminRouteArg", () => {
  it("reads the open section's argument from the hash", () => {
    expect(adminRouteArg("lookup", "#admin/lookup/acc%2F1")).toBe("acc/1");
    expect(adminRouteArg("lookup", "#admin/lookup")).toBeNull();
    expect(adminRouteArg("lookup", "#admin/players/x")).toBeNull();
    expect(adminRouteArg("lookup", "#admin/lookup/%E0%A4%A")).toBeNull();
  });
});
