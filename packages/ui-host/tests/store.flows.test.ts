import { describe, expect, it } from "vite-plus/test";
import type { PaymentProviderInfo, Product } from "@gamez/protocol";
import type { ApiResult, StoreApi } from "../src/platform.ts";
import {
  KIND_ORDER,
  ORDER_STATUS_LABEL,
  STORE_CURRENCIES,
  checkoutKey,
  checkoutOnce,
  currencyFor,
  formatMinor,
  groupProducts,
  priceIn,
  providerOptions,
} from "../src/play/StoreView.tsx";

const gems: Product = {
  sku: "gems.small",
  name: "Gem pouch",
  description: "100 gems",
  kind: "gems",
  prices: [
    { currency: "USD", amountMinor: 99 },
    { currency: "BRL", amountMinor: 490 },
  ],
  grants: { gems: 100, entitlements: [] },
};
const bundle: Product = {
  sku: "bundle.ember",
  name: "Ember bundle",
  description: "cosmetics",
  kind: "cosmetic",
  prices: [{ currency: "USD", amountMinor: 499 }],
  grants: { gems: 0, entitlements: ["cosmetic.title.ember"] },
};
const pass: Product = {
  sku: "pass.premium.2026-s1",
  name: "Premium pass",
  description: "",
  kind: "pass",
  prices: [{ currency: "USD", amountMinor: 999 }],
  grants: { gems: 0, entitlements: ["pass.premium.2026-s1"] },
};

const providers: PaymentProviderInfo[] = [
  { id: "stripe", enabled: true, stub: false, currencies: ["USD", "BRL"], methods: ["card"] },
  {
    id: "asaas",
    enabled: true,
    stub: false,
    currencies: ["BRL"],
    methods: ["pix", "boleto", "card"],
  },
  { id: "mercadopago", enabled: false, stub: false, currencies: ["BRL"], methods: ["pix"] },
  {
    id: "stub",
    enabled: true,
    stub: true,
    currencies: ["USD", "BRL"],
    methods: ["card", "pix", "boleto"],
  },
];

describe("store helpers", () => {
  it("picks BRL for Brazil and USD elsewhere", () => {
    expect(currencyFor("BR")).toBe("BRL");
    expect(currencyFor("br")).toBe("BRL");
    expect(currencyFor("US")).toBe("USD");
    expect(currencyFor(null)).toBe("USD");
    expect(STORE_CURRENCIES).toEqual(["USD", "BRL"]);
  });

  it("formats minor units in the currency's locale", () => {
    expect(formatMinor(99, "USD")).toBe("$0.99");
    expect(formatMinor(490, "BRL")).toMatch(/4,90/);
    expect(formatMinor(490, "BRL")).toMatch(/R\$/);
  });

  it("finds the price of a currency or null", () => {
    expect(priceIn(gems, "BRL")).toEqual({ currency: "BRL", amountMinor: 490 });
    expect(priceIn(bundle, "BRL")).toBeNull();
  });

  it("groups products by kind in the fixed order and drops empty groups", () => {
    const groups = groupProducts([bundle, gems, pass]);
    expect(groups.map((g) => g.kind)).toEqual(["gems", "pass", "cosmetic"]);
    expect(groups.map((g) => g.title)).toEqual(["Gem packs", "Season pass", "Cosmetics"]);
    expect(groupProducts([gems]).map((g) => g.kind)).toEqual(["gems"]);
    expect(KIND_ORDER).toEqual(["gems", "pass", "cosmetic"]);
  });

  it("lists the enabled providers for the currency, suggested first, with PIX and boleto badges", () => {
    const usd = providerOptions(providers, "asaas", "USD");
    expect(usd.map((o) => o.id)).toEqual(["stripe", "stub"]);
    const brl = providerOptions(providers, "asaas", "BRL");
    expect(brl.map((o) => o.id)).toEqual(["asaas", "stripe", "stub"]);
    expect(brl[0]?.suggested).toBe(true);
    expect(brl[0]?.badges).toEqual(["PIX", "Boleto", "Card"]);
    expect(brl[2]?.badges).toEqual(["Card", "PIX", "Boleto", "Sandbox"]);
  });

  it("never offers a disabled provider, even when it is suggested", () => {
    const options = providerOptions(providers, "mercadopago", "BRL");
    expect(options.map((o) => o.id)).not.toContain("mercadopago");
  });

  it("keys a checkout by sku, provider and currency, and labels every order status", () => {
    expect(checkoutKey("gems.small", "stub", "USD")).toBe("gems.small|stub|USD");
    expect(Object.keys(ORDER_STATUS_LABEL).sort()).toEqual([
      "failed",
      "paid",
      "pending",
      "refunded",
    ]);
  });
});

function fakeStore(replies: ApiResult<{ orderId: string; url: string }>[]) {
  const seen: { sku: string; provider: string; currency: string; opId: string | undefined }[] = [];
  const store = {
    checkout: async (sku: string, provider: string, currency: string, opId?: string) => {
      seen.push({ sku, provider, currency, opId });
      return replies.shift() ?? { ok: false, code: "unavailable", message: "no reply" };
    },
  } as unknown as StoreApi;
  return { store, seen };
}

describe("checkoutOnce", () => {
  it("sends one opId per attempt and forgets it after success", async () => {
    const ops = new Map<string, string>();
    const { store, seen } = fakeStore([{ ok: true, value: { orderId: "o1", url: "/u" } }]);
    const res = await checkoutOnce(store, ops, {
      sku: "gems.small",
      provider: "stub",
      currency: "USD",
    });
    expect(res.ok).toBe(true);
    expect(seen[0]?.opId).toMatch(/^[0-9a-f]{32}$/);
    expect(ops.size).toBe(0);
  });

  it("reuses the opId after a network failure, so the retry is the same order", async () => {
    const ops = new Map<string, string>();
    const { store, seen } = fakeStore([
      { ok: false, code: "network", message: "Network error, try again" },
      { ok: true, value: { orderId: "o1", url: "/u" } },
    ]);
    const req = { sku: "gems.small", provider: "stub" as const, currency: "USD" as const };
    await checkoutOnce(store, ops, req);
    await checkoutOnce(store, ops, req);
    expect(seen[0]?.opId).toBeDefined();
    expect(seen[1]?.opId).toBe(seen[0]?.opId);
  });

  it("ends the attempt on a real refusal, so the next click is a new order", async () => {
    const ops = new Map<string, string>();
    const { store, seen } = fakeStore([
      { ok: false, code: "conflict", message: "this opId was used for another order" },
      { ok: true, value: { orderId: "o2", url: "/u" } },
    ]);
    const req = { sku: "gems.small", provider: "stub" as const, currency: "USD" as const };
    const refused = await checkoutOnce(store, ops, req);
    expect(refused.ok).toBe(false);
    await checkoutOnce(store, ops, req);
    expect(seen[1]?.opId).not.toBe(seen[0]?.opId);
  });
});
