/**
 * Stripe provider (wave-C.md §8): Checkout Session API over fetch (form-encoded),
 * webhooks verified with the Stripe-Signature header. OWNER: T-pay.
 *
 * Config: STRIPE_SECRET_KEY (checkout + refunds) and STRIPE_WEBHOOK_SECRET
 * (signature). Enabled only when both are set. Our ids travel in metadata:
 * the session carries accountId/orderId, and payment_intent_data copies them to
 * the payment intent. Charges do not inherit that metadata, so charge.refunded
 * reads our ids from the payment intent (GET /v1/payment_intents/<id>) when the
 * charge has none.
 */
import type { FiatCurrency, PaymentProviderId } from "@gamez/protocol";
import type { VerifiedWebhook } from "../contracts.ts";
import type { CheckoutInput, CheckoutSession, PaymentProvider } from "./provider.ts";
import { constantTimeEqual, hmacSha256Hex } from "./crypto.ts";

export const STRIPE_API = "https://api.stripe.com/v1";
/** Stripe's own default tolerance for timestamps in Stripe-Signature. */
export const STRIPE_TOLERANCE_S = 300;

export interface StripeOptions {
  secretKey?: string;
  webhookSecret?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Milliseconds; injectable for tests. */
  now?: () => number;
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Parses "t=…,v1=…,v1=…,v0=…" into the timestamp and every v1 signature. */
export function parseStripeSignature(header: string): { t: string | null; v1: string[] } {
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && t === null) t = value;
    else if (key === "v1") v1.push(value);
  }
  return { t, v1 };
}

export class StripeProvider implements PaymentProvider {
  readonly id: PaymentProviderId = "stripe";
  readonly enabled: boolean;
  readonly stub = false;
  readonly currencies: readonly FiatCurrency[] = ["USD", "BRL"];
  readonly methods: readonly string[] = ["card"];
  readonly #secretKey: string | undefined;
  readonly #webhookSecret: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(opts: StripeOptions) {
    this.#secretKey = opts.secretKey || undefined;
    this.#webhookSecret = opts.webhookSecret || undefined;
    this.enabled = Boolean(this.#secretKey && this.#webhookSecret);
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? Date.now;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (!this.enabled || !this.#secretKey) throw new Error("stripe is not configured");
    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("success_url", input.successUrl);
    form.set("cancel_url", input.cancelUrl);
    form.set("client_reference_id", input.orderId);
    form.set("line_items[0][quantity]", "1");
    form.set("line_items[0][price_data][currency]", input.price.currency.toLowerCase());
    form.set("line_items[0][price_data][unit_amount]", String(input.price.amountMinor));
    form.set("line_items[0][price_data][product_data][name]", input.product.name);
    form.set("metadata[accountId]", input.accountId);
    form.set("metadata[orderId]", input.orderId);
    form.set("payment_intent_data[metadata][accountId]", input.accountId);
    form.set("payment_intent_data[metadata][orderId]", input.orderId);
    if (input.customerEmail) form.set("customer_email", input.customerEmail);
    const res = await this.#fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        // Same orderId, same parameters: a retried checkout reuses the session.
        "idempotency-key": `checkout:${input.orderId}`,
      },
      body: form.toString(),
    });
    const body = asObject(await res.json().catch(() => null));
    const id = asString(body.id);
    const url = asString(body.url);
    if (!res.ok || !id || !url) throw new Error(`stripe checkout failed: HTTP ${res.status}`);
    return { providerRef: id, url };
  }

  async verifyWebhook(request: Request): Promise<VerifiedWebhook | null> {
    const raw = await request.text();
    const header = request.headers.get("stripe-signature");
    if (!this.enabled || !this.#webhookSecret || !header) return null;
    const { t, v1 } = parseStripeSignature(header);
    if (!t || v1.length === 0) return null;
    const ts = Number(t);
    if (!Number.isSafeInteger(ts)) return null;
    if (Math.abs(this.#now() / 1000 - ts) > STRIPE_TOLERANCE_S) return null;
    const expected = await hmacSha256Hex(this.#webhookSecret, `${t}.${raw}`);
    if (!v1.some((sig) => constantTimeEqual(sig.toLowerCase(), expected))) return null;

    let event: Json;
    try {
      event = asObject(JSON.parse(raw));
    } catch {
      return null;
    }
    const eventId = asString(event.id);
    if (!eventId) return null;
    const object = asObject(asObject(event.data).object);
    const metadata = asObject(object.metadata);
    const orderId = asString(metadata.orderId);
    const accountId = asString(metadata.accountId);
    const type = asString(event.type);

    if (
      type === "checkout.session.completed" ||
      type === "checkout.session.async_payment_succeeded"
    ) {
      // "unpaid" means an async method that has not settled yet: wait for the succeeded event.
      const unpaid = object.payment_status === "unpaid";
      return {
        eventId,
        kind: unpaid ? "ignored" : "paid",
        orderId,
        accountId,
        providerRef: asString(object.id),
      };
    }
    if (type === "charge.refunded") {
      const intent = asString(object.payment_intent);
      // A partial refund leaves the purchase in place: only a full refund revokes it.
      if (object.refunded === false)
        return { eventId, kind: "ignored", orderId, accountId, providerRef: intent };
      // Stripe does not copy the payment intent's metadata onto its charges, so a
      // charge without our ids is resolved through the (already verified) intent.
      let ids = { orderId, accountId };
      if ((!orderId || !accountId) && intent) ids = await this.#intentIds(intent);
      return { eventId, kind: "refunded", ...ids, providerRef: intent };
    }
    return { eventId, kind: "ignored", orderId, accountId, providerRef: null };
  }

  /** Our ids from a payment intent's metadata. Throws on an API failure so the webhook is retried. */
  async #intentIds(intent: string): Promise<{ orderId: string | null; accountId: string | null }> {
    if (!this.#secretKey) return { orderId: null, accountId: null };
    const res = await this.#fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(intent)}`, {
      headers: { authorization: `Bearer ${this.#secretKey}` },
    });
    if (res.status === 404) return { orderId: null, accountId: null };
    if (!res.ok) throw new Error(`stripe payment intent lookup failed: HTTP ${res.status}`);
    const metadata = asObject(asObject(await res.json().catch(() => null)).metadata);
    return { orderId: asString(metadata.orderId), accountId: asString(metadata.accountId) };
  }

  /** providerRef is the checkout session id (the one fulfilment stored). */
  async refund(providerRef: string): Promise<{ ok: boolean; message: string }> {
    if (!this.enabled || !this.#secretKey)
      return { ok: false, message: "stripe is not configured" };
    const session = await this.#fetch(
      `${STRIPE_API}/checkout/sessions/${encodeURIComponent(providerRef)}`,
      { headers: { authorization: `Bearer ${this.#secretKey}` } },
    );
    const sessionBody = asObject(await session.json().catch(() => null));
    const intent = asString(sessionBody.payment_intent);
    if (!session.ok || !intent) return { ok: false, message: "no payment intent for this session" };
    const form = new URLSearchParams();
    form.set("payment_intent", intent);
    const res = await this.#fetch(`${STRIPE_API}/refunds`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `refund:${intent}`,
      },
      body: form.toString(),
    });
    return {
      ok: res.ok,
      message: res.ok ? "refund requested" : `stripe refund HTTP ${res.status}`,
    };
  }
}
