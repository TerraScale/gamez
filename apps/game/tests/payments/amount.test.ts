import { describe, expect, it } from "vite-plus/test";
import {
  decimalAmount,
  fiatCurrency,
  formatPaid,
  minorAmount,
} from "../../src/server/payments/amount.ts";

describe("provider amounts in minor units", () => {
  it("knows only the currencies we sell in, in any case", () => {
    expect(fiatCurrency("usd")).toBe("USD");
    expect(fiatCurrency(" BRL ")).toBe("BRL");
    expect(fiatCurrency("eur")).toBe("EUR");
    expect(fiatCurrency("jpy")).toBeNull();
    expect(fiatCurrency("toString")).toBeNull();
    expect(fiatCurrency("__proto__")).toBeNull();
    expect(fiatCurrency(840)).toBeNull();
  });

  it("takes integers already in minor units as they are", () => {
    expect(minorAmount(99, "usd")).toEqual({ currency: "USD", amountMinor: 99 });
    expect(minorAmount(0, "brl")).toEqual({ currency: "BRL", amountMinor: 0 });
    for (const bad of [9.9, -1, "99", null, undefined, Number.NaN, 2 ** 60])
      expect(minorAmount(bad, "usd")).toBeNull();
    expect(minorAmount(99, "jpy")).toBeNull();
  });

  it("converts decimal major units exactly, without float multiplication", () => {
    // 0.29 * 100 is 28.999999999999996 in floating point.
    expect(decimalAmount(0.29, "BRL")).toEqual({ currency: "BRL", amountMinor: 29 });
    expect(decimalAmount(4.9, "BRL")).toEqual({ currency: "BRL", amountMinor: 490 });
    expect(decimalAmount(19.99, "USD")).toEqual({ currency: "USD", amountMinor: 1999 });
    expect(decimalAmount(1.005, "USD")).toBeNull();
    expect(decimalAmount("19.900", "USD")).toEqual({ currency: "USD", amountMinor: 1990 });
    expect(decimalAmount("19.901", "USD")).toBeNull();
    expect(decimalAmount(100, "EUR")).toEqual({ currency: "EUR", amountMinor: 10000 });
    for (const bad of [-1, 1e21, 1e-7, Number.POSITIVE_INFINITY, "", "1,00", "1.", ".5", null])
      expect(decimalAmount(bad, "USD")).toBeNull();
    expect(decimalAmount(4.9, "ARS")).toBeNull();
  });

  it("formats amounts for reasons", () => {
    expect(formatPaid({ currency: "BRL", amountMinor: 490 })).toBe("BRL 4.90");
    expect(formatPaid({ currency: "USD", amountMinor: 1 })).toBe("USD 0.01");
    expect(formatPaid({ currency: "USD", amountMinor: 123456 })).toBe("USD 1234.56");
  });
});
