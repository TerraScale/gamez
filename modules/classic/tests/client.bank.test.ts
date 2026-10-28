/**
 * Classic client bank (docs/design/wave-C.md §2.5): ServerSync.bankRun wired
 * into the real game controller against an in-process fake verified host
 * that replays segments (replaySegment) and applies classic.bank at its
 * verified tick like the InstanceDO: pause / apply / hash check, the action
 * is never recorded, timeout, late answers, mismatch, slow path, BankView.
 */
import { describe, expect, it } from "vite-plus/test";
import { createSim, loadMode, replaySegment, type Sim, type SimSnapshot } from "@gamez/kernel";
import type { AssetManifest } from "@gamez/assets";
import { BANK_ACTOR, type BankOp } from "@gamez/protocol";
import type {
  ArpgRenderEntity,
  ArpgWorldRenderer,
  BankAnswer,
  EffectSpec,
  FloatTextSpec,
  PointerInfo,
  RendererStats,
  SegmentSubmission,
  VerifiedConnection,
  VerifiedHandlers,
  VerifiedStatus,
} from "@gamez/ui-host";
import type { TileMap } from "@gamez/world";
import { mode, modules } from "../src/index.ts";
import { ACTION } from "../src/actions.ts";
import { Wallet } from "../src/components.ts";
import { BANK_ACTION } from "../src/platform/bank.ts";
import { classicClientDriven } from "../src/platform/policy.ts";
import { createClassicGame, LOCAL_BANK, type ClassicGame } from "../src/client/game.ts";
import { DEFAULT_SETTINGS } from "../src/client/persist.ts";
import { heroOf, RES, type AreaState } from "../src/resources.ts";
import {
  BANK_TIMEOUT_MS,
  newBankOpId,
  serverSaveStore,
  ServerSync,
  SYNC_TEXT,
} from "../src/client/sync/index.ts";

const LOADED = loadMode(mode, modules);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

class FakeRenderer implements ArpgWorldRenderer {
  readonly arpg = true as const;
  frames: ((dt: number) => void)[] = [];
  async init(_h: HTMLElement, _m: AssetManifest, _b: string): Promise<void> {}
  setMap(_map: TileMap): void {}
  upsertEntity(_e: ArpgRenderEntity): void {}
  removeEntity(_id: string): void {}
  follow(_x: number, _y: number): void {}
  onTileTap(_cb: (x: number, y: number) => void): void {}
  showTapMarker(_x: number, _y: number): void {}
  onFrame(cb: (dtMs: number) => void): void {
    this.frames.push(cb);
  }
  destroy(): void {}
  floatText(_spec: FloatTextSpec): void {}
  playEffect(_spec: EffectSpec): void {}
  onPointer(_cb: (p: PointerInfo) => void): void {}
  snapCamera(_x: number, _y: number): void {}
  setZoom(_z: number): void {}
  getZoom(): number {
    return 1;
  }
  setLighting(_opts: { darkness: number; radius: number }): void {}
  tileAtClient(_x: number, _y: number): { x: number; y: number } | null {
    return null;
  }
  stats(): RendererStats {
    return { fps: 0, entities: 0, chunks: 0, props: 0, drawMs: 0 };
  }
  frame(dt: number): void {
    for (const cb of this.frames) cb(dt);
  }
}

type BankMode = "fast" | "slow" | "drop" | "badHash" | "fail";
type Frame =
  | { kind: "join"; conn: FakeConn }
  | { kind: "segment"; conn: FakeConn; seg: SegmentSubmission }
  | {
      kind: "bank";
      conn: FakeConn;
      msg: Parameters<NonNullable<VerifiedConnection["sendBank"]>>[0];
    };

/** The verified InstanceDO in miniature, with the bank fast/slow paths. */
class FakeHost {
  sim: Sim = createSim(LOADED, { seed: 9001 });
  base: SimSnapshot = this.sim.snapshot();
  epoch = 0;
  inbox: Frame[] = [];
  segments: SegmentSubmission[] = [];
  resyncs: string[] = [];
  bankMode: BankMode = "fast";
  /** Answers held back (bankMode "drop"), deliverable later. */
  held: { conn: FakeConn; answer: BankAnswer }[] = [];
  joins = 0;

  pump(): void {
    while (this.inbox.length > 0) {
      const f = this.inbox.shift()!;
      if (f.conn.closed) continue;
      if (f.kind === "join") this.#join(f.conn);
      else if (f.kind === "segment") this.#segment(f.conn, f.seg);
      else this.#bank(f.conn, f.msg);
    }
  }

  #join(conn: FakeConn): void {
    this.joins++;
    const resume = conn.handlers?.resume() ?? null;
    this.epoch++;
    conn.setStatus("online");
    const continued =
      resume !== null && resume.tick === this.sim.tick && resume.hash === this.sim.hash();
    conn.handlers?.state({
      instanceId: "classic:acc",
      epoch: this.epoch,
      tick: this.sim.tick,
      hash: this.sim.hash(),
      continued,
      snapshot: continued ? null : clone(this.base),
      offline: null,
      imported: false,
      importable: false,
      limits: { ...classicLimits },
    });
  }

  #resync(conn: FakeConn, seq: number, code: string): void {
    this.sim = createSim(LOADED, { seed: 0, from: clone(this.base) });
    this.epoch++;
    this.resyncs.push(code);
    conn.handlers?.resync({
      epoch: this.epoch,
      seq,
      code,
      message: code,
      tick: this.sim.tick,
      hash: this.sim.hash(),
      snapshot: clone(this.base),
    });
  }

  #segment(conn: FakeConn, seg: SegmentSubmission): void {
    this.segments.push(clone(seg));
    if (seg.epoch !== this.epoch) return;
    if (seg.fromTick !== this.sim.tick) return this.#resync(conn, seg.seq, "gap");
    const out = replaySegment(this.sim, clone(seg), {
      actor: "local",
      maxTicks: classicClientDriven.maxTicksPerSegment,
      maxInputs: classicClientDriven.maxInputsPerSegment,
      serverOnly: new Set(classicClientDriven.serverOnlyActions),
      speedOf: (w) => classicClientDriven.speedOf(w),
      maxSpeed: classicClientDriven.maxSpeed,
      expectHash: seg.hash,
    });
    if (!out.ok) return this.#resync(conn, seg.seq, out.code);
    this.base = this.sim.snapshot();
    conn.handlers?.verified({
      epoch: this.epoch,
      seq: seg.seq,
      tick: this.sim.tick,
      hash: out.hash,
      creditMs: 1000,
    });
  }

  #bank(conn: FakeConn, msg: Extract<Frame, { kind: "bank" }>["msg"]): void {
    const fast = msg.at.tick === this.sim.tick && msg.at.hash === this.sim.hash();
    const payload = { opId: msg.opId, op: msg.op };
    if (this.bankMode === "fail") {
      conn.handlers?.bank?.({
        opId: msg.opId,
        result: { ok: false, code: "insufficient_funds", message: "no coin" },
        applied: null,
      });
      return;
    }
    const res = this.sim.dispatch(BANK_ACTION, payload, BANK_ACTOR);
    if (!res.ok) {
      conn.handlers?.bank?.({
        opId: msg.opId,
        result: { ok: false, code: "bad_request", message: res.error?.message ?? "" },
        applied: null,
      });
      return;
    }
    this.base = this.sim.snapshot();
    const result = { ok: true as const, balance: 0 };
    const answer: BankAnswer = {
      opId: msg.opId,
      result,
      applied: fast
        ? {
            tick: this.sim.tick,
            name: BANK_ACTION,
            payload,
            hash: this.bankMode === "badHash" ? "deadbeef" : this.sim.hash(),
          }
        : null,
    };
    if (this.bankMode === "drop") {
      this.held.push({ conn, answer });
      return;
    }
    if (!fast || this.bankMode === "slow") {
      this.epoch++;
      this.resyncs.push("bank");
      conn.handlers?.resync({
        epoch: this.epoch,
        seq: 0,
        code: "bank",
        message: "bank",
        tick: this.sim.tick,
        hash: this.sim.hash(),
        snapshot: clone(this.base),
      });
      answer.applied = null;
    }
    conn.handlers?.bank?.(answer);
  }
}

const classicLimits = {
  maxTicksPerSegment: 400,
  maxInputsPerSegment: 256,
  segmentEveryMs: 2000,
  maxPendingTicks: 12_000,
  creditCapMs: 900_000,
};

class FakeConn implements VerifiedConnection {
  readonly mode = "classic";
  status: VerifiedStatus = "connecting";
  handlers: VerifiedHandlers | null = null;
  closed = false;
  constructor(readonly host: FakeHost) {}
  setStatus(s: VerifiedStatus): void {
    this.status = s;
    this.handlers?.status(s);
  }
  start(h: VerifiedHandlers): void {
    this.handlers = h;
    this.setStatus("connecting");
    this.host.inbox.push({ kind: "join", conn: this });
  }
  submit(seg: SegmentSubmission): boolean {
    if (this.status !== "online" || this.closed) return false;
    this.host.inbox.push({ kind: "segment", conn: this, seg: clone(seg) });
    return true;
  }
  sendBank(msg: Parameters<NonNullable<VerifiedConnection["sendBank"]>>[0]): boolean {
    if (this.status !== "online" || this.closed) return false;
    this.host.inbox.push({ kind: "bank", conn: this, msg: clone(msg) });
    return true;
  }
  importSave(_s: SimSnapshot, _at: number): void {}
  restart(): void {}
  serverNow(): number {
    return 0;
  }
  close(): void {
    this.closed = true;
    this.status = "closed";
  }
}

interface Client {
  sync: ServerSync;
  game: ClassicGame;
  renderer: FakeRenderer;
  clock: { now: number };
  timers: { cb: () => void; ms: number; cleared: boolean }[];
  /** Every dispatch the game reported to the recorder hook. */
  recorded: string[];
  conns: FakeConn[];
  logs: string[];
}

async function open(host: FakeHost): Promise<Client> {
  const clock = { now: 1000 };
  const timers: Client["timers"] = [];
  const conns: FakeConn[] = [];
  let ops = 0;
  const sync = new ServerSync({
    loaded: LOADED,
    accountId: "acc",
    connect: () => {
      const c = new FakeConn(host);
      conns.push(c);
      return c;
    },
    storage: null,
    now: () => clock.now,
    wall: () => 1_800_000_000_000 + clock.now,
    setTimer: (cb, ms) => {
      timers.push({ cb, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimer: (h) => {
      const t = timers[h as number];
      if (t) t.cleared = true;
    },
    newOpId: () => `op_bank_test_${++ops}`,
  });
  const pending = sync.boot();
  host.pump();
  const boot = await pending;
  if (!boot) throw new Error("boot failed");
  const recorded: string[] = [];
  const logs: string[] = [];
  const renderer = new FakeRenderer();
  const game = createClassicGame({
    loaded: LOADED,
    sim: boot.sim,
    renderer,
    save: serverSaveStore(sync),
    settings: { ...DEFAULT_SETTINGS },
    now: () => clock.now,
    wall: () => clock.now,
    newSeed: () => 1,
    viewportWidth: () => 1024,
    exit: () => {},
    server: {
      refuse: (n) => sync.refuse(n),
      dispatched: (tick, name, payload) => {
        recorded.push(name);
        sync.dispatched(tick, name, payload);
      },
      room: (s) => sync.room(s),
      stepped: (s, now) => sync.stepped(s, now),
      newGame: (seed) => sync.newGame(seed),
      paused: () => sync.paused(),
    },
    sync: sync.view,
    bank: sync.bank,
  });
  const origLog = game.log.bind(game);
  game.log = (t: string) => {
    logs.push(t);
    origLog(t);
  };
  sync.attach(game);
  host.pump();
  return { sync, game, renderer, clock, timers, recorded, conns, logs };
}

function frames(c: Client, host: FakeHost, n: number): void {
  for (let i = 0; i < n; i++) {
    c.clock.now += 50;
    c.renderer.frame(50);
    host.pump();
  }
}

function gold(sim: Sim): number {
  return sim.world.get(heroOf(sim.world), Wallet)!.gold;
}

async function heroInTown(host: FakeHost): Promise<Client> {
  const c = await open(host);
  expect(c.game.api.act(ACTION.newHero, { classId: "classic.warrior", name: "Bank" }).ok).toBe(
    true,
  );
  // Manual control: the hero stays put in town and keeps its 50 starting gold.
  expect(c.game.api.act(ACTION.setControl, { mode: "manual" }).ok).toBe(true);
  frames(c, host, 50); // 2.5 s: a few verified segments
  expect(host.segments.length).toBeGreaterThan(0);
  return c;
}

const deposit: BankOp = { kind: "depositGold", gold: 20 };

describe("BankClient: pause, apply, hash", () => {
  it("cuts, pauses, applies the server's dispatch outside the recorder and resumes", async () => {
    const host = new FakeHost();
    const c = await heroInTown(host);
    const bank = c.game.api.bank!;
    expect(bank.view.getSnapshot().blocked).toBeNull();
    const before = c.game.currentSim().tick;
    const p = c.sync.bankRun(deposit);
    // Sent right away (no input at the current tick): the game is paused.
    expect(c.sync.paused()).toBe(true);
    expect(bank.view.getSnapshot().blocked).toBe("busy");
    c.clock.now += 50;
    c.renderer.frame(50);
    expect(c.game.currentSim().tick).toBe(before);
    expect(c.game.api.act(ACTION.stop, {}).error?.code).toBe("busy");
    host.pump();
    const result = await p;
    expect(result).toEqual({ ok: true, balance: 0 });
    expect(c.sync.paused()).toBe(false);
    expect(gold(c.game.currentSim())).toBe(30);
    expect(c.game.currentSim().hash()).toBe(host.sim.hash());
    expect(c.sync.verified).toEqual({ tick: host.sim.tick, hash: host.sim.hash() });
    expect(bank.view.getSnapshot()).toEqual({
      blocked: null,
      last: { opId: "op_bank_test_1", ok: true, message: "" },
    });
    // Never recorded as an input, never in a segment; play verifies on.
    frames(c, host, 60);
    expect(c.recorded).not.toContain(BANK_ACTION);
    expect(host.segments.flatMap((s) => s.inputs.map((i) => i.name))).not.toContain(BANK_ACTION);
    expect(host.resyncs).toEqual([]);
    expect(c.game.currentSim().tick).toBeGreaterThan(before);
  });

  it("waits for the next step when an input was made at the current tick", async () => {
    const host = new FakeHost();
    const c = await heroInTown(host);
    expect(c.game.api.act(ACTION.stop, {}).ok).toBe(true);
    const p = c.sync.bankRun(deposit);
    expect(c.sync.paused()).toBe(false);
    host.pump();
    expect(host.inbox).toHaveLength(0);
    // The next frame's step makes the cut legal; the op goes out right after
    // it, at the sim's tick, and nothing steps until the answer.
    const tick = c.game.currentSim().tick;
    c.clock.now += 1000;
    c.renderer.frame(1000);
    expect(c.sync.paused()).toBe(true);
    const at = c.game.currentSim().tick;
    expect(at).toBeGreaterThan(tick);
    expect(host.inbox.at(-1)).toMatchObject({ kind: "bank", msg: { at: { tick: at } } });
    c.clock.now += 1000;
    c.renderer.frame(1000);
    expect(c.game.currentSim().tick).toBe(at);
    host.pump();
    const result = await p;
    expect(result.ok).toBe(true);
    expect(host.resyncs).toEqual([]);
    frames(c, host, 60);
    expect(host.resyncs).toEqual([]);
  });

  it("a mismatching hash forces a rejoin and the server state replaces the local one", async () => {
    const host = new FakeHost();
    const c = await heroInTown(host);
    host.bankMode = "badHash";
    const p = c.sync.bankRun(deposit);
    host.pump();
    await p;
    host.pump();
    expect(c.conns.length).toBe(2);
    expect(c.game.currentSim().hash()).toBe(host.sim.hash());
    expect(c.logs.some((l) => l.includes("did not match"))).toBe(true);
    frames(c, host, 60);
    expect(host.resyncs).toEqual([]);
  });

  it("slow path: a quiet resync (no toast, panels kept) then the answer without applied", async () => {
    const host = new FakeHost();
    const c = await heroInTown(host);
    c.game.api.openPanel("stash");
    host.bankMode = "slow";
    const p = c.sync.bankRun(deposit);
    host.pump();
    expect((await p).ok).toBe(true);
    expect(gold(c.game.currentSim())).toBe(30);
    expect(c.game.api.ui.getSnapshot().panels).toContain("stash");
    expect(c.game.api.ui.getSnapshot().toasts.map((t) => t.title)).not.toContain(
      SYNC_TEXT.resyncTitle,
    );
    expect(c.sync.view.getSnapshot().lastResync).toBeNull();
    frames(c, host, 60);
    expect(host.resyncs).toEqual(["bank"]);
  });

  it("a failed op resolves the failure and resumes without changing the sim", async () => {
    const host = new FakeHost();
    const c = await heroInTown(host);
    host.bankMode = "fail";
    const hash = c.game.currentSim().hash();
    const p = c.sync.bankRun({ kind: "withdrawCoin", coin: 5 });
    host.pump();
    expect(await p).toMatchObject({ ok: false, code: "insufficient_funds" });
    expect(c.game.currentSim().hash()).toBe(hash);
    expect(c.game.api.bank!.view.getSnapshot().last).toEqual({
      opId: "op_bank_test_1",
      ok: false,
      message: "no coin",
    });
  });
});

describe("BankClient: timeout and late answers", () => {
  it("times out after 8 s: resumes and resolves unavailable; a late applied answer rejoins", async () => {
    const host = new FakeHost();
    const c = await heroInTown(host);
    host.bankMode = "drop";
    const p = c.sync.bankRun(deposit);
    host.pump();
    const timer = c.timers.find((t) => t.ms === BANK_TIMEOUT_MS && !t.cleared)!;
    expect(timer).toBeDefined();
    timer.cb();
    expect(await p).toMatchObject({ ok: false, code: "unavailable" });
    expect(c.sync.paused()).toBe(false);
    const tick = c.game.currentSim().tick;
    frames(c, host, 5);
    expect(c.game.currentSim().tick).toBeGreaterThan(tick);
    // The answer arrives after all: the client rejoins and adopts the server state.
    const late = host.held.shift()!;
    late.conn.handlers?.bank?.(late.answer);
    host.pump();
    expect(c.conns.length).toBe(2);
    expect(c.game.currentSim().hash()).toBe(host.sim.hash());
    expect(gold(c.game.currentSim())).toBe(30);
  });

  it("losing the connection during an op resolves unavailable at once", async () => {
    const host = new FakeHost();
    const c = await heroInTown(host);
    host.bankMode = "drop";
    const p = c.sync.bankRun(deposit);
    c.conns[0]!.setStatus("offline");
    expect(await p).toMatchObject({ ok: false, code: "unavailable" });
    expect(c.game.api.bank!.view.getSnapshot().blocked).toBe("offline");
  });
});

describe("BankView", () => {
  it("blocked: busy during an op, town outside town, offline without a socket", async () => {
    const host = new FakeHost();
    const c = await heroInTown(host);
    const view = c.game.api.bank!.view;
    expect(view.getSnapshot().blocked).toBeNull();
    // Two at once: the second is refused as busy.
    host.bankMode = "drop";
    const first = c.sync.bankRun(deposit);
    expect(await c.sync.bankRun(deposit)).toMatchObject({ ok: false, code: "busy" });
    c.timers.at(-1)!.cb();
    await first;
    // Leave town (test-only state edit), let the view refresh.
    const sim = c.game.currentSim();
    const area = sim.world.getResource<AreaState>(RES.area)!;
    sim.world.setResource(RES.area, { ...area, depth: 1 });
    c.clock.now += 1000;
    c.conns[0]!.setStatus("online");
    expect(view.getSnapshot().blocked).toBe("town");
    expect(await c.sync.bankRun(deposit)).toMatchObject({ ok: false, code: "not_in_town" });
    c.conns[0]!.setStatus("offline");
    expect(view.getSnapshot().blocked).toBe("offline");
    expect(await c.sync.bankRun(deposit)).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("local mode: api.bank is blocked 'local' and run() is unavailable", async () => {
    const renderer = new FakeRenderer();
    const game = createClassicGame({
      loaded: LOADED,
      sim: createSim(LOADED, { seed: 5 }),
      renderer,
      save: { load: () => null, loadCarryable: () => null, save: () => true, clear: () => {} },
      settings: { ...DEFAULT_SETTINGS },
      now: () => 0,
      wall: () => 0,
      newSeed: () => 1,
      viewportWidth: () => 1024,
      exit: () => {},
    });
    expect(game.api.bank).toBe(LOCAL_BANK);
    expect(game.api.bank!.view.getSnapshot().blocked).toBe("local");
    expect(await game.api.bank!.run(deposit)).toMatchObject({ ok: false, code: "unavailable" });
    expect("openScreen" in game.api).toBe(false);
  });

  it("api.openScreen forwards to the host", () => {
    const opened: unknown[] = [];
    const game = createClassicGame({
      loaded: LOADED,
      sim: createSim(LOADED, { seed: 5 }),
      renderer: new FakeRenderer(),
      save: { load: () => null, loadCarryable: () => null, save: () => true, clear: () => {} },
      settings: { ...DEFAULT_SETTINGS },
      now: () => 0,
      wall: () => 0,
      newSeed: () => 1,
      viewportWidth: () => 1024,
      exit: () => {},
      openScreen: (s) => opened.push(s),
    });
    game.api.openScreen?.({ id: "vault" });
    expect(opened).toEqual([{ id: "vault" }]);
  });

  it("op ids satisfy isOpId", () => {
    for (let i = 0; i < 5; i++) expect(newBankOpId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
