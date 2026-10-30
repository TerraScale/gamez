import { createHmac } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  StripeProvider,
  parseStripeSignature,
  STRIPE_TOLERANCE_S,
} from "../../src/server/payments/stripe.ts";

const SECRET = "whsec_test_fake_1";
const NOW_MS = 1_800_000_000_000;

function sign(t: number, raw: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
}

const checkoutBody = JSON.stringify({
  id: "evt_1",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_1",
      payment_status: "paid",
      amount_total: 99,
      currency: "usd",
      metadata: { accountId: "acc_abc", orderId: "o0123456789abcdef01234567" },
    },
  },
});

function req(raw: string, header: string | null): Request {
  const headers: Record<string, string> = {};
  if (header !== null) headers["stripe-signature"] = header;
  return new Request("https://gamez.example.com/api/pay/webhook/stripe", {
    method: "POST",
    headers,
    body: raw,
  });
}

function provider(webhookSecret: string | undefined = SECRET): StripeProvider {
  return new StripeProvider({ secretKey: "sk_test_fake", webhookSecret, now: () => NOW_MS });
}

describe("Stripe webhook verification", () => {
  const t = Math.floor(NOW_MS / 1000);

  it("accepts a good signature and maps checkout.session.completed to paid", async () => {
    const v = await provider().verifyWebhook(
      req(checkoutBody, `t=${t},v1=${sign(t, checkoutBody)}`),
    );
    expect(v).toEqual({
      eventId: "evt_1",
      kind: "paid",
      orderId: "o0123456789abcdef01234567",
      accountId: "acc_abc",
      providerRef: "cs_test_1",
      paid: { currency: "USD", amountMinor: 99 },
    });
  });

  it("accepts when any of several v1 signatures matches", async () => {
    const header = `t=${t},v1=${"0".repeat(64)},v1=${sign(t, checkoutBody)},v0=old`;
    expect(await provider().verifyWebhook(req(checkoutBody, header))).not.toBeNull();
  });

  it("rejects a bad signature", async () => {
    const wrong = sign(t, checkoutBody, "whsec_other");
    expect(await provider().verifyWebhook(req(checkoutBody, `t=${t},v1=${wrong}`))).toBeNull();
  });

  it("rejects a tampered body", async () => {
    const sig = sign(t, checkoutBody);
    expect(await provider().verifyWebhook(req(checkoutBody + " ", `t=${t},v1=${sig}`))).toBeNull();
  });

  it("rejects a stale timestamp even with a valid signature", async () => {
    const old = t - STRIPE_TOLERANCE_S - 1;
    expect(
      await provider().verifyWebhook(req(checkoutBody, `t=${old},v1=${sign(old, checkoutBody)}`)),
    ).toBeNull();
  });

  it("accepts the edge of the tolerance window", async () => {
    const edge = t - STRIPE_TOLERANCE_S;
    expect(
      await provider().verifyWebhook(req(checkoutBody, `t=${edge},v1=${sign(edge, checkoutBody)}`)),
    ).not.toBeNull();
  });

  it("rejects a missing header, a header without v1, and a missing timestamp", async () => {
    expect(await provider().verifyWebhook(req(checkoutBody, null))).toBeNull();
    expect(await provider().verifyWebhook(req(checkoutBody, `t=${t}`))).toBeNull();
    expect(
      await provider().verifyWebhook(req(checkoutBody, `v1=${sign(t, checkoutBody)}`)),
    ).toBeNull();
  });

  it("is disabled without the webhook secret", async () => {
    const p = new StripeProvider({ secretKey: "sk_test_fake", now: () => NOW_MS });
    expect(p.enabled).toBe(false);
    expect(
      await p.verifyWebhook(req(checkoutBody, `t=${t},v1=${sign(t, checkoutBody)}`)),
    ).toBeNull();
  });

  it("maps charge.refunded to refunded and leaves unknown events ignored", async () => {
    const refund = JSON.stringify({
      id: "evt_2",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_1",
          metadata: { accountId: "acc_abc", orderId: "o0123456789abcdef01234567" },
        },
      },
    });
    const v = await provider().verifyWebhook(req(refund, `t=${t},v1=${sign(t, refund)}`));
    expect(v?.kind).toBe("refunded");
    expect(v?.providerRef).toBe("pi_1");
    const other = JSON.stringify({ id: "evt_3", type: "customer.created", data: { object: {} } });
    expect((await provider().verifyWebhook(req(other, `t=${t},v1=${sign(t, other)}`)))?.kind).toBe(
      "ignored",
    );
  });

  it("reads our ids from the payment intent when the refunded charge has no metadata", async () => {
    const calls: string[] = [];
    const fake = (async (input: string | URL) => {
      calls.push(input.toString());
      return Response.json({
        id: "pi_9",
        metadata: { accountId: "acc_abc", orderId: "o0123456789abcdef01234567" },
      });
    }) as typeof fetch;
    const p = new StripeProvider({
      secretKey: "sk_test_fake",
      webhookSecret: SECRET,
      fetch: fake,
      now: () => NOW_MS,
    });
    const raw = JSON.stringify({
      id: "evt_4",
      type: "charge.refunded",
      data: { object: { id: "ch_9", payment_intent: "pi_9", refunded: true, metadata: {} } },
    });
    const v = await p.verifyWebhook(req(raw, `t=${t},v1=${sign(t, raw)}`));
    expect(calls).toEqual(["https://api.stripe.com/v1/payment_intents/pi_9"]);
    expect(v).toMatchObject({
      kind: "refunded",
      orderId: "o0123456789abcdef01234567",
      accountId: "acc_abc",
      providerRef: "pi_9",
    });
  });

  it("ignores a partial refund, and throws (retry) when the intent lookup fails", async () => {
    const partial = JSON.stringify({
      id: "evt_5",
      type: "charge.refunded",
      data: { object: { id: "ch_5", payment_intent: "pi_5", refunded: false, metadata: {} } },
    });
    expect(
      (await provider().verifyWebhook(req(partial, `t=${t},v1=${sign(t, partial)}`)))?.kind,
    ).toBe("ignored");
    const failing = new StripeProvider({
      secretKey: "sk_test_fake",
      webhookSecret: SECRET,
      fetch: (async () => new Response("down", { status: 502 })) as typeof fetch,
      now: () => NOW_MS,
    });
    const full = partial.replace('"refunded":false', '"refunded":true');
    await expect(failing.verifyWebhook(req(full, `t=${t},v1=${sign(t, full)}`))).rejects.toThrow(
      /HTTP 502/,
    );
  });

  it("treats an unpaid checkout session as ignored until it succeeds", async () => {
    const unpaid = checkoutBody.replace('"paid"', '"unpaid"');
    const v = await provider().verifyWebhook(req(unpaid, `t=${t},v1=${sign(t, unpaid)}`));
    expect(v?.kind).toBe("ignored");
  });

  it("parses the signature header tolerant of spaces and extra schemes", () => {
    expect(parseStripeSignature("t=12, v1=aa, v0=bb, v1=cc")).toEqual({
      t: "12",
      v1: ["aa", "cc"],
    });
  });
});

describe("Stripe checkout", () => {
  it("posts a form-encoded session with our metadata and returns its url", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ id: "cs_new", url: "https://checkout.stripe.test/c/cs_new" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    const p = new StripeProvider({ secretKey: "sk_test_fake", webhookSecret: SECRET, fetch: fake });
    const session = await p.createCheckout({
      orderId: "o0123456789abcdef01234567",
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
      successUrl: "https://gamez.example.com/#store=paid&order=o0123456789abcdef01234567",
      cancelUrl: "https://gamez.example.com/#store=cancel",
      webhookUrl: "https://gamez.example.com/api/pay/webhook/stripe",
      customerEmail: null,
    });
    expect(session).toEqual({
      providerRef: "cs_new",
      url: "https://checkout.stripe.test/c/cs_new",
    });
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test_fake");
    expect(headers["idempotency-key"]).toBe("checkout:o0123456789abcdef01234567");
    const body = new URLSearchParams(String(calls[0]?.init.body as string));
    expect(body.get("metadata[accountId]")).toBe("acc_abc");
    expect(body.get("metadata[orderId]")).toBe("o0123456789abcdef01234567");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("99");
    expect(body.get("line_items[0][price_data][currency]")).toBe("usd");
  });

  it("throws when Stripe refuses, so the route answers 503 and the order stays pending", async () => {
    const fake = (async () => new Response("{}", { status: 402 })) as unknown as typeof fetch;
    const p = new StripeProvider({ secretKey: "sk_test_fake", webhookSecret: SECRET, fetch: fake });
    await expect(
      p.createCheckout({
        orderId: "o0123456789abcdef01234567",
        accountId: "acc_abc",
        product: {
          sku: "x",
          name: "x",
          description: "",
          kind: "gems",
          prices: [],
          grants: { gems: 1, entitlements: [] },
        },
        price: { currency: "USD", amountMinor: 1 },
        successUrl: "https://a.test/s",
        cancelUrl: "https://a.test/c",
        webhookUrl: "https://a.test/w",
        customerEmail: null,
      }),
    ).rejects.toThrow(/HTTP 402/);
  });
});

/**
 * A checkout.session.completed event as the Stripe test mode sends it
 * (trimmed to the fields we read plus the neighbours that could be confused
 * with them: amount_subtotal before discounts, total_details).
 */
function sandboxSession(object: Record<string, unknown>): string {
  return JSON.stringify({
    id: "evt_1Q2w3E4r5T6y7U8i",
    object: "event",
    api_version: "2024-06-20",
    livemode: false,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_a1B2c3D4",
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_subtotal: 490,
        amount_total: 490,
        currency: "brl",
        total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
        client_reference_id: "o0123456789abcdef01234567",
        payment_intent: "pi_3Q2w3E4r5T6y7U8i",
        metadata: { accountId: "acc_abc", orderId: "o0123456789abcdef01234567" },
        ...object,
      },
    },
  });
}

describe("Stripe paid amount (sandbox fixtures)", () => {
  const t = Math.floor(NOW_MS / 1000);
  const verify = (raw: string) => provider().verifyWebhook(req(raw, `t=${t},v1=${sign(t, raw)}`));

  it("reports amount_total in minor units with the upper-case currency", async () => {
    expect((await verify(sandboxSession({})))?.paid).toEqual({ currency: "BRL", amountMinor: 490 });
    expect((await verify(sandboxSession({ amount_total: 99, currency: "usd" })))?.paid).toEqual({
      currency: "USD",
      amountMinor: 99,
    });
    expect((await verify(sandboxSession({ amount_total: 1999, currency: "eur" })))?.paid).toEqual({
      currency: "EUR",
      amountMinor: 1999,
    });
  });

  it("uses amount_total (after discounts), not amount_subtotal", async () => {
    const v = await verify(sandboxSession({ amount_subtotal: 490, amount_total: 1 }));
    expect(v?.paid).toEqual({ currency: "BRL", amountMinor: 1 });
  });

  it("reports async_payment_succeeded amounts too", async () => {
    const raw = JSON.stringify({
      ...JSON.parse(sandboxSession({})),
      type: "checkout.session.async_payment_succeeded",
    });
    expect(await verify(raw)).toMatchObject({
      kind: "paid",
      paid: { currency: "BRL", amountMinor: 490 },
    });
  });

  it("answers paid: null for an amount or currency it cannot read (the order then fails)", async () => {
    for (const bad of [
      { amount_total: undefined },
      { amount_total: null },
      { amount_total: "490" },
      { amount_total: 4.9 },
      { amount_total: -490 },
      { currency: "jpy" },
      { currency: undefined },
    ]) {
      const v = await verify(sandboxSession(bad));
      expect(v?.kind).toBe("paid");
      expect(v?.paid).toBeNull();
    }
  });

  it("never reports an amount for refunds or ignored events", async () => {
    const refund = JSON.stringify({
      id: "evt_r",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          amount: 490,
          currency: "brl",
          refunded: true,
          payment_intent: "pi_1",
          metadata: { accountId: "acc_abc", orderId: "o0123456789abcdef01234567" },
        },
      },
    });
    expect((await verify(refund))?.paid).toBeNull();
    const unpaid = await verify(sandboxSession({ payment_status: "unpaid" }));
    expect(unpaid).toMatchObject({ kind: "ignored" });
  });
});
