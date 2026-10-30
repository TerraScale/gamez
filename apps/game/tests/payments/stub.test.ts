import { describe, expect, it } from "vite-plus/test";
import { providersFor, stubEnabled } from "../../src/server/payments/index.ts";
import {
  StubProvider,
  signStubBody,
  stubCheckoutPage,
  stubRefOf,
  stubWebhookBody,
  escapeHtml,
} from "../../src/server/payments/stub.ts";

const SECRET = "dev-only-secret-change-me";
const ORDER = "o0123456789abcdef01234567";
const body = {
  id: `stub_${ORDER}_paid`,
  kind: "paid" as const,
  orderId: ORDER,
  accountId: "acc_abc",
  providerRef: stubRefOf(ORDER),
  currency: "USD",
  amountMinor: 99,
};

function req(raw: string, sig: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== null) headers["x-stub-signature"] = sig;
  return new Request("http://localhost:5173/api/pay/webhook/stub", {
    method: "POST",
    headers,
    body: raw,
  });
}

describe("stub provider", () => {
  const stub = new StubProvider({ authSecret: SECRET, enabled: true });

  it("accepts a body signed with AUTH_SECRET and returns the paid event", async () => {
    const raw = stubWebhookBody(body);
    const sig = await signStubBody(SECRET, raw);
    expect(await stub.verifyWebhook(req(raw, sig))).toEqual({
      eventId: body.id,
      kind: "paid",
      orderId: ORDER,
      accountId: "acc_abc",
      providerRef: stubRefOf(ORDER),
      paid: { currency: "USD", amountMinor: 99 },
    });
  });

  it("answers paid: null when the signed body carries no usable amount", async () => {
    const { currency: _c, amountMinor: _a, ...bare } = body;
    for (const b of [bare, { ...body, amountMinor: 0.5 }, { ...body, currency: "XYZ" }]) {
      const raw = stubWebhookBody(b);
      const v = await stub.verifyWebhook(req(raw, await signStubBody(SECRET, raw)));
      expect(v?.kind).toBe("paid");
      expect(v?.paid).toBeNull();
    }
  });

  it("rejects a signature made with another secret, a tampered body and a missing header", async () => {
    const raw = stubWebhookBody(body);
    expect(await stub.verifyWebhook(req(raw, await signStubBody("other-secret", raw)))).toBeNull();
    const tampered = stubWebhookBody({ ...body, accountId: "acc_evil" });
    expect(await stub.verifyWebhook(req(tampered, await signStubBody(SECRET, raw)))).toBeNull();
    expect(await stub.verifyWebhook(req(raw, null))).toBeNull();
  });

  it("refuses everything when disabled (the stub is off on production hosts)", async () => {
    const off = new StubProvider({ authSecret: SECRET, enabled: false });
    const raw = stubWebhookBody(body);
    expect(await off.verifyWebhook(req(raw, await signStubBody(SECRET, raw)))).toBeNull();
  });

  it("has no timestamp, so a replayed body is accepted and fulfilment stays idempotent by orderId", async () => {
    const raw = stubWebhookBody(body);
    const sig = await signStubBody(SECRET, raw);
    expect(await stub.verifyWebhook(req(raw, sig))).not.toBeNull();
    expect(await stub.verifyWebhook(req(raw, sig))).not.toBeNull();
  });

  it("builds a checkout url on the webhook origin with the order and the account", async () => {
    const session = await stub.createCheckout({
      orderId: ORDER,
      accountId: "acc_abc",
      product: {
        sku: "gems.small",
        name: "Gem pouch",
        description: "",
        kind: "gems",
        prices: [],
        grants: { gems: 100, entitlements: [] },
      },
      price: { currency: "USD", amountMinor: 99 },
      successUrl: "http://localhost:5173/#store=paid",
      cancelUrl: "http://localhost:5173/#store=cancel",
      webhookUrl: "http://localhost:5173/api/pay/webhook/stub",
      customerEmail: null,
    });
    expect(session.providerRef).toBe(stubRefOf(ORDER));
    expect(session.url).toBe(
      `http://localhost:5173/api/pay/stub/checkout?order=${ORDER}&account=acc_abc`,
    );
  });

  it("renders the sandbox page with Pay and Cancel, escaping every value", () => {
    const html = stubCheckoutPage({
      orderId: ORDER,
      accountId: "acc_abc",
      productName: "<b>Pouch</b>",
      priceText: "$0.99",
    });
    expect(html).toContain("Pay (sandbox)");
    expect(html).toContain("Cancel");
    expect(html).toContain('action="/api/pay/stub/complete"');
    expect(html).toContain("&lt;b&gt;Pouch&lt;/b&gt;");
    expect(html).not.toContain("<b>Pouch</b>");
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
  });
});

describe("provider registry", () => {
  const base = { AUTH_SECRET: SECRET };

  it("enables the stub on dev hosts and not on public hosts", () => {
    expect(stubEnabled({}, new URL("http://localhost:5173/"))).toBe(true);
    expect(stubEnabled({}, new URL("https://box.tailnet.ts.net/"))).toBe(true);
    expect(stubEnabled({}, new URL("https://gamez.example.com/"))).toBe(false);
  });

  it("PAYMENTS_STUB overrides the host rule in both directions", () => {
    expect(stubEnabled({ PAYMENTS_STUB: "1" }, new URL("https://gamez.example.com/"))).toBe(true);
    expect(stubEnabled({ PAYMENTS_STUB: "0" }, new URL("http://localhost:5173/"))).toBe(false);
  });

  it("enables each real provider only when its keys are present", () => {
    const none = providersFor({ ...base }, new URL("https://gamez.example.com/"));
    expect(none.map((p) => [p.id, p.enabled])).toEqual([
      ["stripe", false],
      ["asaas", false],
      ["mercadopago", false],
      ["stub", false],
    ]);
    const keyed = providersFor(
      {
        ...base,
        STRIPE_SECRET_KEY: "sk_test_fake",
        STRIPE_WEBHOOK_SECRET: "whsec_fake",
        ASAAS_API_KEY: "aak_fake",
        ASAAS_WEBHOOK_TOKEN: "tok_fake",
        MERCADOPAGO_ACCESS_TOKEN: "APP_USR_fake",
        MERCADOPAGO_WEBHOOK_SECRET: "mp_fake",
      },
      new URL("https://gamez.example.com/"),
    );
    expect(keyed.every((p) => p.enabled)).toBe(false); // the stub stays off on a public host
    expect(keyed.filter((p) => p.id !== "stub").every((p) => p.enabled)).toBe(true);
  });

  it("the stripe provider needs both its secret key and its webhook secret", () => {
    const half = providersFor(
      { ...base, STRIPE_SECRET_KEY: "sk_test_fake" },
      new URL("https://gamez.example.com/"),
    );
    expect(half.find((p) => p.id === "stripe")?.enabled).toBe(false);
  });
});
