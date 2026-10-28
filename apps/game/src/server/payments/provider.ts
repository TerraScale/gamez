/**
 * PaymentProvider (plan §10, wave-C.md §8). CONTRACT (architect); OWNER of
 * the implementations: T-pay (stripe.ts, asaas.ts, mercadopago.ts, stub.ts,
 * index.ts providersFor(env, url)).
 *
 * Rules: webhooks are verified before anything is read from them (Stripe:
 * "Stripe-Signature" HMAC-SHA256 of "<t>.<raw body>" with
 * STRIPE_WEBHOOK_SECRET, 5 min tolerance, constant-time compare; Asaas: the
 * "asaas-access-token" header equals ASAAS_WEBHOOK_TOKEN (constant time);
 * Mercado Pago: "x-signature" ts/v1 HMAC-SHA256 of
 * "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" with
 * MERCADOPAGO_WEBHOOK_SECRET, then GET /v1/payments/<id> to read status and
 * external_reference; stub: HMAC-SHA256 with AUTH_SECRET over the raw body in
 * "x-stub-signature"). Every checkout carries our orderId + accountId
 * ("<accountId>|<orderId>") in the provider's metadata/external reference.
 * Every fulfilment goes through AccountApiC.fulfillOrder (idempotent by orderId).
 */
import type { FiatCurrency, PaymentProviderId, Product, ProductPrice } from "@gamez/protocol";
import type { VerifiedWebhook } from "../contracts.ts";

export interface CheckoutInput {
  orderId: string;
  accountId: string;
  product: Product;
  price: ProductPrice;
  /** Absolute URLs. */
  successUrl: string;
  cancelUrl: string;
  webhookUrl: string;
  customerEmail: string | null;
}

export interface CheckoutSession {
  /** Provider payment/session id. */
  providerRef: string;
  /** Redirect URL for the browser. */
  url: string;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  readonly enabled: boolean;
  readonly stub: boolean;
  readonly currencies: readonly FiatCurrency[];
  readonly methods: readonly string[];
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  /** null = signature/token invalid (answer 401, change nothing). Reads the raw body itself. */
  verifyWebhook(request: Request): Promise<VerifiedWebhook | null>;
  refund(providerRef: string): Promise<{ ok: boolean; message: string }>;
}
