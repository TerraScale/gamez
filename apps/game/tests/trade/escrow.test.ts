import { TRADE_MAX_ITEMS, TRADE_TTL_MS, VAULT_MAX_ITEMS } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import type { GatewayMethod } from "../support/fake-gateway.ts";
import { testItem } from "../support/fake-gateway.ts";
import {
  A,
  B,
  TRADE_ID,
  acceptBoth,
  conserved,
  expectOk,
  harness,
  itemKey,
  openStandard,
  seedStandard,
  settle,
} from "./harness.ts";

describe("trade: open", () => {
  it("indexes the trade on both sides, invites b, and a replay returns the same trade", async () => {
    const h = harness();
    seedStandard(h);
    const view = expectOk(await h.escrow.open({ tradeId: TRADE_ID, a: A, b: B }));
    expect(view).toMatchObject({
      id: TRADE_ID,
      a: A,
      b: B,
      status: "open",
      accepted: { a: null, b: null },
      offers: { a: { coin: 0, items: [], version: 0 }, b: { coin: 0, items: [], version: 0 } },
      expiresAt: view.createdAt + TRADE_TTL_MS,
    });
    expect(h.gw.openTrades("alice")).toEqual([TRADE_ID]);
    expect(h.gw.openTrades("bob")).toEqual([TRADE_ID]);
    expect(h.gw.noticesOf("bob").notices).toMatchObject([
      { id: `trade:${TRADE_ID}:invite`, kind: "trade.invite", data: { tradeId: TRADE_ID } },
    ]);
    expect(h.alarm.at).toBe(view.expiresAt);

    const replay = await h.escrow.open({ tradeId: TRADE_ID, a: A, b: B });
    expect(replay).toEqual({ ok: true, value: view, replayed: true });
    expect(h.gw.noticesOf("bob").notices).toHaveLength(1);
    expect(
      await h.escrow.open({ tradeId: TRADE_ID, a: A, b: { ...B, accountId: "carol" } }),
    ).toMatchObject({
      ok: false,
      code: "conflict",
    });
  });

  it("rejects self-trade and bad ids", async () => {
    const h = harness();
    expect(await h.escrow.open({ tradeId: TRADE_ID, a: A, b: A })).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    expect(await h.escrow.open({ tradeId: "x", a: A, b: B })).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    expect(h.escrow.state()).toBeNull();
  });

  it("retries the invite tasks from the alarm when an account call throws", async () => {
    const h = harness();
    seedStandard(h);
    h.gw.failNext("notify", "throw");
    expectOk(await h.escrow.open({ tradeId: TRADE_ID, a: A, b: B }));
    expect(h.gw.noticesOf("bob").notices).toEqual([]);
    expect(h.alarm.at).toBeLessThan(T0Plus(TRADE_TTL_MS));
    await h.fire();
    expect(h.gw.noticesOf("bob").notices).toHaveLength(1);
    expect(h.escrow.state()!.tasks.every((t) => t.done)).toBe(true);
    // Back to the expiry alarm.
    expect(h.alarm.at).toBe(h.escrow.state()!.expiresAt);
  });
});

function T0Plus(ms: number): number {
  return 1_700_000_000_000 + ms;
}

describe("trade: happy path", () => {
  it("swaps items and coin, charges the fee on coin sent, notifies and unlinks", async () => {
    const h = harness();
    const { a, b } = await openStandard(h);
    const before = conserved(h);
    await acceptBoth(h);
    const st = h.escrow.state()!;
    expect(st.status).toBe("done");
    expect(st.reason).toBeNull();
    // A: 1000 - 100 - fee 2 + 50 = 948; B: 500 - 50 - fee 1 + 100 = 549.
    expect(h.gw.balance("alice")).toBe(948);
    expect(h.gw.balance("bob")).toBe(549);
    expect(h.gw.vault("alice").map(itemKey)).toEqual(b.map(itemKey));
    expect(h.gw.vault("bob").map(itemKey).sort()).toEqual(a.map(itemKey).sort());
    // Moved items keep summary/data/flags.
    expect(h.gw.vault("bob")[0]).toMatchObject({ ...a[0], uid: expect.any(String) });
    expect(conserved(h)).toEqual(before);
    expect(h.gw.sunk(["alice", "bob"])).toBe(3);
    expect(h.gw.ledger("alice").map((r) => [r.txId, r.amount, r.flow, r.reasonGroup])).toEqual([
      ["seed:1", 1000, "faucet", "dev.seed"],
      [`trade:${TRADE_ID}:a:coin`, -100, "transfer", "trade"],
      [`trade:${TRADE_ID}:a:fee`, -2, "sink", "trade.fee"],
      [`trade:${TRADE_ID}:b:recv`, 50, "transfer", "trade"],
    ]);
    expect(h.gw.noticesOf("alice").notices.map((n) => n.kind)).toEqual(["trade.done"]);
    expect(h.gw.noticesOf("bob").notices.map((n) => n.kind)).toEqual([
      "trade.invite",
      "trade.done",
    ]);
    expect(h.gw.openTrades("alice")).toEqual([]);
    expect(h.gw.openTrades("bob")).toEqual([]);
    expect(h.alarm.at).toBeNull();

    // Replays after the end are no-ops.
    const v = st.accepted.a!;
    expect(await h.escrow.accept({ accountId: A.accountId, versions: v })).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(await h.escrow.accept({ accountId: B.accountId, versions: v })).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(await h.escrow.offer({ accountId: A.accountId, coin: 1, uids: [] })).toMatchObject({
      ok: false,
      code: "closed",
    });
    expect(await h.escrow.cancel(A.accountId)).toMatchObject({ ok: false, code: "closed" });
    expect(conserved(h)).toEqual(before);
    expect(h.gw.balance("alice")).toBe(948);
  });

  it("items-only trades pay no fee; one-sided gifts work", async () => {
    const h = harness();
    const { a } = seedStandard(h);
    expectOk(await h.escrow.open({ tradeId: TRADE_ID, a: A, b: B }));
    expectOk(await h.escrow.offer({ accountId: A.accountId, coin: 0, uids: [a[0]!.uid] }));
    await acceptBoth(h);
    expect(h.escrow.state()!.status).toBe("done");
    expect(h.gw.balance("alice")).toBe(1000);
    expect(h.gw.vault("bob")).toHaveLength(2);
  });
});

describe("trade: offers and accepts", () => {
  it("an offer change after A accepted forces a re-accept (version-aware)", async () => {
    const h = harness();
    const { b } = await openStandard(h);
    let st = h.escrow.state()!;
    const v1: [number, number] = [st.offers.a.version, st.offers.b.version];
    expect(v1).toEqual([1, 1]);
    expectOk(await h.escrow.accept({ accountId: A.accountId, versions: v1 }));
    expect(h.escrow.state()!.accepted).toEqual({ a: [1, 1], b: null });
    // B sweetens the deal: versions bump, A's accept is cleared.
    expectOk(await h.escrow.offer({ accountId: B.accountId, coin: 60, uids: [b[0]!.uid] }));
    st = h.escrow.state()!;
    expect(st.accepted).toEqual({ a: null, b: null });
    expect(await h.escrow.accept({ accountId: B.accountId, versions: v1 })).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expectOk(await h.escrow.accept({ accountId: B.accountId, versions: [1, 2] }));
    expect(h.escrow.state()!.status).toBe("open");
    expectOk(await h.escrow.accept({ accountId: A.accountId, versions: [1, 2] }));
    expect(h.escrow.state()!.status).toBe("done");
    expect(h.gw.balance("bob")).toBe(500 - 60 - 1 + 100);
  });

  it("an unchanged offer is a no-op (no version bump, accepts kept)", async () => {
    const h = harness();
    const { a } = await openStandard(h);
    expectOk(await h.escrow.accept({ accountId: B.accountId, versions: [1, 1] }));
    const r = await h.escrow.offer({
      accountId: A.accountId,
      coin: 100,
      uids: a.map((i) => i.uid),
    });
    expect(r).toMatchObject({ ok: true, replayed: true });
    expect(h.escrow.state()!.offers.a.version).toBe(1);
    expect(h.escrow.state()!.accepted.b).toEqual([1, 1]);
    // A replayed accept is a no-op too.
    expect(await h.escrow.accept({ accountId: B.accountId, versions: [1, 1] })).toMatchObject({
      ok: true,
      replayed: true,
    });
  });

  it("validates offers: unknown uid, not tradable, too many, duplicates, funds", async () => {
    const h = harness();
    seedStandard(h);
    const [bound] = h.gw.seed("alice", { items: [testItem("bound", { tradable: false })] });
    const many = h.gw.seed("alice", {
      items: Array.from({ length: TRADE_MAX_ITEMS + 1 }, (_, i) => testItem(`m${i}`)),
    });
    expectOk(await h.escrow.open({ tradeId: TRADE_ID, a: A, b: B }));
    const offer = (coin: number, uids: string[]) =>
      h.escrow.offer({ accountId: A.accountId, coin, uids });
    expect(await offer(0, ["v999"])).toMatchObject({ ok: false, code: "not_found" });
    expect(await offer(0, [bound!.uid])).toMatchObject({ ok: false, code: "not_tradable" });
    expect(
      await offer(
        0,
        many.map((i) => i.uid),
      ),
    ).toMatchObject({ ok: false, code: "too_many" });
    expect(await offer(0, [many[0]!.uid, many[0]!.uid])).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    // 1000 coin: 981 + fee 19 = 1000 fits; 990 + 19 does not.
    expect(await offer(990, [])).toMatchObject({ ok: false, code: "insufficient_funds" });
    expect(await offer(-1, [])).toMatchObject({ ok: false, code: "bad_request" });
    expect(await offer(1.5, [])).toMatchObject({ ok: false, code: "bad_request" });
    expectOk(await offer(981, []));
    expect(await h.escrow.accept({ accountId: A.accountId, versions: [0, 0] })).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(
      await h.escrow.accept({
        accountId: A.accountId,
        versions: [1] as unknown as [number, number],
      }),
    ).toMatchObject({
      ok: false,
      code: "bad_request",
    });
  });

  it("refuses to accept an empty trade", async () => {
    const h = harness();
    seedStandard(h);
    expectOk(await h.escrow.open({ tradeId: TRADE_ID, a: A, b: B }));
    expect(await h.escrow.accept({ accountId: A.accountId, versions: [0, 0] })).toMatchObject({
      ok: false,
      code: "bad_request",
    });
  });

  it("an offer racing an accept never commits a stale pair", async () => {
    const h = harness();
    const { b } = await openStandard(h);
    expectOk(await h.escrow.accept({ accountId: A.accountId, versions: [1, 1] }));
    // B's offer awaits its snapshots while B's own accept of the old pair lands.
    const [offer, accept] = await Promise.all([
      h.escrow.offer({ accountId: B.accountId, coin: 10, uids: [b[0]!.uid] }),
      h.escrow.accept({ accountId: B.accountId, versions: [1, 1] }),
    ]);
    const st = h.escrow.state()!;
    if (st.status === "done") {
      // The accept won: the offer must have been refused as busy/closed.
      expect(accept.ok).toBe(true);
      expect(offer).toMatchObject({ ok: false });
      expect(h.gw.balance("bob")).toBe(500 - 50 - 1 + 100);
    } else {
      expect(st.offers.b.coin).toBe(10);
      expect(st.accepted).toEqual({ a: null, b: null });
    }
  });
});

describe("trade: cancel, expiry, outsiders, busy", () => {
  it("either side cancels; cancel is idempotent; notices and unlink", async () => {
    const h = harness();
    await openStandard(h);
    const before = conserved(h);
    const r = expectOk(await h.escrow.cancel(B.accountId));
    expect(r).toMatchObject({ status: "cancelled", reason: "cancelled_by_b" });
    expect(await h.escrow.cancel(A.accountId)).toMatchObject({ ok: true, replayed: true });
    expect(h.gw.noticesOf("alice").notices.map((n) => n.kind)).toEqual(["trade.cancelled"]);
    expect(h.gw.openTrades("alice")).toEqual([]);
    expect(h.gw.openTrades("bob")).toEqual([]);
    expect(conserved(h)).toEqual(before);
    expect(await h.escrow.accept({ accountId: A.accountId, versions: [1, 1] })).toMatchObject({
      ok: false,
      code: "closed",
    });
  });

  it("expires from the alarm after TRADE_TTL_MS while open", async () => {
    const h = harness();
    await openStandard(h);
    expect(h.alarm.at).toBe(h.escrow.state()!.expiresAt);
    h.clock.now += TRADE_TTL_MS - 1;
    await h.escrow.alarm();
    expect(h.escrow.state()!.status).toBe("open");
    await h.fire();
    expect(h.escrow.state()).toMatchObject({ status: "cancelled", reason: "expired" });
    expect(h.gw.noticesOf("bob").notices.at(-1)).toMatchObject({ kind: "trade.cancelled" });
    expect(h.gw.openTrades("bob")).toEqual([]);
    expect(await h.escrow.offer({ accountId: A.accountId, coin: 1, uids: [] })).toMatchObject({
      ok: false,
      code: "expired",
    });
  });

  it("expires lazily when touched after the deadline", async () => {
    const h = harness();
    await openStandard(h);
    h.clock.now += TRADE_TTL_MS;
    expect(await h.escrow.view(A.accountId)).toMatchObject({
      status: "cancelled",
      reason: "expired",
    });
  });

  it("outsiders see nothing and can do nothing", async () => {
    const h = harness();
    await openStandard(h);
    expect(await h.escrow.view("carol")).toBeNull();
    expect(await h.escrow.offer({ accountId: "carol", coin: 0, uids: [] })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await h.escrow.accept({ accountId: "carol", versions: [1, 1] })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await h.escrow.cancel("carol")).toMatchObject({ ok: false, code: "not_found" });
    expect(await harness().escrow.view("alice")).toBeNull();
  });

  it("answers busy while committing", async () => {
    const h = harness();
    await openStandard(h);
    h.gw.failNext("vaultTake", "throw");
    await acceptBoth(h);
    expect(h.escrow.state()!.status).toBe("committing");
    expect(await h.escrow.offer({ accountId: A.accountId, coin: 1, uids: [] })).toMatchObject({
      ok: false,
      code: "busy",
    });
    expect(await h.escrow.accept({ accountId: A.accountId, versions: [9, 9] })).toMatchObject({
      ok: false,
      code: "busy",
    });
    expect(await h.escrow.cancel(B.accountId)).toMatchObject({ ok: false, code: "busy" });
    expect((await h.escrow.view(A.accountId))!.reason).toMatch(/^pending: /);
    expect((await settle(h)).status).toBe("done");
  });
});

// ---- failure injection ------------------------------------------------------

const CUSTODY: [GatewayMethod, string][] = [
  ["walletTx", `trade:${TRADE_ID}:a:coin`],
  ["walletTx", `trade:${TRADE_ID}:a:fee`],
  ["vaultTake", `trade:${TRADE_ID}:a:take:v1`],
  ["vaultTake", `trade:${TRADE_ID}:a:take:v2`],
  ["walletTx", `trade:${TRADE_ID}:b:coin`],
  ["walletTx", `trade:${TRADE_ID}:b:fee`],
  ["vaultTake", `trade:${TRADE_ID}:b:take:v1`],
];
const DELIVERY: [GatewayMethod, string][] = [
  ["vaultPut", `trade:${TRADE_ID}:a:give:v1`],
  ["vaultPut", `trade:${TRADE_ID}:a:give:v2`],
  ["vaultPut", `trade:${TRADE_ID}:b:give:v1`],
  ["walletTx", `trade:${TRADE_ID}:a:recv`],
  ["walletTx", `trade:${TRADE_ID}:b:recv`],
];
const codeFor = (m: GatewayMethod) =>
  m === "walletTx" ? "insufficient_funds" : m === "vaultTake" ? "not_found" : "vault_full";

describe("trade: injected failures conserve coin and items", () => {
  it("the saga's step list is what the tests inject into", async () => {
    const h = harness();
    await openStandard(h);
    await acceptBoth(h);
    const keys = h.gw.calls
      .filter((c) => c.method !== "notify" && c.method !== "linkTrade")
      .filter((c) => c.key?.startsWith(`trade:${TRADE_ID}:`))
      .map((c) => [c.method, c.key]);
    expect(keys).toEqual([...CUSTODY, ...DELIVERY]);
  });

  for (const [method, txId] of CUSTODY) {
    it(`custody failure at ${txId.split(":").slice(2).join(":")} refunds everything -> failed`, async () => {
      const h = harness();
      const { a, b } = await openStandard(h);
      const before = conserved(h);
      h.gw.failNext(method, { code: codeFor(method) }, { txId });
      await acceptBoth(h);
      const st = h.escrow.state()!;
      expect(st.status).toBe("failed");
      expect(st.reason).toBe(codeFor(method));
      expect(conserved(h)).toEqual(before);
      // Everyone is back where they started (items may have new uids).
      expect(h.gw.balance("alice")).toBe(1000);
      expect(h.gw.balance("bob")).toBe(500);
      expect(h.gw.vault("alice").map(itemKey).sort()).toEqual(a.map(itemKey).sort());
      expect(h.gw.vault("bob").map(itemKey)).toEqual(b.map(itemKey));
      expect(h.gw.sunk(["alice", "bob"])).toBe(0);
      expect(h.gw.noticesOf("alice").notices.at(-1)).toMatchObject({ kind: "trade.cancelled" });
      expect(h.gw.openTrades("alice")).toEqual([]);
      // Replaying the accepts changes nothing.
      await acceptBoth(h);
      expect(conserved(h)).toEqual(before);
      expect(h.gw.balance("alice")).toBe(1000);
    });
  }

  const crashes = ["throw", "throwAfter"] as const;
  for (const mode of crashes) {
    for (const [method, txId] of [...CUSTODY, ...DELIVERY]) {
      it(`crash (${mode}) at ${txId.split(":").slice(2).join(":")} re-drives from the alarm -> done`, async () => {
        const h = harness();
        await openStandard(h);
        const before = conserved(h);
        h.gw.failNext(method, mode, { txId });
        await acceptBoth(h);
        expect(h.escrow.state()!.status).toBe("committing");
        // "throwAfter": the call applied but its reply was lost, so the value is
        // in flight until the re-drive replays the call; "throw": nothing moved.
        if (mode === "throw") expect(conserved(h)).toEqual(before);
        expect(h.alarm.at).not.toBeNull();
        // The DO is evicted; a fresh instance re-drives from storage.
        h.restart();
        const st = await settle(h);
        expect(st.status).toBe("done");
        expect(conserved(h)).toEqual(before);
        expect(h.gw.balance("alice")).toBe(948);
        expect(h.gw.balance("bob")).toBe(549);
        expect(h.gw.vault("alice")).toHaveLength(1);
        expect(h.gw.vault("bob")).toHaveLength(2);
        expect(h.gw.sunk(["alice", "bob"])).toBe(3);
      });
    }
  }

  for (const [method, txId] of DELIVERY) {
    it(`delivery failure at ${txId.split(":").slice(2).join(":")} keeps custody and retries -> done`, async () => {
      const h = harness();
      await openStandard(h);
      const before = conserved(h);
      h.gw.failNext(method, { code: codeFor(method) }, { txId });
      await acceptBoth(h);
      const st = h.escrow.state()!;
      expect(st.status).toBe("committing");
      expect(st.blocked).toMatch(new RegExp(codeFor(method)));
      expect(conserved(h)).toEqual(before);
      expect((await settle(h)).status).toBe("done");
      expect(conserved(h)).toEqual(before);
      expect(h.gw.balance("alice")).toBe(948);
    });
  }

  it("a compensation step that fails (vault_full) is retried until the item is back", async () => {
    const h = harness();
    await openStandard(h);
    const before = conserved(h);
    // B's coin custody fails after A's coin, fee and items were taken.
    h.gw.failNext("walletTx", { code: "insufficient_funds" }, { txId: `trade:${TRADE_ID}:b:coin` });
    h.gw.failNext("vaultPut", { code: "vault_full" }, { txId: `trade:${TRADE_ID}:a:return:v2` });
    h.gw.failNext("walletTx", "throwAfter", { txId: `trade:${TRADE_ID}:a:refund` });
    await acceptBoth(h);
    expect(h.escrow.state()!.status).toBe("committing");
    expect(conserved(h)).toEqual(before);
    h.restart();
    const st = await settle(h);
    expect(st).toMatchObject({ status: "failed", reason: "insufficient_funds" });
    expect(conserved(h)).toEqual(before);
    expect(h.gw.balance("alice")).toBe(1000);
    expect(h.gw.vault("alice")).toHaveLength(2);
  });

  it("a delivery into a really full vault is listed as waiting, notifies once, and lands after a take", async () => {
    const h = harness();
    await openStandard(h);
    const fill = Array.from({ length: VAULT_MAX_ITEMS - 1 }, (_, i) => testItem(`junk${i}`));
    h.gw.seed("bob", { items: fill });
    await acceptBoth(h);
    // Custody took the shield (one slot), the sword landed, the ring waits.
    expect(h.escrow.state()!.status).toBe("committing");
    expect(h.gw.account("bob").vault.waiting()).toMatchObject({ count: 1 });
    const full = h.gw.noticesOf("bob").notices.filter((n) => n.kind === "vault.full");
    expect(full).toHaveLength(1);
    await h.fire();
    expect(h.gw.noticesOf("bob").notices.filter((n) => n.kind === "vault.full")).toHaveLength(1);
    const junk = h.gw.vault("bob").find((i) => i.itemId.includes("junk0"))!;
    h.gw.account("bob").vault.vaultTake("free-a-slot", junk.uid);
    expect((await settle(h)).status).toBe("done");
    expect(h.gw.account("bob").vault.waiting()).toEqual({ count: 0, since: null });
  });

  it("backs off between retries", async () => {
    const h = harness();
    await openStandard(h);
    for (let i = 0; i < 3; i++) h.gw.failNext("vaultPut", { code: "vault_full" });
    await acceptBoth(h);
    const t1 = h.alarm.at! - h.clock.now;
    await h.fire();
    const t2 = h.alarm.at! - h.clock.now;
    await h.fire();
    const t3 = h.alarm.at! - h.clock.now;
    expect([t1, t2, t3]).toEqual([5_000, 10_000, 20_000]);
    expect((await settle(h)).status).toBe("done");
  });

  it("a real shortage at commit time (coin spent after the offer) fails cleanly", async () => {
    const h = harness();
    await openStandard(h);
    const before = conserved(h);
    // Bob spends his coin elsewhere between offer and accept.
    await h.gw.walletTx("bob", {
      txId: "elsewhere",
      currency: "coin",
      amount: -480,
      reason: "shop:buy",
    });
    await acceptBoth(h);
    expect(h.escrow.state()).toMatchObject({ status: "failed", reason: "insufficient_funds" });
    expect(h.gw.balance("alice")).toBe(1000);
    expect(conserved(h).items).toEqual(before.items);
  });

  it("an item that left the vault after the offer fails cleanly", async () => {
    const h = harness();
    const { b } = await openStandard(h);
    await h.gw.vaultTake("bob", "bank:withdraw", b[0]!.uid);
    await acceptBoth(h);
    expect(h.escrow.state()).toMatchObject({ status: "failed", reason: "not_found" });
    expect(h.gw.balance("alice")).toBe(1000);
    expect(h.gw.balance("bob")).toBe(500);
    expect(h.gw.vault("alice")).toHaveLength(2);
  });
});
