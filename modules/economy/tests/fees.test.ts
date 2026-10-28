import { describe, expect, it } from "vite-plus/test";
import {
  isAmount,
  listingFee,
  marketEligible,
  marketShard,
  minNextBid,
  plotRent,
  salesTax,
  shardOfListing,
  shopTax,
  tradeFee,
} from "../src/index.ts";

describe("fees (sinks)", () => {
  it("pins the fee numbers", () => {
    expect(listingFee(1000, null)).toBe(20);
    expect(listingFee(null, 10)).toBe(1);
    expect(listingFee(null, null)).toBe(1);
    expect(salesTax(1000)).toBe(50);
    expect(salesTax(3)).toBe(1);
    expect(salesTax(0)).toBe(0);
    expect(shopTax(1000)).toBe(30);
    expect(tradeFee(1000)).toBe(20);
    expect(tradeFee(0)).toBe(0);
    expect(minNextBid(null, 50)).toBe(50);
    expect(minNextBid(100, 50)).toBe(105);
    expect(minNextBid(10, 1)).toBe(11);
    expect(plotRent(100)).toBe(20);
    expect(plotRent(5000)).toBe(500);
  });

  it("validates amounts", () => {
    expect(isAmount(1)).toBe(true);
    expect(isAmount(0)).toBe(false);
    expect(isAmount(1.5)).toBe(false);
    expect(isAmount("5")).toBe(false);
    expect(isAmount(2_000_000_000)).toBe(false);
  });
});

describe("market rules", () => {
  const summary = (category: "weapon" | "gem", level: number) => ({
    name: "x",
    rarity: "rare",
    level,
    category,
    slot: null,
    icon: "item.x",
    lines: [],
  });

  it("only lists high-level equipment, any gem", () => {
    expect(marketEligible(summary("weapon", 9))).toBe(false);
    expect(marketEligible(summary("weapon", 10))).toBe(true);
    expect(marketEligible(summary("gem", 1))).toBe(true);
  });

  it("shards by scope and category", () => {
    expect(
      marketShard({ universal: false, origin: "classic", summary: summary("weapon", 12) }),
    ).toBe("classic:weapon");
    expect(marketShard({ universal: true, origin: "classic", summary: summary("gem", 1) })).toBe(
      "universal:gem",
    );
    expect(shardOfListing("classic:weapon/42")).toBe("classic:weapon");
    expect(shardOfListing("classic:weapon")).toBeNull();
    expect(shardOfListing("../x/1")).toBeNull();
  });
});
