/**
 * Sandbox stub provider (wave-C.md §8). OWNER: T-pay. Dev hosts only (or
 * PAYMENTS_STUB=1). Its checkout is a local page with "Pay (sandbox)" and
 * "Cancel"; paying posts a webhook body signed with HMAC-SHA256(AUTH_SECRET) in
 * `x-stub-signature`, which the webhook route verifies like any other provider.
 * Nothing leaves the Worker.
 */
import type { FiatCurrency, PaymentProviderId } from "@gamez/protocol";
import type { VerifiedWebhook } from "../contracts.ts";
import type { CheckoutInput, CheckoutSession, PaymentProvider } from "./provider.ts";
import { constantTimeEqual, hmacSha256Hex } from "./crypto.ts";

export const STUB_CHECKOUT_PATH = "/api/pay/stub/checkout";
export const STUB_COMPLETE_PATH = "/api/pay/stub/complete";
export const STUB_SIGNATURE_HEADER = "x-stub-signature";

/** Body of a stub webhook (also what the test helpers build). */
export interface StubWebhookBody {
  id: string;
  kind: "paid" | "refunded" | "ignored";
  orderId: string;
  accountId: string;
  providerRef: string;
}

export class StubProvider implements PaymentProvider {
  readonly id: PaymentProviderId = "stub";
  readonly stub = true;
  readonly currencies: readonly FiatCurrency[] = ["USD", "BRL"];
  readonly methods: readonly string[] = ["card", "pix", "boleto"];
  readonly enabled: boolean;
  readonly #authSecret: string;

  constructor(opts: { authSecret: string; enabled: boolean }) {
    this.#authSecret = opts.authSecret;
    this.enabled = opts.enabled;
  }

  /** The stub checkout page on this origin (it needs the order and the account to finish). */
  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const origin = new URL(input.webhookUrl).origin;
    const query = new URLSearchParams({ order: input.orderId, account: input.accountId });
    return {
      providerRef: stubRefOf(input.orderId),
      url: `${origin}${STUB_CHECKOUT_PATH}?${query.toString()}`,
    };
  }

  async verifyWebhook(request: Request): Promise<VerifiedWebhook | null> {
    if (!this.enabled) return null;
    const raw = await request.text();
    const sig = request.headers.get(STUB_SIGNATURE_HEADER);
    if (!sig) return null;
    const expected = await hmacSha256Hex(this.#authSecret, raw);
    if (!constantTimeEqual(sig.toLowerCase(), expected)) return null;
    let body: Partial<StubWebhookBody>;
    try {
      body = JSON.parse(raw) as Partial<StubWebhookBody>;
    } catch {
      return null;
    }
    if (typeof body.id !== "string" || typeof body.orderId !== "string") return null;
    const kind = body.kind === "paid" || body.kind === "refunded" ? body.kind : "ignored";
    return {
      eventId: body.id,
      kind,
      orderId: body.orderId,
      accountId: typeof body.accountId === "string" ? body.accountId : null,
      providerRef: typeof body.providerRef === "string" ? body.providerRef : null,
    };
  }

  async refund(_providerRef: string): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "stub refund: nothing to move" };
  }
}

export function stubRefOf(orderId: string): string {
  return `stub_${orderId}`;
}

/** The signed webhook body for a stub payment (paid or refunded). */
export function stubWebhookBody(body: StubWebhookBody): string {
  return JSON.stringify(body);
}

/** HMAC-SHA256(AUTH_SECRET) over the raw webhook body, lowercase hex. */
export function signStubBody(authSecret: string, raw: string): Promise<string> {
  return hmacSha256Hex(authSecret, raw);
}

/** HTML escaping for values placed in the stub page. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The sandbox checkout page: product, price, the order, and the two choices.
 * The form posts to /api/pay/stub/complete, which signs and applies the webhook.
 */
export function stubCheckoutPage(view: {
  orderId: string;
  accountId: string;
  productName: string;
  priceText: string;
}): string {
  const e = escapeHtml;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandbox checkout</title>
<style>
  body { margin: 0; padding: 16px; font: 16px/1.4 system-ui, sans-serif; background: #15110d; color: #efe6d2; }
  main { max-width: 420px; margin: 24px auto; background: #241c14; border: 1px solid #6b5230; border-radius: 10px; padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 8px; color: #f3d27a; }
  p { margin: 6px 0; color: #c9bca2; }
  .warn { color: #e0664f; font-size: 13px; }
  button { min-height: 44px; min-width: 44px; width: 100%; margin-top: 10px; border-radius: 8px; border: 1px solid #6b5230; font: inherit; cursor: pointer; }
  .pay { background: #5a4220; color: #f3d27a; font-weight: 700; }
  .cancel { background: #2b2219; color: #efe6d2; }
</style>
</head>
<body>
<main>
  <h1>${e(view.productName)}</h1>
  <p>${e(view.priceText)}</p>
  <p class="warn">Sandbox: no money moves. This page exists for local development.</p>
  <p>Order <code>${e(view.orderId)}</code></p>
  <form method="post" action="${STUB_COMPLETE_PATH}">
    <input type="hidden" name="order" value="${e(view.orderId)}">
    <input type="hidden" name="account" value="${e(view.accountId)}">
    <button class="pay" type="submit" name="result" value="paid">Pay (sandbox)</button>
    <button class="cancel" type="submit" name="result" value="cancel">Cancel</button>
  </form>
</main>
</body>
</html>
`;
}
