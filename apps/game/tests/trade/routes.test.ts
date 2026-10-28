import { VAULT_MAX_ITEMS, type TradeView, type VaultItem } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { signToken } from "../../src/server/auth.ts";
import type { Env } from "../../src/server/contracts.ts";
import { tradeIdOf, tradeRoutes } from "../../src/server/routes/trade.ts";
import type { RouteContext, RouteHandler } from "../../src/server/routes/types.ts";
import { vaultRoutes } from "../../src/server/routes/vault.ts";
import { TradeEscrow } from "../../src/server/trade/escrow.ts";
import { FakeGateway, testItem } from "../support/fake-gateway.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const SECRET = "test-secret";
const HOST = "http://localhost:5173";

/** Env whose ACCOUNT and ESCROW namespaces run the real logic classes in memory. */
function fakeEnv() {
  const gw = new FakeGateway(() => Date.now());
  const escrows = new Map<string, TradeEscrow>();
  const accountStub = (id: string) => {
    const a = gw.account(id);
    return {
      checkSession: async () => true,
      profile: async () =>
        a.profile
          ? {
              accountId: id,
              kind: a.profile.kind,
              displayName: a.profile.displayName,
              createdAt: 0,
              identities: [],
            }
          : null,
      wallet: async () => a.economy.wallet(),
      walletTx: async (tx: Parameters<typeof a.vault.walletTx>[0]) => a.vault.walletTx(tx),
      vault: async () => a.vault.vault(),
      vaultPut: async (txId: string, item: Parameters<typeof a.vault.vaultPut>[1]) =>
        a.vault.vaultPut(txId, item),
      notices: async (since: string | null) => a.notices.notices(since),
      markNoticesRead: async (upTo: string) => a.notices.markRead(upTo),
      openTrades: async () => a.notices.openTrades(),
    };
  };
  const escrowStub = (name: string) => {
    let e = escrows.get(name);
    if (!e) {
      e = new TradeEscrow(fakeSqlStore(), gw, { now: () => Date.now(), setAlarm: () => {} });
      e.init();
      escrows.set(name, e);
    }
    return e;
  };
  const env = {
    AUTH_SECRET: SECRET,
    ACCOUNT: { getByName: accountStub },
    ESCROW: { getByName: escrowStub },
  } as unknown as Env;
  return { env, gw, escrows };
}

async function tokenFor(accountId: string, kind: "guest" | "registered" = "registered") {
  return signToken(SECRET, {
    accountId,
    name: accountId,
    issuedAt: Date.now(),
    kind,
    sid: kind === "registered" ? "sid-1" : null,
  });
}

function ctxFor(
  env: Env,
  path: string,
  init: { method?: string; token?: string; body?: unknown; base?: string } = {},
): RouteContext {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const url = new URL(path, init.base ?? HOST);
  const request = new Request(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { request, env, url, ctx: {} as ExecutionContext };
}

async function call(
  handler: RouteHandler,
  env: Env,
  path: string,
  init: Parameters<typeof ctxFor>[2] = {},
): Promise<{ status: number; body: any }> {
  const res = await handler(ctxFor(env, path, init));
  if (!res) throw new Error(`route did not answer ${path}`);
  return { status: res.status, body: await res.json() };
}

describe("vault routes", () => {
  it("serves the vault and notices, marks notices read, 401 without a session", async () => {
    const { env, gw } = fakeEnv();
    const token = await tokenFor("alice", "guest");
    gw.seed("alice", { items: [testItem("sword")] });
    await gw.notify("alice", { id: "n1", kind: "system", text: "one", data: {} });
    await gw.notify("alice", { id: "n2", kind: "system", text: "two", data: {} });

    expect((await call(vaultRoutes, env, "/api/account/vault")).status).toBe(401);
    const vault = await call(vaultRoutes, env, "/api/account/vault", { token });
    expect(vault.status).toBe(200);
    expect(vault.body).toMatchObject({
      max: VAULT_MAX_ITEMS,
      items: [{ uid: "v1", itemId: "test.weapon.sword" }],
    });

    const notices = await call(vaultRoutes, env, "/api/account/notices?since=n1", { token });
    expect(notices.body).toMatchObject({ unread: 2, notices: [{ id: "n2" }] });
    const read = await call(vaultRoutes, env, "/api/account/notices/read", {
      token,
      method: "POST",
      body: { upTo: "n2" },
    });
    expect(read.body).toEqual({ marked: 2 });
    expect(
      (
        await call(vaultRoutes, env, "/api/account/notices/read", {
          token,
          method: "POST",
          body: {},
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(vaultRoutes, env, "/api/account/vault", { token, method: "POST" })).status,
    ).toBe(405);
    expect(await vaultRoutes(ctxFor(env, "/api/account/wallet", { token }))).toBeNull();
  });

  it("dev grant: dev hosts only, validates everything first, idempotent with an opId", async () => {
    const { env, gw } = fakeEnv();
    const token = await tokenFor("guest1", "guest");
    const grant = (body: unknown, base?: string) =>
      call(vaultRoutes, env, "/api/dev/economy/grant", { token, method: "POST", body, base });

    expect((await grant({ coin: 10 }, "https://gamez.example.com")).status).toBe(404);
    const bad = await grant({ coin: 10, items: [testItem("a"), { itemId: "x" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/^items\[1\]/);
    expect(gw.balance("guest1")).toBe(0);
    expect((await grant({ coin: -5 })).status).toBe(400);
    expect((await grant({ coin: 5, opId: "x" })).status).toBe(400);

    const ok = await grant({ opId: "grant-0001", coin: 250, items: [testItem("sword")] });
    expect(ok.status).toBe(200);
    expect(ok.body.balances).toEqual({ coin: 250, gem: 0 });
    expect(ok.body.items).toHaveLength(1);
    expect(ok.body.vault.items).toHaveLength(1);
    const again = await grant({ opId: "grant-0001", coin: 250, items: [testItem("sword")] });
    expect(again.body.balances.coin).toBe(250);
    expect(again.body.vault.items).toHaveLength(1);
    expect(gw.ledger("guest1")).toMatchObject([
      { amount: 250, flow: "faucet", reason: "dev.grant", reasonGroup: "dev.grant" },
    ]);
    // Without opId every call grants again.
    await grant({ coin: 1 });
    await grant({ coin: 1 });
    expect(gw.balance("guest1")).toBe(252);
  });
});

describe("trade routes", () => {
  async function setup() {
    const f = fakeEnv();
    f.gw.register("alice", "Alice");
    f.gw.register("bob", "Bob");
    f.gw.register("gus", "Gus", "guest");
    const [sword] = f.gw.seed("alice", { coin: 500, items: [testItem("sword")] });
    f.gw.seed("bob", { coin: 200 });
    return {
      ...f,
      sword: sword as VaultItem,
      alice: await tokenFor("alice"),
      bob: await tokenFor("bob"),
      carol: await tokenFor("carol"),
      gus: await tokenFor("gus", "guest"),
    };
  }
  const post = (env: Env, path: string, token: string, body: unknown = {}) =>
    call(tradeRoutes, env, path, { method: "POST", token, body });

  it("runs a full trade over HTTP; replays are no-ops", async () => {
    const s = await setup();
    const opened = await post(s.env, "/api/trade", s.alice, { opId: "open-000001", with: "bob" });
    expect(opened.status).toBe(200);
    const id = (opened.body as TradeView).id;
    expect(id).toBe(await tradeIdOf("alice", "open-000001"));
    // Same opId -> same trade, no second invite.
    const replay = await post(s.env, "/api/trade", s.alice, { opId: "open-000001", with: "bob" });
    expect(replay.body.id).toBe(id);
    expect(s.gw.noticesOf("bob").notices).toHaveLength(1);

    const list = await call(tradeRoutes, s.env, "/api/trade", { token: s.bob });
    expect(list.body.trades.map((t: TradeView) => t.id)).toEqual([id]);

    expect(
      (await post(s.env, `/api/trade/${id}/offer`, s.alice, { coin: 100, uids: [s.sword.uid] }))
        .status,
    ).toBe(200);
    expect(
      (await post(s.env, `/api/trade/${id}/offer`, s.bob, { coin: 50, uids: [] })).status,
    ).toBe(200);
    const view = await call(tradeRoutes, s.env, `/api/trade/${id}`, { token: s.alice });
    expect(view.body.fees).toEqual({ a: 2, b: 1 });
    expect(
      (await post(s.env, `/api/trade/${id}/accept`, s.alice, { versions: [1, 1] })).status,
    ).toBe(200);
    const done = await post(s.env, `/api/trade/${id}/accept`, s.bob, { versions: [1, 1] });
    expect(done.body.status).toBe("done");
    expect(s.gw.balance("alice")).toBe(448);
    expect(s.gw.balance("bob")).toBe(249);
    expect(s.gw.vault("bob")).toHaveLength(1);

    const again = await post(s.env, `/api/trade/${id}/accept`, s.bob, { versions: [1, 1] });
    expect(again.status).toBe(200);
    expect(s.gw.balance("bob")).toBe(249);
    expect((await call(tradeRoutes, s.env, "/api/trade", { token: s.bob })).body.trades).toEqual(
      [],
    );
  });

  it("outsiders get 404; guests get guest_forbidden on writes; bad input is refused", async () => {
    const s = await setup();
    const opened = await post(s.env, "/api/trade", s.alice, { opId: "open-000002", with: "bob" });
    const id = opened.body.id as string;
    expect((await call(tradeRoutes, s.env, `/api/trade/${id}`, { token: s.carol })).status).toBe(
      404,
    );
    expect(
      (await post(s.env, `/api/trade/${id}/offer`, s.carol, { coin: 1, uids: [] })).status,
    ).toBe(404);
    expect(
      (await post(s.env, `/api/trade/${id}/accept`, s.carol, { versions: [0, 0] })).status,
    ).toBe(404);
    expect((await post(s.env, `/api/trade/${id}/cancel`, s.carol)).status).toBe(404);
    expect((await call(tradeRoutes, s.env, "/api/trade/tnothex", { token: s.alice })).status).toBe(
      404,
    );
    expect(
      (await call(tradeRoutes, s.env, `/api/trade/${id}/nope`, { token: s.alice, method: "POST" }))
        .status,
    ).toBe(404);

    const guest = await post(s.env, "/api/trade", s.gus, { opId: "open-000003", with: "bob" });
    expect(guest).toMatchObject({ status: 403, body: { error: { code: "guest_forbidden" } } });
    expect((await post(s.env, `/api/trade/${id}/cancel`, s.gus)).status).toBe(403);

    expect(
      (await post(s.env, "/api/trade", s.alice, { opId: "open-000004", with: "alice" })).status,
    ).toBe(400);
    expect((await post(s.env, "/api/trade", s.alice, { opId: "bad", with: "bob" })).status).toBe(
      400,
    );
    expect(
      (await post(s.env, "/api/trade", s.alice, { opId: "open-000005", with: "nobody" })).status,
    ).toBe(404);
    expect(
      await post(s.env, "/api/trade", s.alice, { opId: "open-000006", with: "gus" }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: "not_eligible" } },
    });
    expect((await call(tradeRoutes, s.env, "/api/trade", { token: "" })).status).toBe(401);
    expect((await post(s.env, `/api/trade/${id}/accept`, s.alice, { versions: "x" })).status).toBe(
      400,
    );
    expect(
      (await post(s.env, `/api/trade/${id}/accept`, s.alice, { versions: [5, 5] })).status,
    ).toBe(409);

    expect((await post(s.env, `/api/trade/${id}/cancel`, s.bob)).body.status).toBe("cancelled");
    expect((await post(s.env, `/api/trade/${id}/cancel`, s.bob)).status).toBe(200);
    expect(await tradeRoutes(ctxFor(s.env, "/api/market/x"))).toBeNull();
  });
});
