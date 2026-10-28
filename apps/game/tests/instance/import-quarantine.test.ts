/**
 * ADR 0007 R1: a hero imported from a local save is quarantined from the
 * shared economy. The server cannot tell an honest wave A save from a forged
 * one, so an imported hero keeps everything for solo play but can never use
 * the bank (deposits or withdrawals), the arena (exportBuild) or season
 * progress. The flag survives restarts and content carry-over; only a new
 * game (the Reset-progress button: a fresh join) clears it. Import is refused
 * while a bank op is still pending.
 */
import {
  createSim,
  loadMode,
  SegmentRecorder,
  type ClientDrivenPolicy,
  type LoadedMode,
  type Sim,
  type SimSnapshot,
} from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  BANK_ACTOR,
  packSnapshot,
  unpackSnapshot,
  VERIFIED_ACTOR,
  type BankOp,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import { describe, expect, it } from "vite-plus/test";
import type { InstanceSocket, SocketInfo } from "../../src/server/instance/host.ts";
import { SqlBankStore } from "../../src/server/instance/bank-store.ts";
import {
  VerifiedHost,
  type VerifiedPlatformDeps,
} from "../../src/server/instance/verified-host.ts";
import { SqlVerifiedStore } from "../../src/server/instance/verified-store.ts";
import { FakeGateway, testItem } from "../support/fake-gateway.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const loaded = loadMode(classic.mode, classic.modules);
const basePolicy = classic.mode.instance!.clientDriven!;
const ACC = "acc-imp";
const NAME = `classic:${ACC}`;
const FORGED_GOLD = 1_000_000_000;

type Out = VerifiedServerMessage;
type VState = Extract<Out, { t: "vstate" }>;
type Resync = Extract<Out, { t: "resync" }>;
type BankAnswer = Extract<Out, { t: "bank" }>;
type ErrorMsg = Extract<Out, { t: "error" }>;

class Sock implements InstanceSocket {
  info: SocketInfo = { accountId: ACC, name: "Importer", mode: "classic", joined: false };
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

/** The classic policy with an arena build hook and a season total. */
const policy: ClientDrivenPolicy = {
  ...basePolicy,
  platform: {
    ...basePolicy.platform!,
    build: (world) =>
      classic.heroOf(world) === 0 ? null : { mode: "classic", name: "built", level: 1 },
    seasonTotal: (world) =>
      classic.heroOf(world) === 0 ? null : { key: "classic:test", total: 7 },
  },
};

function setup() {
  const db = fakeSqlStore();
  const store = new SqlVerifiedStore(db);
  const bankStore = new SqlBankStore(db);
  const outbox = new Outbox(db.sql, `instance:${NAME}`);
  outbox.init();
  const gw = new FakeGateway();
  const clock = { now: 5_000_000 };
  const sockets: Sock[] = [];
  const seasonCalls: { accountId: string; key: string; total: number }[] = [];
  const logs: { level: string; message: string }[] = [];
  const platform: VerifiedPlatformDeps = {
    store: bankStore,
    account: gw,
    bankEnabled: async () => true,
    vaultCount: async (id) => gw.vault(id).length,
    scheduleRedrive: () => {},
    seasonProgress: async (accountId, key, total) => {
      seasonCalls.push({ accountId, key, total });
      return null;
    },
  };
  let seed = 0x1a2b;
  const make = (mode: LoadedMode = loaded) =>
    new VerifiedHost({
      name: NAME,
      loaded: mode,
      policy,
      store,
      sockets: () => sockets.filter((s) => s.open),
      now: () => clock.now,
      randomSeed: () => seed++,
      outbox,
      scheduleFlush: () => {},
      log: (level, message) => logs.push({ level, message }),
      platform,
    });
  const env = { host: make(), clock, store, bankStore, gw, sockets, seasonCalls, logs };
  return {
    ...env,
    /** A DO restart: new host on the same storage (optionally under other content). */
    restart(mode?: LoadedMode) {
      env.host = make(mode);
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

/** A browser-like client: local sim, recorder, epoch. */
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

  async bank(op: BankOp, opId = this.nextOpId()): Promise<{ out: Out[]; answer: BankAnswer }> {
    this.env.clock.now += 1_000; // bank rate limit
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
    return { out, answer: answer! };
  }

  nextOpId(): string {
    return `op_import_${String(++this.ops).padStart(4, "0")}`;
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

/** A local save: a warrior in town (manual control) with one item in the bag; `gold` forges the wallet. */
function localSave(gold?: number): SimSnapshot {
  const sim = createSim(loaded, { seed: 77 });
  const act = (name: string, payload: unknown) => {
    const res = sim.dispatch(name, payload, VERIFIED_ACTOR);
    expect(res.ok, `${name}: ${res.error?.code}`).toBe(true);
  };
  act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Local" });
  act(classic.ACTION.setControl, { mode: "manual" });
  sim.step(5);
  act(classic.ACTION.unequip, { slot: "weapon" });
  sim.step(5);
  if (gold !== undefined) sim.world.update(classic.heroOf(sim.world), classic.Wallet, { gold });
  return sim.snapshot();
}

/** Joins a new instance (no progress) and imports `save`; returns the client at the imported state. */
async function imported(env: Env, save: SimSnapshot): Promise<Client> {
  const sock = env.connect();
  const c = new Client(env, sock);
  await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);
  env.clock.now += 1_000;
  const out = await env.send(sock, {
    t: "import",
    snapshot: await packSnapshot(save),
    savedAt: 1,
  });
  const v = out.find((m): m is VState => m.t === "vstate");
  expect(v, JSON.stringify(out).slice(0, 300)).toBeDefined();
  expect(v!.imported).toBe(true);
  await c.adopt(v!);
  return c;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const NOT_ELIGIBLE = {
  ok: false,
  code: "not_eligible",
  message:
    "This hero was imported from a local save and can't use the bank. Start a new hero to trade.",
};

describe("import quarantine (ADR 0007 R1): the bank", () => {
  it("refuses every bank op of an imported hero before any account call or bank row", async () => {
    const env = setup();
    const [vaultItem] = env.gw.seed(ACC, { coin: 1000, items: [testItem("Old blade")] });
    const c = await imported(env, localSave(FORGED_GOLD));
    expect(c.gold()).toBe(FORGED_GOLD);
    await c.play(20); // a verified segment on top of the imported base
    const hash = env.host.record!.verifiedHash;
    const ops: BankOp[] = [
      { kind: "depositGold", gold: 10_000_000 },
      { kind: "depositItem", ref: c.bagUids()[0]! },
      { kind: "withdrawCoin", coin: 100 },
      { kind: "withdrawItem", uid: vaultItem!.uid },
    ];
    for (const op of ops) {
      const opId = c.nextOpId();
      const { out, answer } = await c.bank(op, opId);
      expect(
        out.map((m) => m.t),
        op.kind,
      ).toEqual(["bank"]);
      expect(answer.result, op.kind).toEqual(NOT_ELIGIBLE);
      expect(answer.applied).toBeNull();
      expect(env.bankStore.get(opId), op.kind).toBeNull();
    }
    // Nothing reached the account and nothing moved on either side.
    expect(env.gw.calls).toEqual([]);
    expect(env.gw.balance(ACC)).toBe(1000);
    expect(env.gw.vault(ACC).map((i) => i.uid)).toEqual([vaultItem!.uid]);
    expect(env.host.record!.verifiedHash).toBe(hash);
    expect(c.gold()).toBe(FORGED_GOLD);
    expect(env.bankStore.pending()).toEqual([]);
    // Every refusal is audited with the instance name.
    const audit = env.logs.filter((l) => l.level === "info" && l.message.includes("imported"));
    expect(audit).toHaveLength(ops.length);
    expect(audit[0]!.message).toContain(NAME);
    // Solo play goes on.
    await c.play(40);
  });

  it("refuses the import while a bank op is still pending, and accepts it once settled", async () => {
    const env = setup();
    env.gw.seed(ACC, { coin: 100 });
    const sock = env.connect();
    const c = new Client(env, sock);
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);
    // A withdrawal whose take never answers: the op stays pending.
    env.gw.failNext("walletTx", "throw", { txId: /:take$/ });
    const { answer } = await c.bank({ kind: "withdrawCoin", coin: 30 });
    expect(answer.result).toMatchObject({ ok: false, code: "unavailable" });
    expect(env.host.pendingBankOps()).toBe(1);

    const save = await packSnapshot(localSave(FORGED_GOLD));
    env.clock.now += 1_000;
    const out = await env.send(sock, { t: "import", snapshot: save, savedAt: 1 });
    expect(out.map((m) => m.t)).toEqual(["error"]);
    expect(out[0] as ErrorMsg).toMatchObject({ code: "not_importable" });
    expect((out[0] as ErrorMsg).message).toMatch(/pending bank operation/);
    expect(env.host.record!.imported).toBe(false);
    expect(env.store.load()!.importUsed).toBe(false);

    // The re-drive settles it; then the import goes through.
    expect(await env.host.redrive()).toBe(0);
    env.clock.now += 61_000; // import rate limit
    const ok = await env.send(sock, { t: "import", snapshot: save, savedAt: 1 });
    expect(ok.map((m) => m.t)).toEqual(["vstate"]);
    expect((ok[0] as VState).imported).toBe(true);
  });
});

describe("import quarantine (ADR 0007 R1): arena and season", () => {
  it("exportBuild is null for an imported hero, also after a restart", async () => {
    const env = setup();
    await imported(env, localSave(FORGED_GOLD));
    expect(await env.host.exportBuild("Shown")).toBeNull();
    env.restart();
    expect(await env.host.exportBuild("Shown")).toBeNull();
  });

  it("never reports season progress for an imported hero", async () => {
    const env = setup();
    const c = await imported(env, localSave(FORGED_GOLD));
    await flush();
    // Force compactions (wall time) after verified play.
    for (let i = 0; i < 3; i++) {
      env.clock.now += 31_000;
      await c.play(20);
      await flush();
    }
    expect(env.seasonCalls).toEqual([]);
  });
});

describe("import quarantine (ADR 0007 R1): the flag sticks until a new game", () => {
  it("survives a host restart", async () => {
    const env = setup();
    const c = await imported(env, localSave(FORGED_GOLD));
    await c.play(20);
    c.sock.open = false;
    await env.host.handleClose(c.sock);
    env.restart();
    const sock = env.connect();
    const out = await env.send(sock, {
      t: "join",
      token: "t",
      mode: "classic",
      resume: { tick: c.sim.tick, hash: c.sim.hash(), pending: false },
    });
    const v = out[0] as VState;
    expect(v.imported).toBe(true);
    expect(env.host.record!.imported).toBe(true);
    const again = new Client(env, sock);
    again.sim = c.sim;
    await again.adopt(v);
    const { answer } = await again.bank({ kind: "depositGold", gold: 1_000 });
    expect(answer.result).toEqual(NOT_ELIGIBLE);
    expect(env.gw.calls).toEqual([]);
  });

  it("survives a content carry-over", async () => {
    const env = setup();
    const c = await imported(env, localSave(FORGED_GOLD));
    await c.play(20);
    // Same module ids, one version bumped: a new contentHash that carries over.
    const bumped = loadMode(
      classic.mode,
      classic.modules.map((m, i) => (i === 0 ? { ...m, version: `${m.version}-carry` } : m)),
    );
    expect(bumped.contentHash).not.toBe(loaded.contentHash);
    env.restart(bumped);
    const sock = env.connect();
    const v = (await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState;
    expect(v.t).toBe("vstate");
    expect(v.contentHash).toBe(bumped.contentHash);
    expect(v.imported).toBe(true);
    expect(env.store.load()!.imported).toBe(true);
    expect(await env.host.exportBuild("Shown")).toBeNull();
  });

  it("a new game (Reset progress: fresh join) clears it: the new hero banks again", async () => {
    const env = setup();
    const c = await imported(env, localSave(FORGED_GOLD));
    await c.play(20);
    const sock = env.connect();
    const n = new Client(env, sock);
    const v = (
      await env.send(sock, { t: "join", token: "t", mode: "classic", fresh: true })
    )[0] as VState;
    expect(v.imported).toBe(false);
    expect(v.importable).toBe(false); // one import per instance, ever
    await n.adopt(v);
    n.act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Fresh" });
    await n.play(20);
    expect(n.gold()).toBe(50);
    const { answer } = await n.bank({ kind: "depositGold", gold: 40 });
    expect(answer.result).toEqual({ ok: true, coin: 38, gold: 40, balance: 38 });
    expect(env.gw.balance(ACC)).toBe(38);
    expect(await env.host.exportBuild("Shown")).not.toBeNull();
    await flush();
    expect(env.seasonCalls).toEqual([{ accountId: ACC, key: "classic:test", total: 7 }]);
  });
});

describe("import quarantine (ADR 0007 R1): honest legacy saves", () => {
  it("an honest local save still imports and plays (segments verify)", async () => {
    const env = setup();
    const save = localSave();
    const c = await imported(env, save);
    expect(c.sim.hash()).toBe(createSim(loaded, { seed: 0, from: save }).hash());
    expect(c.gold()).toBe(50);
    for (let i = 0; i < 3; i++) await c.play(40);
    expect(env.host.record!.verifiedHash).toBe(c.sim.hash());
    expect(env.host.record!.segmentsTotal).toBe(3);
  });
});
