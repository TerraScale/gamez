/**
 * Store products (wave-C.md §8). OWNER: T-pay. Prices are minor units per
 * currency (USD cents, BRL centavos); grants are gems and/or entitlement skus
 * ("pass.premium.<season>", "cosmetic.*"). Original names only.
 *
 * Pure data and routing rules: no I/O, no clocks (the server applies them).
 */
import type { PaymentProviderId, Product } from "@gamez/protocol";

/** Premium pass entitlement of season 2026-s1 (modules/economy season.ts). */
export const PASS_PREMIUM_SKU = "pass.premium.2026-s1";

export const PRODUCTS: readonly Product[] = [
  {
    sku: "gems.small",
    name: "Gem pouch",
    description: "100 gems for cosmetics and the battle pass.",
    kind: "gems",
    prices: [
      { currency: "USD", amountMinor: 99 },
      { currency: "BRL", amountMinor: 490 },
    ],
    grants: { gems: 100, entitlements: [] },
  },
  {
    sku: "gems.medium",
    name: "Gem chest",
    description: "550 gems: a little more than the pouch.",
    kind: "gems",
    prices: [
      { currency: "USD", amountMinor: 499 },
      { currency: "BRL", amountMinor: 2490 },
    ],
    grants: { gems: 550, entitlements: [] },
  },
  {
    sku: "gems.large",
    name: "Gem vault",
    description: "1200 gems: the best value per gem.",
    kind: "gems",
    prices: [
      { currency: "USD", amountMinor: 999 },
      { currency: "BRL", amountMinor: 4990 },
    ],
    grants: { gems: 1200, entitlements: [] },
  },
  {
    sku: PASS_PREMIUM_SKU,
    name: "Season of Embers: premium pass",
    description: "Unlocks the premium track of the season. Free tracks stay free.",
    kind: "pass",
    prices: [
      { currency: "USD", amountMinor: 999 },
      { currency: "BRL", amountMinor: 4990 },
    ],
    grants: { gems: 0, entitlements: [PASS_PREMIUM_SKU] },
  },
  {
    sku: "bundle.ember",
    name: "Ember bundle",
    description: "A title, a nameplate and a chat colour in the ember style.",
    kind: "cosmetic",
    prices: [
      { currency: "USD", amountMinor: 499 },
      { currency: "BRL", amountMinor: 2490 },
    ],
    grants: {
      gems: 0,
      entitlements: [
        "cosmetic.title.ember",
        "cosmetic.nameplate.ember",
        "cosmetic.chatColor.ember",
      ],
    },
  },
];

export function productBySku(sku: string): Product | null {
  return PRODUCTS.find((p) => p.sku === sku) ?? null;
}

/** The price of `product` in `currency`, or null when it is not sold in that currency. */
export function productPrice(product: Product, currency: string): Product["prices"][number] | null {
  return product.prices.find((p) => p.currency === currency) ?? null;
}

const LATAM_MERCADOPAGO = new Set(["AR", "MX", "CO", "CL", "PE", "UY"]);

/**
 * Provider routing suggestion by ISO 3166 country (plan §10): BR -> asaas
 * (PIX, boleto, card in BRL), AR/MX/CO/CL/PE/UY -> mercadopago, else stripe.
 * Case-insensitive; a missing country is stripe.
 */
export function suggestedProvider(country: string | null): "stripe" | "asaas" | "mercadopago" {
  const code = country?.trim().toUpperCase() ?? "";
  if (code === "BR") return "asaas";
  if (LATAM_MERCADOPAGO.has(code)) return "mercadopago";
  return "stripe";
}

/** Every payment provider id the store accepts in a checkout body. */
export const PAYMENT_PROVIDER_IDS: readonly PaymentProviderId[] = [
  "stripe",
  "asaas",
  "mercadopago",
  "stub",
];
