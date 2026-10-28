import { describe, expect, it } from "vite-plus/test";
import type { CosmeticSlot } from "@gamez/protocol";
import {
  PASS_PREMIUM_SKU,
  PRODUCTS,
  productBySku,
  productPrice,
  suggestedProvider,
} from "../src/products.ts";

describe("store products", () => {
  it("grants cosmetics only in the protocol's CosmeticSlot names", () => {
    const slots: readonly CosmeticSlot[] = ["title", "nameplate", "chatColor"];
    for (const p of PRODUCTS)
      for (const sku of p.grants.entitlements) {
        if (!sku.startsWith("cosmetic.")) continue;
        expect(slots, sku).toContain(sku.split(".")[1]);
      }
  });

  it("has unique skus and the gem packs of the plan", () => {
    const skus = PRODUCTS.map((p) => p.sku);
    expect(new Set(skus).size).toBe(skus.length);
    expect(productBySku("gems.small")?.grants.gems).toBe(100);
    expect(productBySku("gems.medium")?.grants.gems).toBe(550);
    expect(productBySku("gems.large")?.grants.gems).toBe(1200);
  });

  it("sells every product in USD and BRL, in positive safe integer minor units", () => {
    for (const p of PRODUCTS) {
      for (const currency of ["USD", "BRL"]) {
        const price = productPrice(p, currency);
        expect(price, `${p.sku} in ${currency}`).not.toBeNull();
        expect(Number.isSafeInteger(price!.amountMinor)).toBe(true);
        expect(price!.amountMinor).toBeGreaterThan(0);
      }
    }
    expect(productPrice(productBySku("gems.small")!, "EUR")).toBeNull();
  });

  it("grants the season premium entitlement with the pass product", () => {
    expect(PASS_PREMIUM_SKU).toBe("pass.premium.2026-s1");
    const pass = productBySku(PASS_PREMIUM_SKU);
    expect(pass?.kind).toBe("pass");
    expect(pass?.grants).toEqual({ gems: 0, entitlements: [PASS_PREMIUM_SKU] });
  });

  it("the cosmetic bundle grants two or three cosmetic skus and no gems", () => {
    const bundle = productBySku("bundle.ember");
    expect(bundle?.kind).toBe("cosmetic");
    expect(bundle?.grants.gems).toBe(0);
    const skus = bundle?.grants.entitlements ?? [];
    expect(skus.length).toBeGreaterThanOrEqual(2);
    expect(skus.length).toBeLessThanOrEqual(3);
    for (const sku of skus) expect(sku.startsWith("cosmetic.")).toBe(true);
  });

  it("returns null for unknown skus", () => {
    expect(productBySku("gems.huge")).toBeNull();
  });
});

describe("suggestedProvider", () => {
  it("routes Brazil to asaas", () => {
    expect(suggestedProvider("BR")).toBe("asaas");
    expect(suggestedProvider("br")).toBe("asaas");
  });

  it("routes the Spanish-speaking LatAm countries to mercadopago", () => {
    for (const code of ["AR", "MX", "CO", "CL", "PE", "UY"]) {
      expect(suggestedProvider(code)).toBe("mercadopago");
    }
  });

  it("routes everything else, and an unknown country, to stripe", () => {
    expect(suggestedProvider("US")).toBe("stripe");
    expect(suggestedProvider("DE")).toBe("stripe");
    expect(suggestedProvider("PY")).toBe("stripe");
    expect(suggestedProvider(null)).toBe("stripe");
    expect(suggestedProvider("")).toBe("stripe");
  });
});
