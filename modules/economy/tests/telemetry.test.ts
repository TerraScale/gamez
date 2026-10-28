import { describe, expect, it } from "vite-plus/test";
import {
  dayIndexOf,
  dayKeyOf,
  dayRange,
  flowGroup,
  foldFlows,
  median,
  priceIndex,
} from "../src/index.ts";

describe("median", () => {
  it("is 0 for no values and the value for one", () => {
    expect(median([])).toBe(0);
    expect(median([7])).toBe(7);
  });

  it("takes the lower middle for even counts", () => {
    expect(median([1, 2])).toBe(1);
    expect(median([4, 1, 3, 2])).toBe(2);
    expect(median([10, 20, 30, 40, 50, 60])).toBe(30);
  });

  it("takes the middle for odd counts and does not reorder its input", () => {
    const values = [9, 1, 5];
    expect(median(values)).toBe(5);
    expect(values).toEqual([9, 1, 5]);
  });
});

describe("flowGroup", () => {
  it("keeps the part before the first colon", () => {
    expect(flowGroup("market.tax:classic:weapon/3")).toBe("market.tax");
    expect(flowGroup("bank.deposit")).toBe("bank.deposit");
    expect(flowGroup("")).toBe("");
  });
});

describe("UTC days", () => {
  it("formats day numbers as UTC keys", () => {
    expect(dayKeyOf(0)).toBe("1970-01-01");
    expect(dayKeyOf(dayIndexOf(Date.UTC(2026, 9, 28, 23, 59)))).toBe("2026-10-28");
    expect(dayKeyOf(dayIndexOf(Date.UTC(2024, 1, 29)))).toBe("2024-02-29");
    expect(dayKeyOf(dayIndexOf(Date.UTC(2000, 11, 31)))).toBe("2000-12-31");
  });

  it("lists the last N days ending today, oldest first", () => {
    const now = Date.UTC(2026, 2, 2, 12);
    const days = dayRange(3, now).map(dayKeyOf);
    expect(days).toEqual(["2026-02-28", "2026-03-01", "2026-03-02"]);
  });
});

describe("foldFlows", () => {
  const day = dayIndexOf(Date.UTC(2026, 9, 28));
  const days = [day - 1, day];

  it("sums faucets and negates sink deltas, one entry per day", () => {
    const out = foldFlows(
      [
        { dayIndex: day, flow: "faucet", reason: "bank.deposit", total: 100 },
        { dayIndex: day, flow: "faucet", reason: "bank.deposit", total: 50 },
        { dayIndex: day, flow: "sink", reason: "market.fee", total: -20 },
        // A sink refund is a positive delta and reduces the sink total.
        { dayIndex: day, flow: "sink", reason: "market.fee", total: 5 },
        { dayIndex: day, flow: "transfer", reason: "trade.coin", total: -999 },
      ],
      days,
    );
    expect(out).toEqual([
      { day: "2026-10-27", faucets: {}, sinks: {} },
      { day: "2026-10-28", faucets: { "bank.deposit": 150 }, sinks: { "market.fee": 15 } },
    ]);
  });

  it("drops rows outside the requested days", () => {
    const out = foldFlows(
      [{ dayIndex: day - 10, flow: "faucet", reason: "arena.reward", total: 9 }],
      days,
    );
    expect(out.every((d) => Object.keys(d.faucets).length === 0)).toBe(true);
  });
});

describe("priceIndex", () => {
  it("gives the daily lower median and volume per category", () => {
    const d = dayIndexOf(Date.UTC(2026, 9, 28));
    const points = priceIndex([
      { dayIndex: d, category: "weapon", price: 300 },
      { dayIndex: d, category: "weapon", price: 100 },
      { dayIndex: d, category: "weapon", price: 200 },
      { dayIndex: d, category: "weapon", price: 400 },
      { dayIndex: d, category: "armor", price: 50 },
      { dayIndex: d - 1, category: "weapon", price: 70 },
      { dayIndex: d, category: "", price: 1 },
    ]);
    expect(points).toEqual([
      { day: "2026-10-27", category: "weapon", median: 70, volume: 1 },
      { day: "2026-10-28", category: "armor", median: 50, volume: 1 },
      { day: "2026-10-28", category: "weapon", median: 200, volume: 4 },
    ]);
  });

  it("is empty without sales", () => {
    expect(priceIndex([])).toEqual([]);
  });
});
