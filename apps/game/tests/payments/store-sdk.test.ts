import { describe, expect, it } from "vite-plus/test";
import { createHttp } from "../../src/client/platform/http.ts";
import { createStoreApi } from "../../src/client/platform/store.ts";

function recorder(reply: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("store SDK", () => {
  it("catalog sends the country as a query and returns the store response", async () => {
    const { calls, fetch } = recorder(() => ok({ products: [], providers: [], suggested: null }));
    const api = createStoreApi(createHttp({ token: () => null, fetch }));
    const res = await api.catalog("BR");
    expect(res).toEqual({ ok: true, value: { products: [], providers: [], suggested: null } });
    expect(calls[0]?.url).toBe("/api/store?country=BR");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("catalog without a country omits the query", async () => {
    const { calls, fetch } = recorder(() => ok({ products: [], providers: [], suggested: null }));
    await createStoreApi(createHttp({ token: () => null, fetch })).catalog();
    expect(calls[0]?.url).toBe("/api/store");
  });

  it("checkout posts the body with the given opId and the bearer token", async () => {
    const { calls, fetch } = recorder(() =>
      ok({ orderId: "o0123456789abcdef01234567", url: "/api/pay/stub/checkout?order=x" }),
    );
    const api = createStoreApi(createHttp({ token: () => "tok-1", fetch }));
    const res = await api.checkout("gems.small", "stub", "USD", "opid-00000009");
    expect(res.ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/store/checkout");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body as string))).toEqual({
      opId: "opid-00000009",
      sku: "gems.small",
      provider: "stub",
      currency: "USD",
    });
    expect(((calls[0]?.init.headers ?? {}) as Record<string, string>).authorization).toBe(
      "Bearer tok-1",
    );
  });

  it("checkout generates a 32-char opId when none is given", async () => {
    const { calls, fetch } = recorder(() =>
      ok({ orderId: "o0123456789abcdef01234567", url: "/x" }),
    );
    await createStoreApi(createHttp({ token: () => null, fetch })).checkout(
      "gems.small",
      "stub",
      "BRL",
    );
    const body = JSON.parse(String(calls[0]?.init.body as string)) as { opId: string };
    expect(body.opId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns the server's error code and message unchanged", async () => {
    const { fetch } = recorder(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "guest_forbidden", message: "create an account to trade" },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    const res = await createStoreApi(createHttp({ token: () => null, fetch })).checkout(
      "gems.small",
      "stub",
      "USD",
      "opid-00000010",
    );
    expect(res).toEqual({
      ok: false,
      code: "guest_forbidden",
      message: "create an account to trade",
    });
  });

  it("orders calls GET /api/store/orders", async () => {
    const { calls, fetch } = recorder(() => ok({ orders: [] }));
    const res = await createStoreApi(createHttp({ token: () => "t", fetch })).orders();
    expect(res).toEqual({ ok: true, value: { orders: [] } });
    expect(calls[0]?.url).toBe("/api/store/orders");
  });

  it("maps a network failure to a network code and never throws", async () => {
    const fetch = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof globalThis.fetch;
    const res = await createStoreApi(createHttp({ token: () => null, fetch })).orders();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("network");
  });
});
