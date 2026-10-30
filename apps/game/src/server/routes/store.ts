/**
 * /api/store*, /api/pay/webhook/:provider, /api/pay/stub/* (docs/design/wave-C.md §8).
 * OWNER: T-pay.
 *
 *   GET  /api/store?country=XX      products, providers, suggested provider (flag "store")
 *   POST /api/store/checkout        {opId, sku, provider, currency} -> {orderId, url} (registered)
 *   GET  /api/store/orders          my orders
 *   POST /api/pay/webhook/:provider verified webhook -> fulfil / refund (200, 401 bad signature)
 *   GET  /api/pay/stub/checkout     sandbox checkout page (stub only, else 404)
 *   POST /api/pay/stub/complete     sandbox: signs and applies a paid webhook (stub only)
 *
 * orderId = "o" + first 24 hex of SHA-256("<accountId>:<opId>"): a retried checkout
 * is the same order. Fulfilment and refunds are idempotent by orderId in AccountDO.
 * A paid webhook carries the provider-reported amount and currency; AccountDO
 * grants only when they equal the order's price and otherwise fails the order
 * (200 with applied: false, status "failed", so the provider stops retrying).
 */
import {
  PAYMENT_PROVIDER_IDS,
  PRODUCTS,
  productBySku,
  productPrice,
  suggestedProvider,
} from "@gamez/economy";
import type {
  CheckoutResponse,
  FiatCurrency,
  OrderView,
  OrdersResponse,
  PaymentProviderId,
  StoreResponse,
} from "@gamez/protocol";
import { featureEnabled } from "../config/flags.ts";
import type { Env, OrderRecord, VerifiedWebhook } from "../contracts.ts";
import { economyCaller, opIdOf } from "../economy/guards.ts";
import { apiError, json, readJson } from "../http.ts";
import { sha256Hex } from "../payments/crypto.ts";
import type { PaymentProvider } from "../payments/provider.ts";
import { providerById, providerInfo, providersFor } from "../payments/index.ts";
import {
  STUB_SIGNATURE_HEADER,
  signStubBody,
  stubCheckoutPage,
  stubRefOf,
  stubWebhookBody,
  type StubWebhookBody,
} from "../payments/stub.ts";
import type { RouteContext, RouteHandler } from "./types.ts";

const CURRENCIES: readonly FiatCurrency[] = ["USD", "BRL", "EUR"];
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ORDER_ID_RE = /^o[0-9a-f]{24}$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;
const STUB_BODY_MAX = 4096;

export const storeRoutes: RouteHandler = async (c) => {
  const path = c.url.pathname;
  if (path === "/api/store") return only(c, "GET", () => catalog(c));
  if (path === "/api/store/checkout") return only(c, "POST", () => checkout(c));
  if (path === "/api/store/orders") return only(c, "GET", () => orders(c));
  if (path.startsWith("/api/pay/webhook/")) {
    const id = path.slice("/api/pay/webhook/".length);
    return only(c, "POST", () => webhook(c, id));
  }
  if (path === "/api/pay/stub/checkout") return only(c, "GET", () => stubCheckout(c));
  if (path === "/api/pay/stub/complete") return only(c, "POST", () => stubComplete(c));
  return null;
};

async function only(
  c: RouteContext,
  method: "GET" | "POST",
  run: () => Promise<Response>,
): Promise<Response> {
  if (c.request.method !== method) return apiError(405, "bad_request", "method not allowed");
  return run();
}

// ---- catalog ----------------------------------------------------------------

async function catalog(c: RouteContext): Promise<Response> {
  if (!(await featureEnabled(c.env, "store")))
    return apiError(503, "disabled", "store is switched off for now");
  const providers = providersFor(c.env, c.url);
  const enabled = providers.filter((p) => p.enabled);
  const preferred = suggestedProvider(countryOf(c));
  const suggested: PaymentProviderId | null =
    enabled.find((p) => p.id === preferred)?.id ?? enabled[0]?.id ?? null;
  const body: StoreResponse = {
    products: [...PRODUCTS],
    providers: providers.map(providerInfo),
    suggested,
  };
  return json(body);
}

/** ?country= (two letters), else the edge's country, else null. */
function countryOf(c: RouteContext): string | null {
  const q = c.url.searchParams.get("country");
  if (q !== null) return COUNTRY_RE.test(q) ? q.toUpperCase() : null;
  const cf = (c.request as Request & { cf?: { country?: string } }).cf;
  return cf?.country && COUNTRY_RE.test(cf.country) ? cf.country.toUpperCase() : null;
}

// ---- checkout and orders ------------------------------------------------------

async function checkout(c: RouteContext): Promise<Response> {
  const who = await economyCaller(c, "store", { write: true });
  if (who instanceof Response) return who;
  const body = await readJson(c.request);
  if (!body) return apiError(400, "bad_request", "expected a JSON object");
  const opId = opIdOf(body);
  if (opId instanceof Response) return opId;

  const sku = typeof body.sku === "string" ? body.sku : "";
  const product = productBySku(sku);
  if (!product) return apiError(404, "not_found", "no such product");
  const provider = typeof body.provider === "string" ? body.provider : "";
  if (!(PAYMENT_PROVIDER_IDS as readonly string[]).includes(provider))
    return apiError(400, "bad_request", "unknown payment provider");
  const currency = typeof body.currency === "string" ? body.currency : "";
  if (!(CURRENCIES as readonly string[]).includes(currency))
    return apiError(400, "bad_request", "currency must be USD, BRL or EUR");
  const price = productPrice(product, currency);
  if (!price) return apiError(400, "bad_request", `${sku} is not sold in ${currency}`);

  const p = providerById(providersFor(c.env, c.url), provider);
  if (!p || !p.enabled) return apiError(503, "unavailable", `${provider} is not set up here`);
  if (!p.currencies.includes(price.currency))
    return apiError(400, "bad_request", `${provider} does not take ${currency}`);

  const accountId = who.identity.accountId;
  const orderId = await orderIdFor(accountId, opId);
  const acct = c.env.ACCOUNT.getByName(accountId);
  const order = await acct.createOrder({
    orderId,
    sku,
    provider: p.id,
    price,
  });
  if (
    order.sku !== sku ||
    order.provider !== p.id ||
    order.price.currency !== price.currency ||
    order.price.amountMinor !== price.amountMinor
  )
    return apiError(409, "conflict", "this opId was used for another order");
  if (order.status !== "pending")
    return apiError(409, "conflict", `this order is already ${order.status}`);

  const origin = publicOrigin(c);
  let session;
  try {
    session = await p.createCheckout({
      orderId,
      accountId,
      product,
      price,
      successUrl: `${origin}/#store=paid&order=${orderId}`,
      cancelUrl: `${origin}/#store=cancel`,
      webhookUrl: `${origin}/api/pay/webhook/${p.id}`,
      customerEmail: null,
    });
  } catch (err) {
    console.error(`store: ${p.id} checkout failed`, err);
    return apiError(503, "unavailable", "the payment provider did not answer; try again");
  }
  const out: CheckoutResponse = { orderId, url: session.url };
  return json(out);
}

async function orders(c: RouteContext): Promise<Response> {
  const who = await economyCaller(c, "store");
  if (who instanceof Response) return who;
  const records = await c.env.ACCOUNT.getByName(who.party.accountId).orders();
  const body: OrdersResponse = { orders: records.map(toOrderView).reverse() };
  return json(body);
}

function toOrderView(r: OrderRecord): OrderView {
  return {
    orderId: r.orderId,
    sku: r.sku,
    provider: r.provider,
    price: r.price,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The deterministic order id of (account, opId). */
export async function orderIdFor(accountId: string, opId: string): Promise<string> {
  return `o${(await sha256Hex(`${accountId}:${opId}`)).slice(0, 24)}`;
}

function publicOrigin(c: RouteContext): string {
  const configured = c.env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  return configured ? configured : c.url.origin;
}

// ---- webhooks -------------------------------------------------------------------

async function webhook(c: RouteContext, providerId: string): Promise<Response> {
  const providers = providersFor(c.env, c.url);
  const p = providerById(providers, providerId);
  if (!p || !p.enabled) return apiError(404, "not_found", "no such endpoint");
  return applyWebhook(c.env, p, c.request);
}

/**
 * Verifies a webhook with its provider and applies it. 401 when the signature
 * fails (nothing changes); 200 once verified, even when ignored or replayed; 500
 * when our side fails, so the provider retries. Shared with the stub's self-webhook.
 */
export async function applyWebhook(
  env: Env,
  p: PaymentProvider,
  request: Request,
): Promise<Response> {
  let verified: VerifiedWebhook | null;
  try {
    verified = await p.verifyWebhook(request);
  } catch (err) {
    console.error(`store: ${p.id} webhook check failed`, err);
    return apiError(500, "internal", "the webhook could not be checked; retry");
  }
  if (verified === null) return apiError(401, "unauthorized", "signature check failed");
  if (verified.kind === "ignored" || !verified.orderId || !verified.accountId)
    return json({ received: true, applied: false });
  if (!ACCOUNT_ID_RE.test(verified.accountId) || !ORDER_ID_RE.test(verified.orderId))
    return json({ received: true, applied: false });

  const acct = env.ACCOUNT.getByName(verified.accountId);
  try {
    const result =
      verified.kind === "paid"
        ? await acct.fulfillOrder({
            orderId: verified.orderId,
            providerRef: verified.providerRef,
            eventId: verified.eventId,
            provider: p.id,
            paid: verified.paid,
          })
        : await acct.refundOrder({ orderId: verified.orderId, eventId: verified.eventId });
    if (!result.ok) {
      if (result.code === "not_found")
        return json({ received: true, applied: false, reason: "unknown_order" });
      console.error(`store: ${verified.kind} failed`, result.code, result.message);
      return apiError(500, "internal", "could not record the payment; retry");
    }
    if (verified.kind === "paid" && result.value.status === "failed") {
      // Verified, but it does not match the order: recorded for the admin, never granted.
      if (!result.replayed)
        console.error(
          `store: ${p.id} order ${verified.orderId} failed: ${result.value.failReason ?? "?"}`,
        );
      return json({
        received: true,
        applied: false,
        status: "failed",
        reason: result.value.failReason,
      });
    }
    return json({ received: true, applied: true, status: result.value.status });
  } catch (err) {
    console.error(`store: ${verified.kind} threw`, err);
    return apiError(500, "internal", "could not record the payment; retry");
  }
}

// ---- stub (sandbox) -----------------------------------------------------------

function stubOr404(c: RouteContext): PaymentProvider | Response {
  const p = providerById(providersFor(c.env, c.url), "stub");
  if (!p || !p.enabled) return apiError(404, "not_found", "no such endpoint");
  return p;
}

async function stubCheckout(c: RouteContext): Promise<Response> {
  const stub = stubOr404(c);
  if (stub instanceof Response) return stub;
  const orderId = c.url.searchParams.get("order") ?? "";
  const accountId = c.url.searchParams.get("account") ?? "";
  if (!ORDER_ID_RE.test(orderId) || !ACCOUNT_ID_RE.test(accountId))
    return apiError(400, "bad_request", "order and account are required");
  const order = await findOrder(c, accountId, orderId);
  if (!order) return apiError(404, "not_found", "no such order");
  const product = productBySku(order.sku);
  const html = stubCheckoutPage({
    orderId,
    accountId,
    productName: product?.name ?? order.sku,
    priceText: formatPrice(order.price.amountMinor, order.price.currency),
  });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    },
  });
}

async function stubComplete(c: RouteContext): Promise<Response> {
  const stub = stubOr404(c);
  if (stub instanceof Response) return stub;
  const fields = await readStubFields(c.request);
  if (!fields) return apiError(400, "bad_request", "expected order, account and result");
  const { orderId, accountId, result } = fields;
  if (!ORDER_ID_RE.test(orderId) || !ACCOUNT_ID_RE.test(accountId))
    return apiError(400, "bad_request", "order and account are malformed");
  if (result === "cancel") return redirect("/#store=cancel");
  if (result !== "paid") return apiError(400, "bad_request", "result must be paid or cancel");
  const order = await findOrder(c, accountId, orderId);
  if (!order) return apiError(404, "not_found", "no such order");

  // The sandbox charges exactly the order's price, as a real provider would report it.
  const body: StubWebhookBody = {
    id: `stub_${orderId}_paid`,
    kind: "paid",
    orderId,
    accountId,
    providerRef: stubRefOf(orderId),
    currency: order.price.currency,
    amountMinor: order.price.amountMinor,
  };
  const raw = stubWebhookBody(body);
  const signature = await signStubBody(c.env.AUTH_SECRET, raw);
  // The same handler the provider webhook uses: the signature is checked, not assumed.
  const selfRequest = new Request(`${c.url.origin}/api/pay/webhook/stub`, {
    method: "POST",
    headers: { "content-type": "application/json", [STUB_SIGNATURE_HEADER]: signature },
    body: raw,
  });
  const applied = await applyWebhook(c.env, stub, selfRequest);
  if (applied.status !== 200) return applied;
  return redirect(`/#store=paid&order=${orderId}`);
}

async function readStubFields(
  request: Request,
): Promise<{ orderId: string; accountId: string; result: string } | null> {
  const text = await request.text();
  if (text.length > STUB_BODY_MAX) return null;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const v = JSON.parse(text) as Record<string, unknown>;
      return strFields(v.order, v.account, v.result);
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams(text);
  return strFields(params.get("order"), params.get("account"), params.get("result"));
}

function strFields(
  order: unknown,
  account: unknown,
  result: unknown,
): { orderId: string; accountId: string; result: string } | null {
  if (typeof order !== "string" || typeof account !== "string" || typeof result !== "string")
    return null;
  return { orderId: order, accountId: account, result };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

async function findOrder(
  c: RouteContext,
  accountId: string,
  orderId: string,
): Promise<OrderRecord | null> {
  const records = await c.env.ACCOUNT.getByName(accountId).orders();
  return records.find((r) => r.orderId === orderId) ?? null;
}

function formatPrice(amountMinor: number, currency: string): string {
  const locale = currency === "BRL" ? "pt-BR" : "en-US";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amountMinor / 100);
}
