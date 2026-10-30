/**
 * Mercado Pago provider (wave-C.md §8): Checkout Pro preference with
 * external_reference, webhooks verified with the x-signature header
 * (ts/v1 HMAC-SHA256 of "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"),
 * then GET /v1/payments/<id> for the status and our external reference. OWNER: T-pay.
 *
 * Config: MERCADOPAGO_ACCESS_TOKEN (API bearer, test or live), MERCADOPAGO_WEBHOOK_SECRET
 * (the signature secret of the webhook). Enabled only when both are set.
 */
import type { FiatCurrency, PaymentProviderId } from "@gamez/protocol";
import type { VerifiedWebhook } from "../contracts.ts";
import type { CheckoutInput, CheckoutSession, PaymentProvider } from "./provider.ts";
import { decimalAmount } from "./amount.ts";
import { constantTimeEqual, hmacSha256Hex, parseOrderRef, toMillis } from "./crypto.ts";

export const MERCADOPAGO_API = "https://api.mercadopago.com";
/** Largest clock skew accepted for x-signature timestamps. */
export const MERCADOPAGO_TOLERANCE_S = 300;

export interface MercadoPagoOptions {
  accessToken?: string;
  webhookSecret?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Parses "ts=…,v1=…" into its parts (either may be missing). */
export function parseMercadoPagoSignature(header: string): {
  ts: string | null;
  v1: string | null;
} {
  let ts: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "ts" && ts === null) ts = value;
    else if (key === "v1" && v1 === null) v1 = value;
  }
  return { ts, v1 };
}

export class MercadoPagoProvider implements PaymentProvider {
  readonly id: PaymentProviderId = "mercadopago";
  readonly enabled: boolean;
  readonly stub = false;
  readonly currencies: readonly FiatCurrency[] = ["BRL", "USD"];
  readonly methods: readonly string[] = ["pix", "boleto", "card"];
  readonly #token: string | undefined;
  readonly #webhookSecret: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(opts: MercadoPagoOptions) {
    this.#token = opts.accessToken || undefined;
    this.#webhookSecret = opts.webhookSecret || undefined;
    this.enabled = Boolean(this.#token && this.#webhookSecret);
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? Date.now;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (!this.enabled || !this.#token) throw new Error("mercadopago is not configured");
    const res = await this.#fetch(`${MERCADOPAGO_API}/checkout/preferences`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        "x-idempotency-key": `checkout:${input.orderId}`,
      },
      body: JSON.stringify({
        items: [
          {
            title: input.product.name,
            description: input.product.description,
            quantity: 1,
            currency_id: input.price.currency,
            unit_price: input.price.amountMinor / 100,
          },
        ],
        external_reference: `${input.accountId}|${input.orderId}`,
        metadata: { accountId: input.accountId, orderId: input.orderId },
        notification_url: input.webhookUrl,
        back_urls: {
          success: input.successUrl,
          failure: input.cancelUrl,
          pending: input.successUrl,
        },
        auto_return: "approved",
        ...(input.customerEmail ? { payer: { email: input.customerEmail } } : {}),
      }),
    });
    const body = asObject(await res.json().catch(() => null));
    const id = asString(body.id);
    const url = asString(body.init_point);
    if (!res.ok || !id || !url)
      throw new Error(`mercadopago preference failed: HTTP ${res.status}`);
    return { providerRef: id, url };
  }

  async verifyWebhook(request: Request): Promise<VerifiedWebhook | null> {
    const raw = await request.text();
    const signature = request.headers.get("x-signature");
    const requestId = request.headers.get("x-request-id");
    if (!this.enabled || !this.#webhookSecret || !signature || !requestId) return null;
    const { ts, v1 } = parseMercadoPagoSignature(signature);
    if (!ts || !v1) return null;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return null;
    if (Math.abs(this.#now() - toMillis(tsNum)) > MERCADOPAGO_TOLERANCE_S * 1000) return null;

    // The data id comes from the query string (MP's signed form) or the body.
    const url = new URL(request.url);
    let body: Json = {};
    try {
      body = asObject(JSON.parse(raw));
    } catch {
      return null;
    }
    const rawId = url.searchParams.get("data.id") ?? asObject(body.data).id;
    const dataId = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
    if (!dataId) return null;
    // MP asks for alphanumeric ids in lower case inside the manifest.
    const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
    const expected = await hmacSha256Hex(this.#webhookSecret, manifest);
    if (!constantTimeEqual(v1.toLowerCase(), expected)) return null;

    // The signature is valid: read the truth from the API, never from the body.
    const res = await this.#fetch(`${MERCADOPAGO_API}/v1/payments/${encodeURIComponent(dataId)}`, {
      headers: { authorization: `Bearer ${this.#token ?? ""}` },
    });
    if (res.status === 404)
      return {
        eventId: `mp:${requestId}`,
        kind: "ignored",
        orderId: null,
        accountId: null,
        providerRef: null,
        paid: null,
      };
    if (!res.ok) throw new Error(`mercadopago payment lookup failed: HTTP ${res.status}`);
    const payment = asObject(await res.json().catch(() => null));
    const status = asString(payment.status);
    const ref = parseOrderRef(payment.external_reference);
    const kind =
      status === "approved"
        ? "paid"
        : status === "refunded" || status === "charged_back"
          ? "refunded"
          : "ignored";
    return {
      eventId: `mp:${dataId}:${status ?? "unknown"}`,
      kind,
      orderId: ref?.orderId ?? null,
      accountId: ref?.accountId ?? null,
      providerRef: asString(payment.id) ?? dataId,
      // transaction_amount is the decimal price of the items (installment interest
      // the payer chose is in transaction_details.total_paid_amount, not here).
      paid: kind === "paid" ? decimalAmount(payment.transaction_amount, payment.currency_id) : null,
    };
  }

  /** providerRef is the Mercado Pago payment id. */
  async refund(providerRef: string): Promise<{ ok: boolean; message: string }> {
    if (!this.enabled || !this.#token)
      return { ok: false, message: "mercadopago is not configured" };
    const res = await this.#fetch(
      `${MERCADOPAGO_API}/v1/payments/${encodeURIComponent(providerRef)}/refunds`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          "x-idempotency-key": `refund:${providerRef}`,
        },
        body: "{}",
      },
    );
    return {
      ok: res.ok,
      message: res.ok ? "refund requested" : `mercadopago refund HTTP ${res.status}`,
    };
  }
}
