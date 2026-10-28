import { describe, expect, it } from "vite-plus/test";
import * as source from "../../../modules/economy/src/fees.ts";
import * as market from "../../../modules/economy/src/market.ts";
import * as local from "../src/economy/parts/fees.ts";

// The UI copies the economy formulas (ui-host must not depend on @gamez/economy).
// These tests pin the copy against the source, so a change in one fails here.
const SAMPLES = [0, 1, 2, 19, 20, 49, 50, 99, 100, 101, 199, 999, 12_345, 1_000_000, 987_654_321];

describe("economy fee previews match modules/economy", () => {
  it("listing fee, sales tax, shop tax and trade fee", () => {
    for (const price of SAMPLES) {
      expect(local.listingFee(price, null)).toBe(source.listingFee(price, null));
      expect(local.listingFee(null, price)).toBe(source.listingFee(null, price));
      expect(local.salesTax(price)).toBe(source.salesTax(price));
      expect(local.shopTax(price)).toBe(source.shopTax(price));
      expect(local.tradeFee(price)).toBe(source.tradeFee(price));
    }
    expect(local.listingFee(null, null)).toBe(source.listingFee(null, null));
  });

  it("next bid floor", () => {
    for (const top of SAMPLES) {
      expect(local.minNextBid(top, 1)).toBe(source.minNextBid(top, 1));
    }
    for (const start of SAMPLES.filter((n) => n > 0)) {
      expect(local.minNextBid(null, start)).toBe(source.minNextBid(null, start));
    }
  });

  it("constants and eligibility", () => {
    expect(local.LISTING_FEE_PCT).toBe(source.LISTING_FEE_PCT);
    expect(local.SALES_TAX_PCT).toBe(source.SALES_TAX_PCT);
    expect(local.SHOP_TAX_PCT).toBe(source.SHOP_TAX_PCT);
    expect(local.TRADE_FEE_PCT).toBe(source.TRADE_FEE_PCT);
    expect(local.MIN_BID_STEP_PCT).toBe(source.MIN_BID_STEP_PCT);
    expect(local.MARKET_MIN_LEVEL).toBe(market.MARKET_MIN_LEVEL);
    expect(local.MARKET_MAX_ACTIVE_PER_ACCOUNT).toBe(market.MARKET_MAX_ACTIVE_PER_ACCOUNT);
    expect(local.MARKET_DURATIONS_H).toEqual(market.MARKET_DURATIONS_H);
    expect(local.MARKET_MAX_PRICE).toBe(market.MARKET_MAX_PRICE);

    const categories = [
      "weapon",
      "armor",
      "jewelry",
      "gem",
      "material",
      "consumable",
      "cosmetic",
      "other",
    ] as const;
    for (const category of categories) {
      for (const level of [0, 1, 9, 10, 40]) {
        const summary = { category, level } as Parameters<typeof market.marketEligible>[0];
        expect(local.marketEligible({ category, level })).toBe(market.marketEligible(summary));
      }
    }
  });

  it("worked examples from the design", () => {
    expect(local.listingFee(1000, null)).toBe(20);
    expect(local.salesTax(1000)).toBe(50);
    expect(local.shopTax(1000)).toBe(30);
    expect(local.tradeFee(500)).toBe(10);
    expect(local.minNextBid(200, 1)).toBe(210);
    expect(local.minNextBid(null, 50)).toBe(50);
  });
});
