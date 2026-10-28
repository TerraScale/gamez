/** /api/market/* routes end to end over real books, fake accounts and a projected D1 (T-market). */
import { describe, expect, it } from "vite-plus/test";
import { signToken, type Identity } from "../../src/server/auth.ts";
import type { Env } from "../../src/server/contracts.ts";
import { marketRoutes } from "../../src/server/routes/market.ts";
import type { RouteContext } from "../../src/server/routes/types.ts";
import { FakeAccounts } from "./fake-accounts.ts";
import { FakeD1, FakeMarket, project } from "./fakes.ts";
import { item, makeClock, opId } from "./harness.ts";

const SECRET = "market-route-secret";
const HOST = "https://gamez.test";
const S = "acc-seller";
const B = "acc-buyer";
const G = "acc-guest";

interface World {
  env: Env;
  accounts: FakeAccounts;
  market: FakeMarket;
  d1: FakeD1;
  clock: ReturnType<typeof makeClock>;
}

function world(migrate = true): World {
  const clock = makeClock();
  const accounts = new FakeAccounts();
  const market = new FakeMarket(accounts, clock);
  const d1 = new FakeD1();
  if (migrate) d1.migrate(["0006_market.sql"]);
  const env = {
    AUTH_SECRET: SECRET,
    ACCOUNT: {
      getByName: (id: string) => ({
        ...accounts.stub(id),
        checkSession: async (sid: string) => sid === `sid-${id}`,
        profile: async () => null,
      }),
    },
    MARKET: { getByName: (shard: string) => market.getByName(shard) },
    DB: d1.asD1(),
  } as unknown as Env;
  return { env, accounts, market, d1, clock };
}

async function token(accountId: string, kind: "guest" | "registered"): Promise<string> {
  const identity: Identity =
    kind === "registered"
      ? { accountId, name: accountId, issuedAt: Date.now(), kind, sid: `sid-${accountId}` }
      : { accountId, name: accountId, issuedAt: Date.now() };
  return signToken(SECRET, identity);
}

async function call(
  w: World,
  path: string,
  init: { method?: string; token?: string; body?: unknown; raw?: string } = {},
): Promise<{ status: number; body: unknown } | null> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined || init.raw !== undefined)
    headers["content-type"] = "application/json";
  const url = new URL(path, HOST);
  const request = new Request(url, {
    method: init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
    headers,
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  const c: RouteContext = { request, env: w.env, url, ctx: {} as ExecutionContext };
  const res = await marketRoutes(c);
  if (res === null) return null;
  return { status: res.status, body: await res.json() };
}

describe("GET /api/market/search", () => {
  it("answers guests with the read model", async () => {
    const w = world();
    const res = await call(w, "/api/market/search?q=ember");
    expect(res).toEqual({ status: 200, body: { listings: [], available: true } });
  });

  it("rejects bad parameters with 400", async () => {
    const w = world();
    const res = await call(w, "/api/market/search?sort=nope");
    expect(res?.status).toBe(400);
  });

  it("answers available:false when the migration is missing, never a 500", async () => {
    const w = world(false);
    const res = await call(w, "/api/market/search");
    expect(res).toEqual({ status: 200, body: { listings: [], available: false } });
  });
});

describe("writes", () => {
  it("guests cannot list, bid, buy or cancel", async () => {
    const w = world();
    const guest = await token(G, "guest");
    for (const path of ["list", "bid", "buy", "cancel"]) {
      const res = await call(w, `/api/market/${path}`, { token: guest, body: { opId: opId() } });
      expect(res, path).toMatchObject({
        status: 403,
        body: { error: { code: "guest_forbidden" } },
      });
    }
  });

  it("answers 401 without a session", async () => {
    const w = world();
    const res = await call(w, "/api/market/list", { body: { opId: opId() } });
    expect(res?.status).toBe(401);
  });

  it("rejects a malformed body and a missing opId with 400", async () => {
    const w = world();
    const seller = await token(S, "registered");
    expect((await call(w, "/api/market/list", { token: seller, raw: "[1,2]" }))?.status).toBe(400);
    expect((await call(w, "/api/market/list", { token: seller, body: { uid: "x" } }))?.status).toBe(
      400,
    );
  });

  it("list: an unknown item is 404; untradable and ineligible items are 400", async () => {
    const w = world();
    w.accounts.grant(S, 1000, [item({ tradable: false }), item({}, { level: 3 })]);
    const seller = await token(S, "registered");
    const ids = [...(w.accounts.vaults.get(S)?.keys() ?? [])];
    const body = (uid: string) => ({
      opId: opId(),
      uid,
      buyout: 1000,
      startBid: null,
      durationH: 12,
    });
    expect(await call(w, "/api/market/list", { token: seller, body: body("nope") })).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
    });
    expect(await call(w, "/api/market/list", { token: seller, body: body(ids[0]!) })).toMatchObject(
      {
        status: 400,
        body: { error: { code: "not_tradable" } },
      },
    );
    expect(await call(w, "/api/market/list", { token: seller, body: body(ids[1]!) })).toMatchObject(
      {
        status: 400,
        body: { error: { code: "not_eligible" } },
      },
    );
    expect(w.accounts.coin(S)).toBe(1000);
  });

  it("list, buy, bid and cancel work end to end and show up in search and mine", async () => {
    const w = world();
    w.accounts.grant(S, 1000, [
      item({ data: '{"tag":"route-1"}' }),
      item({ data: '{"tag":"route-2"}' }),
    ]);
    w.accounts.grant(B, 2000);
    const seller = await token(S, "registered");
    const buyer = await token(B, "registered");
    const vault = [...(w.accounts.vaults.get(S)?.values() ?? [])];
    const [first, second] = vault;

    // 1. buyout listing, fee 20
    const listed = await call(w, "/api/market/list", {
      token: seller,
      body: { opId: opId("list"), uid: first!.uid, buyout: 1000, startBid: null, durationH: 12 },
    });
    expect(listed).toMatchObject({
      status: 200,
      body: { id: "classic:weapon/1", status: "active", fee: 20 },
    });
    expect(w.accounts.coin(S)).toBe(980);

    // 2. auction listing, fee 2
    const auction = await call(w, "/api/market/list", {
      token: seller,
      body: { opId: opId("list"), uid: second!.uid, buyout: null, startBid: 100, durationH: 24 },
    });
    expect(auction).toMatchObject({ status: 200, body: { id: "classic:weapon/2" } });

    // 3. D1 sees the listings after the outbox is projected (the DO alarm does this in production).
    await project(w.d1, w.market.outboxOf("classic:weapon"));
    const search = await call(w, "/api/market/search?q=ember&sort=price_asc");
    expect(search?.status).toBe(200);
    const found = (search?.body ?? { listings: [] }) as { listings: { id: string }[] };
    expect(found.listings.map((l) => l.id)).toEqual(["classic:weapon/2", "classic:weapon/1"]);

    // 4. a bid below the start bid is refused; a valid bid is held
    expect(
      await call(w, "/api/market/bid", {
        token: buyer,
        body: { opId: opId("bid"), listingId: "classic:weapon/2", amount: 99 },
      }),
    ).toMatchObject({ status: 400, body: { error: { code: "too_low" } } });
    expect(
      await call(w, "/api/market/bid", {
        token: buyer,
        body: { opId: opId("bid"), listingId: "classic:weapon/2", amount: 100 },
      }),
    ).toMatchObject({ status: 200, body: { topBid: 100, bids: 1 } });
    expect(w.accounts.coin(B)).toBe(1900);

    // 5. a malformed listing id is a 400
    expect(
      await call(w, "/api/market/bid", {
        token: buyer,
        body: { opId: opId(), listingId: "bad", amount: 100 },
      }),
    ).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });

    // 6. buy the buyout listing; the seller nets 1000 - 50 tax
    const bought = await call(w, "/api/market/buy", {
      token: buyer,
      body: { opId: opId("buy"), listingId: "classic:weapon/1" },
    });
    expect(bought).toMatchObject({ status: 200, body: { status: "sold", soldFor: 1000 } });
    expect(w.accounts.coin(B)).toBe(900);
    // 1000 - 20 (list fee) - 2 (auction fee) + 1000 sale - 50 tax
    expect(w.accounts.coin(S)).toBe(1000 - 20 - 2 + 1000 - 50);
    expect(w.accounts.vaultOf(B).map((i) => i.data)).toEqual(['{"tag":"route-1"}']);

    // 7. cancel with a bid is a conflict (409); a second seller cancel without bids is 200
    expect(
      await call(w, "/api/market/cancel", {
        token: seller,
        body: { opId: opId("cancel"), listingId: "classic:weapon/2" },
      }),
    ).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
    const third = item({ data: '{"tag":"route-3"}' });
    w.accounts.grant(S, 0, [third]);
    const third2 = [...(w.accounts.vaults.get(S)?.values() ?? [])].find(
      (i) => i.data === third.data,
    );
    const quick = await call(w, "/api/market/list", {
      token: seller,
      body: { opId: opId("list"), uid: third2!.uid, buyout: 500, startBid: null, durationH: 12 },
    });
    expect(quick).toMatchObject({ status: 200, body: { id: "classic:weapon/3" } });
    expect(
      await call(w, "/api/market/cancel", {
        token: seller,
        body: { opId: opId("cancel"), listingId: "classic:weapon/3" },
      }),
    ).toMatchObject({ status: 200, body: { status: "cancelled" } });
    expect(w.accounts.vaultOf(S).some((i) => i.data === third.data)).toBe(true);

    // 8. buying a sold listing is refused; a guest cannot buy at all
    expect(
      await call(w, "/api/market/buy", {
        token: buyer,
        body: { opId: opId("buy"), listingId: "classic:weapon/1" },
      }),
    ).toMatchObject({ status: 400, body: { error: { code: "closed" } } });

    // 9. mine shows the seller's listings and the auction the buyer leads
    await project(w.d1, w.market.outboxOf("classic:weapon"));
    const mine = await call(w, "/api/market/mine", { token: seller });
    const owned = (mine?.body ?? { listings: [] }) as {
      listings: { id: string; status: string }[];
    };
    const statuses = owned.listings.map((l) => `${l.id}=${l.status}`).sort();
    expect(statuses).toEqual([
      "classic:weapon/1=sold",
      "classic:weapon/2=active",
      "classic:weapon/3=cancelled",
    ]);
    const leading = await call(w, "/api/market/mine", { token: buyer });
    const led = (leading?.body ?? { bids: [] }) as { bids: { id: string }[] };
    expect(led.bids.map((l) => l.id)).toEqual(["classic:weapon/2"]);
  });

  it("an insufficient buyer gets 400 insufficient_funds", async () => {
    const w = world();
    w.accounts.grant(S, 1000, [item()]);
    w.accounts.grant(B, 10);
    const seller = await token(S, "registered");
    const buyer = await token(B, "registered");
    const uid = [...(w.accounts.vaults.get(S)?.keys() ?? [])][0]!;
    await call(w, "/api/market/list", {
      token: seller,
      body: { opId: opId("list"), uid, buyout: 1000, startBid: null, durationH: 12 },
    });
    expect(
      await call(w, "/api/market/buy", {
        token: buyer,
        body: { opId: opId("buy"), listingId: "classic:weapon/1" },
      }),
    ).toMatchObject({ status: 400, body: { error: { code: "insufficient_funds" } } });
  });
});

describe("routing", () => {
  it("answers 405 for the wrong method and ignores other paths", async () => {
    const w = world();
    expect((await call(w, "/api/market/list", { method: "GET" }))?.status).toBe(405);
    expect((await call(w, "/api/market/search", { method: "POST", body: {} }))?.status).toBe(405);
    expect(await call(w, "/api/other")).toBeNull();
  });
});
