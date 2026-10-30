/**
 * Provider amounts -> our minor units (ADR 0006 §13, docs/secrets.md). OWNER: T-pay.
 *
 * Orders store `amountMinor` in ISO 4217 minor units of a FiatCurrency
 * (USD, BRL, EUR: 2 decimals). Providers report the charge differently:
 *   Stripe        integer in the currency's smallest unit + lower-case code ("usd").
 *   Asaas         decimal BRL value (19.9); the account is BRL only, no code.
 *   Mercado Pago  decimal `transaction_amount` (19.9) + `currency_id` ("BRL").
 * Every conversion here is exact: a decimal with more fraction digits than the
 * currency allows, a float that is not integral, a negative or an unknown
 * currency answers null, which the order treats as a mismatch (never granted).
 */
import type { FiatCurrency } from "@gamez/protocol";
import type { PaidAmount } from "../contracts.ts";

/** ISO 4217 minor-unit exponent of each currency we sell in. */
export const CURRENCY_EXPONENT: Readonly<Record<FiatCurrency, number>> = {
  USD: 2,
  BRL: 2,
  EUR: 2,
};

/** Upper-case ISO code when it is one we sell in, else null. */
export function fiatCurrency(code: unknown): FiatCurrency | null {
  if (typeof code !== "string") return null;
  const upper = code.trim().toUpperCase();
  return Object.hasOwn(CURRENCY_EXPONENT, upper) ? (upper as FiatCurrency) : null;
}

/**
 * An integer already in minor units (Stripe's `amount_total`, the stub's
 * `amountMinor`). Stripe's smallest unit is the ISO minor unit for every
 * currency in CURRENCY_EXPONENT (all 2-decimal), so the integer is taken as is.
 */
export function minorAmount(amount: unknown, currency: unknown): PaidAmount | null {
  const c = fiatCurrency(currency);
  if (c === null) return null;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return null;
  return { currency: c, amountMinor: amount };
}

/**
 * A decimal major-unit amount (number or numeric string) in minor units,
 * exactly: "19.9" BRL -> 1990, 19.99 -> 1999, 19.999 -> null, 1e21 -> null.
 * Numbers go through their shortest round-trip text, so 19.9 is "19.9" and no
 * floating-point multiplication is involved.
 */
export function decimalAmount(value: unknown, currency: unknown): PaidAmount | null {
  const c = fiatCurrency(currency);
  if (c === null) return null;
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else return null;
  const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(text);
  if (!m) return null;
  const exp = CURRENCY_EXPONENT[c];
  const fraction = m[2] ?? "";
  // Extra digits are allowed only when they are zeros ("19.900").
  if (fraction.length > exp && !/^0+$/.test(fraction.slice(exp))) return null;
  const minor = Number(m[1]) * 10 ** exp + Number(fraction.slice(0, exp).padEnd(exp, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  return { currency: c, amountMinor: minor };
}

/** "BRL 19.90" for logs and admin reasons. */
export function formatPaid(p: { currency: string; amountMinor: number }): string {
  const exp = Object.hasOwn(CURRENCY_EXPONENT, p.currency)
    ? CURRENCY_EXPONENT[p.currency as FiatCurrency]
    : 2;
  const sign = p.amountMinor < 0 ? "-" : "";
  const abs = Math.abs(p.amountMinor);
  const major = Math.floor(abs / 10 ** exp);
  const minor = String(abs % 10 ** exp).padStart(exp, "0");
  return `${p.currency} ${sign}${major}${exp > 0 ? `.${minor}` : ""}`;
}
