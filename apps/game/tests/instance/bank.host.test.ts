/**
 * VerifiedHost bank saga (docs/design/wave-C.md §2.4) with the real classic
 * mode, fake sockets, a fake clock, the node:sqlite stores and the in-memory
 * account gateway (real AccountDO vault/wallet logic, failure injection):
 * honest deposits and withdrawals, fast vs slow path, idempotent retries,
 * crash recovery by re-drive, refunds, origin rules, the flag, the rate
 * limit, server-only enforcement, arena build export and season reports.
 */
import {
  createSim,
  loadMode,
  SegmentRecorder,
  type ClientDrivenPolicy,
  type Sim,
} from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  BANK_ACTOR,
  unpackSnapshot,
  VERIFIED_ACTOR,
  type BankOp,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import { describe, expect, it } from "vite-plus/test";
import type { InstanceSocket, SocketInfo } from "../../src/server/instance/host.ts";
import { bankTxId, SEASON_KV } from "../../src/server/instance/bank-saga.ts";
import { SqlBankStore } from "../../src/server/instance/bank-store.ts";
import {
  accountOfInstance,
  VerifiedHost,
  type VerifiedPlatformDeps,
} from "../../src/server/instance/verified-host.ts";
import { parseVerifiedClientMessage } from "../../src/server/instance/verified-messages.ts";
import { SqlVerifiedStore } from "../../src/server/instance/verified-store.ts";
import { FakeGateway, testItem } from "../support/fake-gateway.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const loaded = loadMode(classic.mode, classic.modules);
const basePolicy = classic.mode.instance!.clientDriven!;
const ACC = "acc1";
const NAME = `classic:${ACC}`;

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

interface SetupOptions {
  policy?: ClientDrivenPolicy;
  flag?: () => boolean;
  season?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const db = fakeSqlStore();
  const store = new SqlVerifiedStore(db);
  const bankStore = new SqlBankStore(db);
  const outbox = new Outbox(db.sql, `instance:${NAME}`);
  outbox.init();
  const gw = new FakeGateway();
  const clock = { now: 5_000_000 };
  const sockets: Sock[] = [];
  const redrives = { n: 0 };
  const seasonCalls: { accountId: string; key: string; total: number }[] = [];
  const season = { fail: false };
  const platform: VerifiedPlatformDeps = {
    store: bankStore,
    account: gw,
    bankEnabled: async () => opts.flag?.() ?? true,
    vaultCount: async (id) => gw.vault(id).length,
    scheduleRedrive: () => {
      redrives.n++;
    },
    ...(opts.season
      ? {
          seasonProgress: async (accountId: string, key: string, total: number) => {
            if (season.fail) throw new Error("account down");
            seasonCalls.push({ accountId, key, total });
            return null;
          },
        }
      : {}),
  };
  const make = () =>
    new VerifiedHost({
      name: NAME,
      loaded,
      policy: opts.policy ?? basePolicy,
      store,
      sockets: () => sockets.filter((s) => s.open),
      now: () => clock.now,
      randomSeed: () => 0x5eed,
      outbox,
      scheduleFlush: () => {},
      log: () => {},
      platform,
    });
  const env = { host: make(), clock, store, bankStore, gw, sockets, redrives, seasonCalls, season };
  return {
    ...env,
    /** A DO restart: new host on the same storage. */
    restart() {
      env.host = make();
    },
    connect(): Sock {
      const s = new Sock();
      sockets.push(s);
      return s;
    },
    async send(s: Sock, msg: VerifiedClientMessage): Promise<Out[]> {
      await env.host.handleMessage(s, JSON.stringify(msg));
      const out = s.out;
      s.out = [];
      return out;
    },
  };
}

type Env = ReturnType<typeof setup>;

/** A browser-like client: local sim, recorder, epoch, bank replay outside the recorder. */
class Client {
  sim!: Sim;
  rec!: SegmentRecorder;
  epoch = 0;
  seq = 0;
  ops = 0;
  constructor(
    readonly env: Env,
    readonly sock: Sock,
  ) {}

  async adopt(m: VState | Resync): Promise<void> {
    this.epoch = m.epoch;
    if (m.snapshot) {
      this.sim = createSim(loaded, { seed: 0, from: await unpackSnapshot(m.snapshot) });
    }
    this.rec = new SegmentRecorder(this.sim.tick);
  }

  act(name: string, payload: unknown): void {
    const res = this.sim.dispatch(name, payload, VERIFIED_ACTOR);
    expect(res.ok, `${name}: ${res.error?.code}`).toBe(true);
    this.rec.record(this.sim.tick, name, payload);
  }

  /** Steps, cuts and submits a segment; expects the ack. */
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
    expect(out.map((m) => m.t)).toEqual(["verified"]);
  }

  /** Sends a bank op at the local state and applies the answer like ServerSync does. */
  async bank(op: BankOp, opId = this.nextOpId()): Promise<{ out: Out[]; answer: BankAnswer }> {
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
      expect(answer!.applied.tick).toBe(this.sim.tick);
      const res = this.sim.dispatch(answer!.applied.name, answer!.applied.payload, BANK_ACTOR);
      expect(res.ok, JSON.stringify(res.error)).toBe(true);
      expect(this.sim.hash()).toBe(answer!.applied.hash);
    }
    return { out, answer: answer! };
  }

  nextOpId(): string {
    return `op_client_${String(++this.ops).padStart(4, "0")}`;
  }

  gold(): number {
    return this.sim.world.get(classic.heroOf(this.sim.world), classic.Wallet)!.gold;
  }

  bagUids(): number[] {
    return this.sim.world
      .get(classic.heroOf(this.sim.world), classic.Inventory)!
      .items.map((e) => e.item.uid);
  }
}

/** Joins, creates a warrior (manual control: it stays in town) and verifies one segment. */
async function joined(env: Env): Promise<Client> {
  const sock = env.connect();
  const c = new Client(env, sock);
  const out = await env.send(sock, { t: "join", token: "t", mode: "classic" });
  await c.adopt(out[0] as VState);
  c.act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Banker" });
  await c.play(20);
  return c;
}

describe("bank message parsing", () => {
  it("accepts well-formed bank frames and rejects the rest", () => {
    const ok = {
      t: "bank",
      opId: "op_parse_0001",
      op: { kind: "depositGold", gold: 5 },
      at: { tick: 3, hash: "abc" },
    };
    expect(parseVerifiedClientMessage(JSON.stringify(ok))).toEqual(ok);
    const bad = [
      { ...ok, opId: "short" },
      { ...ok, op: { kind: "depositGold", gold: 0 } },
      { ...ok, op: { kind: "depositGold", gold: 2.5 } },
      { ...ok, op: { kind: "withdrawItem", uid: "" } },
      { ...ok, op: { kind: "rob" } },
      { ...ok, at: { tick: -1, hash: "abc" } },
      { ...ok, at: null },
    ];
    for (const b of bad) expect(parseVerifiedClientMessage(JSON.stringify(b))).toBeNull();
  });
});

describe("VerifiedHost bank: honest ops (fast path)", () => {
  it("deposits gold: hero loses gold, account gains gold minus 5 %", async () => {
    const env = setup();
    const c = await joined(env);
    expect(c.gold()).toBe(50);
    const { out, answer } = await c.bank({ kind: "depositGold", gold: 40 });
    expect(out.map((m) => m.t)).toEqual(["bank"]);
    expect(answer.result).toEqual({ ok: true, coin: 38, gold: 40, balance: 38 });
    expect(answer.applied).not.toBeNull();
    expect(c.gold()).toBe(10);
    expect(env.gw.balance(ACC)).toBe(38);
    expect(env.host.record!.verifiedHash).toBe(c.sim.hash());
    // The ledger tags the deposit as a faucet.
    const ledger = env.gw.ledger(ACC);
    expect(ledger.at(-1)).toMatchObject({ amount: 38, flow: "faucet" });
    expect(ledger.at(-1)!.reason).toMatch(/^bank\.deposit/);
    // Play continues from the new verified state.
    await c.play(40);
  });

  it("withdraws coin: account debited first (sink), hero gains gold", async () => {
    const env = setup();
    env.gw.seed(ACC, { coin: 100 });
    const c = await joined(env);
    const { answer } = await c.bank({ kind: "withdrawCoin", coin: 30 });
    expect(answer.result).toEqual({ ok: true, coin: 30, gold: 30, balance: 70 });
    expect(c.gold()).toBe(80);
    expect(env.gw.balance(ACC)).toBe(70);
    expect(env.gw.ledger(ACC).at(-1)).toMatchObject({ amount: -30, flow: "sink" });
    await c.play(40);
  });

  it("deposits an item into the vault and withdraws it back", async () => {
    const env = setup();
    const c = await joined(env);
    c.act(classic.ACTION.unequip, { slot: "weapon" });
    await c.play(5);
    const ref = c.bagUids()[0]!;
    const dep = await c.bank({ kind: "depositItem", ref });
    expect(dep.answer.result.ok).toBe(true);
    expect(c.bagUids()).not.toContain(ref);
    const vault = env.gw.vault(ACC);
    expect(vault).toHaveLength(1);
    expect(vault[0]).toMatchObject({ origin: "classic", universal: false, tradable: true });
    if (dep.answer.result.ok) expect(dep.answer.result.item?.uid).toBe(vault[0]!.uid);
    await c.play(10);

    const wd = await c.bank({ kind: "withdrawItem", uid: vault[0]!.uid });
    expect(wd.answer.result).toMatchObject({ ok: true, item: { uid: vault[0]!.uid } });
    expect(env.gw.vault(ACC)).toHaveLength(0);
    expect(c.bagUids()).toHaveLength(1);
    await c.play(10);
    // The restarted host restores the same verified state.
    const hash = env.host.record!.verifiedHash;
    env.restart();
    const sock = env.connect();
    const out = await env.send(sock, {
      t: "join",
      token: "t",
      mode: "classic",
      resume: { tick: c.sim.tick, hash: c.sim.hash(), pending: false },
    });
    expect((out[0] as VState).continued).toBe(true);
    expect(env.host.record!.verifiedHash).toBe(hash);
  });
});

describe("VerifiedHost bank: slow path, retries, failures", () => {
  it("slow path: the client moved past the verified tick -> resync bank, then applied null", async () => {
    const env = setup();
    const c = await joined(env);
    c.sim.step(30); // unsent local play
    const { out, answer } = await c.bank({ kind: "depositGold", gold: 20 });
    expect(out.map((m) => m.t)).toEqual(["resync", "bank"]);
    expect((out[0] as Resync).code).toBe("bank");
    expect(answer.applied).toBeNull();
    expect(answer.result).toMatchObject({ ok: true, coin: 19 });
    expect(c.gold()).toBe(30); // adopted from the resync snapshot
    expect(c.sim.hash()).toBe(env.host.record!.verifiedHash);
    await c.play(20);
  });

  it("a replayed opId answers the stored result and moves nothing twice", async () => {
    const env = setup();
    const c = await joined(env);
    const first = await c.bank({ kind: "depositGold", gold: 20 }, "op_replay_0001");
    // The answer was lost: the client retries from its pre-op state.
    const out = await env.send(c.sock, {
      t: "bank",
      opId: "op_replay_0001",
      op: { kind: "depositGold", gold: 20 },
      at: { tick: c.sim.tick, hash: c.sim.hash() },
    });
    const again = out.find((m): m is BankAnswer => m.t === "bank")!;
    expect(again.result).toEqual(first.answer.result);
    expect(again.applied).toBeNull();
    expect(env.gw.balance(ACC)).toBe(19);
    expect(c.gold()).toBe(30);
    // Same id for another op: conflict.
    const out2 = await env.send(c.sock, {
      t: "bank",
      opId: "op_replay_0001",
      op: { kind: "depositGold", gold: 5 },
      at: { tick: c.sim.tick, hash: c.sim.hash() },
    });
    expect(out2.at(-1)).toMatchObject({ t: "bank", result: { ok: false, code: "conflict" } });
  });

  it("retry after a lost answer resyncs the client that lacks the change", async () => {
    const env = setup();
    const c = await joined(env);
    const before = { tick: c.sim.tick, hash: c.sim.hash() };
    await env.send(c.sock, {
      t: "bank",
      opId: "op_lost_00001",
      op: { kind: "depositGold", gold: 20 },
      at: before,
    }); // answer dropped: the client never applies it
    const out = await env.send(c.sock, {
      t: "bank",
      opId: "op_lost_00001",
      op: { kind: "depositGold", gold: 20 },
      at: before,
    });
    expect(out.map((m) => m.t)).toEqual(["resync", "bank"]);
    await c.adopt(out[0] as Resync);
    expect(c.gold()).toBe(30);
    expect(env.gw.balance(ACC)).toBe(19);
  });

  it("crash between the sim commit and the credit: the alarm re-drive credits once", async () => {
    const env = setup();
    const c = await joined(env);
    env.gw.failNext("walletTx", "throw", { txId: /:credit$/ });
    const { answer } = await c.bank({ kind: "depositGold", gold: 40 }, "op_crash_00001");
    // The hero side is committed: the client applies it; the account side is pending.
    expect(answer.applied).not.toBeNull();
    expect(answer.result.ok).toBe(true);
    expect(env.gw.balance(ACC)).toBe(0);
    expect(env.redrives.n).toBeGreaterThan(0);
    expect(env.bankStore.get("op_crash_00001")!.state).toBe("crediting");
    env.restart();
    expect(env.host.pendingBankOps()).toBe(1);
    expect(await env.host.redrive()).toBe(0);
    expect(env.gw.balance(ACC)).toBe(38);
    expect(await env.host.redrive()).toBe(0);
    expect(env.gw.balance(ACC)).toBe(38);
    const row = env.bankStore.get("op_crash_00001")!;
    expect(row.state).toBe("done");
    expect(row.result).toEqual({ ok: true, coin: 38, gold: 40, balance: 38 });
    // The restarted host still has the committed hero state.
    const sock = env.connect();
    const out = await env.send(sock, {
      t: "join",
      token: "t",
      mode: "classic",
      resume: { tick: c.sim.tick, hash: c.sim.hash(), pending: false },
    });
    expect((out[0] as VState).continued).toBe(true);
  });

  it("an unknown take outcome is re-driven: replayed and refunded (coin conserved)", async () => {
    const env = setup();
    env.gw.seed(ACC, { coin: 100 });
    const c = await joined(env);
    const hash = c.sim.hash();
    env.gw.failNext("walletTx", "throwAfter", { txId: /:take$/ });
    const { answer } = await c.bank({ kind: "withdrawCoin", coin: 30 }, "op_take_00001");
    expect(answer.result).toMatchObject({ ok: false, code: "unavailable" });
    expect(answer.applied).toBeNull();
    expect(c.sim.hash()).toBe(hash);
    expect(env.gw.balance(ACC)).toBe(70);
    expect(await env.host.redrive()).toBe(0);
    expect(env.gw.balance(ACC)).toBe(100);
    expect(env.bankStore.get("op_take_00001")!.result).toMatchObject({ code: "unavailable" });
    expect(env.host.record!.verifiedHash).toBe(hash);
  });

  it("withdrawItem into a full bag fails and refunds the vault", async () => {
    const env = setup();
    const c = await joined(env);
    c.act(classic.ACTION.unequip, { slot: "weapon" });
    await c.play(5);
    await c.bank({ kind: "depositItem", ref: c.bagUids()[0]! });
    const uid = env.gw.vault(ACC)[0]!.uid;
    // Fill the bag on both sims identically (test-only state edit).
    for (const sim of [c.sim, env.host.sim!]) {
      const hero = classic.heroOf(sim.world);
      const inv = sim.world.get(hero, classic.Inventory)!;
      const items = [];
      let n = 90_000;
      for (let y = 0; y < inv.rows; y++) {
        for (let x = 0; x < inv.cols; x++) {
          items.push({
            item: {
              uid: n++,
              base: "classic.item.potion_life_1",
              rarity: "normal" as const,
              ilvl: 1,
              name: "Potion",
              mods: [],
              affixes: [],
              value: 1,
            },
            x,
            y,
          });
        }
      }
      sim.world.update(hero, classic.Inventory, { items });
    }
    const { answer } = await c.bank({ kind: "withdrawItem", uid });
    expect(answer.result).toMatchObject({ ok: false, code: "no_room" });
    expect(answer.applied).toBeNull();
    const vault = env.gw.vault(ACC);
    expect(vault).toHaveLength(1);
    expect(vault[0]!.origin).toBe("classic");
    expect(env.bankStore.get("op_client_0002")!.state).toBe("done");
  });

  it("refuses vault items of another mode (wrong_origin) without taking them", async () => {
    const env = setup();
    const [item] = env.gw.seed(ACC, { items: [testItem("blade", { origin: "duel" })] });
    const c = await joined(env);
    const { answer } = await c.bank({ kind: "withdrawItem", uid: item!.uid });
    expect(answer.result).toMatchObject({ ok: false, code: "wrong_origin" });
    expect(env.gw.vault(ACC)).toHaveLength(1);
  });

  it("refuses a classic-origin item whose data does not decode, and refunds it", async () => {
    const env = setup();
    const [item] = env.gw.seed(ACC, { items: [testItem("fake")] });
    const c = await joined(env);
    const hash = c.sim.hash();
    const { answer } = await c.bank({ kind: "withdrawItem", uid: item!.uid });
    expect(answer.result).toMatchObject({ ok: false, code: "bad_request" });
    expect(env.gw.vault(ACC)).toHaveLength(1);
    expect(env.host.record!.verifiedHash).toBe(hash);
  });

  it("insufficient coin, unknown items and game rules map to wire codes", async () => {
    const env = setup();
    const c = await joined(env);
    const hash = c.sim.hash();
    expect((await c.bank({ kind: "withdrawCoin", coin: 5 })).answer.result).toMatchObject({
      ok: false,
      code: "insufficient_funds",
    });
    expect((await c.bank({ kind: "depositGold", gold: 999 })).answer.result).toMatchObject({
      ok: false,
      code: "insufficient_funds",
    });
    expect((await c.bank({ kind: "depositItem", ref: 4242 })).answer.result).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect((await c.bank({ kind: "withdrawItem", uid: "nope_0001" })).answer.result).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(env.host.record!.verifiedHash).toBe(hash);
  });

  it("flag off -> disabled", async () => {
    let on = true;
    const env = setup({ flag: () => on });
    const c = await joined(env);
    on = false;
    const { answer } = await c.bank({ kind: "depositGold", gold: 20 });
    expect(answer.result).toMatchObject({ ok: false, code: "disabled" });
    expect(c.gold()).toBe(50);
  });

  it("rate limit: burst 5 per socket", async () => {
    const env = setup();
    const c = await joined(env);
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const { answer } = await c.bank({ kind: "withdrawCoin", coin: 5 });
      codes.push(answer.result.ok ? "ok" : answer.result.code);
    }
    expect(codes.slice(0, 5)).toEqual(Array(5).fill("insufficient_funds"));
    expect(codes.slice(5)).toEqual(["rate_limited", "rate_limited"]);
    env.clock.now += 2000;
    const { answer } = await c.bank({ kind: "withdrawCoin", coin: 5 });
    expect(answer.result).toMatchObject({ code: "insufficient_funds" });
  });

  it("needs a joined socket", async () => {
    const env = setup();
    await joined(env);
    const stranger = env.connect();
    const out = await env.send(stranger, {
      t: "bank",
      opId: "op_strange_01",
      op: { kind: "depositGold", gold: 5 },
      at: { tick: 0, hash: "x" },
    });
    expect(out).toEqual([
      {
        t: "bank",
        opId: "op_strange_01",
        result: { ok: false, code: "unavailable", message: "join first" },
        applied: null,
      },
    ]);
  });

  it("a segment containing classic.bank is refused (server_only_action)", async () => {
    const env = setup();
    const c = await joined(env);
    c.rec.record(c.sim.tick, classic.ACTION.bank, {
      opId: "op_forged_001",
      op: { kind: "withdrawCoin", coin: 1000 },
    });
    c.sim.step(10);
    const seg = c.rec.cut(c.sim)!;
    const out = await env.send(c.sock, { t: "segment", epoch: c.epoch, seq: 99, ...seg });
    expect(out[0]).toMatchObject({ t: "resync", code: "server_only_action" });
  });
});

describe("VerifiedHost platform: arena builds and season progress", () => {
  const policyWith = (over: Partial<NonNullable<ClientDrivenPolicy["platform"]>>) => ({
    ...basePolicy,
    platform: { ...basePolicy.platform!, ...over },
  });

  it("exportBuild: null before anything is stored, the verified hero after", async () => {
    const env = setup({
      policy: policyWith({
        build: (world) => {
          const hero = classic.heroOf(world);
          return hero === 0 ? null : { mode: "classic", name: "built", level: 1 };
        },
      }),
    });
    expect(await env.host.exportBuild("Shown")).toBeNull();
    const c = await joined(env);
    env.restart(); // cold: restored from storage
    const b = await env.host.exportBuild("Shown");
    expect(b).toMatchObject({
      mode: "classic",
      name: "built",
      accountId: ACC,
      displayName: "Shown",
      sourceHash: c.sim.hash(),
    });
    expect(accountOfInstance("classic:a:b")).toBe("a:b");
  });

  it("reports a changed season total after compaction, retrying after a failure", async () => {
    let total = 5;
    const env = setup({
      season: true,
      policy: policyWith({
        seasonTotal: (world) =>
          classic.heroOf(world) === 0 ? null : { key: "classic:test", total },
      }),
    });
    const c = await joined(env);
    const flush = () => new Promise((r) => setTimeout(r, 0));
    // A bank op compacts; the hero exists now.
    await c.bank({ kind: "depositGold", gold: 20 });
    await flush();
    expect(env.seasonCalls).toEqual([{ accountId: ACC, key: "classic:test", total: 5 }]);
    expect(env.bankStore.kvGet(SEASON_KV)).toBe(JSON.stringify({ key: "classic:test", total: 5 }));
    // Unchanged: no call.
    await c.bank({ kind: "depositGold", gold: 10 });
    await flush();
    expect(env.seasonCalls).toHaveLength(1);
    // Changed but the account is down: retried at the next compaction.
    total = 9;
    env.season.fail = true;
    await c.bank({ kind: "withdrawCoin", coin: 1 });
    await flush();
    expect(env.seasonCalls).toHaveLength(1);
    env.season.fail = false;
    await c.bank({ kind: "withdrawCoin", coin: 1 });
    await flush();
    expect(env.seasonCalls.at(-1)).toEqual({ accountId: ACC, key: "classic:test", total: 9 });
  });

  it("txIds name the instance and the op", () => {
    expect(bankTxId(NAME, "op_x_000001", "take")).toBe(`bank:${NAME}:op_x_000001:take`);
  });
});
