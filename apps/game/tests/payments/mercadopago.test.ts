import { createHmac } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  MERCADOPAGO_TOLERANCE_S,
  MercadoPagoProvider,
  parseMercadoPagoSignature,
} from "../../src/server/payments/mercadopago.ts";

const SECRET = "mp-webhook-secret-fake";
const TOKEN = "APP_USR-fake-token-1";
const NOW_MS = 1_800_000_000_000;
const ORDER = "o0123456789abcdef01234567";
const REQUEST_ID = "req-abc-123";

/** The signed manifest exactly as MP documents it. */
function signature(dataId: string, requestId: string, ts: string, secret = SECRET): string {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  return createHmac("sha256", secret).update(manifest).digest("hex");
}

function req(opts: {
  dataId?: string;
  ts?: string;
  sig?: string | null;
  requestId?: string | null;
  body?: string;
}): Request {
  const dataId = opts.dataId ?? "98765";
  const ts = opts.ts ?? String(Math.floor(NOW_MS / 1000));
  const headers: Record<string, string> = {};
  if (opts.sig !== null)
    headers["x-signature"] = opts.sig ?? `ts=${ts},v1=${signature(dataId, REQUEST_ID, ts)}`;
  if (opts.requestId !== null) headers["x-request-id"] = opts.requestId ?? REQUEST_ID;
  return new Request(`https://gamez.example.com/api/pay/webhook/mercadopago?data.id=${dataId}`, {
    method: "POST",
    headers,
    body: opts.body ?? JSON.stringify({ type: "payment", data: { id: dataId } }),
  });
}

/** A fake fetch that answers the payment lookup. */
function paymentFetch(
  status: number,
  payment: Record<string, unknown>,
  seen: string[] = [],
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push(
      `${String(url)} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? ""}`,
    );
    return new Response(JSON.stringify(payment), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function provider(
  fetchImpl: typeof globalThis.fetch,
  webhookSecret: string | undefined = SECRET,
): MercadoPagoProvider {
  return new MercadoPagoProvider({
    accessToken: TOKEN,
    webhookSecret,
    fetch: fetchImpl,
    now: () => NOW_MS,
  });
}

describe("Mercado Pago webhook verification", () => {
  it("verifies x-signature, then reads the payment and maps approved to paid", async () => {
    const seen: string[] = [];
    const p = provider(
      paymentFetch(
        200,
        { id: 98765, status: "approved", external_reference: `acc_abc|${ORDER}` },
        seen,
      ),
    );
    const v = await p.verifyWebhook(req({}));
    expect(v).toEqual({
      eventId: "mp:98765:approved",
      kind: "paid",
      orderId: ORDER,
      accountId: "acc_abc",
      providerRef: "98765",
    });
    expect(seen[0]).toBe(`https://api.mercadopago.com/v1/payments/98765 Bearer ${TOKEN}`);
  });

  it("maps refunded and charged_back to refunded, and other statuses to ignored", async () => {
    const refunded = await provider(
      paymentFetch(200, { id: 1, status: "refunded", external_reference: `acc_abc|${ORDER}` }),
    ).verifyWebhook(req({}));
    expect(refunded?.kind).toBe("refunded");
    const chargeback = await provider(
      paymentFetch(200, { id: 1, status: "charged_back", external_reference: `acc_abc|${ORDER}` }),
    ).verifyWebhook(req({}));
    expect(chargeback?.kind).toBe("refunded");
    const pending = await provider(
      paymentFetch(200, { id: 1, status: "pending", external_reference: `acc_abc|${ORDER}` }),
    ).verifyWebhook(req({}));
    expect(pending?.kind).toBe("ignored");
  });

  it("uses the body's data.id when the query string has none", async () => {
    const r = new Request("https://gamez.example.com/api/pay/webhook/mercadopago", {
      method: "POST",
      headers: {
        "x-signature": `ts=${NOW_MS / 1000},v1=${signature("98765", REQUEST_ID, String(NOW_MS / 1000))}`,
        "x-request-id": REQUEST_ID,
      },
      body: JSON.stringify({ type: "payment", data: { id: 98765 } }),
    });
    const v = await provider(
      paymentFetch(200, { id: 98765, status: "approved", external_reference: `acc_abc|${ORDER}` }),
    ).verifyWebhook(r);
    expect(v?.kind).toBe("paid");
  });

  it("rejects a bad signature without calling the API", async () => {
    const seen: string[] = [];
    const p = provider(paymentFetch(200, {}, seen));
    expect(
      await p.verifyWebhook(req({ sig: `ts=${NOW_MS / 1000},v1=${"0".repeat(64)}` })),
    ).toBeNull();
    expect(
      await p.verifyWebhook(
        req({
          sig: `ts=${NOW_MS / 1000},v1=${signature("98765", REQUEST_ID, String(NOW_MS / 1000), "other")}`,
        }),
      ),
    ).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it("rejects a stale timestamp even with a valid signature", async () => {
    const old = String(Math.floor(NOW_MS / 1000) - MERCADOPAGO_TOLERANCE_S - 1);
    const p = provider(paymentFetch(200, {}));
    expect(
      await p.verifyWebhook(
        req({ ts: old, sig: `ts=${old},v1=${signature("98765", REQUEST_ID, old)}` }),
      ),
    ).toBeNull();
  });

  it("accepts a timestamp in milliseconds too", async () => {
    const ms = String(NOW_MS);
    const p = provider(
      paymentFetch(200, { id: 98765, status: "approved", external_reference: `acc_abc|${ORDER}` }),
    );
    expect(
      (
        await p.verifyWebhook(
          req({ ts: ms, sig: `ts=${ms},v1=${signature("98765", REQUEST_ID, ms)}` }),
        )
      )?.kind,
    ).toBe("paid");
  });

  it("rejects missing x-signature, missing x-request-id, and a signature without v1", async () => {
    const p = provider(paymentFetch(200, {}));
    expect(await p.verifyWebhook(req({ sig: null }))).toBeNull();
    expect(await p.verifyWebhook(req({ requestId: null }))).toBeNull();
    expect(await p.verifyWebhook(req({ sig: `ts=${NOW_MS / 1000}` }))).toBeNull();
  });

  it("is disabled without the webhook secret", async () => {
    expect(
      new MercadoPagoProvider({ accessToken: TOKEN, fetch: paymentFetch(200, {}) }).enabled,
    ).toBe(false);
  });

  it("answers ignored for a payment the API does not know, and throws on API errors", async () => {
    const notFound = await provider(paymentFetch(404, { message: "not found" })).verifyWebhook(
      req({}),
    );
    expect(notFound?.kind).toBe("ignored");
    await expect(provider(paymentFetch(500, {})).verifyWebhook(req({}))).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("parses the x-signature parts in any order", () => {
    expect(parseMercadoPagoSignature("v1=ab,ts=12")).toEqual({ ts: "12", v1: "ab" });
  });
});

describe("Mercado Pago checkout", () => {
  it("creates a preference with our external reference and returns init_point", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init.body as string)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          id: "pref-1",
          init_point: "https://www.mercadopago.test/checkout/pref-1",
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    const session = await provider(fake).createCheckout({
      orderId: ORDER,
      accountId: "acc_abc",
      product: {
        sku: "gems.small",
        name: "Gem pouch",
        description: "100 gems",
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
      providerRef: "pref-1",
      url: "https://www.mercadopago.test/checkout/pref-1",
    });
    expect(seen[0]?.url).toBe("https://api.mercadopago.com/checkout/preferences");
    expect(seen[0]?.body).toMatchObject({
      external_reference: `acc_abc|${ORDER}`,
      notification_url: "https://a.test/w",
      items: [{ currency_id: "BRL", unit_price: 4.9, quantity: 1 }],
    });
  });
});
