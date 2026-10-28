/**
 * Asaas provider (wave-C.md §8): payments API over fetch, BRL only. Customer
 * then payment with billingType UNDEFINED, so the payer picks PIX, boleto or
 * card on the invoice page. Webhooks are checked by the shared access token
 * header (constant time). OWNER: T-pay.
 *
 * Config: ASAAS_API_KEY (sent as `access_token`), ASAAS_WEBHOOK_TOKEN (the
 * token configured on the Asaas webhook), ASAAS_ENV ("production" selects the
 * live API, anything else the sandbox). Enabled only when key and token are set.
 */
import type { FiatCurrency, PaymentProviderId } from "@gamez/protocol";
import type { VerifiedWebhook } from "../contracts.ts";
import type { CheckoutInput, CheckoutSession, PaymentProvider } from "./provider.ts";
import { constantTimeEqual, parseOrderRef } from "./crypto.ts";

export const ASAAS_SANDBOX = "https://api-sandbox.asaas.com/v3";
export const ASAAS_PRODUCTION = "https://api.asaas.com/v3";
/** Days a payment stays payable before it is overdue. */
export const ASAAS_DUE_DAYS = 3;

export interface AsaasOptions {
  apiKey?: string;
  webhookToken?: string;
  /** "production" = live API; anything else = sandbox. */
  env?: string;
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

/** Event names that mean money arrived / was refunded (plan §10). */
const PAID_EVENTS = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"]);
const REFUNDED_EVENTS = new Set(["PAYMENT_REFUNDED"]);

export class AsaasProvider implements PaymentProvider {
  readonly id: PaymentProviderId = "asaas";
  readonly enabled: boolean;
  readonly stub = false;
  readonly currencies: readonly FiatCurrency[] = ["BRL"];
  readonly methods: readonly string[] = ["pix", "boleto", "card"];
  readonly #apiKey: string | undefined;
  readonly #webhookToken: string | undefined;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(opts: AsaasOptions) {
    this.#apiKey = opts.apiKey || undefined;
    this.#webhookToken = opts.webhookToken || undefined;
    this.enabled = Boolean(this.#apiKey && this.#webhookToken);
    this.#base = opts.env === "production" ? ASAAS_PRODUCTION : ASAAS_SANDBOX;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? Date.now;
  }

  #headers(): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      access_token: this.#apiKey ?? "",
      "user-agent": "gamez",
    };
  }

  async #call(
    method: "POST" | "GET",
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; json: Json }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: this.#headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = asObject(await res.json().catch(() => null));
    return { ok: res.ok, status: res.status, json };
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (!this.enabled) throw new Error("asaas is not configured");
    const customer = await this.#call("POST", "/customers", {
      name: `gamez player ${input.accountId.slice(0, 8)}`,
      ...(input.customerEmail ? { email: input.customerEmail } : {}),
      externalReference: input.accountId,
    });
    const customerId = asString(customer.json.id);
    if (!customer.ok || !customerId)
      throw new Error(`asaas customer failed: HTTP ${customer.status}`);

    const due = new Date(this.#now() + ASAAS_DUE_DAYS * 86_400_000).toISOString().slice(0, 10);
    const payment = await this.#call("POST", "/payments", {
      customer: customerId,
      billingType: "UNDEFINED",
      value: input.price.amountMinor / 100,
      dueDate: due,
      description: `${input.product.name} (gamez)`,
      externalReference: `${input.accountId}|${input.orderId}`,
    });
    const paymentId = asString(payment.json.id);
    const url = asString(payment.json.invoiceUrl);
    if (!payment.ok || !paymentId || !url)
      throw new Error(`asaas payment failed: HTTP ${payment.status}`);
    return { providerRef: paymentId, url };
  }

  async verifyWebhook(request: Request): Promise<VerifiedWebhook | null> {
    const raw = await request.text();
    const token = request.headers.get("asaas-access-token");
    if (!this.enabled || !this.#webhookToken || !token) return null;
    if (!constantTimeEqual(token, this.#webhookToken)) return null;

    let body: Json;
    try {
      body = asObject(JSON.parse(raw));
    } catch {
      return null;
    }
    const event = asString(body.event) ?? "";
    const payment = asObject(body.payment);
    const paymentId = asString(payment.id);
    const eventId = asString(body.id) ?? (paymentId ? `asaas:${paymentId}:${event}` : null);
    if (!eventId) return null;
    const ref = parseOrderRef(payment.externalReference);
    const kind = PAID_EVENTS.has(event)
      ? "paid"
      : REFUNDED_EVENTS.has(event)
        ? "refunded"
        : "ignored";
    return {
      eventId,
      kind,
      orderId: ref?.orderId ?? null,
      accountId: ref?.accountId ?? null,
      providerRef: paymentId,
    };
  }

  /** providerRef is the Asaas payment id. */
  async refund(providerRef: string): Promise<{ ok: boolean; message: string }> {
    if (!this.enabled) return { ok: false, message: "asaas is not configured" };
    const res = await this.#call("POST", `/payments/${encodeURIComponent(providerRef)}/refund`, {});
    return { ok: res.ok, message: res.ok ? "refund requested" : `asaas refund HTTP ${res.status}` };
  }
}
