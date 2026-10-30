import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, beforeEach } from "vite-plus/test";
import type { OrderRecord } from "../../src/server/contracts.ts";
import type { Env } from "../../src/server/contracts.ts";
import { AccountEconomy } from "../../src/server/account/economy.ts";
import { AccountPurchases } from "../../src/server/account/purchases.ts";
import { Outbox } from "@gamez/sync";
import { signToken } from "../../src/server/auth.ts";
import { resetFlagsCache } from "../../src/server/config/flags.ts";
import { storeRoutes } from "../../src/server/routes/store.ts";
import { signStubBody, stubWebhookBody } from "../../src/server/payments/stub.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";
import type { AccountNotices } from "../../src/server/account/notices.ts";
import type { AccountVault } from "../../src/server/account/vault.ts";

const SECRET = "dev-only-secret-change-me";
const LOCAL = "http://localhost:5173";
const PROD = "https://gamez.example.com";
const NOW = Date.now();

/** A stand-in for one AccountDO: the real economy and purchases over SQLite. */
function fakeAccount(accountId: string, kind: "guest" | "registered", sid: string | null) {
  const store = fakeSqlStore();
  const economy = new AccountEconomy(store, () => NOW);
  economy.init();
  const outbox = new Outbox(store.sql, `account:${accountId}`);
  outbox.init();
  const vault = {
    walletTx: (tx: Parameters<AccountEconomy["applyWalletTx"]>[0]) => economy.applyWalletTx(tx),
  } as unknown as AccountVault;
  const notices = { notify: () => undefined } as unknown as AccountNotices;
  const purchases = new AccountPurchases(
    store,
    economy,
    vault,
    notices,
    outbox,
    accountId,
    () => NOW,
  );
  purchases.init();
  return {
    kind,
    async profile() {
      return { accountId, kind };
    },
    async checkSession(s: string) {
      return s === sid;
    },
    async wallet() {
      return economy.wallet();
    },
    async createOrder(input: Parameters<AccountPurchases["createOrder"]>[0]): Promise<OrderRecord> {
      return purchases.createOrder(input);
    },
    async fulfillOrder(input: Parameters<AccountPurchases["fulfillOrder"]>[0]) {
      return purchases.fulfillOrder(input);
    },
    async refundOrder(input: Parameters<AccountPurchases["refundOrder"]>[0]) {
      return purchases.refundOrder(input);
    },
    async orders() {
      return purchases.orders();
    },
    async entitlements() {
      return economy.entitlements();
    },
  };
}

type Fake = ReturnType<typeof fakeAccount>;

function makeEnv(extra: Partial<Env> = {}) {
  const accounts = new Map<string, Fake>();
  const env = {
    AUTH_SECRET: SECRET,
    ACCOUNT: {
      getByName: (id: string) => {
        let a = accounts.get(id);
        if (!a) {
          // Ids starting "acc_g" are guests (no session check); the rest are registered.
          a = id.startsWith("acc_g")
            ? fakeAccount(id, "guest", null)
            : fakeAccount(id, "registered", "sid-1");
          accounts.set(id, a);
        }
        return a;
      },
    },
    ...extra,
  } as unknown as Env;
  return { env, accounts };
}

async function regToken(accountId: string): Promise<string> {
  return signToken(SECRET, {
    accountId,
    name: "Mario",
    issuedAt: NOW,
    kind: "registered",
    sid: "sid-1",
  });
}

async function guestToken(accountId: string): Promise<string> {
  return signToken(SECRET, { accountId, name: "Guest", issuedAt: NOW, kind: "guest" });
}

interface Call {
  method?: "GET" | "POST";
  path: string;
  url?: string;
  token?: string;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  raw?: string;
  env: Env;
}

async function call(c: Call): Promise<Response> {
  const url = new URL(`${c.url ?? LOCAL}${c.path}`);
  const headers: Record<string, string> = { ...c.headers };
  if (c.token) headers.authorization = `Bearer ${c.token}`;
  let body: string | undefined;
  if (c.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(c.json);
  } else if (c.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(c.form).toString();
  } else if (c.raw !== undefined) {
    body = c.raw;
  }
  const request = new Request(url, {
    method: c.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
  });
  const res = await storeRoutes({ request, env: c.env, url, ctx: {} as ExecutionContext });
  if (res === null) throw new Error(`route did not answer ${c.path}`);
  return res;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(() => {
  resetFlagsCache();
});

describe("GET /api/store", () => {
  it("lists products and providers to guests, with the stub enabled on localhost", async () => {
    const { env } = makeEnv();
    const token = await guestToken("acc_guest1");
    const res = await call({ path: "/api/store?country=BR", env, token });
    expect(res.status).toBe(200);
    const body = await json<{
      products: { sku: string }[];
      providers: { id: string; enabled: boolean }[];
      suggested: string | null;
    }>(res);
    expect(body.products.map((p) => p.sku)).toContain("gems.small");
    expect(body.providers.find((p) => p.id === "stub")?.enabled).toBe(true);
    expect(body.providers.find((p) => p.id === "asaas")?.enabled).toBe(false);
    // BR prefers asaas, which is not set up here, so the enabled stub is the suggestion.
    expect(body.suggested).toBe("stub");
  });

  it("is switched off by the store flag", async () => {
    const { env } = makeEnv({
      CONFIG: {
        getByName: () => ({
          config: async () => ({
            flags: {
              store: false,
              bank: true,
              market: true,
              trade: true,
              shops: true,
              arena: true,
              pass: true,
            },
            seasonId: "2026-s1",
            serverTime: NOW,
          }),
        }),
      },
    } as unknown as Partial<Env>);
    const res = await call({ path: "/api/store", env });
    expect(res.status).toBe(503);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("disabled");
  });

  it("hides the stub on a public host", async () => {
    const { env } = makeEnv();
    const res = await call({ path: "/api/store", env, url: PROD });
    const body = await json<{
      providers: { id: string; enabled: boolean }[];
      suggested: string | null;
    }>(res);
    expect(body.providers.find((p) => p.id === "stub")?.enabled).toBe(false);
    // Nothing is enabled on a public host without keys, so there is no suggestion.
    expect(body.suggested).toBeNull();
  });
});

describe("POST /api/store/checkout", () => {
  it("is forbidden to guests", async () => {
    const { env } = makeEnv();
    const res = await call({
      path: "/api/store/checkout",
      env,
      token: await guestToken("acc_g"),
      json: { opId: "opid-00000001", sku: "gems.small", provider: "stub", currency: "USD" },
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("guest_forbidden");
  });

  it("creates one order per (account, opId) and returns the stub checkout url", async () => {
    const { env } = makeEnv();
    const token = await regToken("acc_reg1");
    const body = { opId: "opid-00000002", sku: "gems.small", provider: "stub", currency: "USD" };
    const first = await json<{ orderId: string; url: string }>(
      await call({ path: "/api/store/checkout", env, token, json: body }),
    );
    expect(first.orderId).toMatch(/^o[0-9a-f]{24}$/);
    expect(first.url).toBe(
      `${LOCAL}/api/pay/stub/checkout?order=${first.orderId}&account=acc_reg1`,
    );
    const retry = await json<{ orderId: string }>(
      await call({ path: "/api/store/checkout", env, token, json: body }),
    );
    expect(retry.orderId).toBe(first.orderId);
  });

  it("rejects bad input: unknown sku, provider, currency, a sku not sold in the currency, and a disabled provider", async () => {
    const { env } = makeEnv();
    const token = await regToken("acc_reg2");
    const base = { opId: "opid-00000003", sku: "gems.small", provider: "stub", currency: "USD" };
    const status = async (patch: Record<string, unknown>) =>
      (await call({ path: "/api/store/checkout", env, token, json: { ...base, ...patch } })).status;
    expect(await status({ sku: "gems.huge" })).toBe(404);
    expect(await status({ provider: "paypal" })).toBe(400);
    expect(await status({ currency: "EUR" })).toBe(400);
    expect(await status({ provider: "stripe" })).toBe(503);
    expect(await status({ opId: "short" })).toBe(400);
  });

  it("refuses to reuse an opId for another order, and refuses an order that is already paid", async () => {
    const { env } = makeEnv();
    const token = await regToken("acc_reg3");
    const first = await json<{ orderId: string }>(
      await call({
        path: "/api/store/checkout",
        env,
        token,
        json: { opId: "opid-00000004", sku: "gems.small", provider: "stub", currency: "USD" },
      }),
    );
    const other = await call({
      path: "/api/store/checkout",
      env,
      token,
      json: { opId: "opid-00000004", sku: "gems.medium", provider: "stub", currency: "USD" },
    });
    expect(other.status).toBe(409);
    const stub = env.ACCOUNT.getByName("acc_reg3");
    await stub.fulfillOrder({
      orderId: first.orderId,
      providerRef: null,
      eventId: "x",
      provider: "stub",
      paid: { currency: "USD", amountMinor: 99 },
    });
    const paid = await call({
      path: "/api/store/checkout",
      env,
      token,
      json: { opId: "opid-00000004", sku: "gems.small", provider: "stub", currency: "USD" },
    });
    expect(paid.status).toBe(409);
  });
});

describe("the stub flow", () => {
  async function startOrder(env: Env, accountId: string, sku = "gems.small") {
    const token = await regToken(accountId);
    const body = await json<{ orderId: string; url: string }>(
      await call({
        path: "/api/store/checkout",
        env,
        token,
        json: {
          opId: `op-${accountId}-${sku.replace(/\./g, "")}`,
          sku,
          provider: "stub",
          currency: "USD",
        },
      }),
    );
    return { token, ...body };
  }

  it("shows the sandbox page for the order and answers 404 for an unknown one", async () => {
    const { env } = makeEnv();
    const order = await startOrder(env, "acc_stub1");
    const page = await call({
      path: `/api/pay/stub/checkout?order=${order.orderId}&account=acc_stub1`,
      env,
      method: "GET",
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Pay (sandbox)");
    expect(html).toContain("Gem pouch");
    const missing = await call({
      path: "/api/pay/stub/checkout?order=oabcdef0123456789abcdef01&account=acc_stub1",
      env,
      method: "GET",
    });
    expect(missing.status).toBe(404);
  });

  it("completes a payment: gems credited once, redirect to the paid return page, and a re-post changes nothing", async () => {
    const { env, accounts } = makeEnv();
    const order = await startOrder(env, "acc_stub2");
    const paid = await call({
      path: "/api/pay/stub/complete",
      env,
      form: { order: order.orderId, account: "acc_stub2", result: "paid" },
      method: "POST",
    });
    expect(paid.status).toBe(302);
    expect(paid.headers.get("location")).toBe(`/#store=paid&order=${order.orderId}`);
    const acct = accounts.get("acc_stub2")!;
    expect((await acct.wallet()).balances.gem).toBe(100);
    expect((await acct.orders())[0]?.status).toBe("paid");
    const again = await call({
      path: "/api/pay/stub/complete",
      env,
      form: { order: order.orderId, account: "acc_stub2", result: "paid" },
      method: "POST",
    });
    expect(again.status).toBe(302);
    expect((await acct.wallet()).balances.gem).toBe(100);
  });

  it("redirects a cancel without touching the order", async () => {
    const { env, accounts } = makeEnv();
    const order = await startOrder(env, "acc_stub3");
    const res = await call({
      path: "/api/pay/stub/complete",
      env,
      form: { order: order.orderId, account: "acc_stub3", result: "cancel" },
      method: "POST",
    });
    expect(res.headers.get("location")).toBe("/#store=cancel");
    expect((await accounts.get("acc_stub3")!.orders())[0]?.status).toBe("pending");
  });

  it("answers 404 for every stub endpoint on a public host", async () => {
    const { env } = makeEnv();
    const page = await call({
      path: "/api/pay/stub/checkout?order=o0123456789abcdef01234567&account=acc_x",
      env,
      url: PROD,
      method: "GET",
    });
    expect(page.status).toBe(404);
    const complete = await call({
      path: "/api/pay/stub/complete",
      env,
      url: PROD,
      form: { order: "o0123456789abcdef01234567", account: "acc_x", result: "paid" },
      method: "POST",
    });
    expect(complete.status).toBe(404);
    const hook = await call({
      path: "/api/pay/webhook/stub",
      env,
      url: PROD,
      raw: "{}",
      headers: { "x-stub-signature": "00" },
    });
    expect(hook.status).toBe(404);
  });

  it("answers 400 for a malformed order id on the stub page", async () => {
    const { env } = makeEnv();
    const res = await call({
      path: "/api/pay/stub/checkout?order=../../x&account=acc_x",
      env,
      method: "GET",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/pay/webhook/:provider", () => {
  it("answers 401 with nothing changed when the signature is bad", async () => {
    const { env, accounts } = makeEnv();
    const token = await regToken("acc_wh1");
    const order = await json<{ orderId: string }>(
      await call({
        path: "/api/store/checkout",
        env,
        token,
        json: { opId: "op-wh1-0001", sku: "gems.small", provider: "stub", currency: "USD" },
      }),
    );
    const raw = stubWebhookBody({
      id: "evil",
      kind: "paid",
      orderId: order.orderId,
      accountId: "acc_wh1",
      providerRef: "x",
    });
    const res = await call({
      path: "/api/pay/webhook/stub",
      env,
      raw,
      headers: { "x-stub-signature": "0".repeat(64) },
    });
    expect(res.status).toBe(401);
    expect((await accounts.get("acc_wh1")!.wallet()).balances.gem).toBe(0);
  });

  it("answers 200 for a signed re-post and grants once", async () => {
    const { env, accounts } = makeEnv();
    const token = await regToken("acc_wh2");
    const order = await json<{ orderId: string }>(
      await call({
        path: "/api/store/checkout",
        env,
        token,
        json: { opId: "op-wh2-0001", sku: "gems.small", provider: "stub", currency: "USD" },
      }),
    );
    const raw = stubWebhookBody({
      id: `stub_${order.orderId}_paid`,
      kind: "paid",
      orderId: order.orderId,
      accountId: "acc_wh2",
      providerRef: `stub_${order.orderId}`,
      currency: "USD",
      amountMinor: 99,
    });
    const sig = await signStubBody(SECRET, raw);
    const post = () =>
      call({ path: "/api/pay/webhook/stub", env, raw, headers: { "x-stub-signature": sig } });
    const first = await post();
    expect(first.status).toBe(200);
    expect(await json<{ applied: boolean }>(first)).toMatchObject({ applied: true });
    const second = await post();
    expect(second.status).toBe(200);
    expect(await json<{ applied: boolean }>(second)).toMatchObject({
      applied: true,
      status: "paid",
    });
    expect((await accounts.get("acc_wh2")!.wallet()).balances.gem).toBe(100);
  });

  it("answers 200 and applies nothing for an order this account does not have", async () => {
    const { env, accounts } = makeEnv();
    const raw = stubWebhookBody({
      id: "stub_missing",
      kind: "paid",
      orderId: "oabcdef0123456789abcdef01",
      accountId: "acc_wh3",
      providerRef: "x",
    });
    const res = await call({
      path: "/api/pay/webhook/stub",
      env,
      raw,
      headers: { "x-stub-signature": await signStubBody(SECRET, raw) },
    });
    expect(res.status).toBe(200);
    expect(await json<{ reason: string }>(res)).toMatchObject({ reason: "unknown_order" });
    expect(accounts.get("acc_wh3")).toBeDefined();
  });

  it("refunds through a signed refunded webhook", async () => {
    const { env, accounts } = makeEnv();
    const token = await regToken("acc_wh4");
    const order = await json<{ orderId: string }>(
      await call({
        path: "/api/store/checkout",
        env,
        token,
        json: { opId: "op-wh4-0001", sku: "gems.small", provider: "stub", currency: "USD" },
      }),
    );
    await call({
      path: "/api/pay/stub/complete",
      env,
      form: { order: order.orderId, account: "acc_wh4", result: "paid" },
      method: "POST",
    });
    const raw = stubWebhookBody({
      id: `refund_${order.orderId}`,
      kind: "refunded",
      orderId: order.orderId,
      accountId: "acc_wh4",
      providerRef: "x",
    });
    const res = await call({
      path: "/api/pay/webhook/stub",
      env,
      raw,
      headers: { "x-stub-signature": await signStubBody(SECRET, raw) },
    });
    expect(await json<{ status: string }>(res)).toMatchObject({ status: "refunded" });
    expect((await accounts.get("acc_wh4")!.wallet()).balances.gem).toBe(0);
  });

  it("answers 404 for a provider that is not configured", async () => {
    const { env } = makeEnv();
    const res = await call({
      path: "/api/pay/webhook/asaas",
      env,
      raw: "{}",
      headers: { "asaas-access-token": "x" },
    });
    expect(res.status).toBe(404);
  });

  it("verifies a Stripe webhook with its own secret before reading it", async () => {
    const { env } = makeEnv({
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_WEBHOOK_SECRET: "whsec_fake",
    } as unknown as Partial<Env>);
    const res = await call({
      path: "/api/pay/webhook/stripe",
      env,
      url: PROD,
      raw: JSON.stringify({
        id: "evt_1",
        type: "checkout.session.completed",
        data: { object: {} },
      }),
      headers: { "stripe-signature": `t=${Math.floor(NOW / 1000)},v1=${"0".repeat(64)}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/store/orders", () => {
  it("lists my orders newest first, as views without the account", async () => {
    const { env } = makeEnv();
    const token = await regToken("acc_ord1");
    await call({
      path: "/api/store/checkout",
      env,
      token,
      json: { opId: "op-ord-0001", sku: "gems.small", provider: "stub", currency: "USD" },
    });
    await call({
      path: "/api/store/checkout",
      env,
      token,
      json: { opId: "op-ord-0002", sku: "gems.medium", provider: "stub", currency: "USD" },
    });
    const res = await call({ path: "/api/store/orders", env, token });
    const body = await json<{ orders: { sku: string; accountId?: string }[] }>(res);
    expect(body.orders.map((o) => o.sku)).toEqual(["gems.medium", "gems.small"]);
    expect(body.orders[0]).not.toHaveProperty("accountId");
  });

  it("needs a session", async () => {
    const { env } = makeEnv();
    expect((await call({ path: "/api/store/orders", env })).status).toBe(401);
  });
});

// ---- paid amount vs the order (ADR 0006 §13) ------------------------------------

const AMOUNT_ACCOUNT = "acc_amt1";
/** gems.small: USD 0.99 / BRL 4.90, 100 gems. */
const ORDER_OK = "o00000000000000000000aa01";
const ORDER_BAD = "o00000000000000000000aa02";

type Provider = "stripe" | "asaas" | "mercadopago" | "stub";

async function seedOrders(env: Env, provider: Provider, currency: "USD" | "BRL") {
  const acct = env.ACCOUNT.getByName(AMOUNT_ACCOUNT) as unknown as Fake;
  const price = { currency, amountMinor: currency === "USD" ? 99 : 490 } as const;
  for (const orderId of [ORDER_OK, ORDER_BAD])
    await acct.createOrder({ orderId, sku: "gems.small", provider, price });
  return acct;
}

async function statusOf(acct: Fake, orderId: string) {
  return (await acct.orders()).find((o) => o.orderId === orderId);
}

async function expectMatchGrantsAndMismatchFails(
  acct: Fake,
  post: (orderId: string, amount: string) => Promise<Response>,
  good: string,
  bad: string,
  reason: RegExp,
) {
  const ok = await post(ORDER_OK, good);
  expect(ok.status).toBe(200);
  expect(await json(ok)).toMatchObject({ applied: true, status: "paid" });
  expect((await acct.wallet()).balances.gem).toBe(100);

  const wrong = await post(ORDER_BAD, bad);
  expect(wrong.status).toBe(200);
  const body = await json<{ applied: boolean; status: string; reason: string }>(wrong);
  expect(body).toMatchObject({ applied: false, status: "failed" });
  expect(body.reason).toMatch(reason);
  expect((await acct.wallet()).balances.gem).toBe(100);
  expect(await statusOf(acct, ORDER_BAD)).toMatchObject({ status: "failed" });
  expect((await statusOf(acct, ORDER_BAD))?.failReason).toMatch(reason);

  // A redelivery with the right amount does not revive a failed order.
  const again = await post(ORDER_BAD, good);
  expect(await json(again)).toMatchObject({ applied: false, status: "failed" });
  expect((await acct.wallet()).balances.gem).toBe(100);
}

describe("webhooks grant only when the paid amount equals the order", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const realFetch = globalThis.fetch;

  it("stripe: amount_total + currency", async () => {
    const whsec = "whsec_route_fake";
    const { env } = makeEnv({
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_WEBHOOK_SECRET: whsec,
    } as unknown as Partial<Env>);
    const acct = await seedOrders(env, "stripe", "USD");
    const post = (orderId: string, amount: string) => {
      const [currency, total] = amount.split(" ");
      const raw = JSON.stringify({
        id: `evt_${orderId}_${amount}`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: `cs_test_${orderId}`,
            payment_status: "paid",
            amount_total: Number(total),
            currency,
            metadata: { accountId: AMOUNT_ACCOUNT, orderId },
          },
        },
      });
      const t = Math.floor(Date.now() / 1000);
      const v1 = createHmac("sha256", whsec).update(`${t}.${raw}`).digest("hex");
      return call({
        path: "/api/pay/webhook/stripe",
        env,
        url: PROD,
        raw,
        headers: { "stripe-signature": `t=${t},v1=${v1}` },
      });
    };
    await expectMatchGrantsAndMismatchFails(
      acct,
      post,
      "usd 99",
      "usd 9",
      /^amount_mismatch: paid USD 0\.09, the order is USD 0\.99$/,
    );
  });

  it("stripe: the same number in another currency fails", async () => {
    const whsec = "whsec_route_fake";
    const { env } = makeEnv({
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_WEBHOOK_SECRET: whsec,
    } as unknown as Partial<Env>);
    const acct = await seedOrders(env, "stripe", "BRL");
    const raw = JSON.stringify({
      id: "evt_cur",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_cur",
          payment_status: "paid",
          amount_total: 490,
          currency: "usd",
          metadata: { accountId: AMOUNT_ACCOUNT, orderId: ORDER_BAD },
        },
      },
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", whsec).update(`${t}.${raw}`).digest("hex");
    const res = await call({
      path: "/api/pay/webhook/stripe",
      env,
      url: PROD,
      raw,
      headers: { "stripe-signature": `t=${t},v1=${v1}` },
    });
    expect(await json(res)).toMatchObject({ applied: false, status: "failed" });
    expect((await statusOf(acct, ORDER_BAD))?.failReason).toMatch(/^currency_mismatch/);
    expect((await acct.wallet()).balances.gem).toBe(0);
  });

  it("asaas: the decimal value in BRL", async () => {
    const { env } = makeEnv({
      ASAAS_API_KEY: "aak_fake",
      ASAAS_WEBHOOK_TOKEN: "asaas-route-token",
    } as unknown as Partial<Env>);
    const acct = await seedOrders(env, "asaas", "BRL");
    const post = (orderId: string, amount: string) =>
      call({
        path: "/api/pay/webhook/asaas",
        env,
        url: PROD,
        raw: JSON.stringify({
          id: `evt_${orderId}_${amount}`,
          event: "PAYMENT_RECEIVED",
          payment: {
            id: `pay_${orderId}`,
            value: Number(amount),
            netValue: 0.01,
            status: "RECEIVED",
            externalReference: `${AMOUNT_ACCOUNT}|${orderId}`,
          },
        }),
        headers: { "asaas-access-token": "asaas-route-token" },
      });
    await expectMatchGrantsAndMismatchFails(
      acct,
      post,
      "4.9",
      "4.8",
      /^amount_mismatch: paid BRL 4\.80, the order is BRL 4\.90$/,
    );
  });

  it("mercadopago: transaction_amount + currency_id from the payment API", async () => {
    const secret = "mp-route-secret";
    const { env } = makeEnv({
      MERCADOPAGO_ACCESS_TOKEN: "APP_USR-route",
      MERCADOPAGO_WEBHOOK_SECRET: secret,
    } as unknown as Partial<Env>);
    const acct = await seedOrders(env, "mercadopago", "BRL");
    const payments = new Map<string, Record<string, unknown>>();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const id =
        String(input instanceof Request ? input.url : input)
          .split("/")
          .pop() ?? "";
      const p = payments.get(id);
      return new Response(JSON.stringify(p ?? {}), { status: p ? 200 : 404 });
    }) as typeof fetch;
    let n = 0;
    const post = (orderId: string, amount: string) => {
      const [currency, value] = amount.split(" ");
      const dataId = String(1000 + n++);
      payments.set(dataId, {
        id: Number(dataId),
        status: "approved",
        external_reference: `${AMOUNT_ACCOUNT}|${orderId}`,
        transaction_amount: Number(value),
        currency_id: currency,
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const v1 = createHmac("sha256", secret)
        .update(`id:${dataId};request-id:req-${dataId};ts:${ts};`)
        .digest("hex");
      return call({
        path: `/api/pay/webhook/mercadopago?data.id=${dataId}`,
        env,
        url: PROD,
        raw: JSON.stringify({ type: "payment", data: { id: dataId } }),
        headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": `req-${dataId}` },
      });
    };
    await expectMatchGrantsAndMismatchFails(
      acct,
      post,
      "BRL 4.9",
      "USD 4.9",
      /^currency_mismatch: paid USD 4\.90, the order is BRL 4\.90$/,
    );
  });

  it("stub: a signed body with another amount fails; the sandbox page charges the order price", async () => {
    const { env } = makeEnv();
    const acct = await seedOrders(env, "stub", "USD");
    const post = async (orderId: string, amount: string) => {
      const raw = stubWebhookBody({
        id: `stub_${orderId}_${amount}`,
        kind: "paid",
        orderId,
        accountId: AMOUNT_ACCOUNT,
        providerRef: `stub_${orderId}`,
        currency: "USD",
        amountMinor: Number(amount),
      });
      return call({
        path: "/api/pay/webhook/stub",
        env,
        raw,
        headers: { "x-stub-signature": await signStubBody(SECRET, raw) },
      });
    };
    await expectMatchGrantsAndMismatchFails(
      acct,
      post,
      "99",
      "1",
      /^amount_mismatch: paid USD 0\.01/,
    );
  });

  it("a paid event from another provider than the order's fails it", async () => {
    const { env } = makeEnv();
    const acct = await seedOrders(env, "stripe", "USD");
    const raw = stubWebhookBody({
      id: "stub_cross",
      kind: "paid",
      orderId: ORDER_BAD,
      accountId: AMOUNT_ACCOUNT,
      providerRef: "x",
      currency: "USD",
      amountMinor: 99,
    });
    const res = await call({
      path: "/api/pay/webhook/stub",
      env,
      raw,
      headers: { "x-stub-signature": await signStubBody(SECRET, raw) },
    });
    expect(await json(res)).toMatchObject({ applied: false, status: "failed" });
    expect((await statusOf(acct, ORDER_BAD))?.failReason).toMatch(/^provider_mismatch/);
    expect((await acct.wallet()).balances.gem).toBe(0);
  });
});
