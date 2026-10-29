/**
 * ADR 0007 R2: a bank opId can never be reused, not even after the 7-day
 * prune. Through the real VerifiedHost (classic mode) with the in-memory
 * gateway (real AccountEconomy/AccountVault on node:sqlite):
 *  - layer 1: BankStore.prune keeps a permanent tombstone per opId, so the
 *    host's own conflict check and the stored replay answer work forever;
 *  - layer 2: even without the bank_op row (a row lost or pruned before the
 *    fix), the AccountDO answers "conflict" to a take whose txId was used
 *    with other parameters, and the saga never refunds a conflicting take.
 */
import { createSim, loadMode, SegmentRecorder, type Sim } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  BANK_ACTOR,
  unpackSnapshot,
  VERIFIED_ACTOR,
  type BankOp,
  type VaultItem,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  BANK_KEEP_MS,
  bankTxId,
  creditAccount,
  refundToAccount,
} from "../../src/server/instance/bank-saga.ts";
import { SqlBankStore, type BankOpRow } from "../../src/server/instance/bank-store.ts";
import type { InstanceSocket, SocketInfo } from "../../src/server/instance/host.ts";
import {
  VerifiedHost,
  type VerifiedPlatformDeps,
} from "../../src/server/instance/verified-host.ts";
import { SqlVerifiedStore } from "../../src/server/instance/verified-store.ts";
import { FakeGateway } from "../support/fake-gateway.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const loaded = loadMode(classic.mode, classic.modules);
const policy = classic.mode.instance!.clientDriven!;
const ACC = "acc1";
const NAME = `classic:${ACC}`;
const DAY = 24 * 3600 * 1000;

type Out = VerifiedServerMessage;
type VState = Extract<Out, { t: "vstate" }>;
type Resync = Extract<Out, { t: "resync" }>;
type BankAnswer = Extract<Out, { t: "bank" }>;

class Sock implements InstanceSocket {
  info: SocketInfo = { accountId: ACC, name: "Banker", mode: "classic", joined: false };
  open = true;
  out: Out[] = [];
  setInfo(info: SocketInfo): void {
    this.info = info;
  }
  send(frame: string): void {
    this.out.push(JSON.parse(frame) as Out);
  }
  close(): void {
    this.open = false;
  }
}

function setup() {
  const db = fakeSqlStore();
  const store = new SqlVerifiedStore(db);
  const bankStore = new SqlBankStore(db);
  const outbox = new Outbox(db.sql, `instance:${NAME}`);
  outbox.init();
  const gw = new FakeGateway();
  const clock = { now: 5_000_000 };
  const sockets: Sock[] = [];
  const logs: { level: string; message: string }[] = [];
  const platform: VerifiedPlatformDeps = {
    store: bankStore,
    account: gw,
    bankEnabled: async () => true,
    vaultCount: async (id) => gw.vault(id).length,
    scheduleRedrive: () => {},
  };
  const host = new VerifiedHost({
    name: NAME,
    loaded,
    policy,
    store,
    sockets: () => sockets.filter((s) => s.open),
    now: () => clock.now,
    randomSeed: () => 0x5eed,
    outbox,
    scheduleFlush: () => {},
    log: (level, message) => logs.push({ level, message }),
    platform,
  });
  return {
    db,
    host,
    clock,
    bankStore,
    gw,
    logs,
    connect(): Sock {
      const s = new Sock();
      sockets.push(s);
      return s;
    },
    async send(s: Sock, msg: VerifiedClientMessage): Promise<Out[]> {
      await host.handleMessage(s, JSON.stringify(msg));
      const out = s.out;
      s.out = [];
      return out;
    },
  };
}

type Env = ReturnType<typeof setup>;

class Client {
  sim!: Sim;
  rec!: SegmentRecorder;
  epoch = 0;
  seq = 0;
  constructor(
    readonly env: Env,
    readonly sock: Sock,
  ) {}

  async adopt(m: VState | Resync): Promise<void> {
    this.epoch = m.epoch;
    if (m.snapshot)
      this.sim = createSim(loaded, { seed: 0, from: await unpackSnapshot(m.snapshot) });
    this.rec = new SegmentRecorder(this.sim.tick);
  }

  act(name: string, payload: unknown): void {
    const res = this.sim.dispatch(name, payload, VERIFIED_ACTOR);
    expect(res.ok, `${name}: ${res.error?.code}`).toBe(true);
    this.rec.record(this.sim.tick, name, payload);
  }

  async play(ticks: number): Promise<void> {
    this.env.clock.now += ticks * 50;
    this.sim.step(ticks);
    const seg = this.rec.cut(this.sim)!;
    const out = await this.env.send(this.sock, {
      t: "segment",
      epoch: this.epoch,
      seq: ++this.seq,
      ...seg,
    });
    // A segment after a long silence on a live socket (eight days of prune
    // wait) pays the absence right after its ack (offline-idle.md §5.6).
    const offline = out.find((m): m is Resync => m.t === "resync" && m.code === "offline");
    if (offline) await this.adopt(offline);
    expect(out.map((m) => m.t)).toEqual(offline ? ["verified", "resync"] : ["verified"]);
  }

  async bank(op: BankOp, opId: string): Promise<BankAnswer> {
    const out = await this.env.send(this.sock, {
      t: "bank",
      opId,
      op,
      at: { tick: this.sim.tick, hash: this.sim.hash() },
    });
    for (const m of out) if (m.t === "resync") await this.adopt(m);
    const answer = out.find((m): m is BankAnswer => m.t === "bank");
    expect(answer, JSON.stringify(out).slice(0, 400)).toBeDefined();
    if (answer!.applied) {
      const res = this.sim.dispatch(answer!.applied.name, answer!.applied.payload, BANK_ACTOR);
      expect(res.ok, JSON.stringify(res.error)).toBe(true);
      expect(this.sim.hash()).toBe(answer!.applied.hash);
    }
    return answer!;
  }

  gold(): number {
    return this.sim.world.get(classic.heroOf(this.sim.world), classic.Wallet)!.gold;
  }

  bag(): string[] {
    return this.sim.world
      .get(classic.heroOf(this.sim.world), classic.Inventory)!
      .items.map((e) => `${e.item.base}#${e.item.uid}`);
  }
}

async function joined(env: Env): Promise<Client> {
  const sock = env.connect();
  const c = new Client(env, sock);
  const out = await env.send(sock, { t: "join", token: "t", mode: "classic" });
  await c.adopt(out[0] as VState);
  c.act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Banker" });
  await c.play(20);
  return c;
}

/**
 * Two real classic items in the vault: the hero's weapon (deposited) and a
 * second vault row with the same item (seeded), so either can be withdrawn.
 */
async function twoVaultItems(env: Env, c: Client): Promise<[VaultItem, VaultItem]> {
  c.act(classic.ACTION.unequip, { slot: "weapon" });
  await c.play(5);
  const ref = c.sim.world.get(classic.heroOf(c.sim.world), classic.Inventory)!.items[0]!.item.uid;
  const dep = await c.bank({ kind: "depositItem", ref }, "op_dep_item_0001");
  expect(dep.result.ok).toBe(true);
  await c.play(5);
  const [a] = env.gw.vault(ACC) as [VaultItem];
  const { uid: _uid, ...input } = a;
  const [b] = env.gw.seed(ACC, { items: [input] }) as [VaultItem];
  return [a, b];
}

/** Eight days pass, then an unrelated op runs the prune. */
async function afterPrune(env: Env, c: Client): Promise<void> {
  env.clock.now += BANK_KEEP_MS + DAY;
  const dep = await c.bank({ kind: "depositGold", gold: 2 }, "op_trigger_prune");
  expect(dep.result.ok).toBe(true);
}

/** Wallet tx rows the account applied for a bank txId suffix (":refund", ":credit"). */
function ledgerTx(env: Env, suffix: string) {
  return env.gw.ledger(ACC).filter((r) => r.txId.endsWith(suffix));
}

const OP_X = "op_reused_00001";

describe("bank opId reuse after the prune (ADR 0007 R2)", () => {
  for (const coin of [1_000_000_000, 1_000_000]) {
    it(`withdrawCoin {coin:${coin}} under a used opId: conflict, nothing minted`, async () => {
      const env = setup();
      env.gw.seed(ACC, { coin: 100 });
      const c = await joined(env);
      const first = await c.bank({ kind: "withdrawCoin", coin: 1 }, OP_X);
      expect(first.result).toMatchObject({ ok: true, coin: 1 });
      await c.play(10);
      await afterPrune(env, c);
      await c.play(10);
      const balance = env.gw.balance(ACC);
      const gold = c.gold();
      const verified = env.host.record!.verifiedHash;

      const again = await c.bank({ kind: "withdrawCoin", coin }, OP_X);
      expect(again.result).toMatchObject({ ok: false, code: "conflict" });
      expect(again.applied).toBeNull();
      expect(env.gw.balance(ACC)).toBe(balance);
      expect(c.gold()).toBe(gold);
      expect(env.host.record!.verifiedHash).toBe(verified);
      expect(ledgerTx(env, ":refund")).toEqual([]);
      // The tombstone still answers an identical retry with the first result.
      const retry = await c.bank({ kind: "withdrawCoin", coin: 1 }, OP_X);
      expect(retry.result).toEqual(first.result);
      expect(env.gw.balance(ACC)).toBe(balance);
      await c.play(10);
    });
  }

  it("withdrawItem under a used opId with another uid: conflict, no second copy", async () => {
    const env = setup();
    const c = await joined(env);
    const [a, b] = await twoVaultItems(env, c);
    const bag0 = c.bag().length;
    const first = await c.bank({ kind: "withdrawItem", uid: a.uid }, OP_X);
    expect(first.result).toMatchObject({ ok: true, item: { uid: a.uid } });
    expect(c.bag()).toHaveLength(bag0 + 1);
    await c.play(10);
    await afterPrune(env, c);
    await c.play(10);
    const bag = c.bag();

    const again = await c.bank({ kind: "withdrawItem", uid: b.uid }, OP_X);
    expect(again.result).toMatchObject({ ok: false, code: "conflict" });
    expect(again.applied).toBeNull();
    expect(c.bag()).toEqual(bag);
    expect(env.gw.vault(ACC).map((i) => i.uid)).toEqual([b.uid]);
    await c.play(10);
  });

  it("an identical retry after the prune answers the stored result and moves nothing", async () => {
    const env = setup();
    env.gw.seed(ACC, { coin: 100 });
    const c = await joined(env);
    const first = await c.bank({ kind: "withdrawCoin", coin: 30 }, OP_X);
    await c.play(10);
    await afterPrune(env, c);
    const balance = env.gw.balance(ACC);
    const gold = c.gold();
    const again = await c.bank({ kind: "withdrawCoin", coin: 30 }, OP_X);
    expect(again.result).toEqual(first.result);
    expect(env.gw.balance(ACC)).toBe(balance);
    expect(c.gold()).toBe(gold);
  });
});

describe("account layer alone (the bank_op row is gone): conflict, never refunded", () => {
  /** Simulates a row deleted by the pre-fix prune: the AccountDO tx row stays. */
  function forget(env: Env, opId: string): void {
    env.db.sql.exec("DELETE FROM bank_op WHERE op_id = ?", opId);
    expect(env.bankStore.get(opId)).toBeNull();
  }

  it("withdrawCoin: the reused take txId is a conflict; no refund, nothing credited", async () => {
    const env = setup();
    env.gw.seed(ACC, { coin: 100 });
    const c = await joined(env);
    await c.bank({ kind: "withdrawCoin", coin: 1 }, OP_X);
    await c.play(10);
    forget(env, OP_X);
    const balance = env.gw.balance(ACC);
    const gold = c.gold();
    for (const coin of [1_000_000_000, 1_000_000]) {
      const again = await c.bank({ kind: "withdrawCoin", coin }, OP_X);
      expect(again.result).toMatchObject({ ok: false, code: "conflict" });
      expect(again.applied).toBeNull();
      forget(env, OP_X);
    }
    expect(env.gw.balance(ACC)).toBe(balance);
    expect(c.gold()).toBe(gold);
    expect(ledgerTx(env, ":refund")).toEqual([]);
    expect(
      env.gw.calls.filter((k) => k.key === bankTxId(NAME, OP_X, "refund")),
      "no refund call",
    ).toEqual([]);
  });

  it("withdrawItem: the reused take txId with another uid is a conflict; no copy, no refund", async () => {
    const env = setup();
    const c = await joined(env);
    const [a, b] = await twoVaultItems(env, c);
    await c.bank({ kind: "withdrawItem", uid: a.uid }, OP_X);
    await c.play(10);
    forget(env, OP_X);
    const bag = c.bag();
    const again = await c.bank({ kind: "withdrawItem", uid: b.uid }, OP_X);
    expect(again.result).toMatchObject({ ok: false, code: "conflict" });
    expect(again.applied).toBeNull();
    expect(c.bag()).toEqual(bag);
    expect(env.gw.vault(ACC).map((i) => i.uid)).toEqual([b.uid]);
    expect(env.gw.calls.filter((k) => k.key === bankTxId(NAME, OP_X, "refund"))).toEqual([]);
  });
});

describe("SqlBankStore.prune keeps a permanent tombstone", () => {
  it("compacts old done rows (effect dropped) and keeps op, account and result", () => {
    const db = fakeSqlStore();
    const s = new SqlBankStore(db);
    const op: BankOp = { kind: "withdrawCoin", coin: 1 };
    const result = { ok: true as const, coin: 1, gold: 1, balance: 9 };
    s.put({
      opId: "old_done_000001",
      accountId: ACC,
      state: "done",
      op,
      effect: { coin: 1, gold: 1, item: null, balance: 9 },
      result,
      at: 1_000,
    });
    s.put({
      opId: "old_pending_0001",
      accountId: ACC,
      state: "crediting",
      op: { kind: "depositGold", gold: 5 },
      effect: { coin: 4, gold: 5, item: null, balance: null },
      result: null,
      at: 1_000,
    });
    s.put({
      opId: "new_done_000001",
      accountId: ACC,
      state: "done",
      op,
      effect: { coin: 1, gold: 1, item: null, balance: 9 },
      result,
      at: 9_000,
    });
    expect(s.prune(5_000)).toBe(1);
    expect(s.prune(5_000)).toBe(0);
    expect(s.get("old_done_000001")).toEqual({
      opId: "old_done_000001",
      accountId: ACC,
      state: "done",
      op,
      effect: null,
      result,
      at: 1_000,
    });
    expect(s.get("old_pending_0001")!.effect).not.toBeNull();
    expect(s.get("new_done_000001")!.effect).not.toBeNull();
    expect(s.pending().map((r) => r.opId)).toEqual(["old_pending_0001"]);
  });
});

describe("conflicting refund or credit is terminal and logged (never loops, never re-credits)", () => {
  it("host: a deposit whose credit txId is taken finishes as conflict, nothing pending", async () => {
    const env = setup();
    const c = await joined(env);
    const opId = "op_credit_taken1";
    env.gw.seed(ACC, {});
    env.gw.account(ACC).vault.walletTx({
      txId: bankTxId(NAME, opId, "credit"),
      currency: "coin",
      amount: 1,
      reason: "dev.seed",
      flow: "faucet",
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ans = await c.bank({ kind: "depositGold", gold: 20 }, opId);
      expect(ans.result).toMatchObject({ ok: false, code: "conflict" });
      // Through the host's own logger (the DO's log pipeline), not a bare console.error.
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    expect(
      env.logs.filter((l) => l.level === "error" && /NOT credited/.test(l.message)),
    ).toHaveLength(1);
    expect(env.gw.balance(ACC)).toBe(1);
    expect(env.bankStore.get(opId)).toMatchObject({ state: "done", result: { code: "conflict" } });
    expect(env.host.pendingBankOps()).toBe(0);
    expect(await env.host.redrive()).toBe(0);
    expect(env.gw.balance(ACC)).toBe(1);
  });

  it("host: a refused withdrawal whose refund txId is taken finishes, nothing pending", async () => {
    const env = setup();
    env.gw.seed(ACC, { coin: 20_000_000 });
    const c = await joined(env);
    const opId = "op_refund_taken1";
    env.gw.account(ACC).vault.walletTx({
      txId: bankTxId(NAME, opId, "refund"),
      currency: "coin",
      amount: 1,
      reason: "dev.seed",
      flow: "faucet",
    });
    const gold = c.gold();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Over the mode's per-op limit: taken, refused by the sim, then the refund conflicts.
      const ans = await c.bank({ kind: "withdrawCoin", coin: 15_000_000 }, opId);
      expect(ans.result).toMatchObject({ ok: false, code: "bad_request" });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    expect(
      env.logs.filter((l) => l.level === "error" && /NOT refunded/.test(l.message)),
    ).toHaveLength(1);
    expect(c.gold()).toBe(gold);
    expect(env.bankStore.get(opId)!.state).toBe("done");
    expect(env.host.pendingBankOps()).toBe(0);
    expect(await env.host.redrive()).toBe(0);
    // Exactly one refund-txId row exists (the pre-existing one): no second refund.
    expect(env.gw.ledger(ACC).filter((r) => r.txId.endsWith(":refund"))).toHaveLength(1);
  });

  it("host: a re-driven take whose txId holds another tx finishes as conflict, no refund", async () => {
    const env = setup();
    env.gw.seed(ACC, { coin: 100 });
    const c = await joined(env);
    const opId = "op_redrive_take1";
    // The take txId already holds a different change (an opId reused after a lost row).
    env.gw.account(ACC).vault.walletTx({
      txId: bankTxId(NAME, opId, "take"),
      currency: "coin",
      amount: 1,
      reason: "dev.seed",
      flow: "faucet",
    });
    const balance = env.gw.balance(ACC);
    // A crash left the op in "taking".
    env.bankStore.put({
      opId,
      accountId: ACC,
      state: "taking",
      op: { kind: "withdrawCoin", coin: 5 },
      effect: null,
      result: null,
      at: env.clock.now,
    });
    const gold = c.gold();
    await env.host.redrive();
    expect(env.bankStore.get(opId)).toMatchObject({
      state: "done",
      result: { ok: false, code: "conflict" },
    });
    expect(env.host.pendingBankOps()).toBe(0);
    expect(env.gw.balance(ACC)).toBe(balance);
    expect(c.gold()).toBe(gold);
    expect(env.gw.calls.filter((k) => k.key === bankTxId(NAME, opId, "refund"))).toEqual([]);
  });

  it("refundToAccount / creditAccount: conflict -> logged, no throw, nothing written", async () => {
    const gw = new FakeGateway();
    const [item] = gw.seed(ACC, {
      coin: 100,
      items: [
        {
          itemId: "test.weapon.axe",
          origin: "classic",
          count: 1,
          universal: false,
          tradable: true,
          summary: {
            name: "axe",
            rarity: "magic",
            level: 1,
            category: "weapon",
            slot: "weapon",
            icon: "item.axe",
            lines: [],
          },
          data: null,
        },
      ],
    }) as [VaultItem];
    // The refund/credit txIds of op "op_x" already hold other changes.
    const a = gw.account(ACC).vault;
    a.walletTx({
      txId: bankTxId(NAME, "op_x", "refund"),
      currency: "coin",
      amount: 3,
      reason: "r",
    });
    a.walletTx({
      txId: bankTxId(NAME, "op_x", "credit"),
      currency: "coin",
      amount: 4,
      reason: "r",
    });
    a.vaultPut(bankTxId(NAME, "op_y", "refund"), { ...item, count: 2 });
    a.vaultPut(bankTxId(NAME, "op_y", "credit"), { ...item, count: 2 });
    const before = { coin: gw.balance(ACC), vault: gw.vault(ACC) };
    const row = (opId: string, op: BankOp, effect: BankOpRow["effect"]): BankOpRow => ({
      opId,
      accountId: ACC,
      state: "refunding",
      op,
      effect,
      result: null,
      at: 0,
    });
    const logs: string[] = [];
    const log = (m: string) => void logs.push(m);
    const coinW = row(
      "op_x",
      { kind: "withdrawCoin", coin: 50 },
      {
        coin: 50,
        gold: 50,
        item: null,
        balance: 50,
      },
    );
    await expect(refundToAccount(gw, NAME, "classic", coinW, log)).resolves.toBeUndefined();
    const itemW = row(
      "op_y",
      { kind: "withdrawItem", uid: item.uid },
      {
        coin: 0,
        gold: 0,
        item,
        balance: null,
      },
    );
    await expect(refundToAccount(gw, NAME, "classic", itemW, log)).resolves.toBeUndefined();
    const coinD = row(
      "op_x",
      { kind: "depositGold", gold: 50 },
      {
        coin: 47,
        gold: 50,
        item: null,
        balance: null,
      },
    );
    expect(await creditAccount(gw, NAME, "classic", coinD, log)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    const itemD = row(
      "op_y",
      { kind: "depositItem", ref: 1 },
      {
        coin: 0,
        gold: 0,
        item: { ...item, uid: undefined } as unknown as VaultItem,
        balance: null,
      },
    );
    expect(await creditAccount(gw, NAME, "classic", itemD, log)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(logs).toHaveLength(4);
    expect({ coin: gw.balance(ACC), vault: gw.vault(ACC) }).toEqual(before);
  });
});
