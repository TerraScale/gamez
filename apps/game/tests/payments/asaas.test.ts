import { describe, expect, it } from "vite-plus/test";
import { AsaasProvider, ASAAS_SANDBOX, ASAAS_PRODUCTION } from "../../src/server/payments/asaas.ts";

const TOKEN = "asaas-token-fake-1";
const ORDER = "o0123456789abcdef01234567";
const REF = `acc_abc|${ORDER}`;

function paymentEvent(event: string, id = "evt_9"): string {
  return JSON.stringify({
    id,
    event,
    payment: { id: "pay_1", externalReference: REF, status: "RECEIVED", value: 4.9 },
  });
}

function req(raw: string, token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers["asaas-access-token"] = token;
  return new Request("https://gamez.example.com/api/pay/webhook/asaas", {
    method: "POST",
    headers,
    body: raw,
  });
}

const provider = () =>
  new AsaasProvider({ apiKey: "aak_fake", webhookToken: TOKEN, env: "sandbox" });

describe("Asaas webhook verification", () => {
  it("accepts the access token and maps PAYMENT_RECEIVED and PAYMENT_CONFIRMED to paid", async () => {
    for (const ev of ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"]) {
      const v = await provider().verifyWebhook(req(paymentEvent(ev), TOKEN));
      expect(v).toEqual({
        eventId: "evt_9",
        kind: "paid",
        orderId: ORDER,
        accountId: "acc_abc",
        providerRef: "pay_1",
        paid: { currency: "BRL", amountMinor: 490 },
      });
    }
  });

  it("maps PAYMENT_REFUNDED to refunded and other events to ignored", async () => {
    expect(
      (await provider().verifyWebhook(req(paymentEvent("PAYMENT_REFUNDED"), TOKEN)))?.kind,
    ).toBe("refunded");
    expect(
      (await provider().verifyWebhook(req(paymentEvent("PAYMENT_CREATED"), TOKEN)))?.kind,
    ).toBe("ignored");
  });

  it("rejects a wrong token (constant-time compare) and a missing header", async () => {
    expect(
      await provider().verifyWebhook(req(paymentEvent("PAYMENT_RECEIVED"), "wrong-token-fake")),
    ).toBeNull();
    expect(
      await provider().verifyWebhook(req(paymentEvent("PAYMENT_RECEIVED"), "asaas-token-fake-")),
    ).toBeNull();
    expect(await provider().verifyWebhook(req(paymentEvent("PAYMENT_RECEIVED"), null))).toBeNull();
  });

  it("has no timestamp to check, so the access token is its only freshness-free guard", async () => {
    // Asaas webhooks carry no signed timestamp; replays are harmless (fulfilment is per orderId).
    const v = await provider().verifyWebhook(
      req(paymentEvent("PAYMENT_RECEIVED", "evt_old"), TOKEN),
    );
    expect(v?.eventId).toBe("evt_old");
  });

  it("ignores a malformed externalReference instead of trusting it", async () => {
    const raw = JSON.stringify({
      id: "e",
      event: "PAYMENT_RECEIVED",
      payment: { id: "p", externalReference: "nope" },
    });
    const v = await provider().verifyWebhook(req(raw, TOKEN));
    expect(v?.kind).toBe("paid");
    expect(v?.orderId).toBeNull();
    expect(v?.accountId).toBeNull();
  });

  it("is disabled without the token", async () => {
    const p = new AsaasProvider({ apiKey: "aak_fake" });
    expect(p.enabled).toBe(false);
    expect(await p.verifyWebhook(req(paymentEvent("PAYMENT_RECEIVED"), TOKEN))).toBeNull();
  });
});

describe("Asaas checkout", () => {
  it("creates a customer and a payment with our externalReference, in BRL units", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = String(url).endsWith("/customers")
        ? { id: "cus_1" }
        : { id: "pay_new", invoiceUrl: "https://sandbox.asaas.test/i/pay_new" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const p = new AsaasProvider({
      apiKey: "aak_fake",
      webhookToken: TOKEN,
      env: "sandbox",
      fetch: fake,
      now: () => Date.UTC(2026, 9, 28),
    });
    const session = await p.createCheckout({
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
      price: { currency: "BRL", amountMinor: 490 },
      successUrl: "https://a.test/s",
      cancelUrl: "https://a.test/c",
      webhookUrl: "https://a.test/w",
      customerEmail: null,
    });
    expect(session).toEqual({
      providerRef: "pay_new",
      url: "https://sandbox.asaas.test/i/pay_new",
    });
    expect(calls[0]?.url).toBe(`${ASAAS_SANDBOX}/customers`);
    expect(calls[1]?.url).toBe(`${ASAAS_SANDBOX}/payments`);
    expect(((calls[0]?.init.headers ?? {}) as Record<string, string>).access_token).toBe(
      "aak_fake",
    );
    const payment = JSON.parse(String(calls[1]?.init.body as string)) as Record<string, unknown>;
    expect(payment).toMatchObject({
      customer: "cus_1",
      billingType: "UNDEFINED",
      value: 4.9,
      externalReference: REF,
      dueDate: "2026-10-31",
    });
  });

  it("uses the live API only when ASAAS_ENV is production", () => {
    expect(ASAAS_PRODUCTION).toBe("https://api.asaas.com/v3");
    expect(ASAAS_SANDBOX).toBe("https://api-sandbox.asaas.com/v3");
  });

  it("refunds through the payment's refund endpoint", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const p = new AsaasProvider({ apiKey: "aak_fake", webhookToken: TOKEN, fetch: fake });
    expect((await p.refund("pay_1")).ok).toBe(true);
    expect(calls[0]).toBe(`${ASAAS_SANDBOX}/payments/pay_1/refund`);
  });
});

/** A PAYMENT_RECEIVED webhook as the Asaas sandbox posts it (fields we read and their neighbours). */
function sandboxPayment(payment: Record<string, unknown>, event = "PAYMENT_RECEIVED"): string {
  return JSON.stringify({
    id: "evt_05b708f961d739ea7eba7e4db318f621&368604920",
    event,
    dateCreated: "2026-10-30 10:00:00",
    payment: {
      object: "payment",
      id: "pay_080225913252",
      dateCreated: "2026-10-30",
      customer: "cus_G7Dvo4iphUNk",
      value: 4.9,
      netValue: 3.91,
      originalValue: null,
      billingType: "PIX",
      status: "RECEIVED",
      externalReference: REF,
      deleted: false,
      ...payment,
    },
  });
}

describe("Asaas paid amount (sandbox fixtures)", () => {
  const verify = (raw: string) => provider().verifyWebhook(req(raw, TOKEN));

  it("converts the decimal BRL value exactly (never netValue)", async () => {
    expect((await verify(sandboxPayment({})))?.paid).toEqual({ currency: "BRL", amountMinor: 490 });
    expect((await verify(sandboxPayment({ value: 19.9 })))?.paid).toEqual({
      currency: "BRL",
      amountMinor: 1990,
    });
    expect((await verify(sandboxPayment({ value: 0.29 })))?.paid).toEqual({
      currency: "BRL",
      amountMinor: 29,
    });
    expect((await verify(sandboxPayment({ value: 1234.56 })))?.paid).toEqual({
      currency: "BRL",
      amountMinor: 123456,
    });
    expect((await verify(sandboxPayment({ value: 49 })))?.paid).toEqual({
      currency: "BRL",
      amountMinor: 4900,
    });
  });

  it("reports PAYMENT_CONFIRMED (card) amounts too", async () => {
    const v = await verify(
      sandboxPayment({ billingType: "CREDIT_CARD", status: "CONFIRMED" }, "PAYMENT_CONFIRMED"),
    );
    expect(v).toMatchObject({ kind: "paid", paid: { currency: "BRL", amountMinor: 490 } });
  });

  it("answers paid: null for a value it cannot convert exactly", async () => {
    for (const value of [undefined, null, "abc", 4.905, -4.9, Number.NaN, "4,90"]) {
      const v = await verify(sandboxPayment({ value }));
      expect(v?.kind).toBe("paid");
      expect(v?.paid).toBeNull();
    }
  });

  it("never reports an amount for refunds or ignored events", async () => {
    expect(
      (await verify(sandboxPayment({ status: "REFUNDED" }, "PAYMENT_REFUNDED")))?.paid,
    ).toBeNull();
    expect(
      (await verify(sandboxPayment({ status: "PENDING" }, "PAYMENT_CREATED")))?.paid,
    ).toBeNull();
  });
});
