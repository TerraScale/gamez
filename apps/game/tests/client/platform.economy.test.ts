import { describe, expect, it } from "vite-plus/test";
import { isOpId } from "@gamez/protocol";
import { createHttp, type FetchFn } from "../../src/client/platform/http.ts";
import { createMarketApi } from "../../src/client/platform/market.ts";
import { createShopsApi } from "../../src/client/platform/shops.ts";
import { createTradeApi } from "../../src/client/platform/trade.ts";
import { createVaultApi, NETWORK_RETRIES } from "../../src/client/platform/vault.ts";

interface Sent {
  url: string;
  method: string;
  auth: string | undefined;
  body: unknown;
}

type Answer = { status?: number; body?: unknown } | Error;

/** Answers queued responses in order and records every request. */
function fakeFetch(answers: Answer[]) {
  const sent: Sent[] = [];
  const fetch: FetchFn = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url,
      method: init?.method ?? "GET",
      auth: headers.authorization,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    if (next instanceof Error) throw next;
    const status = next.status ?? 200;
    const text = next.body === undefined ? "" : JSON.stringify(next.body);
    return new Response(text, {
      status,
      statusText: status === 200 ? "OK" : "Status",
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, sent };
}

function clientWith(answers: Answer[]) {
  const { fetch, sent } = fakeFetch(answers);
  return { http: createHttp({ token: () => "tok-1", fetch }), sent };
}

const TRADE = {
  id: "t0123456789abcdef01234567",
  a: { accountId: "me", displayName: "Me" },
  b: { accountId: "them", displayName: "Them" },
  offers: {
    a: { coin: 0, items: [], version: 1 },
    b: { coin: 0, items: [], version: 1 },
  },
  accepted: { a: null, b: null },
  status: "open",
  reason: null,
  fees: { a: 0, b: 0 },
  createdAt: 1,
  expiresAt: 2,
};

const LISTING = {
  id: "classic:weapon/42",
  shard: "classic:weapon",
  seller: { accountId: "me", displayName: "Me" },
  item: {},
  buyout: 100,
  startBid: null,
  topBid: null,
  topBidder: null,
  bids: 0,
  fee: 2,
  createdAt: 1,
  endsAt: 2,
  status: "active",
  soldFor: null,
};

describe("vault and notices", () => {
  it("reads the vault and sends the bearer token", async () => {
    const { http, sent } = clientWith([{ body: { items: [], max: 200 } }]);
    const res = await createVaultApi(http).vault();
    expect(res).toEqual({ ok: true, value: { items: [], max: 200 } });
    expect(sent).toEqual([
      { url: "/api/account/vault", method: "GET", auth: "Bearer tok-1", body: undefined },
    ]);
  });

  it("rejects a vault body of the wrong shape", async () => {
    const { http } = clientWith([{ body: { nope: true } }]);
    const res = await createVaultApi(http).vault();
    expect(res).toMatchObject({ ok: false, code: "bad_response" });
  });

  it("notices: since is omitted when absent and sent when given", async () => {
    const reply = { notices: [], unread: 0 };
    const { http, sent } = clientWith([{ body: reply }, { body: reply }]);
    const api = createVaultApi(http);
    expect(await api.notices()).toEqual({ ok: true, value: reply });
    expect(await api.notices("n-9")).toEqual({ ok: true, value: reply });
    expect(sent.map((s) => s.url)).toEqual([
      "/api/account/notices",
      "/api/account/notices?since=n-9",
    ]);
  });

  it("mark read posts upTo and returns the count", async () => {
    const { http, sent } = clientWith([{ body: { marked: 3 } }]);
    expect(await createVaultApi(http).markRead("n-12")).toEqual({ ok: true, value: { marked: 3 } });
    expect(sent[0]).toMatchObject({
      url: "/api/account/notices/read",
      method: "POST",
      body: { upTo: "n-12" },
    });
  });

  it("maps server errors to their code and message", async () => {
    const { http } = clientWith([
      { status: 503, body: { error: { code: "disabled", message: "Vault is off" } } },
    ]);
    expect(await createVaultApi(http).vault()).toEqual({
      ok: false,
      code: "disabled",
      message: "Vault is off",
    });
  });
});

describe("trade", () => {
  it("open posts an opId and the counterpart", async () => {
    const { http, sent } = clientWith([{ body: TRADE }]);
    const res = await createTradeApi(http).open("them", "open-op-123");
    expect(res).toEqual({ ok: true, value: TRADE });
    expect(sent[0]).toMatchObject({
      url: "/api/trade",
      method: "POST",
      body: { opId: "open-op-123", with: "them" },
    });
  });

  it("open generates a valid opId when none is given", async () => {
    const { http, sent } = clientWith([{ body: TRADE }]);
    await createTradeApi(http).open("them");
    const body = sent[0]?.body as { opId: string };
    expect(isOpId(body.opId)).toBe(true);
  });

  it("network failures retry with the same opId", async () => {
    const { http, sent } = clientWith([
      new Error("offline"),
      new Error("offline"),
      { body: TRADE },
    ]);
    const res = await createTradeApi(http).open("them");
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(NETWORK_RETRIES + 1);
    const ids = new Set(sent.map((s) => (s.body as { opId: string }).opId));
    expect(ids.size).toBe(1);
  });

  it("gives up after the network retries", async () => {
    const answers: Answer[] = Array.from(
      { length: NETWORK_RETRIES + 1 },
      () => new Error("offline"),
    );
    const { http, sent } = clientWith(answers);
    const res = await createTradeApi(http).open("them", "same-op-1234");
    expect(res).toEqual({ ok: false, code: "network", message: "Network error, try again" });
    expect(sent).toHaveLength(NETWORK_RETRIES + 1);
  });

  it("get encodes the trade id in the path", async () => {
    const { http, sent } = clientWith([{ body: TRADE }]);
    await createTradeApi(http).get("t 1/2");
    expect(sent[0]?.url).toBe("/api/trade/t%201%2F2");
  });

  it("offer, accept and cancel send their bodies", async () => {
    const { http, sent } = clientWith([{ body: TRADE }, { body: TRADE }, { body: TRADE }]);
    const api = createTradeApi(http);
    await api.offer(TRADE.id, 40, ["u1", "u2"]);
    await api.accept(TRADE.id, [1, 1]);
    await api.cancel(TRADE.id);
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      ["POST", `/api/trade/${TRADE.id}/offer`, { coin: 40, uids: ["u1", "u2"] }],
      ["POST", `/api/trade/${TRADE.id}/accept`, { versions: [1, 1] }],
      ["POST", `/api/trade/${TRADE.id}/cancel`, {}],
    ]);
  });

  it("list returns the trades and rejects a bad body", async () => {
    const good = clientWith([{ body: { trades: [TRADE] } }]);
    expect(await createTradeApi(good.http).list()).toEqual({
      ok: true,
      value: { trades: [TRADE] },
    });
    const bad = clientWith([{ body: {} }]);
    expect(await createTradeApi(bad.http).list()).toMatchObject({
      ok: false,
      code: "bad_response",
    });
  });

  it("maps a conflict from accept", async () => {
    const { http } = clientWith([
      { status: 409, body: { error: { code: "conflict", message: "Offers changed" } } },
    ]);
    expect(await createTradeApi(http).accept(TRADE.id, [1, 2])).toEqual({
      ok: false,
      code: "conflict",
      message: "Offers changed",
    });
  });
});

describe("market", () => {
  it("search sends only the defined filters", async () => {
    const { http, sent } = clientWith([{ body: { listings: [], available: true } }]);
    await createMarketApi(http).search({
      scope: "classic",
      category: "weapon",
      q: "wolf sword",
      minLevel: 5,
      sort: "price_asc",
      limit: 20,
      offset: 40,
    });
    expect(sent[0]?.url).toBe(
      "/api/market/search?scope=classic&category=weapon&q=wolf+sword&minLevel=5&sort=price_asc&limit=20&offset=40",
    );
  });

  it("search rejects a body without listings", async () => {
    const { http } = clientWith([{ body: { available: true } }]);
    expect(await createMarketApi(http).search({})).toMatchObject({
      ok: false,
      code: "bad_response",
    });
  });

  it("mine returns listings and bids", async () => {
    const { http, sent } = clientWith([{ body: { listings: [LISTING], bids: [] } }]);
    const res = await createMarketApi(http).mine();
    expect(res).toEqual({ ok: true, value: { listings: [LISTING], bids: [] } });
    expect(sent[0]?.url).toBe("/api/market/mine");
  });

  it("list sends the form and an opId", async () => {
    const { http, sent } = clientWith([{ body: LISTING }]);
    const res = await createMarketApi(http).list({
      uid: "u1",
      buyout: 100,
      startBid: null,
      durationH: 24,
      opId: "list-op-0001",
    });
    expect(res).toEqual({ ok: true, value: LISTING });
    expect(sent[0]).toMatchObject({
      url: "/api/market/list",
      method: "POST",
      body: { opId: "list-op-0001", uid: "u1", buyout: 100, startBid: null, durationH: 24 },
    });
  });

  it("bid, buy and cancel post the listing id unencoded in the body", async () => {
    const { http, sent } = clientWith([{ body: LISTING }, { body: LISTING }, { body: LISTING }]);
    const api = createMarketApi(http);
    await api.bid("classic:weapon/42", 150, "bid-op-00001");
    await api.buy("classic:weapon/42", "buy-op-00001");
    await api.cancel("classic:weapon/42", "cancel-op-001");
    expect(sent.map((s) => s.body)).toEqual([
      { opId: "bid-op-00001", listingId: "classic:weapon/42", amount: 150 },
      { opId: "buy-op-00001", listingId: "classic:weapon/42" },
      { opId: "cancel-op-001", listingId: "classic:weapon/42" },
    ]);
  });

  it("buy reuses its opId across network retries", async () => {
    const { http, sent } = clientWith([new Error("offline"), { body: LISTING }]);
    const res = await createMarketApi(http).buy("classic:weapon/42");
    expect(res.ok).toBe(true);
    const ids = sent.map((s) => (s.body as { opId: string }).opId);
    expect(ids[0]).toBe(ids[1]);
    expect(isOpId(ids[0])).toBe(true);
  });
});

describe("shops", () => {
  const SHOP = {
    plotId: "p1",
    world: "classic-town",
    owner: { accountId: "me", displayName: "Me" },
    name: "Ember Forge",
    appearance: "unit.hero",
    open: true,
    stock: [],
    earnings: null,
    leaseEndsAt: 2,
  };

  it("plots reads the world's plots", async () => {
    const { http, sent } = clientWith([{ body: { world: "classic-town", plots: [] } }]);
    const res = await createShopsApi(http).plots("classic-town");
    expect(res).toEqual({ ok: true, value: { world: "classic-town", plots: [] } });
    expect(sent[0]?.url).toBe("/api/shops?world=classic-town");
  });

  it("bidPlot posts world, plot and amount with an opId", async () => {
    const { http, sent } = clientWith([{ body: { id: "p1", world: "classic-town" } }]);
    const res = await createShopsApi(http).bidPlot("classic-town", "p1", 60, "plot-op-0001");
    expect(res.ok).toBe(true);
    expect(sent[0]).toMatchObject({
      url: "/api/shops/plots/bid",
      method: "POST",
      body: { opId: "plot-op-0001", world: "classic-town", plotId: "p1", amount: 60 },
    });
  });

  it("shop, configure and claim use encoded world and plot paths", async () => {
    const { http, sent } = clientWith([{ body: SHOP }, { body: SHOP }, { body: SHOP }]);
    const api = createShopsApi(http);
    await api.shop("classic town", "p1");
    await api.configure("classic-town", "p1", { name: "Ember Forge", open: false });
    await api.claim("classic-town", "p1", "claim-op-001");
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ["GET", "/api/shops/classic%20town/p1"],
      ["POST", "/api/shops/classic-town/p1/configure"],
      ["POST", "/api/shops/classic-town/p1/claim"],
    ]);
    expect(sent[1]?.body).toEqual({ name: "Ember Forge", open: false });
    expect(sent[2]?.body).toEqual({ opId: "claim-op-001" });
  });

  it("stock, unstock and buy send their opIds and bodies", async () => {
    const { http, sent } = clientWith([{ body: SHOP }, { body: SHOP }, { body: SHOP }]);
    const api = createShopsApi(http);
    await api.stock("classic-town", "p1", "u1", 120, "stock-op-001");
    await api.unstock("classic-town", "p1", "e7", "unst-op-001");
    await api.buy("classic-town", "p1", "e7", "buy-op-0001");
    expect(sent.map((s) => s.body)).toEqual([
      { opId: "stock-op-001", uid: "u1", price: 120 },
      { opId: "unst-op-001", entryId: "e7" },
      { opId: "buy-op-0001", entryId: "e7" },
    ]);
  });

  it("a shop write retried after a network error keeps its opId", async () => {
    const { http, sent } = clientWith([new Error("offline"), { body: SHOP }]);
    await createShopsApi(http).stock("classic-town", "p1", "u1", 10);
    const ids = sent.map((s) => (s.body as { opId: string }).opId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("maps a closed shop to its error code", async () => {
    const { http } = clientWith([
      { status: 409, body: { error: { code: "closed", message: "The shop is closed" } } },
    ]);
    expect(await createShopsApi(http).buy("classic-town", "p1", "e7", "buy-op-0002")).toEqual({
      ok: false,
      code: "closed",
      message: "The shop is closed",
    });
  });
});
