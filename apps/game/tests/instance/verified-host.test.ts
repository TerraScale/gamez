/**
 * VerifiedHost (docs/design/wave-B.md §2.3-§2.4) with fake sockets, a fake
 * clock and the node:sqlite store: an inline fixed-tick mode for the fast
 * rule checks. The real classic mode is exercised in verified-classic.test.ts.
 */
import {
  ActionError,
  createSim,
  defineMode,
  defineModule,
  loadMode,
  SegmentRecorder,
  type ClientDrivenPolicy,
  type LoadedMode,
  type ModuleSpec,
  type Sim,
  type SimSnapshot,
} from "@gamez/kernel";
import {
  MAX_VERIFIED_CLIENT_FRAME,
  packSnapshot,
  unpackSnapshot,
  VERIFIED_ACTOR,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import { describe, expect, it } from "vite-plus/test";
import type { ReportEnvelope } from "../../src/server/contracts.ts";
import type { InstanceSocket, SocketInfo } from "../../src/server/instance/host.ts";
import { CLOSE_REPLACED } from "../../src/server/instance/messages.ts";
import {
  COMPACT_TICKS,
  CREDIT_CAP_MS,
  FLAG_AFTER,
  START_CREDIT_MS,
  TOLERANCE_MS,
  VerifiedHost,
} from "../../src/server/instance/verified-host.ts";
import { parseVerifiedClientMessage } from "../../src/server/instance/verified-messages.ts";
import { SqlVerifiedStore } from "../../src/server/instance/verified-store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

// ---- inline client-driven test mode ---------------------------------------

interface Meter {
  ticks: number;
  sum: number;
  speed: number;
  eligible: boolean;
  offline: number;
}

const METER = "tvc.meter";
const meterOf = (sim: { world: Sim["world"] }) => sim.world.getResource<Meter>(METER)!;

function meterModule(version: string): ModuleSpec {
  return defineModule({
    id: "tvc.core",
    version,
    setup(world) {
      world.setResource<Meter>(METER, {
        ticks: 0,
        sum: 0,
        speed: 1,
        eligible: true,
        offline: 0,
      });
    },
    systems: [
      {
        id: "tvc.tick",
        stage: "update",
        run(world, ctx) {
          const m = world.getResource<Meter>(METER)!;
          world.setResource<Meter>(METER, {
            ...m,
            ticks: m.ticks + 1,
            sum: m.sum + ctx.rng.int(0, 9),
          });
        },
      },
    ],
    actions: [
      {
        name: "tvc.add",
        parse(_w, p) {
          const by = (p as { by?: unknown } | null)?.by;
          if (typeof by !== "number" || !Number.isInteger(by))
            throw new ActionError("bad_payload", "by");
          return by;
        },
        apply(world, by: number) {
          const m = world.getResource<Meter>(METER)!;
          if (m.sum + by > 1_000_000) throw new ActionError("too_big", "too big");
          world.setResource<Meter>(METER, { ...m, sum: m.sum + by });
        },
      },
      {
        name: "tvc.speed",
        parse: (_w, p) => (p as { speed: number }).speed,
        apply(world, speed: number) {
          world.setResource<Meter>(METER, { ...world.getResource<Meter>(METER)!, speed });
        },
      },
      {
        name: "tvc.eligible",
        parse: (_w, p) => (p as { on: boolean }).on === true,
        apply(world, on: boolean) {
          world.setResource<Meter>(METER, { ...world.getResource<Meter>(METER)!, eligible: on });
        },
      },
      {
        name: "tvc.offline",
        parse(_w, p) {
          const ms = (p as { elapsedMs?: unknown } | null)?.elapsedMs;
          if (typeof ms !== "number" || ms <= 0) throw new ActionError("bad_payload", "ms");
          return ms;
        },
        apply(world, ms: number, ctx) {
          const m = world.getResource<Meter>(METER)!;
          const gain = Math.floor(ms / 1000);
          world.setResource<Meter>(METER, { ...m, sum: m.sum + gain, offline: m.offline + 1 });
          ctx.emit({ type: "tvc.offline.summary", gain });
        },
      },
    ],
  });
}

const extraModule = defineModule({
  id: "tvc.extra",
  version: "1.0.0",
  deps: ["tvc.core"],
  setup(world) {
    world.setResource("tvc.extra", { on: true });
  },
});

const policy: ClientDrivenPolicy = {
  maxTicksPerSegment: 400,
  maxInputsPerSegment: 16,
  speedOf: (world) => world.getResource<Meter>(METER)?.speed ?? 1,
  maxSpeed: 8,
  serverOnlyActions: ["tvc.offline"],
  offline: {
    action: "tvc.offline",
    minMs: 60_000,
    capMs: 3_600_000,
    eligible: (world) => world.getResource<Meter>(METER)?.eligible === true,
  },
  reports: (world) => {
    const m = world.getResource<Meter>(METER);
    return m
      ? [{ table: "classic_hero", key: "hero", data: { hundreds: Math.floor(m.ticks / 100) } }]
      : [];
  },
};

const modeSpec = defineMode({
  id: "tvc",
  name: "Verified test",
  description: "client-driven test mode",
  world: null,
  modules: ["tvc.*"],
  tick: { kind: "fixed", hz: 20 },
  instance: { maxPlayers: 1, clientDriven: policy },
});

const V1 = loadMode(modeSpec, [meterModule("1.0.0"), extraModule]);
/** Same module set, new content: carryable. */
const V2 = loadMode(modeSpec, [meterModule("1.1.0"), extraModule]);
/** A stored module disappeared: not carryable. */
const V3 = loadMode(modeSpec, [meterModule("1.2.0")]);

// ---- harness ---------------------------------------------------------------

type Out = VerifiedServerMessage;
type VState = Extract<Out, { t: "vstate" }>;
type Resync = Extract<Out, { t: "resync" }>;
type Ack = Extract<Out, { t: "verified" }>;
type SegmentMsg = Extract<VerifiedClientMessage, { t: "segment" }>;

class FakeSocket implements InstanceSocket {
  info: SocketInfo;
  open = true;
  closed: { code: number; reason: string } | null = null;
  out: Out[] = [];

  constructor(accountId: string, mode: string) {
    this.info = { accountId, name: `Hero-${accountId}`, mode, joined: false };
  }
  setInfo(info: SocketInfo): void {
    this.info = info;
  }
  send(frame: string): void {
    this.out.push(JSON.parse(frame) as Out);
  }
  close(code: number, reason: string): void {
    this.open = false;
    this.closed = { code, reason };
  }
  take(): Out[] {
    const out = this.out;
    this.out = [];
    return out;
  }
}

class Harness {
  readonly db = fakeSqlStore();
  readonly store = new SqlVerifiedStore(this.db);
  readonly outbox = new Outbox(this.db.sql, "instance:tvc:acc1");
  readonly clock = { now: 1_000_000 };
  readonly sockets: FakeSocket[] = [];
  flushes = 0;
  seeds = 41;
  logs: string[] = [];
  host: VerifiedHost;

  constructor(readonly loaded: LoadedMode = V1) {
    this.outbox.init();
    this.host = this.make(loaded);
  }

  make(loaded: LoadedMode): VerifiedHost {
    return new VerifiedHost({
      name: "tvc:acc1",
      loaded,
      policy: loaded.mode.instance!.clientDriven!,
      store: this.store,
      sockets: () => this.sockets.filter((s) => s.open),
      now: () => this.clock.now,
      randomSeed: () => this.seeds++,
      outbox: this.outbox,
      scheduleFlush: () => this.flushes++,
      log: (level, message) => this.logs.push(`${level}: ${message}`),
    });
  }

  /** A new host over the same storage (DO evicted / redeployed). */
  restart(loaded: LoadedMode = this.loaded): VerifiedHost {
    this.host = this.make(loaded);
    return this.host;
  }

  connect(): FakeSocket {
    const s = new FakeSocket("acc1", "tvc");
    this.sockets.push(s);
    return s;
  }

  async send(s: FakeSocket, msg: unknown): Promise<Out[]> {
    await this.host.handleMessage(s, typeof msg === "string" ? msg : JSON.stringify(msg));
    return s.take();
  }

  async close(s: FakeSocket): Promise<void> {
    s.open = false;
    await this.host.handleClose(s);
  }

  async join(
    s: FakeSocket,
    extra: Partial<Extract<VerifiedClientMessage, { t: "join" }>> = {},
  ): Promise<{ vstate: VState; all: Out[] }> {
    const all = await this.send(s, { t: "join", token: "x", mode: "tvc", ...extra });
    const vstate = all.find((m): m is VState => m.t === "vstate");
    if (!vstate) throw new Error(`no vstate: ${JSON.stringify(all)}`);
    return { vstate, all };
  }

  advance(ms: number): void {
    this.clock.now += ms;
  }
}

/** The browser side: a local sim, a recorder, the epoch and a seq counter. */
class Player {
  sim!: Sim;
  rec!: SegmentRecorder;
  epoch = 0;
  seq = 0;

  constructor(readonly loaded: LoadedMode) {}

  async adopt(msg: VState | Resync): Promise<void> {
    this.epoch = msg.epoch;
    if (msg.snapshot) {
      const snap = await unpackSnapshot(msg.snapshot);
      this.sim = createSim(this.loaded, { seed: 0, from: snap });
    }
    this.rec = new SegmentRecorder(this.sim.tick);
  }

  act(name: string, payload: unknown): void {
    const res = this.sim.dispatch(name, payload, VERIFIED_ACTOR);
    if (!res.ok) throw new Error(`${name} rejected: ${res.error?.code}`);
    this.rec.record(this.sim.tick, name, payload);
  }

  /** Steps n ticks and cuts a segment message. */
  play(n: number): SegmentMsg {
    this.sim.step(n);
    const seg = this.rec.cut(this.sim)!;
    return { t: "segment", epoch: this.epoch, seq: ++this.seq, ...seg };
  }
}

async function started(loaded: LoadedMode = V1) {
  const h = new Harness(loaded);
  const s = h.connect();
  const { vstate } = await h.join(s);
  const p = new Player(loaded);
  await p.adopt(vstate);
  return { h, s, p, vstate };
}

function only<T extends Out["t"]>(out: Out[], t: T): Extract<Out, { t: T }> {
  expect(out.map((m) => m.t)).toEqual([t]);
  return out[0] as Extract<Out, { t: T }>;
}

// ---- tests -----------------------------------------------------------------

describe("VerifiedHost: join", () => {
  it("a first join creates a game with a server seed and sends the snapshot", async () => {
    const { h, vstate } = await started();
    expect(vstate.continued).toBe(false);
    expect(vstate.snapshot).not.toBeNull();
    expect(vstate.tick).toBe(0);
    expect(vstate.epoch).toBe(1);
    expect(vstate.importable).toBe(true);
    expect(vstate.imported).toBe(false);
    expect(vstate.offline).toBeNull();
    expect(vstate.contentHash).toBe(V1.contentHash);
    expect(vstate.instanceId).toBe("tvc:acc1:00000029");
    expect(vstate.limits).toEqual({
      maxTicksPerSegment: 400,
      maxInputsPerSegment: 16,
      segmentEveryMs: 2000,
      maxPendingTicks: 12000,
      creditCapMs: CREDIT_CAP_MS,
    });
    const snap = await unpackSnapshot(vstate.snapshot!);
    expect(createSim(V1, { seed: 0, from: snap }).hash()).toBe(vstate.hash);
    expect(h.store.load()?.verifiedHash).toBe(vstate.hash);
  });

  it("rejects a join for another mode and messages before joining", async () => {
    const h = new Harness();
    const s = h.connect();
    expect(only(await h.send(s, { t: "join", token: "x", mode: "duel" }), "error").code).toBe(
      "wrong_mode",
    );
    const seg = { t: "segment", epoch: 1, seq: 1, fromTick: 0, toTick: 1, inputs: [], hash: "a" };
    expect(only(await h.send(s, seg), "error").code).toBe("not_joined");
  });

  it("a newer socket replaces the older one (CLOSE_REPLACED)", async () => {
    const { h, s } = await started();
    const s2 = h.connect();
    await h.join(s2);
    expect(s.closed?.code).toBe(CLOSE_REPLACED);
    expect(s.info.joined).toBe(false);
    expect(s2.info.joined).toBe(true);
  });

  it("resume at the verified tick/hash continues without a snapshot, in a new epoch", async () => {
    const { h, s, p } = await started();
    only(await h.send(s, p.play(20)), "verified");
    h.advance(1000);
    const s2 = h.connect();
    const { vstate } = await h.join(s2, {
      resume: { tick: p.sim.tick, hash: p.sim.hash(), pending: false },
    });
    expect(vstate.continued).toBe(true);
    expect(vstate.snapshot).toBeNull();
    expect(vstate.tick).toBe(20);
    expect(vstate.epoch).toBe(p.epoch + 1);
  });

  it("a resume at an earlier verified state of the log continues (lost acks)", async () => {
    const { h, s, p } = await started();
    h.advance(5000);
    const first = p.play(20);
    only(await h.send(s, first), "verified");
    const second = p.play(20);
    only(await h.send(s, second), "verified");
    // The client never saw the second ack: it resumes at tick 20 and resends.
    const afterFirst = h.store.segments()[0]!;
    h.restart();
    const s2 = h.connect();
    const { vstate } = await h.join(s2, {
      resume: { tick: 20, hash: afterFirst.hash, pending: true },
    });
    expect(vstate.continued).toBe(true);
    expect(vstate.tick).toBe(40);
    p.epoch = vstate.epoch;
    const again = only(await h.send(s2, { ...second, epoch: vstate.epoch }), "verified") as Ack;
    expect(again.tick).toBe(40);
    h.advance(2000);
    only(await h.send(s2, p.play(20)), "verified");
    // Not an ancestor: a hash the log never had.
    const { vstate: v2 } = await h.join(h.connect(), {
      resume: { tick: 20, hash: "beef", pending: true },
    });
    expect(v2.continued).toBe(false);
  });

  it("a resume that does not match gets the server snapshot", async () => {
    const { h, s, p } = await started();
    only(await h.send(s, p.play(20)), "verified");
    const { vstate } = await h.join(h.connect(), {
      resume: { tick: 20, hash: "deadbeef", pending: true },
    });
    expect(vstate.continued).toBe(false);
    expect((await unpackSnapshot(vstate.snapshot!)).tick).toBe(20);
  });

  it("fresh discards the instance: new seed, tick 0, still not importable after play", async () => {
    const { h, s, p } = await started();
    only(await h.send(s, p.play(40)), "verified");
    const { vstate } = await h.join(s, { fresh: true });
    expect(vstate.tick).toBe(0);
    expect(vstate.continued).toBe(false);
    expect(vstate.instanceId).toBe("tvc:acc1:0000002a");
    expect(vstate.importable).toBe(false);
    expect(h.store.segments()).toEqual([]);
  });
});

describe("VerifiedHost: segments", () => {
  it("honest play verifies, the ack is durable and credit is charged by speed", async () => {
    const { h, s, p } = await started();
    p.act("tvc.add", { by: 5 });
    h.advance(1000);
    const ack = only(await h.send(s, p.play(20)), "verified") as Ack;
    expect(ack).toMatchObject({ epoch: p.epoch, seq: 1, tick: 20, hash: p.sim.hash() });
    // START + 1000 ms accrued - 20 ticks * 50 ms.
    expect(ack.creditMs).toBe(START_CREDIT_MS + 1000 - 1000);
    expect(h.store.load()).toMatchObject({ verifiedTick: 20, verifiedHash: p.sim.hash() });
    expect(h.store.segments()).toHaveLength(1);

    // x8: 160 ticks cost 1000 ms.
    p.act("tvc.speed", { speed: 8 });
    h.advance(1000);
    const ack2 = only(await h.send(s, p.play(160)), "verified") as Ack;
    expect(ack2.creditMs).toBe(ack.creditMs + 1000 - 1000);
    expect(h.host.sim!.hash()).toBe(p.sim.hash());
  });

  it("speeds above maxSpeed are clamped in the ledger", async () => {
    const { h, s, p } = await started();
    p.act("tvc.speed", { speed: 64 });
    h.advance(1000);
    const ack = only(await h.send(s, p.play(160)), "verified") as Ack;
    expect(ack.creditMs).toBe(START_CREDIT_MS + 1000 - 1000);
  });

  async function rejected(
    tamper: (seg: SegmentMsg, p: Player) => SegmentMsg | void,
    code: string,
  ): Promise<void> {
    const { h, s, p } = await started();
    p.act("tvc.add", { by: 3 });
    h.advance(1000);
    only(await h.send(s, p.play(20)), "verified");
    const durable = { rec: h.store.load(), segs: h.store.segments() };
    const hostHash = h.host.sim!.hash();
    h.advance(1000);
    p.act("tvc.add", { by: 7 });
    let seg = p.play(20);
    seg = tamper(seg, p) ?? seg;
    const r = only(await h.send(s, seg), "resync") as Resync;
    expect(r.code).toBe(code);
    expect(r.seq).toBe(seg.seq);
    expect(r.epoch).toBe(p.epoch + 1);
    expect(r.tick).toBe(20);
    expect(r.hash).toBe(hostHash);
    const snap = await unpackSnapshot(r.snapshot);
    expect(createSim(V1, { seed: 0, from: snap }).hash()).toBe(hostHash);
    // Durable state is unchanged (apart from the epoch and the counters).
    const after = h.store.load()!;
    expect(after.verifiedTick).toBe(durable.rec!.verifiedTick);
    expect(after.verifiedHash).toBe(durable.rec!.verifiedHash);
    expect(after.epoch).toBe(r.epoch);
    expect(after.counters.byCode[code]).toBe(1);
    expect(h.store.segments()).toEqual(durable.segs);
    expect(h.host.sim!.hash()).toBe(hostHash);
    // In-flight segments of the old epoch are dropped silently.
    const stale = p.play(10);
    expect(await h.send(s, stale)).toEqual([]);
    // Adopting the resync continues verified.
    await p.adopt(r);
    h.advance(1000);
    only(await h.send(s, p.play(20)), "verified");
  }

  it("a wrong hash -> hash_mismatch", () =>
    rejected((seg) => ({ ...seg, hash: "0badc0de" }), "hash_mismatch"));

  it("a tampered payload -> hash_mismatch", () =>
    rejected((seg) => {
      seg.inputs[0]!.payload = { by: 700 };
    }, "hash_mismatch"));

  it("an input the server rejects -> input_rejected", () =>
    rejected((seg) => {
      seg.inputs[0]!.payload = { by: "lots" };
    }, "input_rejected"));

  it("a server-only action -> server_only_action", () =>
    rejected((seg) => {
      seg.inputs.push({ tick: seg.fromTick, name: "tvc.offline", payload: { elapsedMs: 9e6 } });
      seg.inputs.sort((a, b) => a.tick - b.tick);
    }, "server_only_action"));

  it("an unknown action -> input_rejected", () =>
    rejected((seg) => {
      seg.inputs[0]!.name = "tvc.nope";
    }, "input_rejected"));

  it("a segment that does not start at the verified tick -> gap", () =>
    rejected((seg) => ({ ...seg, fromTick: seg.fromTick + 1 }), "gap"));

  it("a segment over the tick limit -> bad_segment", () =>
    rejected((seg) => ({ ...seg, toTick: seg.fromTick + 401 }), "bad_segment"));

  it("more inputs than the policy allows -> bad_segment", () =>
    rejected((seg) => {
      for (let i = 0; i < 20; i++) seg.inputs.push({ ...seg.inputs[0]! });
    }, "bad_segment"));

  it("an input at a tick not before toTick -> bad_segment", () =>
    rejected((seg) => {
      seg.inputs[0]!.tick = seg.toTick;
    }, "bad_segment"));

  it("claiming far more sim time than wall time -> too_fast, nothing consumed", async () => {
    const { h, s, p } = await started();
    h.advance(500);
    // 400 ticks at x1 = 20 s of play after 0.5 s of wall time.
    const seg = p.play(400);
    const r = only(await h.send(s, seg), "resync") as Resync;
    expect(r.code).toBe("too_fast");
    expect(r.tick).toBe(0);
    expect(h.store.load()!.verifiedTick).toBe(0);
    expect(h.store.load()!.counters.byCode.too_fast).toBe(1);
  });

  it("too_fast is decided after replay at the replayed speed", async () => {
    const { h, s, p } = await started();
    // 120 ticks at x1 = 6 s; min cost at x8 is 0.75 s so the precheck passes.
    h.advance(100);
    const r = only(await h.send(s, p.play(120)), "resync") as Resync;
    expect(r.code).toBe("too_fast");
    expect(h.host.sim!.tick).toBe(0);
    // The same ticks at x8 fit.
    await p.adopt(r);
    p.act("tvc.speed", { speed: 8 });
    only(await h.send(s, p.play(120)), "verified");
  });

  it("the tolerance absorbs a small overdraw", async () => {
    const { h, s, p } = await started();
    // START 3 s + tolerance 2 s: 4.9 s of play right away is fine.
    const ack = only(await h.send(s, p.play(98)), "verified") as Ack;
    expect(ack.creditMs).toBe(START_CREDIT_MS - 98 * 50);
    expect(ack.creditMs).toBeGreaterThanOrEqual(-TOLERANCE_MS);
  });

  it("credit accrues with wall time up to the cap", async () => {
    const { h, s, p } = await started();
    h.advance(3_600_000);
    const ack = only(await h.send(s, p.play(20)), "verified") as Ack;
    expect(ack.creditMs).toBe(CREDIT_CAP_MS - 1000);
  });

  it("a duplicate segment is re-acked with the verified tick", async () => {
    const { h, s, p } = await started();
    h.advance(2000);
    const seg = p.play(20);
    only(await h.send(s, seg), "verified");
    h.advance(2000);
    only(await h.send(s, p.play(20)), "verified");
    const again = only(await h.send(s, seg), "verified") as Ack;
    expect(again).toMatchObject({ seq: seg.seq, tick: 40, hash: p.sim.hash() });
    expect(h.store.segments()).toHaveLength(2);
  });

  it("flags the instance after FLAG_AFTER mismatches within an hour", async () => {
    const { h, s, p } = await started();
    for (let i = 0; i < FLAG_AFTER; i++) {
      h.advance(1000);
      const seg = p.play(10);
      const r = only(await h.send(s, { ...seg, hash: "bad" }), "resync") as Resync;
      await p.adopt(r);
    }
    const rec = h.store.load()!;
    expect(rec.counters.flagged).toBe(true);
    expect(rec.counters.byCode.hash_mismatch).toBe(FLAG_AFTER);
    expect(h.logs.some((l) => l.includes("flagged"))).toBe(true);
  });

  it("failed replays cost credit", async () => {
    const { h, s, p } = await started();
    h.advance(10_000);
    const r = only(await h.send(s, { ...p.play(100), hash: "bad" }), "resync") as Resync;
    await p.adopt(r);
    const ack = only(await h.send(s, p.play(20)), "verified") as Ack;
    // START + 10 s - 5 s (failed) - 1 s.
    expect(ack.creditMs).toBe(START_CREDIT_MS + 10_000 - 5000 - 1000);
  });

  it("segments are rate limited per socket (burst 40, 2/s)", async () => {
    const { h, s, p } = await started();
    h.advance(CREDIT_CAP_MS);
    let acks = 0;
    let limited = 0;
    for (let i = 0; i < 45; i++) {
      const out = await h.send(s, p.play(1));
      if (out[0]?.t === "verified") acks++;
      if (out[0]?.t === "error" && out[0].code === "rate_limited") limited++;
    }
    expect(acks).toBe(40);
    expect(limited).toBe(5);
  });
});

describe("VerifiedHost: persistence", () => {
  it("a restarted host restores base + log to the same verified hash", async () => {
    const { h, s, p } = await started();
    for (let i = 0; i < 5; i++) {
      h.advance(2000);
      p.act("tvc.add", { by: i });
      only(await h.send(s, p.play(30)), "verified");
    }
    expect(h.store.segments().length).toBe(5);
    h.restart();
    const s2 = h.connect();
    const { vstate } = await h.join(s2, {
      resume: { tick: p.sim.tick, hash: p.sim.hash(), pending: false },
    });
    expect(vstate.continued).toBe(true);
    expect(h.host.sim!.hash()).toBe(p.sim.hash());
    p.epoch = vstate.epoch;
    h.advance(2000);
    only(await h.send(s2, p.play(30)), "verified");
  });

  it("compacts after COMPACT_TICKS and after 30 s, dropping the log", async () => {
    const { h, s, p } = await started();
    p.act("tvc.speed", { speed: 8 });
    h.advance(8000);
    for (let i = 0; i < COMPACT_TICKS / 400; i++) only(await h.send(s, p.play(400)), "verified");
    expect(h.store.load()!.baseTick).toBe(COMPACT_TICKS);
    expect(h.store.segments()).toEqual([]);
    only(await h.send(s, p.play(10)), "verified");
    expect(h.store.segments()).toHaveLength(1);
    h.advance(30_000);
    only(await h.send(s, p.play(10)), "verified");
    expect(h.store.segments()).toEqual([]);
    expect(h.store.load()!.baseTick).toBe(COMPACT_TICKS + 20);
  });

  it("the last socket closing compacts and marks the player inactive", async () => {
    const { h, s, p } = await started();
    h.advance(2000);
    only(await h.send(s, p.play(30)), "verified");
    h.advance(5000);
    await h.close(s);
    const rec = h.store.load()!;
    expect(rec.baseTick).toBe(30);
    expect(rec.lastActiveAt).toBe(h.clock.now);
    expect(h.store.segments()).toEqual([]);
  });

  it("a stored segment that no longer replays falls back to the base", async () => {
    const { h, s, p } = await started();
    h.advance(2000);
    only(await h.send(s, p.play(30)), "verified");
    h.db.sql.exec("UPDATE verified_segment SET hash = 'corrupt'");
    h.restart();
    const { vstate } = await h.join(h.connect());
    expect(vstate.tick).toBe(0);
    expect(h.logs.some((l) => l.includes("stored segment"))).toBe(true);
  });
});

describe("VerifiedHost: storage failures", () => {
  it("a failed segment write answers resync internal and keeps durable state", async () => {
    const { h, s, p } = await started();
    h.advance(5000);
    only(await h.send(s, p.play(20)), "verified");
    const durable = h.store.load()!;
    const append = h.store.appendSegment.bind(h.store);
    h.store.appendSegment = () => {
      throw new Error("disk full");
    };
    const r = only(await h.send(s, p.play(20)), "resync") as Resync;
    expect(r.code).toBe("internal");
    expect(r.tick).toBe(20);
    expect(r.hash).toBe(durable.verifiedHash);
    expect(h.store.load()!.counters.byCode.internal).toBeUndefined();
    h.store.appendSegment = append;
    await p.adopt(r);
    only(await h.send(s, p.play(20)), "verified");
  });

  it("a failed offline-grant write leaves memory at the durable state", async () => {
    const { h, s, p } = await started();
    h.advance(5000);
    only(await h.send(s, p.play(20)), "verified");
    await h.close(s);
    h.advance(120_000);
    const write = h.store.writeBase.bind(h.store);
    h.store.writeBase = () => {
      throw new Error("disk full");
    };
    const s2 = h.connect();
    const out = await h.send(s2, { t: "join", token: "x", mode: "tvc" });
    expect(only(out, "error").code).toBe("internal");
    h.store.writeBase = write;
    // The retry grants offline progress from the durable state, once.
    const { vstate } = await h.join(s2);
    expect(vstate.offline?.elapsedMs).toBe(120_000);
    expect(vstate.tick).toBe(20);
    const sim = createSim(V1, { seed: 0, from: await unpackSnapshot(vstate.snapshot!) });
    expect(meterOf(sim).offline).toBe(1);
  });
});

describe("VerifiedHost: offline progress", () => {
  async function playedAndLeft() {
    const { h, s, p } = await started();
    h.advance(2000);
    only(await h.send(s, p.play(30)), "verified");
    await h.close(s);
    return { h, p };
  }

  it("a rejoin after >= minMs grants offline progress once, with credit reset", async () => {
    const { h, p } = await playedAndLeft();
    h.advance(120_000);
    const s2 = h.connect();
    const resume = { tick: p.sim.tick, hash: p.sim.hash(), pending: false };
    const { vstate } = await h.join(s2, { resume });
    expect(vstate.continued).toBe(false);
    expect(vstate.offline?.elapsedMs).toBe(120_000);
    expect(vstate.offline?.events).toEqual([{ type: "tvc.offline.summary", gain: 120 }]);
    expect(vstate.tick).toBe(30);
    const snap = await unpackSnapshot(vstate.snapshot!);
    const sim = createSim(V1, { seed: 0, from: snap });
    expect(meterOf(sim).offline).toBe(1);
    expect(vstate.hash).toBe(sim.hash());
    const rec = h.store.load()!;
    expect(rec.verifiedHash).toBe(vstate.hash);
    expect(rec.creditMs).toBe(START_CREDIT_MS);
    // Again right away: nothing more.
    const again = await h.join(h.connect(), {
      resume: { tick: vstate.tick, hash: vstate.hash, pending: false },
    });
    expect(again.vstate.offline).toBeNull();
    expect(again.vstate.continued).toBe(true);
  });

  it("is capped at capMs", async () => {
    const { h } = await playedAndLeft();
    h.advance(10 * 3_600_000);
    const { vstate } = await h.join(h.connect());
    expect(vstate.offline?.elapsedMs).toBe(3_600_000);
  });

  it("is never granted while the client holds pending segments", async () => {
    const { h, p } = await playedAndLeft();
    h.advance(120_000);
    const { vstate } = await h.join(h.connect(), {
      resume: { tick: p.sim.tick, hash: p.sim.hash(), pending: true },
    });
    expect(vstate.offline).toBeNull();
    expect(vstate.continued).toBe(true);
  });

  it("is not granted below minMs, nor when not eligible, nor on a fresh join", async () => {
    const a = await playedAndLeft();
    a.h.advance(59_000);
    expect((await a.h.join(a.h.connect())).vstate.offline).toBeNull();

    const { h, s, p } = await started();
    p.act("tvc.eligible", { on: false });
    h.advance(2000);
    only(await h.send(s, p.play(10)), "verified");
    await h.close(s);
    h.advance(120_000);
    expect((await h.join(h.connect())).vstate.offline).toBeNull();
    h.advance(120_000);
    expect((await h.join(h.connect(), { fresh: true })).vstate.offline).toBeNull();
  });
});

describe("VerifiedHost: import", () => {
  async function localSave(loaded: LoadedMode, ticks: number): Promise<SimSnapshot> {
    const sim = createSim(loaded, { seed: 99 });
    sim.dispatch("tvc.add", { by: 1234 }, VERIFIED_ACTOR);
    sim.step(ticks);
    return sim.snapshot();
  }

  it("imports a local save once while the instance has no progress", async () => {
    const { h, s } = await started();
    const save = await localSave(V1, 500);
    h.advance(1000);
    const out = await h.send(s, { t: "import", snapshot: await packSnapshot(save), savedAt: 1 });
    const v = only(out, "vstate") as VState;
    expect(v.imported).toBe(true);
    expect(v.importable).toBe(false);
    expect(v.tick).toBe(500);
    expect(v.hash).toBe(createSim(V1, { seed: 0, from: save }).hash());
    expect(h.store.load()).toMatchObject({ imported: true, importUsed: true, verifiedTick: 500 });
    // The imported state is the new verified base.
    const p = new Player(V1);
    await p.adopt(v);
    h.advance(2000);
    only(await h.send(s, p.play(20)), "verified");
    // Never again.
    h.advance(120_000);
    const again = await h.send(s, { t: "import", snapshot: await packSnapshot(save), savedAt: 1 });
    expect(only(again, "error").code).toBe("not_importable");
  });

  it("refuses gzip-packed saves without inflating them (R8)", async () => {
    const { h, s } = await started();
    const save = await localSave(V1, 50);
    const packed = await packSnapshot(save, { forceGzip: true });
    const real = globalThis.DecompressionStream;
    let inflations = 0;
    globalThis.DecompressionStream = class extends real {
      constructor(format: CompressionFormat) {
        inflations++;
        super(format);
      }
    };
    try {
      const out = await h.send(s, { t: "import", snapshot: packed, savedAt: 1 });
      expect(only(out, "error")).toMatchObject({
        code: "import_rejected",
        message: "compressed saves are not accepted",
      });
    } finally {
      globalThis.DecompressionStream = real;
    }
    expect(inflations).toBe(0);
    expect(h.store.load()!.importUsed).toBe(false);
    // The same save as plain JSON still imports.
    h.advance(61_000);
    const v = only(
      await h.send(s, { t: "import", snapshot: await packSnapshot(save), savedAt: 1 }),
      "vstate",
    );
    expect((v as VState).tick).toBe(50);
  });

  it("refuses an under-cap save whose structure would amplify in memory (R8)", async () => {
    const { h, s } = await started();
    const send = async (snapshot: SimSnapshot) => {
      h.advance(61_000); // import rate limit
      const frame = JSON.stringify({
        t: "import",
        snapshot: { enc: "json", data: snapshot },
        savedAt: 1,
      });
      expect(frame.length).toBeLessThanOrEqual(MAX_VERIFIED_CLIENT_FRAME);
      return only(await h.send(s, JSON.parse(frame)), "error");
    };
    // About 290k empty objects in an unknown resource, just under the frame cap:
    // the kernel restores and clones it several times before validation ends.
    const wide = await localSave(V1, 10);
    const junk = Array.from({ length: 290_000 }, () => ({}));
    (wide.world.resources as Record<string, unknown>)["zz.junk"] = junk;
    expect(await send(wide)).toMatchObject({
      code: "import_rejected",
      message: "the save is too large",
    });
    // Deep nesting.
    const deep = await localSave(V1, 10);
    let nest: unknown = 0;
    for (let i = 0; i < 1_000; i++) nest = [nest];
    (deep.world.resources as Record<string, unknown>)["zz.deep"] = nest;
    expect(await send(deep)).toMatchObject({
      code: "import_rejected",
      message: "the save is too large",
    });
    expect(h.store.load()!.importUsed).toBe(false);
    expect(h.store.load()!.imported).toBe(false);
  });

  it("is refused after any verified segment", async () => {
    const { h, s, p } = await started();
    h.advance(2000);
    only(await h.send(s, p.play(10)), "verified");
    const save = await localSave(V1, 50);
    const out = await h.send(s, { t: "import", snapshot: await packSnapshot(save), savedAt: 1 });
    expect(only(out, "error").code).toBe("not_importable");
  });

  it("rejects other content, other modes and saves that do not run", async () => {
    const { h, s } = await started();
    const send = async (snapshot: unknown) => {
      h.advance(61_000); // import rate limit
      return only(await h.send(s, { t: "import", snapshot, savedAt: 1 }), "error").code;
    };
    const v2 = await localSave(V2, 10);
    expect(await send(await packSnapshot(v2))).toBe("import_rejected");
    const other = { ...(await localSave(V1, 10)), modeId: "duel" };
    expect(await send({ enc: "json", data: other })).toBe("import_rejected");
    const broken = await localSave(V1, 10);
    (broken.world as unknown as { resources: unknown }).resources = "nope";
    expect(await send({ enc: "json", data: broken })).toBe("import_rejected");
    expect(await send({ enc: "gzip64", data: "bm90IGd6aXA=" })).toBe("import_rejected");
    expect(h.store.load()!.importUsed).toBe(false);
  });

  it("is rate limited to one per minute", async () => {
    const { h, s } = await started();
    const bad = { t: "import", snapshot: { enc: "json", data: { modeId: "x" } }, savedAt: 1 };
    expect(only(await h.send(s, bad), "error").code).toBe("import_rejected");
    expect(only(await h.send(s, bad), "error").code).toBe("rate_limited");
  });
});

describe("VerifiedHost: content changes", () => {
  async function playedOn(loaded: LoadedMode) {
    const { h, s, p } = await started(loaded);
    p.act("tvc.add", { by: 77 });
    h.advance(2000);
    only(await h.send(s, p.play(30)), "verified");
    h.advance(2000);
    only(await h.send(s, p.play(30)), "verified");
    return { h, s, p };
  }

  it("carries a compatible instance over to the new content hash", async () => {
    const { h, p } = await playedOn(V1);
    h.restart(V2);
    const { vstate, all } = await h.join(h.connect(), {
      resume: { tick: p.sim.tick, hash: p.sim.hash(), pending: false },
    });
    expect(all.map((m) => m.t)).toEqual(["vstate"]);
    expect(vstate.continued).toBe(false);
    expect(vstate.contentHash).toBe(V2.contentHash);
    expect(vstate.tick).toBe(60);
    const snap = await unpackSnapshot(vstate.snapshot!);
    expect(snap.contentHash).toBe(V2.contentHash);
    expect(meterOf(createSim(V2, { seed: 0, from: snap })).sum).toBe(meterOf(p.sim).sum);
    expect(h.store.segments()).toEqual([]);
    expect(h.store.load()!.base.contentHash).toBe(V2.contentHash);
  });

  it("a segment arriving first after a carry-over gets resync content_changed", async () => {
    const { h, s, p } = await playedOn(V1);
    h.restart(V2);
    h.advance(2000);
    const r = only(await h.send(s, p.play(10)), "resync") as Resync;
    expect(r.code).toBe("content_changed");
    expect((await unpackSnapshot(r.snapshot)).contentHash).toBe(V2.contentHash);
  });

  it("starts over (error content_changed, then vstate) when a module disappeared", async () => {
    const { h } = await playedOn(V1);
    h.restart(V3);
    const { vstate, all } = await h.join(h.connect());
    expect(all.map((m) => m.t)).toEqual(["error", "vstate"]);
    expect((all[0] as { code: string }).code).toBe("content_changed");
    expect(vstate.tick).toBe(0);
    expect(vstate.contentHash).toBe(V3.contentHash);
  });
});

describe("VerifiedHost: reports", () => {
  it("appends changed report rows to the outbox at compaction only", async () => {
    const { h, s, p } = await started();
    // The first base (tick 0) reported hundreds = 0.
    expect(h.outbox.size()).toBe(1);
    h.advance(CREDIT_CAP_MS);
    only(await h.send(s, p.play(50)), "verified");
    await h.close(s);
    // Compacted at tick 50: hundreds still 0 -> nothing new.
    expect(h.outbox.size()).toBe(1);
    const s2 = h.connect();
    const { vstate } = await h.join(s2, {
      resume: { tick: p.sim.tick, hash: p.sim.hash(), pending: true },
    });
    p.epoch = vstate.epoch;
    for (let i = 0; i < 3; i++) only(await h.send(s2, p.play(400)), "verified");
    // Compaction at 1250 (>= 1200 ticks since base 50): hundreds = 12.
    const recs = h.outbox.pending();
    expect(recs).toHaveLength(2);
    const last = recs[1]!;
    expect(last.table).toBe("classic_hero");
    expect(last.pk).toBe("tvc:acc1/hero");
    const env = last.payload as ReportEnvelope;
    expect(env).toEqual({
      accountId: "acc1",
      displayName: "Hero-acc1",
      mode: "tvc",
      imported: false,
      key: "hero",
      data: { hundreds: 12 },
    });
    expect(h.flushes).toBe(2);
  });

  it("a new display name re-reports the row", async () => {
    const { h, s } = await started();
    expect(h.outbox.size()).toBe(1);
    await h.close(s);
    const s2 = h.connect();
    s2.info = { ...s2.info, name: "Renamed" };
    await h.join(s2, { fresh: true });
    expect(h.outbox.size()).toBe(2);
    expect((h.outbox.pending()[1]!.payload as ReportEnvelope).displayName).toBe("Renamed");
  });
});

describe("VerifiedHost: frames and pings", () => {
  it("rejects malformed and oversized frames", async () => {
    const { h, s } = await started();
    const bad = async (frame: string) => only(await h.send(s, frame), "error").code;
    expect(await bad("not json")).toBe("bad_message");
    expect(await bad(JSON.stringify({ t: "segment", epoch: 1 }))).toBe("bad_message");
    expect(await bad(JSON.stringify({ t: "nope" }))).toBe("bad_message");
    expect(await bad("x".repeat(MAX_VERIFIED_CLIENT_FRAME + 1))).toBe("bad_message");
  });

  it("answers pings within the ping limit", async () => {
    const { h, s } = await started();
    const pongs: Out[] = [];
    for (let i = 0; i < 5; i++) pongs.push(...(await h.send(s, { t: "ping", clientTime: i })));
    expect(pongs.map((m) => m.t)).toEqual(["pong", "pong", "pong"]);
    expect(pongs[0]).toEqual({ t: "pong", clientTime: 0, serverTime: h.clock.now });
  });

  it("handles messages one at a time even when they arrive together", async () => {
    const { h, s, p } = await started();
    h.advance(CREDIT_CAP_MS);
    const segs = [p.play(10), p.play(10), p.play(10)];
    await Promise.all(segs.map((seg) => h.host.handleMessage(s, JSON.stringify(seg))));
    expect(s.take().map((m) => (m as Ack).tick)).toEqual([10, 20, 30]);
  });
});

describe("parseVerifiedClientMessage", () => {
  it("accepts valid messages and normalises them", () => {
    expect(
      parseVerifiedClientMessage(JSON.stringify({ t: "join", token: "a", mode: "m" })),
    ).toEqual({ t: "join", token: "a", mode: "m" });
    expect(
      parseVerifiedClientMessage(
        JSON.stringify({
          t: "join",
          token: "a",
          mode: "m",
          fresh: true,
          resume: { tick: 3, hash: "ab", pending: false },
        }),
      ),
    ).toEqual({
      t: "join",
      token: "a",
      mode: "m",
      fresh: true,
      resume: { tick: 3, hash: "ab", pending: false },
    });
    expect(
      parseVerifiedClientMessage(
        JSON.stringify({
          t: "segment",
          epoch: 1,
          seq: 2,
          fromTick: 0,
          toTick: 5,
          inputs: [{ tick: 0, name: "a.b" }],
          hash: "ff",
          extra: 1,
        }),
      ),
    ).toEqual({
      t: "segment",
      epoch: 1,
      seq: 2,
      fromTick: 0,
      toTick: 5,
      inputs: [{ tick: 0, name: "a.b", payload: null }],
      hash: "ff",
    });
  });

  it("rejects wrong shapes", () => {
    const bad = [
      { t: "join", token: 1, mode: "m" },
      { t: "join", token: "a", mode: "" },
      { t: "join", token: "a", mode: "m", fresh: "yes" },
      { t: "join", token: "a", mode: "m", resume: { tick: -1, hash: "a", pending: false } },
      { t: "join", token: "a", mode: "m", resume: { tick: 1, hash: "", pending: false } },
      { t: "segment", epoch: -1, seq: 1, fromTick: 0, toTick: 1, inputs: [], hash: "a" },
      { t: "segment", epoch: 1, seq: 1, fromTick: 0.5, toTick: 1, inputs: [], hash: "a" },
      { t: "segment", epoch: 1, seq: 1, fromTick: 0, toTick: 1, inputs: {}, hash: "a" },
      { t: "segment", epoch: 1, seq: 1, fromTick: 0, toTick: 1, inputs: [{ tick: 0 }], hash: "a" },
      { t: "segment", epoch: 1, seq: 1, fromTick: 0, toTick: 1, inputs: [], hash: "x".repeat(65) },
      {
        t: "segment",
        epoch: 1,
        seq: 1,
        fromTick: 0,
        toTick: 1,
        inputs: Array.from({ length: 1025 }, () => ({ tick: 0, name: "a" })),
        hash: "a",
      },
      { t: "import", snapshot: { enc: "zip", data: "" }, savedAt: 1 },
      { t: "import", snapshot: { enc: "json", data: {} }, savedAt: "now" },
      { t: "ping", clientTime: "1" },
      [],
      null,
    ];
    for (const m of bad)
      expect(parseVerifiedClientMessage(JSON.stringify(m)), JSON.stringify(m)).toBeNull();
  });
});
